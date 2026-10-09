import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServeProfile } from '@calame/core';

vi.mock('@calame/core', async (original) => {
  const actual = await original<typeof import('@calame/core')>();
  return { ...actual, registerCalcTool: vi.fn(), sourceAdapterRegistry: {
    get: () => ({ type: 'local', capabilities: ['read'] }), register: vi.fn(),
  } };
});
import { AppState } from '../../state.js';
import { CalameDatabase } from '../../database.js';
import { registerToolsViaAdapters } from '../serve/registration.js';
import { registerDocumentWriteTools } from '../../../../../ee/rag-core/src/write-tools.js';
import { runRagMigrations } from '../../../../../ee/rag-core/src/storage/schema.js';
import { SqliteVecStore } from '../../../../../ee/rag-core/src/storage/sqlite-vec-store.js';
import { IngestionPipeline } from '../../../../../ee/rag-core/src/pipeline/ingest.js';
import { LocalOnnxEmbeddingClient } from '../../../../../ee/rag-core/src/embeddings/local-onnx-client.js';
import { SyncQueue } from '../../../../../ee/rag-core/src/jobs/sync-queue.js';
import { runSyncJob } from '../../../../../ee/rag-core/src/routes/rag-index.js';
import type { RagRouteDeps } from '../../../../../ee/rag-core/src/routes/types.js';
import { LocalFolderConnector } from '../../../../../ee/rag-connectors/src/local-folder.js';

const modelsRoot = process.env.CALAME_TEST_MODEL_ROOT;
let dir: string | undefined;
let db: CalameDatabase | undefined;
afterEach(async () => {
  db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

// Opt-in, because this loads the real 300M ONNX graph. Never substitutes fake
// vectors, fabricated indexed rows, a remote provider, or a model download.
it.skipIf(!modelsRoot)('real host write -> queue -> local connector -> ONNX -> SQLite index -> read/version', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'calame-write-index-'));
  const notes = path.join(dir, 'notes');
  await mkdir(notes);
  await mkdir(path.join(notes, 'mission'));
  await mkdir(path.join(dir, 'store'));
  db = new CalameDatabase(path.join(dir, 'store'));
  runRagMigrations({ raw: db.raw });
  const client = new LocalOnnxEmbeddingClient({
    modelsRootDir: modelsRoot!, modelFolderName: 'embeddinggemma-300m',
    dtype: 'q4', dimensions: 768, maxTokens: 2048, modelName: 'embeddinggemma-300m-q4',
  });
  const vectorStore = new SqliteVecStore(db.raw, client.dimensions);
  const pipeline = new IngestionPipeline({ db: db.raw, vectorStore, embeddingClient: client });
  const connector = new LocalFolderConnector();
  const now = new Date().toISOString();
  db.raw.prepare(`INSERT INTO rag_sources
    (id,name,type,config_encrypted,embedding_setting_name,embedding_model_version,
     embedding_dimensions,tenant_id,created_at,updated_at)
    VALUES ('local','Mission notes','local',?,'local-model',?,768,'default',?,?)`)
    .run(JSON.stringify({ rootPath: notes, includeGlobs: ['**/*.md'] }), client.modelName, now, now);
  const queue = new SyncQueue({ runJob: (sourceId, jobId) => runSyncJob(deps, sourceId, jobId) });
  const deps: RagRouteDeps = {
    db: db.raw, vectorStore, pipeline, syncQueue: queue,
    decryptConfig: (value: string) => value, encryptConfig: (value: string) => value,
    resolveEmbeddingClient: () => client,
    resolveEmbeddingSetting: () => ({ embeddingModel: client.modelName, dimensions: client.dimensions }),
    resolveConnector: (type: string) => type === 'local' ? connector : null,
  } as unknown as RagRouteDeps;
  const triggerSync = (sourceId: string) => {
    const jobId = randomUUID();
    db!.raw.prepare(`INSERT INTO rag_jobs (id,source_id,status,tenant_id,started_at)
      VALUES (?,?,'pending','default',?)`).run(jobId, sourceId, new Date().toISOString());
    if (!queue.enqueue(sourceId, jobId)) {
      db!.raw.prepare('DELETE FROM rag_jobs WHERE id = ?').run(jobId);
      return null;
    }
    return jobId;
  };
  const state = new AppState();
  state.db = db;
  state.ragRuntime = {
    decryptConfig: (value: string) => value, triggerSync,
    documentAdapterDeps: {},
    ragCore: { registerDocumentWriteTools, registerMergedDocumentRagTools: vi.fn() },
  } as unknown as NonNullable<AppState['ragRuntime']>;
  const profile = {
    label: 'Index integration', sources: ['local'],
    scopes: { local: { kind: 'document', mode: 'allowAll' } },
    documentWrite: { enabled: true, sources: { local: { folder: 'mission' } } },
  } as unknown as ServeProfile;
  state.serveProfiles.notes = profile;
  type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  const handlers = new Map<string, Handler>();
  const server = { tool: (name: string, ...args: unknown[]) => {
    handlers.set(name, args[args.length - 1] as Handler);
  } } as unknown as McpServer;
  await registerToolsViaAdapters({
    mcpServer: server, profile, state, profileName: 'notes', tenantId: 'default',
    profileConnections: [], effectiveSelectedTables: {}, effectiveTableOptions: undefined,
    effectiveColumnMasking: undefined, effectiveDocumentScopes: {}, scopeGuard: {} as never,
    responseMode: 'raw', wrapResponse: (value) => value, resolvedTokenLabel: 'index-test',
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await handlers.get(name)!(args);
    return { ...JSON.parse(result.content[0]!.text), isError: result.isError === true };
  };
  const content = '---\nproject: Nationex\nstatus: in-progress\n---\n\nResume: verify the dispatch workflow and write regression tests before the next delivery.\n';
  const saved = await call('rag_write_document', { source: 'Mission notes', path: 'mission/nationex.md', content });
  expect(saved).toMatchObject({ saved: true, isError: false, indexing: { status: 'queued', indexed: false } });
  await queue.drain();
  const job = db.raw.prepare("SELECT status,error,processed_documents FROM rag_jobs WHERE source_id = 'local' ORDER BY started_at DESC LIMIT 1")
    .get();
  expect(job).toMatchObject({ status: 'completed', processed_documents: 1, error: null });
  const document = db.raw.prepare("SELECT id,hash FROM rag_documents WHERE source_id = 'local' AND path = 'mission/nationex.md'")
    .get() as { id: string; hash: string };
  expect(document.hash).toBe(saved.version);
  const chunks = db.raw.prepare('SELECT count(*) AS n FROM rag_chunks WHERE document_id = ?')
    .get(document.id) as { n: number };
  expect(chunks.n).toBeGreaterThan(0);
  const vectors = db.raw.prepare('SELECT count(*) AS n FROM rag_chunks_vec').get() as { n: number };
  expect(vectors.n).toBe(chunks.n);
  const read = await call('rag_read_note', { source: 'Mission notes', path: 'mission/nationex.md' });
  expect(read).toMatchObject({ content, version: saved.version, indexed: true, isError: false });
  expect(read.content).toBe(await readFile(path.join(notes, 'mission/nationex.md'), 'utf8'));
  // Authorize by a real indexed folder ID, not a fabricated database row.
  const folder = db.raw.prepare("SELECT id FROM rag_folders WHERE source_id = 'local' AND path = 'mission'")
    .get() as { id: string };
  state.serveProfiles.notes = { ...profile, scopes: {
    local: { kind: 'document', mode: 'allowList', allowedFolders: [folder.id], allowedDocuments: [] },
  } };
  expect(await call('rag_read_note', { source: 'Mission notes', path: 'mission/nationex.md' }))
    .toMatchObject({ indexed: true, isError: false });
  state.serveProfiles.notes = { ...profile, scopes: {
    local: { kind: 'document', mode: 'allowList', allowedFolders: [], allowedDocuments: [document.id] },
  } };
  const updated = await call('rag_write_document', {
    source: 'Mission notes', path: 'mission/nationex.md', content: content + '\nCompleted the regression.\n', expectedVersion: read.version,
  });
  expect(updated).toMatchObject({ saved: true, operation: 'replaced' });
  await queue.drain();
  expect(await call('rag_read_note', { source: 'Mission notes', path: 'mission/nationex.md' }))
    .toMatchObject({ indexed: true, version: updated.version, isError: false });
}, 90_000);
