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
// Fixtures — mirrors ingest-cap.test.ts's shape, parameterized by dimensions
// so per-source dimension-mismatch scenarios can be constructed.
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

function makeStubEmbeddingClient(
  modelName: string,
  dimensions = 16,
): { client: EmbeddingClient; embed: ReturnType<typeof vi.fn> } {
  const embed = vi.fn(async (texts: string[]) =>
    texts.map(() => Array.from({ length: dimensions }, () => 0)),
  );
  const client: EmbeddingClient = {
    dimensions,
    modelName,
    embed: embed as unknown as EmbeddingClient['embed'],
  };
  return { client, embed };
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

function makeBuffer(): Buffer {
  return Buffer.from(
    'A reasonably sized document with several sentences to chunk.\n'.repeat(20),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IngestionPipeline — per-source embedding client resolution', () => {
  let db: BetterSqlite3Database;
  let vectorStore: VectorStore;

  beforeEach(() => {
    db = makeDb();
    vectorStore = makeStubVectorStore();
  });

  it('embeds each source with ITS OWN client, not the pipeline default', async () => {
    const sourceA = makeSource({ embeddingSettingName: 'setting-a' });
    const sourceB = makeSource({ embeddingSettingName: 'setting-b' });
    insertSourceRow(db, sourceA);
    insertSourceRow(db, sourceB);

    const { client: clientA, embed: embedA } = makeStubEmbeddingClient('model-a');
    const { client: clientB, embed: embedB } = makeStubEmbeddingClient('model-b');
    const { client: defaultClient, embed: embedDefault } = makeStubEmbeddingClient('model-default');

    const resolveEmbeddingClient = vi.fn((settingName: string) => {
      if (settingName === 'setting-a') return clientA;
      if (settingName === 'setting-b') return clientB;
      throw new Error(`unexpected setting name: ${settingName}`);
    });

    const pipeline = new IngestionPipeline({
      db,
      vectorStore,
      embeddingClient: defaultClient,
      resolveEmbeddingClient,
    });

    await pipeline.ingestDocument({
      source: sourceA,
      folder: null,
      path: 'a.txt',
      mimeType: 'text/plain',
      buffer: makeBuffer(),
    });
    await pipeline.ingestDocument({
      source: sourceB,
      folder: null,
      path: 'b.txt',
      mimeType: 'text/plain',
      buffer: makeBuffer(),
    });

    expect(embedA).toHaveBeenCalledTimes(1);
    expect(embedB).toHaveBeenCalledTimes(1);
    expect(embedDefault).not.toHaveBeenCalled();
  });

  it('falls back to the constructor-level embeddingClient when no resolver is provided', async () => {
    const source = makeSource();
    insertSourceRow(db, source);
    const { client, embed } = makeStubEmbeddingClient('only-client');

    const pipeline = new IngestionPipeline({ db, vectorStore, embeddingClient: client });
    await pipeline.ingestDocument({
      source,
      folder: null,
      path: 'a.txt',
      mimeType: 'text/plain',
      buffer: makeBuffer(),
    });

    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('does NOT silently fall back to the default when the resolver throws (fails loud instead)', async () => {
    const source = makeSource({ embeddingSettingName: 'deleted-setting' });
    insertSourceRow(db, source);
    const { client: defaultClient, embed: embedDefault } = makeStubEmbeddingClient('model-default');

    const resolveEmbeddingClient = vi.fn(() => {
      throw new Error('AI setting "deleted-setting" not found.');
    });

    const pipeline = new IngestionPipeline({
      db,
      vectorStore,
      embeddingClient: defaultClient,
      resolveEmbeddingClient,
    });

    await expect(
      pipeline.ingestDocument({
        source,
        folder: null,
        path: 'a.txt',
        mimeType: 'text/plain',
        buffer: makeBuffer(),
      }),
    ).rejects.toThrow('AI setting "deleted-setting" not found.');
    expect(embedDefault).not.toHaveBeenCalled();

    // Nothing should have landed in the DB — same "fail before any write" invariant as the cap gate.
    const docCount = db
      .prepare(`SELECT COUNT(*) AS n FROM rag_documents WHERE source_id = ?`)
      .get(source.id) as {
      n: number;
    };
    expect(docCount.n).toBe(0);
  });

  it('throws a clear error when the resolved client dimensions do not match the source configuration', async () => {
    const source = makeSource();
    insertSourceRow(db, source, 1536); // source configured for 1536 dims

    const { client } = makeStubEmbeddingClient('mismatched-model', 768); // but resolves to a 768-dim client
    const pipeline = new IngestionPipeline({
      db,
      vectorStore,
      embeddingClient: client,
      resolveEmbeddingClient: () => client,
    });

    await expect(
      pipeline.ingestDocument({
        source,
        folder: null,
        path: 'a.txt',
        mimeType: 'text/plain',
        buffer: makeBuffer(),
      }),
    ).rejects.toThrow(/configured for 1536 dimensions.*produces 768/s);
  });

  it('does not throw when the resolved client dimensions match the source configuration', async () => {
    const source = makeSource();
    insertSourceRow(db, source, 768);
    const { client, embed } = makeStubEmbeddingClient('matching-model', 768);

    const pipeline = new IngestionPipeline({
      db,
      vectorStore,
      embeddingClient: client,
      resolveEmbeddingClient: () => client,
    });

    await expect(
      pipeline.ingestDocument({
        source,
        folder: null,
        path: 'a.txt',
        mimeType: 'text/plain',
        buffer: makeBuffer(),
      }),
    ).resolves.toBeDefined();
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('skips the monthly cap gate when the resolved client is non-billable', async () => {
    const source = makeSource();
    insertSourceRow(db, source);

    // Pre-load the tenant over the cap — a billable client would throw.
    db.prepare(
      `INSERT INTO rag_jobs
			 (id, source_id, status, progress, total_documents, processed_documents,
			  skipped_by_etag, gc_deleted, tokens_embedded, tenant_id, started_at, finished_at)
			 VALUES (?, ?, 'completed', 1, 1, 1, 0, 0, ?, ?, ?, ?)`,
    ).run(
      nanoid(),
      source.id,
      1_000_000,
      'default',
      new Date().toISOString(),
      new Date().toISOString(),
    );

    const { client, embed } = makeStubEmbeddingClient('free-local-model');
    const nonBillableClient: EmbeddingClient = { ...client, billable: false };

    const pipeline = new IngestionPipeline({
      db,
      vectorStore,
      embeddingClient: nonBillableClient,
      resolveEmbeddingClient: () => nonBillableClient,
      capConfig: { monthlyTokenCap: 100 }, // already far exceeded
    });

    await expect(
      pipeline.ingestDocument({
        source,
        folder: null,
        path: 'a.txt',
        mimeType: 'text/plain',
        buffer: makeBuffer(),
      }),
    ).resolves.toBeDefined();
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('still gates a billable client even when a non-billable one was used elsewhere in the process', async () => {
    const source = makeSource();
    insertSourceRow(db, source);
    db.prepare(
      `INSERT INTO rag_jobs
			 (id, source_id, status, progress, total_documents, processed_documents,
			  skipped_by_etag, gc_deleted, tokens_embedded, tenant_id, started_at, finished_at)
			 VALUES (?, ?, 'completed', 1, 1, 1, 0, 0, ?, ?, ?, ?)`,
    ).run(
      nanoid(),
      source.id,
      1_000_000,
      'default',
      new Date().toISOString(),
      new Date().toISOString(),
    );

    const { client } = makeStubEmbeddingClient('billable-model'); // billable defaults to true (undefined)
    const pipeline = new IngestionPipeline({
      db,
      vectorStore,
      embeddingClient: client,
      resolveEmbeddingClient: () => client,
      capConfig: { monthlyTokenCap: 100 },
    });

    await expect(
      pipeline.ingestDocument({
        source,
        folder: null,
        path: 'a.txt',
        mimeType: 'text/plain',
        buffer: makeBuffer(),
      }),
    ).rejects.toBeInstanceOf(EmbeddingCapExceededError);
  });
});
