// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { Express, Request, Response } from 'express';

import { runRagMigrations } from '../../storage/schema.js';
import { registerRagContentRoutes } from '../rag-content.js';
import { SyncQueue } from '../../jobs/sync-queue.js';
import { PollScheduler } from '../../jobs/poll-scheduler.js';
import { WatchManager } from '../../jobs/watch-manager.js';
import type { RagRouteDeps } from '../types.js';

// ---------------------------------------------------------------------------
// Minimal test harness (same pattern as rag-sources.test.ts).
// ---------------------------------------------------------------------------

type RouteHandler = (req: Request, res: Response) => void | Promise<void>;

interface CapturedApp {
  app: Express;
  get(path: string): RouteHandler;
}

function makeCapturedApp(): CapturedApp {
  const handlers: Record<string, RouteHandler> = {};
  const app = {
    get: vi.fn((path: string, h: RouteHandler) => {
      handlers[path] = h;
    }),
  } as unknown as Express;

  return {
    app,
    get: (path: string): RouteHandler => {
      const h = handlers[path];
      if (!h) throw new Error(`no GET handler registered for ${path}`);
      return h;
    },
  };
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

function makeReq(opts: {
  params?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string | string[] | undefined>;
}): Request {
  return {
    params: opts.params ?? {},
    body: {},
    query: opts.query ?? {},
    headers: opts.headers ?? {},
  } as unknown as Request;
}

function makeDb(): BetterSqlite3Database {
  const db = new Database(':memory:');
  runRagMigrations({ raw: db });
  return db;
}

function makeDeps(db: BetterSqlite3Database): RagRouteDeps {
  const syncQueue = new SyncQueue({ runJob: async () => undefined });
  const pollScheduler = new PollScheduler({ db, triggerSync: () => null });
  const watchManager = new WatchManager({
    db,
    resolveConnector: () => null,
    decryptConfig: (s) => s,
    triggerSync: () => null,
  });

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
    resolveEmbeddingSetting: vi.fn(() => ({ embeddingModel: 'mock-1', dimensions: 16 })),
    encryptConfig: (s: string) => s,
    decryptConfig: (s: string) => s,
    resolveConnector: vi.fn(() => null),
    syncQueue,
    pollScheduler,
    watchManager,
    onAudit: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Helpers — seed data directly via SQL (no need to go through the sources route).
// ---------------------------------------------------------------------------

function seedSource(db: BetterSqlite3Database, tenantId = 'default'): string {
  const id = `src-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO rag_sources
       (id, name, type, config_encrypted, embedding_setting_name, embedding_model_version, embedding_dimensions, tenant_id)
     VALUES (?, 'Test Source', 'local', '{}', 'mock', 'mock-1', 16, ?)`,
  ).run(id, tenantId);
  return id;
}

function seedFolder(
  db: BetterSqlite3Database,
  sourceId: string,
  parentId: string | null,
  name: string,
  tenantId = 'default',
): string {
  const id = `fld-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO rag_folders (id, source_id, parent_id, path, name, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, sourceId, parentId, `/${name}`, name, tenantId);
  return id;
}

function seedDocument(
  db: BetterSqlite3Database,
  sourceId: string,
  folderId: string | null,
  name: string,
  tenantId = 'default',
): string {
  const id = `doc-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO rag_documents
       (id, source_id, folder_id, path, name, mime_type, size, hash, tenant_id)
     VALUES (?, ?, ?, ?, ?, 'text/plain', 10, 'h1', ?)`,
  ).run(id, sourceId, folderId, `/${name}`, name, tenantId);
  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/rag/sources/:id/documents — root-only filter (bug fix)', () => {
  let db: BetterSqlite3Database;
  let captured: CapturedApp;

  beforeEach(() => {
    db = makeDb();
    captured = makeCapturedApp();
    registerRagContentRoutes(captured.app, makeDeps(db));
  });

  it('without ?folder= returns only root documents (folder_id IS NULL)', async () => {
    const sourceId = seedSource(db);
    const folderId = seedFolder(db, sourceId, null, 'sub');

    const rootDocId = seedDocument(db, sourceId, null, 'root.txt');
    const nestedDocId = seedDocument(db, sourceId, folderId, 'nested.txt');

    const res = makeRes();
    await captured.get('/api/rag/sources/:id/documents')(
      makeReq({ params: { id: sourceId } }),
      res.res,
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as { documents: Array<{ id: string; folderId: string | null }> };
    const ids = body.documents.map((d) => d.id);

    // Root document is present.
    expect(ids).toContain(rootDocId);
    // Nested document must NOT appear at root level (this was the bug).
    expect(ids).not.toContain(nestedDocId);
    // All returned documents have no parent folder.
    for (const doc of body.documents) {
      expect(doc.folderId).toBeNull();
    }
  });

  it('without ?folder= and no root documents returns an empty array', async () => {
    const sourceId = seedSource(db);
    const folderId = seedFolder(db, sourceId, null, 'sub');
    seedDocument(db, sourceId, folderId, 'nested.txt');

    const res = makeRes();
    await captured.get('/api/rag/sources/:id/documents')(
      makeReq({ params: { id: sourceId } }),
      res.res,
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as { documents: unknown[] };
    expect(body.documents).toHaveLength(0);
  });

  it('with ?folder=<id> still returns documents inside that folder (existing branch untouched)', async () => {
    const sourceId = seedSource(db);
    const folderId = seedFolder(db, sourceId, null, 'sub');

    const rootDocId = seedDocument(db, sourceId, null, 'root.txt');
    const nestedDocId = seedDocument(db, sourceId, folderId, 'nested.txt');

    const res = makeRes();
    await captured.get('/api/rag/sources/:id/documents')(
      makeReq({ params: { id: sourceId }, query: { folder: folderId } }),
      res.res,
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as { documents: Array<{ id: string }> };
    const ids = body.documents.map((d) => d.id);

    expect(ids).toContain(nestedDocId);
    expect(ids).not.toContain(rootDocId);
  });

  it('returns 404 for an unknown source id', async () => {
    const res = makeRes();
    await captured.get('/api/rag/sources/:id/documents')(
      makeReq({ params: { id: 'does-not-exist' } }),
      res.res,
    );
    expect(res.statusCode).toBe(404);
  });

  it('does not return soft-deleted documents', async () => {
    const sourceId = seedSource(db);
    const docId = seedDocument(db, sourceId, null, 'deleted.txt');

    // Soft-delete the document.
    db.prepare(`UPDATE rag_documents SET deleted_at = datetime('now') WHERE id = ?`).run(docId);

    const res = makeRes();
    await captured.get('/api/rag/sources/:id/documents')(
      makeReq({ params: { id: sourceId } }),
      res.res,
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as { documents: Array<{ id: string }> };
    expect(body.documents.map((d) => d.id)).not.toContain(docId);
  });

  it('cross-tenant source returns 404 (Phase B isolation)', async () => {
    const db2 = db;
    const deps = makeDeps(db2);
    deps.getTenantId = (req?: Request) => {
      const h = (req?.headers as Record<string, unknown> | undefined)?.['x-tenant-id'];
      return typeof h === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(h) ? h : 'default';
    };
    const captured2 = makeCapturedApp();
    registerRagContentRoutes(captured2.app, deps);

    // Source belongs to 'acme'.
    const sourceId = seedSource(db2, 'acme');
    seedDocument(db2, sourceId, null, 'secret.txt', 'acme');

    // 'beta' tenant cannot see it.
    const res = makeRes();
    await captured2.get('/api/rag/sources/:id/documents')(
      makeReq({ params: { id: sourceId }, headers: { 'x-tenant-id': 'beta' } }),
      res.res,
    );
    expect(res.statusCode).toBe(404);
  });
});
