// "Forgotten admin account" help on the login page. The server only exposes
// read-only facts (desktop or not, and the unexpanded default data folder of
// the packaged app); there must be no HTTP route able to reset the admin
// account or the data folder, from localhost or anywhere else, and a failed
// sign-in must leave the data untouched.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createApp } from '../../app.js';
import { AppState } from '../../state.js';
import { UserManager } from '../../user.js';
import { CalameDatabase } from '../../database.js';
import { getPackagedDataDir, getPackagedDataDirLabel, loadConfig } from '../../config.js';
import { ADMIN, setupAdminAndGetCookie } from './helpers.js';

describe('GET /api/auth/recovery-help', () => {
  let state: AppState;
  let tmpDir: string;
  let db: CalameDatabase;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `calame-recovery-help-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    delete process.env.CALAME_ADMIN_PASSWORD;
    delete process.env.CALAME_DATA_DIR;
    delete process.env.CALAME_PACKAGED;
    state = new AppState();
    db = new CalameDatabase(tmpDir);
    state.db = db;
    state.userManager = new UserManager(db);
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('packaged desktop with its default folder: gives the unexpanded folder, no username', async () => {
    process.env.CALAME_PACKAGED = '1';
    state.config = loadConfig();
    expect(state.config.dataDir).toBe(getPackagedDataDir());
    const app = createApp(state);
    await setupAdminAndGetCookie(app);

    const res = await request(app).get('/api/auth/recovery-help').expect(200);

    expect(res.body).toEqual({
      success: true,
      desktop: true,
      dataDirLabel: getPackagedDataDirLabel(),
    });
    expect(res.body.dataDirLabel).not.toContain(os.homedir());
    expect(res.body.dataDirLabel).not.toContain(os.userInfo().username);
  });

  it('packaged desktop with CALAME_DATA_DIR: no folder given (only the variable is named)', async () => {
    process.env.CALAME_PACKAGED = '1';
    process.env.CALAME_DATA_DIR = tmpDir;
    state.config = loadConfig();
    const app = createApp(state);

    const res = await request(app).get('/api/auth/recovery-help').expect(200);

    expect(res.body).toEqual({ success: true, desktop: true, dataDirLabel: null });
  });

  it('server / dev (not packaged): generic help, no folder', async () => {
    state.config = loadConfig();
    const app = createApp(state);

    const res = await request(app).get('/api/auth/recovery-help').expect(200);

    expect(res.body).toEqual({ success: true, desktop: false, dataDirLabel: null });
  });

  it('is unauthenticated and read-only: the admin account survives it', async () => {
    const app = createApp(state);
    await setupAdminAndGetCookie(app);

    await request(app).get('/api/auth/recovery-help').expect(200);

    expect(state.userManager!.hasAdminUser()).toBe(true);
    await request(app)
      .post('/api/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password })
      .expect(200);
  });

  it('failed sign-ins do not modify the admin account', async () => {
    const app = createApp(state);
    await setupAdminAndGetCookie(app);
    const before = state.userManager!.getUserByEmail(ADMIN.email);

    for (let i = 0; i < 3; i++) {
      await request(app).post('/api/auth/login').send({ email: ADMIN.email, password: 'wrong' });
    }

    expect(state.userManager!.hasAdminUser()).toBe(true);
    expect(state.userManager!.getUserByEmail(ADMIN.email)).toEqual(before);
  });
});

describe('no HTTP reset surface', () => {
  it('registers no route that resets or recovers the admin account or data', () => {
    const app = createApp(new AppState());
    // Express 4 keeps registered routes on the internal router stack.
    const router = (app as unknown as { _router: { stack: Array<{ route?: unknown }> } })._router;
    const routes = router.stack
      .map((layer) => layer.route as { path: string; methods: Record<string, boolean> } | undefined)
      .filter((r): r is { path: string; methods: Record<string, boolean> } => !!r)
      .flatMap((r) => Object.keys(r.methods).map((m) => ({ method: m, path: String(r.path) })));

    expect(routes.length).toBeGreaterThan(0);
    expect(routes).toContainEqual({ method: 'get', path: '/api/auth/recovery-help' });
    const resetLike = routes.filter(
      (r) =>
        /reset|recover|wipe|factory|forgot/i.test(r.path) &&
        !(r.method === 'get' && r.path === '/api/auth/recovery-help'),
    );
    expect(resetLike).toEqual([]);
  });

  it.each(['post', 'put', 'delete', 'patch'] as const)(
    '%s /api/auth/recovery-help is not a mutation endpoint',
    async (method) => {
      const app = createApp(new AppState());
      const res = await request(app)[method]('/api/auth/recovery-help').set('Host', 'localhost');
      expect(res.status).not.toBe(200);
    },
  );
});
