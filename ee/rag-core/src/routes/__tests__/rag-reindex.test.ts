// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { Express, Request, Response } from 'express';

import { runRagMigrations } from '../../storage/schema.js';
import { registerRagReindexRoutes, resumeReindexJobs } from '../rag-reindex.js';
import type { RagRouteDeps, ResolvedEmbeddingSetting } from '../types.js';

// ---------------------------------------------------------------------------
// Test harness — same "captured app" pattern as rag-index.test.ts: grab the
// registered handlers from a fake Express app and invoke them directly.
// ---------------------------------------------------------------------------

type Handler = (req: Request, res: Response) => void | Promise<void>;

function makeCapturedApp(): { app: Express; post: Map<string, Handler>; get: Map<string, Handler> } {
  const post = new Map<string, Handler>();
  const get = new Map<string, Handler>();
  const app = {
    post: vi.fn((path: string, handler: Handler) => post.set(path, handler)),
    get: vi.fn((path: string, handler: Handler) => get.set(path, handler)),
  } as unknown as Express;
  return { app, post, get };
}

interface FakeResponse {
  statusCode: number;
  body: unknown;
  res: Response;
}

function makeRes(): FakeResponse {
  const r: FakeResponse = { statusCode: 200, body: undefined, res: {} as Response };
  (r.res as unknown as { status: (s: number) => Response }).status = (s: number) => {
    r.statusCode = s;
    return r.res;
  };
  (r.res as unknown as { json: (b: unknown) => Response }).json = (b: unknown) => {
    r.body = b;
    return r.res;
  };
  return r;
}

function makeReq(body: unknown = {}, tenantId = 'default'): Request {
  return { body, query: {}, params: {}, _tenantId: tenantId } as unknown as Request;
}

// ---------------------------------------------------------------------------
// DB fixtures
// ---------------------------------------------------------------------------

function makeDb(): BetterSqlite3Database {
  const db = new Database(':memory:');
  runRagMigrations({ raw: db });
  return db;
}

function insertSource(
  db: BetterSqlite3Database,
  overrides: {
    id?: string;
    tenantId?: string;
    embeddingSettingName?: string;
    embeddingDimensions?: number;
    deletedAt?: string | null;
  } = {},
): string {
  const id = overrides.id ?? nanoid();
  db.prepare(
    `INSERT INTO rag_sources
     (id, name, type, config_encrypted, embedding_setting_name, embedding_model_version,
      embedding_dimensions, tenant_id, deleted_at, created_at, updated_at)
     VALUES (?, ?, 'local', '{}', ?, 'old-model', ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(
    id,
    `Source ${id}`,
    overrides.embeddingSettingName ?? 'old-setting',
    overrides.embeddingDimensions ?? 1536,
    overrides.tenantId ?? 'default',
    overrides.deletedAt ?? null,
  );
  return id;
}

function insertDocWithChunk(db: BetterSqlite3Database, sourceId: string, tenantId = 'default'): string {
  const docId = nanoid();
  const chunkId = nanoid();
  db.prepare(
    `INSERT INTO rag_documents
     (id, source_id, folder_id, path, name, mime_type, size, hash, etag, tenant_id, last_indexed_at, deleted_at)
     VALUES (?, ?, NULL, ?, ?, 'text/plain', 10, 'h', NULL, ?, datetime('now'), NULL)`,
  ).run(docId, sourceId, `${docId}.txt`, `${docId}.txt`, tenantId);
  db.prepare(
    `INSERT INTO rag_chunks (id, document_id, position, text, token_count, embedding_dimensions, tenant_id, created_at)
     VALUES (?, ?, 0, 'hello world', 2, 1536, ?, datetime('now'))`,
  ).run(chunkId, docId, tenantId);
  return docId;
}

function makeDeps(db: BetterSqlite3Database, overrides: Partial<RagRouteDeps> = {}): RagRouteDeps {
  const resolveEmbeddingSetting = vi.fn(
    (name: string): ResolvedEmbeddingSetting => {
      if (name === 'new-local-setting') return { embeddingModel: 'embeddinggemma-300m-q4', dimensions: 768 };
      if (name === 'old-setting') return { embeddingModel: 'old-model', dimensions: 1536 };
      throw new Error(`unknown setting: ${name}`);
    },
  );
  return {
    db,
    pipeline: {} as RagRouteDeps['pipeline'],
    vectorStore: {
      upsert: vi.fn(),
      search: vi.fn(() => []),
      delete: vi.fn(),
      deleteByDocument: vi.fn(),
    },
    resolveEmbeddingClient: vi.fn(),
    resolveEmbeddingSetting,
    encryptConfig: (s: string) => s,
    decryptConfig: (s: string) => s,
    syncQueue: {} as RagRouteDeps['syncQueue'],
    pollScheduler: {} as RagRouteDeps['pollScheduler'],
    watchManager: {} as RagRouteDeps['watchManager'],
    getTenantId: (req?: Request) => (req as unknown as { _tenantId?: string } | undefined)?._tenantId ?? 'default',
    onAudit: vi.fn(),
    ...overrides,
  };
}

async function callReindex(deps: RagRouteDeps, body: unknown, tenantId = 'default') {
  const { app, post } = makeCapturedApp();
  registerRagReindexRoutes(app, deps);
  const handler = post.get('/api/rag/reindex');
  if (!handler) throw new Error('POST /api/rag/reindex was not registered');
  const req = makeReq(body, tenantId);
  const res = makeRes();
  await handler(req, res.res);
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/rag/reindex', () => {
  it('requires confirm:true', async () => {
    const db = makeDb();
    const deps = makeDeps(db);
    const res = await callReindex(deps, { targetSettingName: 'new-local-setting' });
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toContain('confirm: true');
  });

  it('requires targetSettingName', async () => {
    const db = makeDb();
    const deps = makeDeps(db);
    const res = await callReindex(deps, { confirm: true });
    expect(res.statusCode).toBe(400);
  });

  it('is a no-op when already at the target dimension', async () => {
    const db = makeDb();
    insertSource(db, { embeddingDimensions: 1536 });
    const deps = makeDeps(db);
    const res = await callReindex(deps, { targetSettingName: 'old-setting', confirm: true });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ reindexed: false, message: 'Already at the target dimension.' });
  });

  it('returns 409 when another tenant still holds chunks in the shared vector table', async () => {
    const db = makeDb();
    insertSource(db, { tenantId: 'tenant-a', embeddingDimensions: 1536 });
    const otherSourceId = insertSource(db, { tenantId: 'tenant-b', embeddingDimensions: 1536 });
    insertDocWithChunk(db, otherSourceId, 'tenant-b');

    const deps = makeDeps(db);
    const res = await callReindex(deps, { targetSettingName: 'new-local-setting', confirm: true }, 'tenant-a');
    expect(res.statusCode).toBe(409);
    expect((res.body as { code: string }).code).toBe('other-tenants-have-chunks');
  });

  it('purges chunks AND documents (not just chunks) for every active source, then flips to awaiting-restart', async () => {
    const db = makeDb();
    const sourceId = insertSource(db, { embeddingDimensions: 1536 });
    const docId = insertDocWithChunk(db, sourceId);

    const deps = makeDeps(db);
    const res = await callReindex(deps, { targetSettingName: 'new-local-setting', confirm: true });

    expect(res.statusCode).toBe(200);
    const body = res.body as { reindexed: boolean; requiresRestart: boolean; job: { status: string } };
    expect(body.reindexed).toBe(true);
    expect(body.requiresRestart).toBe(true);
    expect(body.job.status).toBe('awaiting-restart');

    const chunkCount = db.prepare(`SELECT COUNT(*) AS n FROM rag_chunks`).get() as { n: number };
    expect(chunkCount.n).toBe(0);
    // Documents must be purged too — the pipeline's hash fast-path and the
    // sync route's etag fast-path both key off rag_documents surviving,
    // which would leave the index permanently empty after re-sync.
    const docCount = db.prepare(`SELECT COUNT(*) AS n FROM rag_documents WHERE id = ?`).get(docId) as {
      n: number;
    };
    expect(docCount.n).toBe(0);

    expect(deps.vectorStore.deleteByDocument).toHaveBeenCalledWith(docId);
  });

  it('repoints every active source at the new setting/model/dimensions', async () => {
    const db = makeDb();
    const s1 = insertSource(db, { embeddingDimensions: 1536 });
    const s2 = insertSource(db, { embeddingDimensions: 1536 });
    const deps = makeDeps(db);

    await callReindex(deps, { targetSettingName: 'new-local-setting', confirm: true });

    for (const id of [s1, s2]) {
      const row = db
        .prepare(`SELECT embedding_setting_name, embedding_model_version, embedding_dimensions FROM rag_sources WHERE id = ?`)
        .get(id) as { embedding_setting_name: string; embedding_model_version: string; embedding_dimensions: number };
      expect(row.embedding_setting_name).toBe('new-local-setting');
      expect(row.embedding_model_version).toBe('embeddinggemma-300m-q4');
      expect(row.embedding_dimensions).toBe(768);
    }
  });

  it('does not touch a soft-deleted source', async () => {
    const db = makeDb();
    const activeId = insertSource(db, { embeddingDimensions: 1536 });
    const deletedId = insertSource(db, { embeddingDimensions: 1536, deletedAt: '2026-01-01T00:00:00.000Z' });
    const deps = makeDeps(db);

    await callReindex(deps, { targetSettingName: 'new-local-setting', confirm: true });

    const activeRow = db.prepare(`SELECT embedding_setting_name FROM rag_sources WHERE id = ?`).get(activeId) as {
      embedding_setting_name: string;
    };
    const deletedRow = db.prepare(`SELECT embedding_setting_name FROM rag_sources WHERE id = ?`).get(deletedId) as {
      embedding_setting_name: string;
    };
    expect(activeRow.embedding_setting_name).toBe('new-local-setting');
    expect(deletedRow.embedding_setting_name).toBe('old-setting');
  });

  it('is idempotent — purging an already-purged source does not throw on retry', async () => {
    const db = makeDb();
    const sourceId = insertSource(db, { embeddingDimensions: 1536 });
    insertDocWithChunk(db, sourceId);
    const deps = makeDeps(db);

    await callReindex(deps, { targetSettingName: 'new-local-setting', confirm: true });
    // Second call: current dimension is now 768 == target, so it's a clean no-op — not an error.
    const res2 = await callReindex(deps, { targetSettingName: 'new-local-setting', confirm: true });
    expect(res2.statusCode).toBe(200);
    expect((res2.body as { reindexed: boolean }).reindexed).toBe(false);
  });

  it('records total_sources / processed_sources on the job row', async () => {
    const db = makeDb();
    insertSource(db, { embeddingDimensions: 1536 });
    insertSource(db, { embeddingDimensions: 1536 });
    const deps = makeDeps(db);

    const res = await callReindex(deps, { targetSettingName: 'new-local-setting', confirm: true });
    const body = res.body as { job: { totalSources: number; processedSources: number } };
    expect(body.job.totalSources).toBe(2);
    expect(body.job.processedSources).toBe(2);
  });
});

describe('GET /api/rag/reindex/status', () => {
  it('returns null when no job has ever run for the tenant', async () => {
    const db = makeDb();
    const deps = makeDeps(db);
    const { app, get } = makeCapturedApp();
    registerRagReindexRoutes(app, deps);
    const handler = get.get('/api/rag/reindex/status');
    if (!handler) throw new Error('not registered');
    const req = makeReq({});
    const res = makeRes();
    await handler(req, res.res);
    expect(res.body).toEqual({ job: null });
  });

  it('returns the most recent job for the tenant', async () => {
    const db = makeDb();
    insertSource(db, { embeddingDimensions: 1536 });
    const deps = makeDeps(db);
    await callReindex(deps, { targetSettingName: 'new-local-setting', confirm: true });

    const { app, get } = makeCapturedApp();
    registerRagReindexRoutes(app, deps);
    const handler = get.get('/api/rag/reindex/status');
    if (!handler) throw new Error('not registered');
    const res = makeRes();
    await handler(makeReq({}), res.res);
    const body = res.body as { job: { status: string; targetDimension: number } };
    expect(body.job.status).toBe('awaiting-restart');
    expect(body.job.targetDimension).toBe(768);
  });
});

describe('resumeReindexJobs (boot recovery)', () => {
  it('marks a still-running job as failed (server restart mid-purge)', () => {
    const db = makeDb();
    const jobId = nanoid();
    db.prepare(
      `INSERT INTO rag_reindex_jobs (id, tenant_id, status, phase, target_setting_name, target_dimension, started_at)
       VALUES (?, 'default', 'running', 'purging', 'new-local-setting', 768, datetime('now'))`,
    ).run(jobId);

    resumeReindexJobs(db, 768, () => null);

    const row = db.prepare(`SELECT status, error FROM rag_reindex_jobs WHERE id = ?`).get(jobId) as {
      status: string;
      error: string;
    };
    expect(row.status).toBe('failed');
    expect(row.error).toContain('restart');
  });

  it('triggers a re-sync for every active source when the target dimension matches the live one', () => {
    const db = makeDb();
    const s1 = insertSource(db, { embeddingDimensions: 768 });
    const s2 = insertSource(db, { embeddingDimensions: 768 });
    const jobId = nanoid();
    db.prepare(
      `INSERT INTO rag_reindex_jobs (id, tenant_id, status, phase, target_setting_name, target_dimension, started_at)
       VALUES (?, 'default', 'awaiting-restart', 'awaiting-restart', 'new-local-setting', 768, datetime('now'))`,
    ).run(jobId);

    const triggerSync = vi.fn((sourceId: string) => `job-for-${sourceId}`);
    resumeReindexJobs(db, 768, triggerSync);

    expect(triggerSync).toHaveBeenCalledWith(s1);
    expect(triggerSync).toHaveBeenCalledWith(s2);
    const row = db.prepare(`SELECT status FROM rag_reindex_jobs WHERE id = ?`).get(jobId) as { status: string };
    expect(row.status).toBe('completed');
  });

  it('does NOT resume a job whose target dimension does not match the live dimension yet', () => {
    const db = makeDb();
    insertSource(db, { embeddingDimensions: 1536 });
    const jobId = nanoid();
    db.prepare(
      `INSERT INTO rag_reindex_jobs (id, tenant_id, status, phase, target_setting_name, target_dimension, started_at)
       VALUES (?, 'default', 'awaiting-restart', 'awaiting-restart', 'new-local-setting', 768, datetime('now'))`,
    ).run(jobId);

    const triggerSync = vi.fn(() => 'job-x');
    // Boot resolved a DIFFERENT live dimension (e.g. the restart hasn't
    // picked up the new sqlite-vec table yet, or targeted the wrong job).
    resumeReindexJobs(db, 1536, triggerSync);

    expect(triggerSync).not.toHaveBeenCalled();
    const row = db.prepare(`SELECT status FROM rag_reindex_jobs WHERE id = ?`).get(jobId) as { status: string };
    expect(row.status).toBe('awaiting-restart');
  });
});
