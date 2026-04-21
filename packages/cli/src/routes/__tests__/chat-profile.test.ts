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

describe('GET /api/chat-profile/:profileName', () => {
  let app: ReturnType<typeof createApp>;
  let state: AppState;
  let tmpDir: string;
  let db: CalameDatabase;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = path.join(os.tmpdir(), `calame-chat-profile-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    process.chdir(tmpDir);

    state = new AppState();
    db = new CalameDatabase(tmpDir);
    state.db = db;
    state.userManager = new UserManager(db);
    app = createApp(state);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  /** Helper: register a profile in state.serveProfiles */
  function loadProfile(profile: ServeProfile): void {
    state.serveProfiles = { ...state.serveProfiles, [profile.name]: profile };
  }

  /** Helper: mark a profile as active */
  function activateProfile(name: string): void {
    state.activeProfileNames.add(name);
  }

  it('returns 400 for an invalid profile name (contains special chars)', async () => {
    const res = await request(app).get('/api/chat-profile/bad!name').expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('Invalid profile name');
  });

  it('returns 404 when the profile does not exist', async () => {
    const res = await request(app).get('/api/chat-profile/unknown').expect(404);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('not found');
  });

  it('returns profile info for a loaded inactive profile', async () => {
    loadProfile({
      name: 'finance',
      label: 'Finance',
      selectedTables: {},
      authMode: 'calame',
    });

    const res = await request(app).get('/api/chat-profile/finance').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.profile).toMatchObject({
      name: 'finance',
      label: 'Finance',
      authMode: 'calame',
      active: false,
    });
    expect(res.body.profile.oauthProvider).toBeUndefined();
  });

  it('returns active: true when the profile is in activeProfileNames', async () => {
    loadProfile({
      name: 'analytics',
      label: 'Analytics',
      selectedTables: {},
      authMode: 'token',
    });
    activateProfile('analytics');

    const res = await request(app).get('/api/chat-profile/analytics').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.profile.active).toBe(true);
    expect(res.body.profile.authMode).toBe('token');
  });

  it('defaults authMode to "token" when the profile has none set', async () => {
    loadProfile({
      name: 'legacy',
      label: 'Legacy',
      selectedTables: {},
      // no authMode field
    });

    const res = await request(app).get('/api/chat-profile/legacy').expect(200);
    expect(res.body.profile.authMode).toBe('token');
  });

  it('returns oauthProvider for oauth-mode profiles without leaking secrets', async () => {
    loadProfile({
      name: 'secured',
      label: 'Secured',
      selectedTables: {},
      authMode: 'oauth',
      oauthConfig: {
        provider: 'github',
        clientId: 'my-client-id',
        clientSecret: 'super-secret',
      },
    });

    const res = await request(app).get('/api/chat-profile/secured').expect(200);
    expect(res.body.profile.authMode).toBe('oauth');
    expect(res.body.profile.oauthProvider).toBe('github');
    // Secrets must NOT be exposed
    expect(JSON.stringify(res.body)).not.toContain('my-client-id');
    expect(JSON.stringify(res.body)).not.toContain('super-secret');
  });

  it('does not include oauthProvider for non-oauth profiles', async () => {
    loadProfile({
      name: 'ssoProfile',
      label: 'SSO Profile',
      selectedTables: {},
      authMode: 'sso',
    });

    const res = await request(app).get('/api/chat-profile/ssoProfile').expect(200);
    expect(res.body.profile.authMode).toBe('sso');
    expect(res.body.profile.oauthProvider).toBeUndefined();
  });

  it('is accessible without any admin session cookie (public route)', async () => {
    loadProfile({
      name: 'public',
      label: 'Public',
      selectedTables: {},
      authMode: 'open',
    });

    // No cookie set — should still succeed
    const res = await request(app).get('/api/chat-profile/public').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.profile.authMode).toBe('open');
  });
});
