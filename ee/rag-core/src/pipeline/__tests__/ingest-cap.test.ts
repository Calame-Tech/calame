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
import { EmbeddingCapExceededError } from '../../jobs/embedding-cap.js';

// ---------------------------------------------------------------------------
// Test fixtures: an in-memory pipeline wiring focused on observing whether the
// cap gate fires BEFORE the embed client call. We don't need sqlite-vec for
// these tests — a stub VectorStore is enough.
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

function makeStubEmbeddingClient(): { client: EmbeddingClient; embed: ReturnType<typeof vi.fn> } {
  const embed = vi.fn(async (texts: string[]) =>
    texts.map(() => Array.from({ length: 16 }, () => 0)),
  );
  const client: EmbeddingClient = {
    dimensions: 16,
    modelName: 'stub-embed',
    embed: embed as unknown as EmbeddingClient['embed'],
  };
  return { client, embed };
}

function insertSourceRow(db: BetterSqlite3Database, source: RagSource): void {
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
    16,
    source.tenantId,
    source.createdAt,
    source.updatedAt,
  );
}

function makeSource(overrides: Partial<RagSource> = {}): RagSource {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? nanoid(),
    name: overrides.name ?? 'Test source',
    type: 'local',
    configEncrypted: '{}',
    embeddingSettingName: 'test',
    embeddingModelVersion: 'text-embedding-3-small',
    tenantId: 'default',
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function insertCompletedJob(
  db: BetterSqlite3Database,
  sourceId: string,
  tokens: number,
  tenantId = 'default',
): void {
  const id = nanoid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO rag_jobs
		 (id, source_id, status, progress, total_documents, processed_documents,
		  skipped_by_etag, gc_deleted, tokens_embedded, tenant_id, started_at, finished_at)
		 VALUES (?, ?, 'completed', 1, 1, 1, 0, 0, ?, ?, ?, ?)`,
  ).run(id, sourceId, tokens, tenantId, now, now);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IngestionPipeline — monthly embedding cap', () => {
  let db: BetterSqlite3Database;
  let vectorStore: VectorStore;

  beforeEach(() => {
    db = makeDb();
    vectorStore = makeStubVectorStore();
  });

  it('does not change behaviour when capConfig is undefined', async () => {
    const source = makeSource();
    insertSourceRow(db, source);

    const { client, embed } = makeStubEmbeddingClient();
    const pipeline = new IngestionPipeline({
      db,
      vectorStore,
      embeddingClient: client,
    });

    const buffer = Buffer.from(
      'Lorem ipsum dolor sit amet consectetur adipiscing elit. '.repeat(20),
      'utf8',
    );
    const doc = await pipeline.ingestDocument({
      source,
      folder: null,
      path: 'doc.txt',
      mimeType: 'text/plain',
      buffer,
    });

    expect(doc.id).toBeDefined();
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('does not gate when monthlyTokenCap is 0 (unlimited)', async () => {
    const source = makeSource();
    insertSourceRow(db, source);

    const { client, embed } = makeStubEmbeddingClient();
    const pipeline = new IngestionPipeline({
      db,
      vectorStore,
      embeddingClient: client,
      capConfig: { monthlyTokenCap: 0 },
    });

    const buffer = Buffer.from('Some plain text content.\n'.repeat(50), 'utf8');
    await pipeline.ingestDocument({
      source,
      folder: null,
      path: 'doc.txt',
      mimeType: 'text/plain',
      buffer,
    });

    expect(embed).toHaveBeenCalled();
  });

  it('throws EmbeddingCapExceededError BEFORE calling the embedding client', async () => {
    const source = makeSource();
    insertSourceRow(db, source);

    // Pre-load the tenant's monthly counter with 100 tokens.
    insertCompletedJob(db, source.id, 100);

    const { client, embed } = makeStubEmbeddingClient();
    const pipeline = new IngestionPipeline({
      db,
      vectorStore,
      embeddingClient: client,
      // Cap so low that even one chunk overflows.
      capConfig: { monthlyTokenCap: 110 },
    });

    // The chunker will produce at least one chunk of meaningful size; even
    // a tiny doc will easily exceed (110 - 100) = 10 tokens.
    const buffer = Buffer.from(
      'A reasonably sized doc with several words to chunk and tokenize. '.repeat(20),
      'utf8',
    );

    await expect(
      pipeline.ingestDocument({
        source,
        folder: null,
        path: 'huge.txt',
        mimeType: 'text/plain',
        buffer,
      }),
    ).rejects.toBeInstanceOf(EmbeddingCapExceededError);

    // Critical: the embed client must NOT have been invoked — that's the
    // whole point of the pre-embed gate.
    expect(embed).not.toHaveBeenCalled();

    // And nothing should have landed in the DB (the cap check fires
    // before the transaction opens).
    const docCount = db
      .prepare(`SELECT COUNT(*) AS n FROM rag_documents WHERE source_id = ?`)
      .get(source.id) as { n: number };
    expect(docCount.n).toBe(0);
    const chunkCount = db
      .prepare(
        `SELECT COUNT(*) AS n FROM rag_chunks WHERE document_id IN
				 (SELECT id FROM rag_documents WHERE source_id = ?)`,
      )
      .get(source.id) as { n: number };
    expect(chunkCount.n).toBe(0);
  });

  it('throws with informative error data (tenant, current, cap, attempted)', async () => {
    const source = makeSource({ tenantId: 'acme' });
    insertSourceRow(db, source);
    // Headroom of 100 tokens — any non-trivial doc will overflow.
    insertCompletedJob(db, source.id, 9_900, 'acme');

    const { client } = makeStubEmbeddingClient();
    const pipeline = new IngestionPipeline({
      db,
      vectorStore,
      embeddingClient: client,
      capConfig: { monthlyTokenCap: 10_000 },
    });

    const buffer = Buffer.from(
      'Each sentence adds a handful of tokens to the embedding budget. '.repeat(50),
      'utf8',
    );

    let caught: unknown = null;
    try {
      await pipeline.ingestDocument({
        source,
        folder: null,
        path: 'doc.txt',
        mimeType: 'text/plain',
        buffer,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EmbeddingCapExceededError);
    const e = caught as EmbeddingCapExceededError;
    expect(e.tenantId).toBe('acme');
    expect(e.currentTokens).toBe(9_900);
    expect(e.cap).toBe(10_000);
    expect(e.attemptedTokens).toBeGreaterThan(0);
  });

  it('still re-embeds when the cap has headroom', async () => {
    const source = makeSource();
    insertSourceRow(db, source);

    // 100 tokens already spent. With a 1_000_000 cap there's plenty of
    // room for the doc below.
    insertCompletedJob(db, source.id, 100);

    const { client, embed } = makeStubEmbeddingClient();
    const pipeline = new IngestionPipeline({
      db,
      vectorStore,
      embeddingClient: client,
      capConfig: { monthlyTokenCap: 1_000_000 },
    });

    const buffer = Buffer.from('Small doc content.\n'.repeat(10), 'utf8');
    const result = await pipeline.ingestDocument({
      source,
      folder: null,
      path: 'small.txt',
      mimeType: 'text/plain',
      buffer,
    });

    expect(result.id).toBeDefined();
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('does not consume cap headroom from a different tenant', async () => {
    const source = makeSource({ tenantId: 'tenant-A' });
    insertSourceRow(db, source);

    // Pile of tokens spent on a different tenant — must not count.
    insertCompletedJob(db, source.id, 1_000_000, 'tenant-B');

    const { client, embed } = makeStubEmbeddingClient();
    const pipeline = new IngestionPipeline({
      db,
      vectorStore,
      embeddingClient: client,
      capConfig: { monthlyTokenCap: 1_000 },
    });

    const buffer = Buffer.from('Small doc.\n'.repeat(5), 'utf8');
    await pipeline.ingestDocument({
      source,
      folder: null,
      path: 'tenant-a.txt',
      mimeType: 'text/plain',
      buffer,
    });

    expect(embed).toHaveBeenCalledTimes(1);
  });
});
