import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createApp } from '../../app.js';
import { AppState } from '../../state.js';
import { UserManager } from '../../user.js';
import { CalameDatabase } from '../../database.js';
import { setupAdminAndGetCookie } from './helpers.js';

describe('PATCH /api/profiles/:name/document-write', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;
  let db: CalameDatabase;
  let cookie: string;

  const insertSource = (
    id: string,
    type: string,
    tenant = 'default',
    deletedAt: string | null = null,
  ) =>
    db.raw
      .prepare(
        `INSERT INTO rag_sources (id, type, name, config_encrypted, tenant_id, deleted_at) VALUES (?, ?, ?, 'x', ?, ?)`,
      )
      .run(id, type, `name-${id}`, tenant, deletedAt);

  const readProfile = (name: string) => {
    const row = db.raw.prepare("SELECT data FROM profiles WHERE key = 'main'").get() as {
      data: string;
    };
    return (JSON.parse(row.data) as { profiles: Record<string, Record<string, unknown>> }).profiles[
      name
    ];
  };

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `calame-patch-docwrite-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    const state = new AppState();
    db = new CalameDatabase(tmpDir);
    state.db = db;
    state.userManager = new UserManager(db);
    app = createApp(state);
    cookie = await setupAdminAndGetCookie(app);
    db.raw.exec(
      `CREATE TABLE IF NOT EXISTS rag_sources (id TEXT PRIMARY KEY, type TEXT, name TEXT, config_encrypted TEXT, tenant_id TEXT, deleted_at TEXT)`,
    );
    db.raw
      .prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)")
      .run(JSON.stringify({ profiles: { dev: { label: 'Dev', selectedTables: {} } } }));
    insertSource('loc', 'local');
    insertSource('s3', 's3');
    insertSource('foreign', 'local', 'tenant-b');
    insertSource('gone', 'local', 'default', '2026-01-01');
  });

  afterEach(async () => {
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  const patch = (body: object, name = 'dev') =>
    request(app).patch(`/api/profiles/${name}/document-write`).set('Cookie', cookie).send(body);

  it('is not enabled on a fresh profile', () => {
    expect(readProfile('dev').documentWrite).toBeUndefined();
  });

  it('persists enabled + a local source', async () => {
    const res = await patch({ enabled: true, sources: { loc: { folder: 'notes/nationex' } } });
    expect(res.status).toBe(200);
    expect(readProfile('dev').documentWrite).toEqual({
      enabled: true,
      sources: { loc: { folder: 'notes/nationex' } },
    });
  });

  it('rejects non-local, foreign-tenant, soft-deleted and unknown sources', async () => {
    for (const id of ['s3', 'foreign', 'gone', 'nope']) {
      const res = await patch({ enabled: true, sources: { [id]: {} } });
      expect(res.status, id).toBe(400);
    }
    expect(readProfile('dev').documentWrite).toBeUndefined();
  });

  it('rejects unsafe folder values', async () => {
    for (const folder of ['/etc', '../x', 'a/../b', 'a\\b', 'a//b', 'a\u0000b']) {
      const res = await patch({ enabled: true, sources: { loc: { folder } } });
      expect(res.status, JSON.stringify(folder)).toBe(400);
    }
  });

  it('404 on unknown profile, 400 on bad body', async () => {
    expect((await patch({ enabled: true, sources: {} }, 'ghost')).status).toBe(404);
    expect((await patch({ sources: {} })).status).toBe(400);
  });

  it('can be disabled again', async () => {
    await patch({ enabled: true, sources: { loc: {} } });
    await patch({ enabled: false, sources: {} });
    expect(readProfile('dev').documentWrite).toEqual({ enabled: false, sources: {} });
  });
});
