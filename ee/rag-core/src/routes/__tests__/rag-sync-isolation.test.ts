// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

// Per-file error isolation of the sync worker, driven end-to-end through
// runSyncJob with a REAL IngestionPipeline and a SQL-backed vector store, so
// chunk / vector consistency after failures can be checked in the database.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { Readable } from 'node:stream';

import { runRagMigrations } from '../../storage/schema.js';
import { runSyncJob } from '../rag-index.js';
import { IngestionPipeline } from '../../pipeline/ingest.js';
import { IsolatedParser } from '../../parsers/isolated-parser.js';
import {
  DocumentRejectedError,
  classifyReadError,
  isOfficeTempFile,
} from '../../pipeline/document-errors.js';
import type { ConnectorLike, RagRouteDeps } from '../types.js';
import type { EmbeddingClient, RagSource, VectorStore } from '../../types.js';

const DIM = 4;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const FAKE_WORKER = new URL(
  '../../parsers/__tests__/fixtures/fake-parse-worker.mjs',
  import.meta.url,
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FakeFile {
  /** Content, or a factory for a custom (e.g. failing) stream. */
  body: string | Buffer | (() => Readable);
  mimeType?: string;
  etag: string;
}

function errnoStream(code: string): () => Readable {
  return () =>
    new Readable({
      read() {
        this.destroy(Object.assign(new Error(`${code}: simulated`), { code }));
      },
    });
}

function makeConnector(files: Map<string, FakeFile>): ConnectorLike & {
  fetchDocument: ReturnType<typeof vi.fn>;
} {
  const fetchDocument = vi.fn(async (_cfg: unknown, _sid: string, docId: string) => {
    const f = files.get(docId);
    if (!f) throw new Error(`unknown doc ${docId}`);
    const stream =
      typeof f.body === 'function' ? f.body() : Readable.from([Buffer.from(f.body as string)]);
    return { stream, mimeType: f.mimeType ?? 'text/plain' };
  });
  return {
    type: 'local',
    testConnection: vi.fn(async () => undefined),
    listFolders: vi.fn(async () => []),
    listDocuments: vi.fn(async (_cfg: unknown, sourceId: string, folder: unknown) => {
      if (folder !== undefined) return [];
      return [...files.entries()].map(([path, f]) => ({
        id: path,
        sourceId,
        folderId: null,
        path,
        name: path.split('/').pop() ?? path,
        mimeType: f.mimeType ?? 'text/plain',
        size: 1,
        hash: '',
        etag: f.etag,
        lastIndexedAt: '',
        deletedAt: null,
        ingestError: null,
      }));
    }),
    fetchDocument,
  };
}

/** Vector store persisted in the same SQLite DB (so it shares transactions). */
function makeSqlVectorStore(db: BetterSqlite3Database): VectorStore {
  db.exec(`CREATE TABLE test_vectors (chunk_id TEXT PRIMARY KEY)`);
  return {
    upsert: (chunkId: string) => {
      db.prepare(`INSERT INTO test_vectors (chunk_id) VALUES (?)`).run(chunkId);
    },
    search: () => [],
    delete: (chunkId: string) => {
      db.prepare(`DELETE FROM test_vectors WHERE chunk_id = ?`).run(chunkId);
    },
    deleteByDocument: (documentId: string) => {
      db.prepare(
        `DELETE FROM test_vectors WHERE chunk_id IN (SELECT id FROM rag_chunks WHERE document_id = ?)`,
      ).run(documentId);
    },
  } as unknown as VectorStore;
}

const embeddingClient: EmbeddingClient = {
  dimensions: DIM,
  modelName: 'stub',
  embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
};

const SOURCE: RagSource = {
  id: 'src-iso',
  name: 'Isolation source',
  type: 'local',
  configEncrypted: '{}',
  embeddingSettingName: 'stub',
  embeddingModelVersion: 'stub',
  tenantId: 'default',
  deletedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

interface Harness {
  db: BetterSqlite3Database;
  deps: RagRouteDeps;
  connector: ReturnType<typeof makeConnector>;
  sync(): Promise<Record<string, unknown>>;
}

function makeHarness(
  files: Map<string, FakeFile>,
  parseDocument?: ConstructorParameters<typeof IngestionPipeline>[0]['parseDocument'],
): Harness {
  const db = new Database(':memory:');
  runRagMigrations({ raw: db });
  db.prepare(
    `INSERT INTO rag_sources
		 (id, name, type, config_encrypted, embedding_setting_name, embedding_model_version,
		  embedding_dimensions, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SOURCE.id,
    SOURCE.name,
    'local',
    '{}',
    'stub',
    'stub',
    DIM,
    SOURCE.createdAt,
    SOURCE.updatedAt,
  );
  const pipeline = new IngestionPipeline({
    db,
    vectorStore: makeSqlVectorStore(db),
    embeddingClient,
    ...(parseDocument ? { parseDocument } : {}),
  });
  const connector = makeConnector(files);
  const deps = {
    db,
    pipeline,
    decryptConfig: (s: string) => s,
    resolveConnector: () => connector,
    onAudit: vi.fn(),
  } as unknown as RagRouteDeps;
  let n = 0;
  return {
    db,
    deps,
    connector,
    async sync() {
      const jobId = `job-${++n}`;
      db.prepare(
        `INSERT INTO rag_jobs (id, source_id, status, progress, total_documents, processed_documents, tenant_id, started_at)
				 VALUES (?, ?, 'pending', 0, 0, 0, 'default', ?)`,
      ).run(jobId, SOURCE.id, new Date(Date.now() + n).toISOString());
      await runSyncJob(deps, SOURCE.id, jobId);
      return db.prepare(`SELECT * FROM rag_jobs WHERE id = ?`).get(jobId) as Record<
        string,
        unknown
      >;
    },
  };
}

function indexedPaths(db: BetterSqlite3Database): string[] {
  return (
    db
      .prepare(
        `SELECT path FROM rag_documents WHERE deleted_at IS NULL AND ingest_error IS NULL ORDER BY path`,
      )
      .all() as Array<{ path: string }>
  ).map((r) => r.path);
}

function chunkTexts(db: BetterSqlite3Database, path: string): string[] {
  return (
    db
      .prepare(
        `SELECT c.text FROM rag_chunks c JOIN rag_documents d ON d.id = c.document_id
				 WHERE d.path = ? ORDER BY c.position`,
      )
      .all(path) as Array<{ text: string }>
  ).map((r) => r.text);
}

/** Every chunk has exactly one vector and every vector a chunk; no duplicate docs. */
function assertConsistent(db: BetterSqlite3Database): void {
  const orphanVectors = db
    .prepare(
      `SELECT COUNT(*) AS n FROM test_vectors v LEFT JOIN rag_chunks c ON c.id = v.chunk_id WHERE c.id IS NULL`,
    )
    .get() as { n: number };
  const chunksWithoutVector = db
    .prepare(
      `SELECT COUNT(*) AS n FROM rag_chunks c LEFT JOIN test_vectors v ON v.chunk_id = c.id WHERE v.chunk_id IS NULL`,
    )
    .get() as { n: number };
  const duplicateDocs = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (SELECT source_id, path FROM rag_documents GROUP BY source_id, path HAVING COUNT(*) > 1)`,
    )
    .get() as { n: number };
  expect(orphanVectors.n).toBe(0);
  expect(chunksWithoutVector.n).toBe(0);
  expect(duplicateDocs.n).toBe(0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSyncJob — per-file error isolation', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env['CALAME_RAG_LOCKED_RETRY_DELAY_MS'] = '1';
    process.env['CALAME_RAG_MAX_DOC_BYTES'] = '1024';
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('indexes every valid document despite corrupt, oversized, locked and unreadable files', async () => {
    const corruptDocx = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(64, 7)]);
    const files = new Map<string, FakeFile>([
      ['a.txt', { body: 'alpha document', etag: 'e1' }],
      [
        'Rapport.docx',
        { body: () => Readable.from([corruptDocx]), mimeType: DOCX_MIME, etag: 'e2' },
      ],
      ['b.txt', { body: 'bravo document', etag: 'e3' }],
      ['big.txt', { body: 'x'.repeat(4096), etag: 'e4' }],
      ['locked.docx', { body: errnoStream('EBUSY'), mimeType: DOCX_MIME, etag: 'e5' }],
      ['denied.txt', { body: errnoStream('EACCES'), etag: 'e6' }],
      ['~$Rapport.docx', { body: 'owner-file', mimeType: DOCX_MIME, etag: 'e7' }],
      ['c.txt', { body: 'charlie document', etag: 'e8' }],
    ]);
    // More rejections in a row than the circuit-breaker threshold: they
    // must not abort the job.
    process.env['CALAME_RAG_SYNC_MAX_CONSECUTIVE_FAILURES'] = '2';
    const h = makeHarness(files);
    const job = await h.sync();

    expect(indexedPaths(h.db)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    // Office temp file: never fetched, not counted.
    expect(h.connector.fetchDocument.mock.calls.map((c) => c[2])).not.toContain('~$Rapport.docx');
    expect(job['total_documents']).toBe(7);
    expect(job['processed_documents']).toBe(7);
    // Lock: bounded retries (default 2 → 3 attempts), then rejected.
    expect(h.connector.fetchDocument.mock.calls.filter((c) => c[2] === 'locked.docx')).toHaveLength(
      3,
    );
    // Access denied is not a lock: no retry.
    expect(h.connector.fetchDocument.mock.calls.filter((c) => c[2] === 'denied.txt')).toHaveLength(
      1,
    );
    expect(String(job['error'])).toMatch(/^4\/7 failed/);
    const audit = (h.deps.onAudit as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    const terminal = audit[audit.length - 1];
    expect(terminal.payload['reason']).toBeUndefined();
    expect(terminal.payload['failures']).toBe(4);
    assertConsistent(h.db);
  });

  it('records the rejected file path and a readable reason', async () => {
    const files = new Map<string, FakeFile>([
      ['ok.txt', { body: 'fine', etag: 'e1' }],
      ['dossier/big.txt', { body: 'x'.repeat(4096), etag: 'e2' }],
    ]);
    const h = makeHarness(files);
    const job = await h.sync();
    expect(String(job['error'])).toContain('dossier/big.txt');
    expect(String(job['error'])).toContain('per-document limit');
  });

  it('isolates a parser that throws and a parser stuck in a loop (hard timeout)', async () => {
    const parser = new IsolatedParser({ workerUrl: FAKE_WORKER, timeoutMs: 300 });
    try {
      const files = new Map<string, FakeFile>([
        ['1.txt', { body: 'one', etag: 'e1' }],
        ['throw.txt', { body: 'x', etag: 'e2' }],
        ['loop.txt', { body: 'x', etag: 'e3' }],
        ['2.txt', { body: 'two', etag: 'e4' }],
      ]);
      const h = makeHarness(files, (m, b, f) => parser.parse(m, b, f));
      const job = await h.sync();
      expect(indexedPaths(h.db)).toEqual(['1.txt', '2.txt']);
      expect(job['status']).toBe('failed');
      expect(String(job['error'])).toContain('loop.txt');
      expect(String(job['error'])).toMatch(/stopped/);
      // The worker that spun forever is gone; the parser keeps working.
      expect((await parser.parse('text/plain', Buffer.from('z'), 'z.txt')).text).toBe('z');
      assertConsistent(h.db);
    } finally {
      await parser.close();
    }
  });

  it('keeps the last valid version when an update fails, then recovers on the next sync', async () => {
    const corruptDocx = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(64, 7)]);
    const files = new Map<string, FakeFile>([
      ['doc.txt', { body: 'version one', etag: 'v1' }],
      ['other.txt', { body: 'other', etag: 'o1' }],
    ]);
    const h = makeHarness(files);
    await h.sync();
    expect(chunkTexts(h.db, 'doc.txt').join(' ')).toContain('version one');
    const before = h.db.prepare(`SELECT * FROM rag_documents WHERE path = 'doc.txt'`).get();

    // The file is replaced by unparseable content.
    files.set('doc.txt', {
      body: () => Readable.from([corruptDocx]),
      mimeType: DOCX_MIME,
      etag: 'v2',
    });
    const failed = await h.sync();
    expect(String(failed['error'])).toContain('doc.txt');
    // Previous version untouched: same row (etag/hash), same chunks, vectors.
    expect(h.db.prepare(`SELECT * FROM rag_documents WHERE path = 'doc.txt'`).get()).toEqual(
      before,
    );
    expect(chunkTexts(h.db, 'doc.txt').join(' ')).toContain('version one');
    assertConsistent(h.db);

    // Fixed on disk → re-indexed; old chunks / vectors replaced, not duplicated.
    files.set('doc.txt', { body: 'version three', etag: 'v3' });
    const fetchesBefore = h.connector.fetchDocument.mock.calls.length;
    const ok = await h.sync();
    expect(ok['status']).toBe('completed');
    expect(chunkTexts(h.db, 'doc.txt').join(' ')).toContain('version three');
    expect(chunkTexts(h.db, 'doc.txt').join(' ')).not.toContain('version one');
    // Incremental: only the changed file was fetched again.
    expect(h.connector.fetchDocument.mock.calls.slice(fetchesBefore).map((c) => c[2])).toEqual([
      'doc.txt',
    ]);
    assertConsistent(h.db);
  });

  it('a new file that fails leaves no partial row behind', async () => {
    const files = new Map<string, FakeFile>([['big.txt', { body: 'x'.repeat(4096), etag: 'e1' }]]);
    const h = makeHarness(files);
    await h.sync();
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM rag_documents`).get()).toEqual({ n: 0 });
    assertConsistent(h.db);
  });
});

describe('per-file error helpers', () => {
  it('recognises Office temp files with POSIX and Windows separators', () => {
    expect(isOfficeTempFile('~$Rapport.docx')).toBe(true);
    expect(isOfficeTempFile('dossier/~$Rapport.docx')).toBe(true);
    expect(isOfficeTempFile('C:\\Users\\rafael\\Documents\\~$Rapport.docx')).toBe(true);
    expect(isOfficeTempFile('\\\\serveur\\partage\\~$note.docx')).toBe(true);
    expect(isOfficeTempFile('C:\\Users\\rafael\\Documents\\Rapport.docx')).toBe(false);
    expect(isOfficeTempFile('dossier/Rapport~$.docx')).toBe(false);
  });

  it('classifies Windows lock / access errors', () => {
    const errno = (code: string) => Object.assign(new Error(code), { code });
    expect(classifyReadError(errno('EBUSY'))?.kind).toBe('locked');
    expect(classifyReadError(errno('EPERM'))?.kind).toBe('locked');
    expect(classifyReadError(errno('EACCES'))?.kind).toBe('unreadable');
    expect(classifyReadError(errno('ENOENT'))?.kind).toBe('unreadable');
    expect(classifyReadError(new Error('HTTP 503'))).toBeNull();
    const rejected = new DocumentRejectedError('too_large', 'big');
    expect(classifyReadError(rejected)).toBe(rejected);
  });
});
