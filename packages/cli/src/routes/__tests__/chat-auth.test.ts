import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createApp } from '../../app.js';
import { AppState } from '../../state.js';
import { CalameDatabase } from '../../database.js';
import { UserManager } from '../../user.js';
import type { ServeProfile } from '@calame/core';

describe('POST /api/chat-auth/token', () => {
  let app: ReturnType<typeof createApp>;
  let state: AppState;
  let tmpDir: string;
  let db: CalameDatabase;
  let originalCwd: string;
  let plaintextToken: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = path.join(os.tmpdir(), `calame-chat-auth-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    process.chdir(tmpDir);

    state = new AppState();
    db = new CalameDatabase(tmpDir);
    state.db = db;
    state.userManager = new UserManager(db);

    // Create a test user with access to a 'data' profile
    const result = state.userManager.createUser({
      name: 'Test User',
      email: 'user@test.com',
      role: 'user',
      profiles: [
        {
          profileName: 'data',
          allowedTables: null,
          allowedTools: null,
          accessMode: 'both',
        },
      ],
    });
    // Activate the user (skip onboarding)
    state.userManager.consumeOnboardingCode(result.onboardingCode!);
    plaintextToken = result._plaintextToken;

    // Register a token-mode serve profile in state
    const tokenProfile: ServeProfile = {
      name: 'data',
      label: 'Data',
      authMode: 'token',
    };
    state.serveProfiles = { data: tokenProfile };

    app = createApp(state);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns 400 when token is missing', async () => {
    const res = await request(app)
      .post('/api/chat-auth/token')
      .send({ profileName: 'data' })
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when profileName is missing', async () => {
    const res = await request(app)
      .post('/api/chat-auth/token')
      .send({ token: plaintextToken })
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for an invalid profile name (special chars)', async () => {
    const res = await request(app)
      .post('/api/chat-auth/token')
      .send({ token: plaintextToken, profileName: 'bad name!' })
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('Invalid profile name');
  });

  it('returns 403 when profile authMode is "open"', async () => {
    state.serveProfiles = {
      data: { name: 'data', label: 'Data', authMode: 'open' },
    };

    const res = await request(app)
      .post('/api/chat-auth/token')
      .send({ token: plaintextToken, profileName: 'data' })
      .expect(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('open');
  });

  it('accepts token when profile authMode is "calame"', async () => {
    state.serveProfiles = {
      data: { name: 'data', label: 'Data', authMode: 'calame' },
    };

    const res = await request(app)
      .post('/api/chat-auth/token')
      .send({ token: plaintextToken, profileName: 'data' })
      .expect(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 401 for an invalid token', async () => {
    const res = await request(app)
      .post('/api/chat-auth/token')
      .send({ token: 'fmcp_invalidtoken', profileName: 'data' })
      .expect(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('Invalid token');
  });

  it('returns 403 when user has no access to the requested profile', async () => {
    const res = await request(app)
      .post('/api/chat-auth/token')
      .send({ token: plaintextToken, profileName: 'other-profile' })
      .expect(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('do not have access');
  });

  it('returns 403 when user has mcp-only access to the profile', async () => {
    // Update user profile to mcp-only access
    const users = state.userManager!.listUsers();
    const user = users[0];
    state.userManager!.updateUser(user.id, {
      profiles: [
        {
          profileName: 'data',
          allowedTables: null,
          allowedTools: null,
          accessMode: 'mcp',
        },
      ],
    });

    const res = await request(app)
      .post('/api/chat-auth/token')
      .send({ token: plaintextToken, profileName: 'data' })
      .expect(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('Chat access is not enabled');
  });

  it('returns 200, sets user session cookie, and returns user info on valid token', async () => {
    const res = await request(app)
      .post('/api/chat-auth/token')
      .send({ token: plaintextToken, profileName: 'data' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe('user@test.com');
    expect(res.body.user.role).toBe('user');

    // A user session cookie should be set
    const rawCookies: unknown = res.headers['set-cookie'];
    const cookies: string[] = Array.isArray(rawCookies) ? rawCookies : [];
    expect(cookies.length).toBeGreaterThan(0);
    const userCookie = cookies.find((c) => c.startsWith('calame_user_session'));
    expect(userCookie).toBeDefined();
  });

  it('is accessible without admin session (public route)', async () => {
    // No Cookie header at all — should still reach the handler
    const res = await request(app)
      .post('/api/chat-auth/token')
      .send({ token: 'fmcp_invalid', profileName: 'data' })
      .expect(401); // 401 because token is invalid, not because route is guarded

    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Invalid token.');
  });
});
