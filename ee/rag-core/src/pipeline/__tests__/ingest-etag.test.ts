// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

import { runRagMigrations } from '../../storage/schema.js';
import { IngestionPipeline } from '../ingest.js';
import type { EmbeddingClient, RagSource, VectorStore } from '../../types.js';

// ---------------------------------------------------------------------------
// Fixtures — same shape as ingest-per-source-client.test.ts.
// ---------------------------------------------------------------------------

function makeDb(): BetterSqlite3Database {
  const db = new Database(':memory:');
  runRagMigrations({ raw: db });
  return db;
}

function makeStubVectorStore(): VectorStore {
  return {
    upsert: vi.fn(),
    search: vi.fn(() => []),
    delete: vi.fn(),
    deleteByDocument: vi.fn(),
  };
}

function makeStubEmbeddingClient(dimensions = 16): {
  client: EmbeddingClient;
  embed: ReturnType<typeof vi.fn>;
} {
  const embed = vi.fn(async (texts: string[]) =>
    texts.map(() => Array.from({ length: dimensions }, () => 0)),
  );
  const client: EmbeddingClient = {
    dimensions,
    modelName: 'stub-model',
    embed: embed as unknown as EmbeddingClient['embed'],
  };
  return { client, embed };
}

function makeSource(overrides: Partial<RagSource> = {}): RagSource {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? nanoid(),
    name: 'Etag test source',
    type: 'local',
    configEncrypted: '{}',
    embeddingSettingName: 'test',
    embeddingModelVersion: 'stub-model',
    tenantId: 'default',
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function insertSourceRow(db: BetterSqlite3Database, source: RagSource, dimensions = 16): void {
  db.prepare(
    `INSERT INTO rag_sources
		 (id, name, type, config_encrypted, embedding_setting_name, embedding_model_version,
		  embedding_dimensions, tenant_id, deleted_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    source.id,
    source.name,
    source.type,
    source.configEncrypted,
    source.embeddingSettingName,
    source.embeddingModelVersion,
    dimensions,
    source.tenantId,
    source.createdAt,
    source.updatedAt,
  );
}

function readDocRow(
  db: BetterSqlite3Database,
  sourceId: string,
  path: string,
): { etag: string | null; last_indexed_at: string; ingest_error: string | null } | undefined {
  return db
    .prepare<
      [string, string],
      { etag: string | null; last_indexed_at: string; ingest_error: string | null }
    >(`SELECT etag, last_indexed_at, ingest_error FROM rag_documents WHERE source_id = ? AND path = ?`)
    .get(sourceId, path);
}

const BUFFER = Buffer.from('Same content across syncs, only the mtime moved.\n'.repeat(10), 'utf8');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IngestionPipeline — hash fast-path etag refresh', () => {
  let db: BetterSqlite3Database;
  let vectorStore: VectorStore;
  let source: RagSource;

  beforeEach(() => {
    db = makeDb();
    vectorStore = makeStubVectorStore();
    source = makeSource();
    insertSourceRow(db, source);
  });

  it('refreshes a stale etag on the hash fast-path without re-embedding', async () => {
    const { client, embed } = makeStubEmbeddingClient();
    const pipeline = new IngestionPipeline({ db, vectorStore, embeddingClient: client });

    await pipeline.ingestDocument({
      source,
      folder: null,
      path: 'doc.txt',
      mimeType: 'text/plain',
      buffer: BUFFER,
      etag: 'local-v1:100:1',
    });
    expect(embed).toHaveBeenCalledTimes(1);
    const first = readDocRow(db, source.id, 'doc.txt');
    expect(first?.etag).toBe('local-v1:100:1');

    // Same content, new stat fingerprint (mtime moved) — fast path must NOT
    // re-embed, but MUST stamp the new etag so the sync host's etag
    // fast-path skips the fetch on the following sync.
    const result = await pipeline.ingestDocument({
      source,
      folder: null,
      path: 'doc.txt',
      mimeType: 'text/plain',
      buffer: BUFFER,
      etag: 'local-v1:100:2',
    });
    expect(embed).toHaveBeenCalledTimes(1); // unchanged — no re-embed
    expect(result.etag).toBe('local-v1:100:2');
    const second = readDocRow(db, source.id, 'doc.txt');
    expect(second?.etag).toBe('local-v1:100:2');
    // lastIndexedAt untouched — the content wasn't re-indexed.
    expect(second?.last_indexed_at).toBe(first?.last_indexed_at);
  });

  it('stamps an etag onto rows indexed before the connector reported etags', async () => {
    const { client, embed } = makeStubEmbeddingClient();
    const pipeline = new IngestionPipeline({ db, vectorStore, embeddingClient: client });

    // Legacy row: indexed without any etag (stored NULL).
    await pipeline.ingestDocument({
      source,
      folder: null,
      path: 'legacy.txt',
      mimeType: 'text/plain',
      buffer: BUFFER,
    });
    expect(readDocRow(db, source.id, 'legacy.txt')?.etag).toBeNull();

    // One hash-matched sync later, the fingerprint converges.
    await pipeline.ingestDocument({
      source,
      folder: null,
      path: 'legacy.txt',
      mimeType: 'text/plain',
      buffer: BUFFER,
      etag: 'local-v1:100:1',
    });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(readDocRow(db, source.id, 'legacy.txt')?.etag).toBe('local-v1:100:1');
  });
});

describe('IngestionPipeline.markDocumentUnsupported — etag is kept', () => {
  let db: BetterSqlite3Database;
  let vectorStore: VectorStore;
  let source: RagSource;

  beforeEach(() => {
    db = makeDb();
    vectorStore = makeStubVectorStore();
    source = makeSource();
    insertSourceRow(db, source);
  });

  it('stores the supplied etag on a fresh unsupported row (INSERT path)', () => {
    const { client } = makeStubEmbeddingClient();
    const pipeline = new IngestionPipeline({ db, vectorStore, embeddingClient: client });

    pipeline.markDocumentUnsupported(
      {
        source,
        folder: null,
        path: 'weird.xyz',
        mimeType: 'application/x-foo',
        buffer: BUFFER,
        etag: 'local-v1:100:1',
      },
      'No RAG parser is registered for MIME type "application/x-foo".',
    );

    const row = readDocRow(db, source.id, 'weird.xyz');
    // Kept (previously cleared to NULL) so the sync host's etag fast-path can
    // skip re-fetching/diagnosing the file until it actually changes.
    expect(row?.etag).toBe('local-v1:100:1');
    expect(row?.ingest_error).toContain('No RAG parser is registered');
  });

  it('keeps the etag when downgrading a previously healthy row (UPDATE path)', async () => {
    const { client } = makeStubEmbeddingClient();
    const pipeline = new IngestionPipeline({ db, vectorStore, embeddingClient: client });

    await pipeline.ingestDocument({
      source,
      folder: null,
      path: 'was-ok.txt',
      mimeType: 'text/plain',
      buffer: BUFFER,
      etag: 'local-v1:100:1',
    });

    pipeline.markDocumentUnsupported(
      {
        source,
        folder: null,
        path: 'was-ok.txt',
        mimeType: 'application/x-foo',
        buffer: Buffer.from('now some binary format'),
        etag: 'local-v1:22:9',
      },
      'No RAG parser is registered for MIME type "application/x-foo".',
    );

    const row = readDocRow(db, source.id, 'was-ok.txt');
    expect(row?.etag).toBe('local-v1:22:9');
    expect(row?.ingest_error).toContain('No RAG parser is registered');
  });
});
