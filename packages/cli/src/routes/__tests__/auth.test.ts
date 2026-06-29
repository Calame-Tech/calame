import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createApp } from '../../app.js';
import { AppState } from '../../state.js';
import { UserManager } from '../../user.js';
import { CalameDatabase } from '../../database.js';
import { ADMIN, setupAdminAndGetCookie } from './helpers.js';

describe('auth routes', () => {
  let app: ReturnType<typeof createApp>;
  let state: AppState;
  let originalCwd: string;
  let tmpDir: string;
  let db: CalameDatabase;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = path.join(os.tmpdir(), `calame-auth-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    process.chdir(tmpDir);

    delete process.env.CALAME_ADMIN_PASSWORD;

    state = new AppState();
    db = new CalameDatabase(tmpDir);
    state.db = db;
    state.userManager = new UserManager(db);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    process.env = { ...originalEnv };
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('when no admin exists (first-run)', () => {
    beforeEach(() => {
      app = createApp(state);
    });

    it('GET /api/auth/status returns needsSetup: true', async () => {
      const res = await request(app).get('/api/auth/status').expect(200);
      expect(res.body.needsSetup).toBe(true);
      expect(res.body.authRequired).toBe(true);
      expect(res.body.authenticated).toBe(false);
    });

    it('POST /api/auth/login rejects (no admin to authenticate against)', async () => {
      await request(app)
        .post('/api/auth/login')
        .send({ email: 'a@b.com', password: 'whatever' })
        .expect(401);
    });

    it('POST /api/auth/setup creates admin and sets cookie', async () => {
      const res = await request(app).post('/api/auth/setup').send(ADMIN).expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.user.role).toBe('admin');
      expect(res.headers['set-cookie']).toBeDefined();
      expect(res.headers['set-cookie'][0]).toContain('calame_session');
    });

    it('POST /api/auth/setup validates input', async () => {
      await request(app)
        .post('/api/auth/setup')
        .send({ name: '', email: 'admin@test.com', password: 'testpass123' })
        .expect(400);

      await request(app)
        .post('/api/auth/setup')
        .send({ name: 'Admin', email: 'bad-email', password: 'testpass123' })
        .expect(400);

      await request(app)
        .post('/api/auth/setup')
        .send({ name: 'Admin', email: 'admin@test.com', password: 'short' })
        .expect(400);
    });
  });

  describe('when admin exists', () => {
    let cookie: string;

    beforeEach(async () => {
      app = createApp(state);
      cookie = await setupAdminAndGetCookie(app);
    });

    it('GET /api/auth/status returns authenticated: true with valid session', async () => {
      const res = await request(app).get('/api/auth/status').set('Cookie', cookie).expect(200);
      expect(res.body.authRequired).toBe(true);
      expect(res.body.authenticated).toBe(true);
      expect(res.body.user.email).toBe(ADMIN.email);
    });

    it('GET /api/auth/status returns authenticated: false without session', async () => {
      const res = await request(app).get('/api/auth/status').expect(200);
      expect(res.body.authenticated).toBe(false);
      expect(res.body.authRequired).toBe(true);
    });

    it('POST /api/auth/setup is rejected (403)', async () => {
      await request(app).post('/api/auth/setup').send(ADMIN).expect(403);
    });

    it('POST /api/auth/login accepts correct email+password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: ADMIN.email, password: ADMIN.password })
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(res.headers['set-cookie'][0]).toContain('calame_session');
    });

    it('POST /api/auth/login rejects wrong password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: ADMIN.email, password: 'wrong' })
        .expect(401);
      expect(res.body.success).toBe(false);
    });

    it('API routes are blocked without session', async () => {
      const res = await request(app).get('/api/users').expect(401);
      expect(res.body.message).toContain('Authentication required');
    });

    it('API routes work with valid session cookie', async () => {
      const res = await request(app).get('/api/users').set('Cookie', cookie).expect(200);
      expect(res.body.success).toBe(true);
    });

    it('POST /api/auth/logout destroys session', async () => {
      await request(app).post('/api/auth/logout').set('Cookie', cookie).expect(200);

      const res = await request(app).get('/api/users').set('Cookie', cookie).expect(401);
      expect(res.body.message).toContain('Session expired');
    });

    it('rate limits after 5 failed login attempts', async () => {
      for (let i = 0; i < 5; i++) {
        await request(app).post('/api/auth/login').send({ email: ADMIN.email, password: 'wrong' });
      }

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: ADMIN.email, password: 'wrong' })
        .expect(429);
      expect(res.body.message).toContain('Too many login attempts');
    });
  });

  describe('deprecation warning', () => {
    it('warns when CALAME_ADMIN_PASSWORD is set', () => {
      process.env.CALAME_ADMIN_PASSWORD = 'old-password';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      createApp(state);

      const found = warnSpy.mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0].includes('CALAME_ADMIN_PASSWORD is deprecated'),
      );
      expect(found).toBe(true);

      warnSpy.mockRestore();
      delete process.env.CALAME_ADMIN_PASSWORD;
    });
  });
});
