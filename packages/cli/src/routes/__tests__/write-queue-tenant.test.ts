/**
 * Write-queue tenancy + target-connection execution (migration v15).
 *
 * Regressions covered:
 *  - entries used to carry no tenant → any admin could list/approve every
 *    tenant's pending writes;
 *  - approval executed via a hardcoded pg client against the LAST cached
 *    connection → sqlite/mysql writes failed and multi-connection setups
 *    could execute against the wrong database.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { createApp } from '../../app.js';
import { AppState } from '../../state.js';
import { CalameDatabase } from '../../database.js';
import { UserManager } from '../../user.js';
import { WriteQueue } from '../../write-queue.js';
import { setupAdminAndGetCookie } from './helpers.js';

describe('write-queue routes — tenant scoping + target-connection execution', () => {
  let app: ReturnType<typeof createApp>;
  let state: AppState;
  let db: CalameDatabase;
  let originalCwd: string;
  let tmpDir: string;
  let cookie: string;
  let targetDbPath: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = path.join(os.tmpdir(), `calame-wq-tenant-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    process.chdir(tmpDir);

    state = new AppState();
    db = new CalameDatabase(tmpDir);
    state.db = db;
    state.userManager = new UserManager(db);
    state.writeQueue = new WriteQueue(db);
    app = createApp(state);
    cookie = await setupAdminAndGetCookie(app);

    // A real sqlite TARGET database the approved write must land in.
    targetDbPath = path.join(tmpDir, 'target.db');
    const target = new Database(targetDbPath);
    target.exec(
      `CREATE TABLE colis (id INTEGER PRIMARY KEY, reference TEXT NOT NULL, fragile INTEGER)`,
    );
    target.close();
    state.connections.set('demo', {
      connection: {
        name: 'demo',
        label: 'Demo',
        databaseType: 'sqlite',
        connectionString: targetDbPath,
      },
      schema: { tables: [], relations: [] },
      piiDetections: null,
    });
  });

  afterEach(async () => {
    state.db?.close();
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  function queueWrite(tenantId: string, connectionName?: string): string {
    return state.writeQueue!.addRequest({
      profileName: 'p1',
      // The boolean param is deliberate: pg/mysql bind booleans natively but
      // better-sqlite3 rejects them — the executor must coerce to 0/1.
      sql: 'INSERT INTO colis (reference, fragile) VALUES (?, ?)',
      params: ['COL-123', false],
      tableName: 'colis',
      operation: 'insert',
      description: 'test insert',
      tenantId,
      connectionName,
      databaseType: connectionName ? 'sqlite' : undefined,
    });
  }

  it('lists and counts only the caller tenant entries', async () => {
    queueWrite('default');
    queueWrite('acme');

    const list = await request(app).get('/api/write-queue').set('Cookie', cookie).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.entries[0].tenantId).toBe('default');

    const count = await request(app)
      .get('/api/write-queue/count')
      .set('Cookie', cookie)
      .expect(200);
    expect(count.body.pending).toBe(1);
  });

  it('returns 404 (not 403) when approving another tenant entry — existence not leaked', async () => {
    const otherId = queueWrite('acme');
    await request(app)
      .post(`/api/write-queue/${otherId}/approve`)
      .set('Cookie', cookie)
      .expect(404);
    // Still pending, untouched.
    expect(state.writeQueue!.getById(otherId)?.status).toBe('pending');
  });

  it('rejecting another tenant entry is also a 404', async () => {
    const otherId = queueWrite('acme');
    await request(app).post(`/api/write-queue/${otherId}/reject`).set('Cookie', cookie).expect(404);
    expect(state.writeQueue!.getById(otherId)?.status).toBe('pending');
  });

  it('approval executes on the entry TARGET connection with the sqlite driver', async () => {
    // Two live connections, with a poisoned one FIRST: the legacy behavior
    // (and the cachedConnectionString shim, which aliases the first map
    // entry) would execute against 'wrong-first' and fail. Resolution by the
    // entry's connectionName must pick 'demo' regardless of map order.
    const demo = state.connections.get('demo')!;
    state.connections.clear();
    state.connections.set('wrong-first', {
      connection: {
        name: 'wrong-first',
        label: 'Wrong',
        databaseType: 'postgresql',
        connectionString: 'postgresql://nowhere:5432/wrong',
      },
      schema: { tables: [], relations: [] },
      piiDetections: null,
    });
    state.connections.set('demo', demo);

    const id = queueWrite('default', 'demo');
    const res = await request(app)
      .post(`/api/write-queue/${id}/approve`)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.entry.status).toBe('approved');
    expect(res.body.entry.executionError).toBeUndefined();

    const target = new Database(targetDbPath, { readonly: true });
    const row = target.prepare('SELECT reference, fragile FROM colis').get() as
      | { reference: string; fragile: number }
      | undefined;
    target.close();
    expect(row?.reference).toBe('COL-123');
    expect(row?.fragile).toBe(0);
  });

  it('approving an entry whose target connection is gone fails without executing', async () => {
    const id = queueWrite('default', 'vanished');
    const res = await request(app)
      .post(`/api/write-queue/${id}/approve`)
      .set('Cookie', cookie)
      .expect(500);
    expect(res.body.message).toContain('vanished');
    expect(state.writeQueue!.getById(id)?.status).toBe('pending');
  });
});
