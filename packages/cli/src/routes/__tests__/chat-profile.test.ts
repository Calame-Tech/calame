import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createApp } from '../../app.js';
import { AppState } from '../../state.js';
import { CalameDatabase } from '../../database.js';
import { UserManager } from '../../user.js';
import { AiSettingsManager } from '../../ai-config.js';
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
      // no authMode field
    });

    const res = await request(app).get('/api/chat-profile/legacy').expect(200);
    expect(res.body.profile.authMode).toBe('token');
  });

  it('returns oauthProvider for oauth-mode profiles without leaking secrets', async () => {
    loadProfile({
      name: 'secured',
      label: 'Secured',
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
      authMode: 'open',
    });

    // No cookie set — should still succeed
    const res = await request(app).get('/api/chat-profile/public').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.profile.authMode).toBe('open');
  });

  // ---------------------------------------------------------------------------
  // `aiSettings` must never surface the embeddings-only built-in `local`
  // setting: ChatPanel/ChatEntryPage/UserChatPanel all pre-select
  // `aiSettings[0]` and send it as an explicit `aiSettingName`, which the
  // backend then rejects ("does not support chat" / "is not allowed for this
  // MCP") — since `local` is seeded first on every install, the unfiltered
  // version of this endpoint made that failure the common case, not an edge
  // case. See ai-resolver.ts's `isChatCapable`.
  // ---------------------------------------------------------------------------
  describe('aiSettings (chat-capable filtering)', () => {
    function createChatSetting(name: string): void {
      state.aiSettingsManager!.createSetting({
        name,
        label: name,
        provider: 'anthropic',
        apiKey: 'sk-test',
        capabilities: ['chat'],
      });
    }

    beforeEach(() => {
      state.aiSettingsManager = new AiSettingsManager(db);
    });

    it('omits aiSettings entirely when only the built-in "local" setting exists (no explicit list)', async () => {
      loadProfile({ name: 'noAi', label: 'No AI', authMode: 'open' });

      const res = await request(app).get('/api/chat-profile/noAi').expect(200);
      expect(res.body.profile.aiSettings).toBeUndefined();
    });

    it('the fallback (no explicit aiSettingNames) skips "local" and picks a chat-capable setting', async () => {
      createChatSetting('my-chat-setting');
      loadProfile({ name: 'fallbackProfile', label: 'Fallback', authMode: 'open' });

      const res = await request(app).get('/api/chat-profile/fallbackProfile').expect(200);
      expect(res.body.profile.aiSettings).toEqual([
        { name: 'my-chat-setting', label: 'my-chat-setting' },
      ]);
    });

    it('an explicit aiSettingNames list filters out "local" even if present alongside a real chat setting', async () => {
      createChatSetting('qwen27b');
      loadProfile({
        name: 'mixedProfile',
        label: 'Mixed',
        authMode: 'open',
        aiSettingNames: ['local', 'qwen27b'],
      });

      const res = await request(app).get('/api/chat-profile/mixedProfile').expect(200);
      expect(res.body.profile.aiSettings).toEqual([{ name: 'qwen27b', label: 'qwen27b' }]);
    });

    it('an explicit aiSettingNames list of only "local" resolves to no aiSettings (not a crash)', async () => {
      loadProfile({
        name: 'localOnlyProfile',
        label: 'Local only',
        authMode: 'open',
        aiSettingNames: ['local'],
      });

      const res = await request(app).get('/api/chat-profile/localOnlyProfile').expect(200);
      expect(res.body.profile.aiSettings).toBeUndefined();
    });
  });
});
