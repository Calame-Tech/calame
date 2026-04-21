import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createApp } from '../../app.js';
import { AppState } from '../../state.js';
import { CalameDatabase } from '../../database.js';
import { TokenManager } from '../../token.js';
import { UserManager } from '../../user.js';
import { setupAdminAndGetCookie, ADMIN } from './helpers.js';

describe('tokens routes', () => {
  let app: ReturnType<typeof createApp>;
  let state: AppState;
  let originalCwd: string;
  let tmpDir: string;
  let cookie: string;
  let db: CalameDatabase;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = path.join(os.tmpdir(), `calame-tokens-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    process.chdir(tmpDir);

    state = new AppState();
    db = new CalameDatabase(tmpDir);
    state.db = db;
    state.tokenManager = new TokenManager(db);
    state.userManager = new UserManager(db);
    app = createApp(state);
    cookie = await setupAdminAndGetCookie(app);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('POST /api/tokens/generate', () => {
    it('creates a token', async () => {
      const res = await request(app)
        .post('/api/tokens/generate')
        .set('Cookie', cookie)
        .send({ profileName: 'prod', label: 'CI Token' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeDefined();
      expect(res.body.token.plaintextToken.startsWith('fmcp_')).toBe(true);
      expect(res.body.token.profileName).toBe('prod');
      expect(res.body.token.label).toBe('CI Token');
    });

    it('requires profileName', async () => {
      const res = await request(app)
        .post('/api/tokens/generate')
        .set('Cookie', cookie)
        .send({ label: 'No Profile' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('profileName');
    });

    it('requires label', async () => {
      const res = await request(app)
        .post('/api/tokens/generate')
        .set('Cookie', cookie)
        .send({ profileName: 'prod' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('label');
    });
  });

  describe('GET /api/tokens', () => {
    it('returns masked tokens', async () => {
      await request(app)
        .post('/api/tokens/generate')
        .set('Cookie', cookie)
        .send({ profileName: 'prod', label: 'Test' });

      const res = await request(app)
        .get('/api/tokens')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.tokens).toHaveLength(1);
      expect(res.body.tokens[0].tokenHash).toContain('...');
    });
  });

  describe('DELETE /api/tokens/:id', () => {
    it('revokes a token by id', async () => {
      const genRes = await request(app)
        .post('/api/tokens/generate')
        .set('Cookie', cookie)
        .send({ profileName: 'prod', label: 'To Revoke' });

      const tokenId = genRes.body.token.id;

      const res = await request(app)
        .delete(`/api/tokens/${tokenId}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.success).toBe(true);

      const listRes = await request(app).get('/api/tokens').set('Cookie', cookie).expect(200);
      expect(listRes.body.tokens).toHaveLength(0);
    });

    it('returns error for non-existent id', async () => {
      const res = await request(app)
        .delete('/api/tokens/nonexistent_id')
        .set('Cookie', cookie)
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('not found');
    });
  });

  describe('POST /api/tokens/:id/reveal', () => {
    it('returns 400 when password is missing', async () => {
      const res = await request(app)
        .post('/api/tokens/some-id/reveal')
        .set('Cookie', cookie)
        .send({})
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Admin password');
    });

    it('returns 401 when not authenticated', async () => {
      const res = await request(app)
        .post('/api/tokens/some-id/reveal')
        .send({ password: 'whatever' })
        .expect(401);

      expect(res.body.success).toBe(false);
    });

    it('returns 403 when password is incorrect', async () => {
      const genRes = await request(app)
        .post('/api/tokens/generate')
        .set('Cookie', cookie)
        .send({ profileName: 'prod', label: 'Secret Token' })
        .expect(200);

      const tokenId = genRes.body.token.id;

      const res = await request(app)
        .post(`/api/tokens/${tokenId}/reveal`)
        .set('Cookie', cookie)
        .send({ password: 'wrongpassword' })
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Incorrect password');
    });

    it('returns 404 when token has no encrypted copy (no secret key set)', async () => {
      // Ensure CALAME_SECRET_KEY is not set so token is stored without encryption
      const originalKey = process.env.CALAME_SECRET_KEY;
      delete process.env.CALAME_SECRET_KEY;

      const genRes = await request(app)
        .post('/api/tokens/generate')
        .set('Cookie', cookie)
        .send({ profileName: 'prod', label: 'Unencrypted Token' })
        .expect(200);

      const tokenId = genRes.body.token.id;

      // Restore env before calling reveal (reveal needs no key to be absent too, giving 404)
      process.env.CALAME_SECRET_KEY = originalKey;

      const res = await request(app)
        .post(`/api/tokens/${tokenId}/reveal`)
        .set('Cookie', cookie)
        .send({ password: ADMIN.password })
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('created before encryption');

      if (originalKey === undefined) delete process.env.CALAME_SECRET_KEY;
    });

    it('reveals the plaintext token when secret key is set and password is correct', async () => {
      const secretKey = 'test-secret-key-for-reveal';
      const originalKey = process.env.CALAME_SECRET_KEY;
      process.env.CALAME_SECRET_KEY = secretKey;

      try {
        const genRes = await request(app)
          .post('/api/tokens/generate')
          .set('Cookie', cookie)
          .send({ profileName: 'prod', label: 'Encrypted Token' })
          .expect(200);

        const tokenId = genRes.body.token.id;
        const originalPlaintext = genRes.body.token.plaintextToken;

        const revealRes = await request(app)
          .post(`/api/tokens/${tokenId}/reveal`)
          .set('Cookie', cookie)
          .send({ password: ADMIN.password })
          .expect(200);

        expect(revealRes.body.success).toBe(true);
        expect(revealRes.body.token).toBe(originalPlaintext);
        expect(revealRes.body.token.startsWith('fmcp_')).toBe(true);
      } finally {
        if (originalKey === undefined) {
          delete process.env.CALAME_SECRET_KEY;
        } else {
          process.env.CALAME_SECRET_KEY = originalKey;
        }
      }
    });

    it('returns 404 for a non-existent token id', async () => {
      const secretKey = 'test-secret-key-for-reveal';
      const originalKey = process.env.CALAME_SECRET_KEY;
      process.env.CALAME_SECRET_KEY = secretKey;

      try {
        const res = await request(app)
          .post('/api/tokens/nonexistent-token-id/reveal')
          .set('Cookie', cookie)
          .send({ password: ADMIN.password })
          .expect(404);

        expect(res.body.success).toBe(false);
      } finally {
        if (originalKey === undefined) {
          delete process.env.CALAME_SECRET_KEY;
        } else {
          process.env.CALAME_SECRET_KEY = originalKey;
        }
      }
    });
  });
});
