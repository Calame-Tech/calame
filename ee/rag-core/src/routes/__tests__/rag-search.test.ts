// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { Express, Request, Response } from 'express';

import { runRagMigrations } from '../../storage/schema.js';
import { registerRagSearchRoutes } from '../rag-search.js';
import { SyncQueue } from '../../jobs/sync-queue.js';
import { PollScheduler } from '../../jobs/poll-scheduler.js';
import { WatchManager } from '../../jobs/watch-manager.js';
import type { RagRouteDeps } from '../types.js';
import type { RagSearchResult } from '../../types.js';

// ---------------------------------------------------------------------------
// Harness — same pattern as rag-content.test.ts.
// ---------------------------------------------------------------------------

type RouteHandler = (req: Request, res: Response) => void | Promise<void>;

function makeCapturedApp(): { app: Express; post(path: string): RouteHandler } {
  const handlers: Record<string, RouteHandler> = {};
  const app = {
    post: vi.fn((path: string, h: RouteHandler) => {
      handlers[path] = h;
    }),
  } as unknown as Express;
  return {
    app,
    post: (path: string): RouteHandler => {
      const h = handlers[path];
      if (!h) throw new Error(`no POST handler registered for ${path}`);
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

function makeDb(): BetterSqlite3Database {
  const db = new Database(':memory:');
  runRagMigrations({ raw: db });
  return db;
}

const CHUNK_TEXT = 'Contact ops@example.net or call 555.123.4567 for onboarding.';

/** Seed one source + document + chunk (id 'c1') so the JOIN hydrates a hit. */
function seedChunk(db: BetterSqlite3Database): void {
  db.prepare(
    `INSERT INTO rag_sources
		 (id, name, type, config_encrypted, embedding_setting_name, embedding_model_version, embedding_dimensions, tenant_id)
		 VALUES ('src-1', 'S', 'local', '{}', 's1', 'stub-model', 16, 'default')`,
  ).run();
  db.prepare(
    `INSERT INTO rag_documents
		 (id, source_id, folder_id, path, name, mime_type, size, hash, tenant_id, last_indexed_at)
		 VALUES ('doc-1', 'src-1', NULL, 'hr/contacts.md', 'contacts.md', 'text/markdown', 10, 'h1', 'default', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO rag_chunks
		 (id, document_id, position, text, token_count, embedding_dimensions, tenant_id, created_at)
		 VALUES ('c1', 'doc-1', 0, ?, 12, 16, 'default', '2026-01-01T00:00:00.000Z')`,
  ).run(CHUNK_TEXT);
}

function makeDeps(db: BetterSqlite3Database): RagRouteDeps {
  return {
    db,
    pipeline: {} as RagRouteDeps['pipeline'],
    vectorStore: {
      upsert: vi.fn(),
      search: vi.fn(() => [{ chunkId: 'c1', distance: 0.25 }]),
      delete: vi.fn(),
      deleteByDocument: vi.fn(),
    },
    resolveEmbeddingClient: vi.fn(() => ({
      dimensions: 16,
      modelName: 'stub-model',
      embed: async (texts: string[]) => texts.map(() => Array.from({ length: 16 }, () => 0)),
    })),
    resolveEmbeddingSetting: vi.fn(() => ({ embeddingModel: 'stub-model', dimensions: 16 })),
    encryptConfig: (s: string) => s,
    decryptConfig: (s: string) => s,
    resolveConnector: vi.fn(() => null),
    syncQueue: new SyncQueue({ runJob: async () => undefined }),
    pollScheduler: new PollScheduler({ db, triggerSync: () => null }),
    watchManager: new WatchManager({
      db,
      resolveConnector: () => null,
      decryptConfig: (s) => s,
      triggerSync: () => null,
    }),
    onAudit: vi.fn(),
  };
}

async function search(db: BetterSqlite3Database): Promise<RagSearchResult> {
  const captured = makeCapturedApp();
  registerRagSearchRoutes(captured.app, makeDeps(db));
  const res = makeRes();
  await captured.post('/api/rag/search')(
    { body: { query: 'who do I contact?', settingName: 's1' } } as unknown as Request,
    res.res,
  );
  expect(res.statusCode).toBe(200);
  return res.body as RagSearchResult;
}

// ---------------------------------------------------------------------------
// Tests — response-time PII masking parity with the MCP rag_search tool.
// ---------------------------------------------------------------------------

describe('POST /api/rag/search — PII masking', () => {
  const ENV = 'CALAME_RAG_PII_MASK';
  let db: BetterSqlite3Database;

  beforeEach(() => {
    delete process.env[ENV];
    db = makeDb();
    seedChunk(db);
  });

  afterEach(() => {
    delete process.env[ENV];
  });

  it('masks emails and phones by default (env unset → safe-by-default ON)', async () => {
    const result = await search(db);
    expect(result.chunks).toHaveLength(1);
    const text = result.chunks[0]!.text;
    expect(text).not.toContain('ops@example.net');
    expect(text).not.toContain('555.123.4567');
    expect(text).toContain('[EMAIL]');
    // Filenames / paths stay untouched (out of masking scope).
    expect(result.chunks[0]!.fileName).toBe('contacts.md');
  });

  it('honors CALAME_RAG_PII_MASK=off (returns raw text)', async () => {
    process.env[ENV] = 'off';
    const result = await search(db);
    expect(result.chunks[0]!.text).toBe(CHUNK_TEXT);
  });

  it('leaves the stored chunk rows verbatim (masking is response-time only)', async () => {
    await search(db);
    const stored = db.prepare(`SELECT text FROM rag_chunks WHERE id = 'c1'`).get() as {
      text: string;
    };
    expect(stored.text).toBe(CHUNK_TEXT);
  });
});
