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

describe('users routes', () => {
  let app: ReturnType<typeof createApp>;
  let state: AppState;
  let originalCwd: string;
  let tmpDir: string;
  let db: CalameDatabase;
  let cookie: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = path.join(os.tmpdir(), `calame-users-route-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    process.chdir(tmpDir);

    delete process.env.CALAME_ADMIN_PASSWORD;

    state = new AppState();
    db = new CalameDatabase(tmpDir);
    state.db = db;
    state.userManager = new UserManager(db);
    app = createApp(state);
    cookie = await setupAdminAndGetCookie(app);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('POST /api/users', () => {
    it('creates a user with multi-profile format', async () => {
      const res = await request(app)
        .post('/api/users')
        .set('Cookie', cookie)
        .send({
          name: 'Jean Dupont',
          email: 'jean@example.com',
          role: 'user',
          profiles: [
            { profileName: 'prod', accessMode: 'both' },
            { profileName: 'compta', accessMode: 'chat' },
          ],
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.user.profiles).toHaveLength(2);
      expect(res.body.user.profiles[0].profileName).toBe('prod');
      expect(res.body.user.profiles[1].profileName).toBe('compta');
      expect(res.body.plaintextToken.startsWith('fmcp_')).toBe(true);
    });

    it('supports legacy single-profile format', async () => {
      const res = await request(app)
        .post('/api/users')
        .set('Cookie', cookie)
        .send({
          name: 'Jean',
          email: 'jean@x.com',
          role: 'user',
          profileName: 'prod',
          accessMode: 'both',
        })
        .expect(200);

      expect(res.body.user.profiles).toHaveLength(1);
      expect(res.body.user.profiles[0].profileName).toBe('prod');
    });

    it('rejects missing profiles', async () => {
      await request(app)
        .post('/api/users')
        .set('Cookie', cookie)
        .send({ name: 'Jean', email: 'j@x.com', role: 'user' })
        .expect(400);
    });
  });

  describe('POST /api/users/:id/profiles', () => {
    it('adds a profile to an existing user', async () => {
      const createRes = await request(app)
        .post('/api/users')
        .set('Cookie', cookie)
        .send({
          name: 'Jean',
          email: 'jean@x.com',
          role: 'user',
          profiles: [{ profileName: 'prod', accessMode: 'both' }],
        });
      const userId = createRes.body.user.id;

      const res = await request(app)
        .post(`/api/users/${userId}/profiles`)
        .set('Cookie', cookie)
        .send({ profileName: 'compta', accessMode: 'chat' })
        .expect(200);

      expect(res.body.user.profiles).toHaveLength(2);
      expect(res.body.user.profiles[1].profileName).toBe('compta');
    });
  });

  describe('DELETE /api/users/:id/profiles/:profileName', () => {
    it('removes a profile from a user', async () => {
      const createRes = await request(app)
        .post('/api/users')
        .set('Cookie', cookie)
        .send({
          name: 'Jean',
          email: 'jean@x.com',
          role: 'user',
          profiles: [
            { profileName: 'prod', accessMode: 'both' },
            { profileName: 'compta', accessMode: 'chat' },
          ],
        });
      const userId = createRes.body.user.id;

      const res = await request(app)
        .delete(`/api/users/${userId}/profiles/prod`)
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.user.profiles).toHaveLength(1);
      expect(res.body.user.profiles[0].profileName).toBe('compta');
    });
  });

  describe('GET /api/users', () => {
    it('filters by profileName across multi-profile users', async () => {
      await request(app).post('/api/users').set('Cookie', cookie).send({
        name: 'Jean',
        email: 'jean@x.com',
        role: 'user',
        profiles: [{ profileName: 'prod', accessMode: 'both' }, { profileName: 'compta', accessMode: 'chat' }],
      });
      await request(app).post('/api/users').set('Cookie', cookie).send({
        name: 'Alice',
        email: 'alice@x.com',
        role: 'user',
        profiles: [{ profileName: 'dev', accessMode: 'both' }],
      });

      const res = await request(app)
        .get('/api/users?profileName=compta')
        .set('Cookie', cookie)
        .expect(200);
      // Admin user + Jean have access (admin has no profile, but Jean does)
      const nonAdminUsers = res.body.users.filter((u: { email: string }) => u.email !== 'admin@test.com');
      expect(nonAdminUsers).toHaveLength(1);
      expect(nonAdminUsers[0].name).toBe('Jean');
    });
  });

  describe('POST /api/users/:id/disable', () => {
    it('disables a user', async () => {
      const createRes = await request(app)
        .post('/api/users')
        .set('Cookie', cookie)
        .send({ name: 'Jean', email: 'jean@x.com', role: 'user', profiles: [{ profileName: 'prod', accessMode: 'both' }] });
      const userId = createRes.body.user.id;

      const res = await request(app)
        .post(`/api/users/${userId}/disable`)
        .set('Cookie', cookie)
        .send({ reason: 'Left company' })
        .expect(200);

      expect(res.body.user.status).toBe('disabled');
    });
  });

  describe('POST /api/users/:id/enable', () => {
    it('re-enables with new token', async () => {
      const createRes = await request(app)
        .post('/api/users')
        .set('Cookie', cookie)
        .send({ name: 'Jean', email: 'jean@x.com', role: 'user', profiles: [{ profileName: 'prod', accessMode: 'both' }] });
      const userId = createRes.body.user.id;
      await request(app).post(`/api/users/${userId}/disable`).set('Cookie', cookie).send({});

      const res = await request(app)
        .post(`/api/users/${userId}/enable`)
        .set('Cookie', cookie)
        .expect(200);
      expect(res.body.user.status).toBe('active');
      expect(res.body.plaintextToken.startsWith('fmcp_')).toBe(true);
    });
  });

  describe('multi-tenancy write scoping (M2)', () => {
    it('stamps a created user with the request tenant', async () => {
      await request(app)
        .post('/api/users')
        .set('Cookie', cookie)
        .set('X-Tenant-Id', 'tenant-x')
        .send({ name: 'X', email: 'x@x.com', role: 'user', profiles: [{ profileName: 'prod', accessMode: 'both' }] })
        .expect(200);

      expect(state.userManager!.listUsers({}, 'tenant-x').some((u) => u.email === 'x@x.com')).toBe(true);
      // Must NOT leak into the default tenant.
      expect(state.userManager!.listUsers({}, 'default').some((u) => u.email === 'x@x.com')).toBe(false);
    });

    it('import refuses to cross-tenant update an email owned by another tenant', async () => {
      await request(app)
        .post('/api/users')
        .set('Cookie', cookie)
        .set('X-Tenant-Id', 'tenant-a')
        .send({ name: 'A', email: 'shared@x.com', role: 'user', profiles: [{ profileName: 'prod', accessMode: 'both' }] })
        .expect(200);

      const res = await request(app)
        .post('/api/users/import')
        .set('Cookie', cookie)
        .set('X-Tenant-Id', 'tenant-b')
        .send({ users: [{ email: 'shared@x.com', customAttributes: { hacked: 'yes' } }] })
        .expect(200);

      expect(res.body.created).toBe(0);
      expect(res.body.updated).toBe(0);
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0].reason).toMatch(/another tenant/i);
      // The foreign-tenant user must be untouched.
      expect(state.userManager!.getUserByEmail('shared@x.com')?.customAttributes?.hacked).toBeUndefined();
    });

    it('import creates new users scoped to the request tenant', async () => {
      const res = await request(app)
        .post('/api/users/import')
        .set('Cookie', cookie)
        .set('X-Tenant-Id', 'tenant-c')
        .send({ users: [{ email: 'newimport@x.com', name: 'New' }], profileName: 'prod' })
        .expect(200);

      expect(res.body.created).toBe(1);
      expect(state.userManager!.listUsers({}, 'tenant-c').some((u) => u.email === 'newimport@x.com')).toBe(true);
      expect(state.userManager!.listUsers({}, 'default').some((u) => u.email === 'newimport@x.com')).toBe(false);
    });
  });

  describe('DELETE /api/users/:id', () => {
    it('deletes a user permanently', async () => {
      const createRes = await request(app)
        .post('/api/users')
        .set('Cookie', cookie)
        .send({ name: 'Jean', email: 'jean@x.com', role: 'user', profiles: [{ profileName: 'prod', accessMode: 'both' }] });
      const userId = createRes.body.user.id;

      await request(app).delete(`/api/users/${userId}`).set('Cookie', cookie).expect(200);
      const listRes = await request(app).get('/api/users').set('Cookie', cookie).expect(200);
      // Only admin user should remain
      expect(listRes.body.users).toHaveLength(1);
    });
  });
});
