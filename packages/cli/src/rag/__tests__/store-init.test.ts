import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import * as ragCore from '@calame-ee/rag-core';
import { readExistingDimension, initVectorStore } from '../store-init.js';

// ---------------------------------------------------------------------------
// DEFAULT_DIMENSION changed from 1536 (OpenAI) to 768 (bundled local model)
// so a fresh install works offline with zero config. The critical invariant
// this file locks in: an EXISTING install (which already has a source at
// some dimension) must NOT be affected by that default changing — only a
// truly empty rag_sources table falls back to the new default.
// ---------------------------------------------------------------------------

function makeDb(): BetterSqlite3Database {
  const db = new Database(':memory:');
  ragCore.runRagMigrations({ raw: db });
  return db;
}

function insertSourceWithDimension(db: BetterSqlite3Database, dimensions: number): void {
  db.prepare(
    `INSERT INTO rag_sources
		 (id, name, type, config_encrypted, embedding_setting_name, embedding_model_version,
		  embedding_dimensions, tenant_id, deleted_at, created_at, updated_at)
		 VALUES ('src-1', 'Test', 'local', '{}', 'test-setting', 'test-model', ?, 'default', NULL, datetime('now'), datetime('now'))`,
  ).run(dimensions);
}

describe('DEFAULT_DIMENSION', () => {
  const originalEnv = process.env['CALAME_RAG_DEFAULT_DIMENSION'];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['CALAME_RAG_DEFAULT_DIMENSION'];
    else process.env['CALAME_RAG_DEFAULT_DIMENSION'] = originalEnv;
    vi.resetModules();
  });

  it('defaults to 768 (the bundled local model) with no env override', async () => {
    delete process.env['CALAME_RAG_DEFAULT_DIMENSION'];
    vi.resetModules();
    const mod = await import('../store-init.js');
    expect(mod.DEFAULT_DIMENSION).toBe(768);
  });

  it('honors CALAME_RAG_DEFAULT_DIMENSION when set to a valid positive integer', async () => {
    process.env['CALAME_RAG_DEFAULT_DIMENSION'] = '1536';
    vi.resetModules();
    const mod = await import('../store-init.js');
    expect(mod.DEFAULT_DIMENSION).toBe(1536);
  });

  it('falls back to 768 when the env value is not a valid positive integer', async () => {
    process.env['CALAME_RAG_DEFAULT_DIMENSION'] = 'not-a-number';
    vi.resetModules();
    const mod = await import('../store-init.js');
    expect(mod.DEFAULT_DIMENSION).toBe(768);

    process.env['CALAME_RAG_DEFAULT_DIMENSION'] = '-5';
    vi.resetModules();
    const mod2 = await import('../store-init.js');
    expect(mod2.DEFAULT_DIMENSION).toBe(768);
  });
});

describe('readExistingDimension', () => {
  it('returns null when rag_sources is empty', () => {
    const db = makeDb();
    expect(readExistingDimension(db)).toBeNull();
  });

  it('returns the dimension of an existing source', () => {
    const db = makeDb();
    insertSourceWithDimension(db, 1536);
    expect(readExistingDimension(db)).toBe(1536);
  });
});

describe('initVectorStore — existing-install safety', () => {
  let db: BetterSqlite3Database;
  let logs: { info: string[]; warn: string[] };
  const log = {
    info: (msg: string) => logs.info.push(msg),
    warn: (msg: string) => logs.warn.push(msg),
  };

  beforeEach(() => {
    db = makeDb();
    logs = { info: [], warn: [] };
  });

  it('a fresh DB (no sources) initializes the vec table at 768, not 1536', () => {
    const state = { ragDisabledReason: null as string | null };
    const calameDb = { raw: db } as unknown as Parameters<typeof initVectorStore>[1];
    const result = initVectorStore(ragCore, calameDb, state, log);
    expect(result).not.toBeNull();
    expect(result!.dimension).toBe(768);
    expect(state.ragDisabledReason).toBeNull();
  });

  it('an existing install with a 1536-dim source keeps 1536 — the new 768 default never overrides it', () => {
    insertSourceWithDimension(db, 1536);
    const state = { ragDisabledReason: null as string | null };
    const calameDb = { raw: db } as unknown as Parameters<typeof initVectorStore>[1];
    const result = initVectorStore(ragCore, calameDb, state, log);
    expect(result).not.toBeNull();
    expect(result!.dimension).toBe(1536);
    expect(state.ragDisabledReason).toBeNull();
  });
});
