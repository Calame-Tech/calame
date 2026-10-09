// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Integration test: write tool → real local-source indexing pipeline →
 * rag_read_note reports indexed=true with stored hash matching version.
 *
 * This test exercises the full chain:
 *   1. Create a temp file on disk via fs-write's writeTextFile.
 *   2. Register a fake MCP server with rag_write_document / rag_read_note.
 *   3. Call rag_write_document → file lands on disk, indexing queued.
 *   4. Run the real IngestionPipeline against the file (simulating the
 *      sync worker that would normally be triggered by the queue).
 *   5. Call rag_read_note → isIndexed checks rag_documents for a matching
 *      (source_id, path) row whose hash equals the file's sha256.
 *
 * No fake indexed=true rows are pre-seeded. The test proves that the
 * pipeline's ingestDocument call creates a real rag_documents row and
 * rag_chunks entries, and that the isIndexed check correctly reads them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { nanoid } from 'nanoid';

import { runRagMigrations } from '../storage/schema.js';
import { IngestionPipeline } from '../pipeline/ingest.js';
import { writeTextFile, sha256Hex } from '../fs-write.js';
import {
  registerDocumentWriteTools,
  WRITE_TOOL_NAME,
  READ_NOTE_TOOL_NAME,
} from '../write-tools.js';
import type { ResolveWriteTarget, IndexTriggerResult } from '../write-tools.js';
import type { RagSource, VectorStore, EmbeddingClient } from '../types.js';

// ---------------------------------------------------------------------------
// Test doubles — deterministic, in-process versions of the embedding boundary.
// ---------------------------------------------------------------------------

const EMBED_DIM = 16;

function makeVectorStore(): VectorStore {
  const vectors = new Map<string, Float32Array>();
  return {
    upsert(chunkId, embedding) {
      vectors.set(chunkId, embedding);
    },
    delete(chunkId) {
      vectors.delete(chunkId);
    },
    deleteByDocument() {
      /* no-op for first-time ingestion */
    },
    search(query, topK) {
      const results: Array<{ chunkId: string; distance: number }> = [];
      for (const [chunkId, vec] of vectors) {
        let dot = 0;
        for (let i = 0; i < query.length; i++) {
          dot += (query[i] ?? 0) * (vec[i] ?? 0);
        }
        results.push({ chunkId, distance: 1 - dot });
      }
      results.sort((a, b) => a.distance - b.distance);
      return results.slice(0, topK);
    },
  };
}

/**
 * Character-frequency embedding client. Produces deterministic vectors so
 * that identical text always yields the same embedding — enough for
 * integration-level verification that the pipeline actually called embed.
 */
function makeEmbeddingClient(): EmbeddingClient {
  return {
    dimensions: EMBED_DIM,
    modelName: 'mock-embedding-v1',
    async embed(texts) {
      return texts.map((t) => {
        const v = new Array(EMBED_DIM).fill(0) as number[];
        for (let i = 0; i < t.length; i++) {
          v[t.charCodeAt(i) % EMBED_DIM] += 1;
        }
        let norm = 0;
        for (const x of v) norm += x * x;
        norm = Math.sqrt(norm) || 1;
        return v.map((x) => x / norm);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): BetterSqlite3Database {
  const db = new Database(':memory:');
  runRagMigrations({ raw: db });
  return db;
}

function insertSource(db: BetterSqlite3Database, overrides?: Partial<RagSource>): RagSource {
  const source: RagSource = {
    id: 'src-int',
    name: 'Integration Test Source',
    type: 'local',
    configEncrypted: '{}',
    embeddingSettingName: 'mock',
    embeddingModelVersion: 'mock-embedding-v1',
    tenantId: 'default',
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  db.prepare(
    `INSERT INTO rag_sources
       (id, name, type, config_encrypted, embedding_setting_name, embedding_model_version,
        embedding_dimensions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    source.id,
    source.name,
    source.type,
    source.configEncrypted,
    source.embeddingSettingName,
    source.embeddingModelVersion,
    EMBED_DIM,
    source.createdAt,
    source.updatedAt,
  );
  return source;
}

// ---------------------------------------------------------------------------
// MCP server capture
// ---------------------------------------------------------------------------

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

function makeMcpServer(): { server: McpServer; handlers: Record<string, Handler> } {
  const handlers: Record<string, Handler> = {};
  const server = {
    tool: ((name: string, _d: string, _s: unknown, h: Handler) => {
      handlers[name] = h;
    }) as McpServer['tool'],
  } as unknown as McpServer;
  return { server, handlers };
}

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

describe('write tool → real indexing pipeline → rag_read_note indexed', () => {
  let db: BetterSqlite3Database;
  let vectorStore: VectorStore;
  let embeddingClient: EmbeddingClient;
  let pipeline: IngestionPipeline;
  let source: RagSource;
  let baseDir: string;
  let rootPath: string;
  let handlers: Record<string, Handler>;
  let mcpServer: McpServer;

  beforeEach(async () => {
    db = makeDb();
    vectorStore = makeVectorStore();
    embeddingClient = makeEmbeddingClient();
    pipeline = new IngestionPipeline({ db, vectorStore, embeddingClient });
    source = insertSource(db);

    baseDir = await mkdtemp(join(tmpdir(), 'write-indexing-'));
    rootPath = join(baseDir, 'notes');
    await mkdir(rootPath, { recursive: true });

    ({ server: mcpServer, handlers } = makeMcpServer());
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
    db.close();
  });

  // -------------------------------------------------------------------------
  // Test: write a note, run the real pipeline, read it back with indexed=true
  // -------------------------------------------------------------------------

  it('rag_write_document + real pipeline → rag_read_note shows indexed=true with matching version', async () => {
    // 1. Build MCP tool registrations with real deps.
    const triggerIndex = vi.fn((): IndexTriggerResult => ({ status: 'queued', jobId: nanoid() }));
    const audits: unknown[] = [];

    const resolveTarget: ResolveWriteTarget = async (_name: string, relPath: string) => {
      // For create: file may not exist yet. For replace: check existence.
      // We always accept the path for the create case.
      const { existsSync } = await import('node:fs');
      const fullPath = join(rootPath, relPath);
      const fileExists = existsSync(fullPath);
      // Always resolve for the create case; for replace, only if file exists.
      // Since this test only creates (no expectedVersion), we always return ok.
      return {
        ok: true,
        sourceId: source.id,
        sourceName: source.name,
        rootPath,
        allowedExtensions: ['.md', '.txt'],
      };
    };

    // isIndexed: checks whether rag_documents has a row for this path
    // whose hash matches the provided version.
    const isIndexed = async (
      sourceId: string,
      relPath: string,
      version: string,
    ): Promise<boolean> => {
      const row = db
        .prepare<
          [string, string],
          { hash: string } | undefined
        >(`SELECT hash FROM rag_documents WHERE source_id = ? AND path = ? AND deleted_at IS NULL`)
        .get(sourceId, relPath);
      if (!row) return false;
      return row.hash === version;
    };

    registerDocumentWriteTools({
      server: mcpServer,
      profileName: 'integration-test',
      sourceNames: [source.name],
      resolveTarget,
      triggerIndex: triggerIndex as unknown as (id: string) => IndexTriggerResult,
      isIndexed,
      onAuditLog: (e) => audits.push(e),
    });

    // 2. Write a note via the MCP tool.
    const noteContent =
      '# Integration Test Note\n\nThis file exercises the real indexing pipeline.\n';
    const writeResult = await handlers[WRITE_TOOL_NAME]!({
      source: source.name,
      path: 'test.md',
      content: noteContent,
    });
    expect(writeResult.isError).toBeUndefined();
    const writeBody = JSON.parse(writeResult.content[0]!.text) as Record<string, unknown>;
    expect(writeBody.saved).toBe(true);
    expect(writeBody.operation).toBe('created');
    expect(writeBody.indexing).toMatchObject({ status: 'queued', indexed: false });

    // Capture the version returned by the write.
    const writeVersion = writeBody.version as string;
    expect(writeVersion).toMatch(/^[0-9a-f]{64}$/);

    // 3. Verify the file actually landed on disk.
    const diskContent = await readFile(join(rootPath, 'test.md'), 'utf8');
    expect(diskContent).toBe(noteContent);

    // 4. Verify the hash of the content matches the version.
    const computedHash = sha256Hex(Buffer.from(noteContent, 'utf8'));
    expect(computedHash).toBe(writeVersion);

    // 5. Run the real IngestionPipeline against the file (simulating the
    //    sync worker that the queue would invoke).
    const ingestResult = await pipeline.ingestDocument({
      source,
      folder: null,
      path: 'test.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(noteContent, 'utf8'),
    });

    // 6. Verify the pipeline created a real rag_documents row.
    const docRow = db
      .prepare<
        [string],
        { id: string; hash: string; source_id: string } | undefined
      >(`SELECT id, hash, source_id FROM rag_documents WHERE id = ?`)
      .get(ingestResult.id);
    expect(docRow).toBeDefined();
    expect(docRow!.source_id).toBe(source.id);

    // 7. Verify chunks were persisted.
    const chunkCount = db
      .prepare<
        [string],
        { c: number }
      >(`SELECT COUNT(*) AS c FROM rag_chunks WHERE document_id = ?`)
      .get(ingestResult.id);
    expect(chunkCount?.c).toBeGreaterThan(0);

    // 8. Now read the note back via rag_read_note — isIndexed should return true
    //    because rag_documents has a row with the matching hash.
    const readResult = await handlers[READ_NOTE_TOOL_NAME]!({
      source: source.name,
      path: 'test.md',
    });
    expect(readResult.isError).toBeUndefined();
    const readBody = JSON.parse(readResult.content[0]!.text) as Record<string, unknown>;

    expect(readBody.source).toBe(source.name);
    expect(readBody.path).toBe('test.md');
    expect(readBody.version).toBe(writeVersion);
    expect(readBody.bytes).toBe(noteContent.length);
    expect(readBody.content).toBe(noteContent);
    expect(readBody.indexed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test: read before indexing shows indexed=false
  // -------------------------------------------------------------------------

  it('rag_read_note shows indexed=false immediately after write (before pipeline runs)', async () => {
    const triggerIndex = vi.fn((): IndexTriggerResult => ({ status: 'queued', jobId: nanoid() }));
    const audits: unknown[] = [];

    const resolveTarget: ResolveWriteTarget = async (_name: string, relPath: string) => {
      // Always accept the path for the create case.
      return {
        ok: true,
        sourceId: source.id,
        sourceName: source.name,
        rootPath,
        allowedExtensions: ['.md', '.txt'],
      };
    };

    const isIndexed = async (
      _sourceId: string,
      _relPath: string,
      _version: string,
    ): Promise<boolean> => {
      return false; // pre-index: nothing indexed yet
    };

    registerDocumentWriteTools({
      server: mcpServer,
      profileName: 'integration-test',
      sourceNames: [source.name],
      resolveTarget,
      triggerIndex: triggerIndex as unknown as (id: string) => IndexTriggerResult,
      isIndexed,
      onAuditLog: (e) => audits.push(e),
    });

    // Write a note.
    const noteContent = 'Pre-index content.\n';
    const writeResult = await handlers[WRITE_TOOL_NAME]!({
      source: source.name,
      path: 'before-index.md',
      content: noteContent,
    });
    expect(writeResult.isError).toBeUndefined();
    const writeBody = JSON.parse(writeResult.content[0]!.text) as Record<string, unknown>;
    expect(writeBody.saved).toBe(true);

    // Read back — isIndexed returns false because the pipeline hasn't run.
    const readResult = await handlers[READ_NOTE_TOOL_NAME]!({
      source: source.name,
      path: 'before-index.md',
    });
    const readBody = JSON.parse(readResult.content[0]!.text) as Record<string, unknown>;
    expect(readBody.indexed).toBe(false);
    expect(readBody.version).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Test: version conflict on write, then pipeline indexes the correct content
  // -------------------------------------------------------------------------

  it('version conflict write → pipeline indexes the original content', async () => {
    const triggerIndex = vi.fn((): IndexTriggerResult => ({ status: 'queued', jobId: nanoid() }));
    const audits: unknown[] = [];

    const resolveTarget: ResolveWriteTarget = async (_name: string, relPath: string) => {
      // For create: always accept. For replace: accept if file exists.
      return {
        ok: true,
        sourceId: source.id,
        sourceName: source.name,
        rootPath,
        allowedExtensions: ['.md', '.txt'],
      };
    };

    const isIndexed = async (
      sourceId: string,
      relPath: string,
      version: string,
    ): Promise<boolean> => {
      const row = db
        .prepare<
          [string, string],
          { hash: string } | undefined
        >(`SELECT hash FROM rag_documents WHERE source_id = ? AND path = ? AND deleted_at IS NULL`)
        .get(sourceId, relPath);
      if (!row) return false;
      return row.hash === version;
    };

    registerDocumentWriteTools({
      server: mcpServer,
      profileName: 'integration-test',
      sourceNames: [source.name],
      resolveTarget,
      triggerIndex: triggerIndex as unknown as (id: string) => IndexTriggerResult,
      isIndexed,
      onAuditLog: (e) => audits.push(e),
    });

    // Write a note.
    const noteContent = 'Version conflict test content.\n';
    const writeResult = await handlers[WRITE_TOOL_NAME]!({
      source: source.name,
      path: 'conflict.md',
      content: noteContent,
    });
    const writeBody = JSON.parse(writeResult.content[0]!.text) as Record<string, unknown>;
    const version = writeBody.version as string;

    // Try to replace with a wrong expectedVersion → should fail.
    const conflictResult = await handlers[WRITE_TOOL_NAME]!({
      source: source.name,
      path: 'conflict.md',
      content: 'Different content\n',
      expectedVersion: '0000000000000000000000000000000000000000000000000000000000000000',
    });
    expect(conflictResult.isError).toBe(true);

    // Run pipeline on the ORIGINAL content (still on disk).
    const ingestResult = await pipeline.ingestDocument({
      source,
      folder: null,
      path: 'conflict.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(noteContent, 'utf8'),
    });

    // Verify the document was indexed with the correct hash.
    const docRow = db
      .prepare<
        [string],
        { hash: string } | undefined
      >(`SELECT hash FROM rag_documents WHERE id = ?`)
      .get(ingestResult.id);
    expect(docRow?.hash).toBe(sha256Hex(Buffer.from(noteContent, 'utf8')));

    // Read back — should be indexed with the original version.
    const readResult = await handlers[READ_NOTE_TOOL_NAME]!({
      source: source.name,
      path: 'conflict.md',
    });
    const readBody = JSON.parse(readResult.content[0]!.text) as Record<string, unknown>;
    expect(readBody.indexed).toBe(true);
    expect(readBody.version).toBe(version);
  });
});
