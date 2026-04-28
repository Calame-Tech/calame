/**
 * Tests for POST /api/chat
 *
 * These tests cover:
 * - Zod body validation (missing message, empty message, message too long)
 * - profileName selection logic (missing → fallback, explicit → validate, unknown → 404)
 * - Upstream guards (no AI config, MCP server not running, no profiles)
 *
 * createMcpChatTools and executeChatTurn are mocked so the tests do not require a
 * live database or LLM provider.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { AppState } from '../../state.js';
import { CalameDatabase } from '../../database.js';
import { UserManager } from '../../user.js';
import { registerChatRoute } from '../chat.js';
import type { ServeProfile } from '@calame/core';

// ---------------------------------------------------------------------------
// Module-level mocks — must be hoisted before any import that transitively
// uses these modules.
// ---------------------------------------------------------------------------
vi.mock('../../chat-engine.js', () => ({
  INTERNAL_CHAT_SECRET: 'test-secret',
  createMcpChatTools: vi.fn(),
  createCalcTool: vi.fn().mockReturnValue({ name: 'calc', description: '', parameters: {}, handler: vi.fn() }),
  executeChatTurn: vi.fn(),
  getDefaultSystemPrompt: vi.fn().mockReturnValue('system prompt'),
}));

vi.mock('../../session.js', () => ({
  validateSession: vi.fn(),
}));

import { createMcpChatTools, executeChatTurn } from '../../chat-engine.js';
import { validateSession } from '../../session.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an Express app with only the /api/chat route registered. */
function makeApp(state: AppState): express.Express {
  const app = express();
  app.use(express.json());
  registerChatRoute(app, state);
  return app;
}

/** Minimal ServeProfile fixture. */
function makeProfile(name: string, overrides?: Partial<ServeProfile>): ServeProfile {
  return { name, label: name, selectedTables: {}, ...overrides };
}

/**
 * Seed state with profiles. By default all provided profiles are also activated
 * (making serveMode = true). Pass an explicit activeNames list to override.
 */
function seedProfiles(
  state: AppState,
  profiles: ServeProfile[],
  activeNames?: string[],
): void {
  for (const p of profiles) {
    state.serveProfiles = { ...state.serveProfiles, [p.name]: p };
  }
  for (const n of activeNames ?? profiles.map((p) => p.name)) {
    state.activeProfileNames.add(n);
  }
}

/**
 * Cookie string to attach to requests that must pass the session guard.
 * Must match the session ID returned by the validateSession mock below.
 */
const ADMIN_SESSION_COOKIE = 'calame_session=test-admin-session';

/**
 * Set up mocks so the session + token guards succeed.
 * Callers MUST also send `.set('Cookie', ADMIN_SESSION_COOKIE)` on the request,
 * because chat.ts reads the cookie to obtain the session ID before calling
 * validateSession().
 */
function mockValidAdminSession(userManager: UserManager): void {
  vi.mocked(validateSession).mockReturnValue({
    id: 'test-admin-session',
    userId: 'admin-user-id',
    createdAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
  });
  vi.spyOn(userManager, 'getUserToken').mockReturnValue('mock-admin-token');
}

/** Mock a successful MCP tools call + chat turn. */
function mockSuccessfulChat(): void {
  vi.mocked(createMcpChatTools).mockResolvedValue({
    tools: [],
    close: vi.fn().mockResolvedValue(undefined),
  });
  vi.mocked(executeChatTurn).mockResolvedValue({
    success: true,
    response: 'Hello from AI',
    toolResults: [],
  });
}

/** Minimal AI settings mock — inject on state.aiSettingsManager. */
function mockAiConfig(state: AppState): void {
  const setting = {
    name: 'default',
    label: 'Default',
    provider: 'anthropic',
    apiKey: 'key',
    model: 'claude',
  };
  state.aiSettingsManager = {
    getConfig: vi.fn().mockReturnValue(setting),
    isConfigured: vi.fn().mockReturnValue(true),
    listSettings: vi.fn().mockReturnValue([setting]),
    getSetting: vi.fn().mockImplementation((name: string) => (name === 'default' ? setting : null)),
  } as unknown as typeof state.aiSettingsManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/chat', () => {
  let app: express.Express;
  let state: AppState;
  let db: CalameDatabase;
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    vi.clearAllMocks();

    originalCwd = process.cwd();
    tmpDir = path.join(os.tmpdir(), `calame-chat-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    process.chdir(tmpDir);

    state = new AppState();
    db = new CalameDatabase(tmpDir);
    state.db = db;
    state.userManager = new UserManager(db);
    app = makeApp(state);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // -------------------------------------------------------------------------
  // Zod body validation
  // -------------------------------------------------------------------------

  describe('request body validation', () => {
    it('returns 400 when message is missing', async () => {
      const res = await request(app).post('/api/chat').send({}).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBeDefined();
    });

    it('returns 400 when message is an empty string', async () => {
      const res = await request(app).post('/api/chat').send({ message: '' }).expect(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 when message exceeds 32 000 characters', async () => {
      const res = await request(app)
        .post('/api/chat')
        .send({ message: 'x'.repeat(32_001) })
        .expect(400);
      expect(res.body.success).toBe(false);
    });

    it('accepts a message exactly at the 32 000-char limit — stops at AI config guard', async () => {
      // Validation passes (no 400) → next guard fires (503: AI not configured)
      const res = await request(app)
        .post('/api/chat')
        .send({ message: 'x'.repeat(32_000) })
        .expect(503);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 when profileName is an empty string', async () => {
      const res = await request(app)
        .post('/api/chat')
        .send({ message: 'hello', profileName: '' })
        .expect(400);
      expect(res.body.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Upstream guards (before profileName resolution)
  // -------------------------------------------------------------------------

  describe('upstream guards', () => {
    it('returns 503 when AI config is not configured', async () => {
      // Seed profiles + active so we reach the AI resolver guard (AI is now resolved
      // after the profile, since each profile may pin its own AI setting).
      seedProfiles(state, [makeProfile('demo')]);
      // No aiSettingsManager set on state — default is null
      const res = await request(app).post('/api/chat').send({ message: 'test' }).expect(500);
      expect(res.body.message).toContain('AI settings manager not initialized');
    });

    it('returns 503 when MCP server is not running (no active profiles)', async () => {
      // AI config present, but activeProfileNames is empty → serveMode = false
      mockAiConfig(state);

      const res = await request(app).post('/api/chat').send({ message: 'test' }).expect(503);
      expect(res.body.message).toContain('MCP server is not running');
    });

    it('returns 503 when no profiles are in serveProfiles (phantom active name)', async () => {
      // serveMode = true (one active name) but serveProfiles is still empty
      mockAiConfig(state);
      state.activeProfileNames.add('__phantom__');

      const res = await request(app).post('/api/chat').send({ message: 'test' }).expect(503);
      expect(res.body.message).toContain('No profiles are being served');
    });
  });

  // -------------------------------------------------------------------------
  // profileName selection and resolution
  // -------------------------------------------------------------------------

  describe('profileName selection', () => {
    beforeEach(() => {
      mockAiConfig(state);
    });

    it('returns 404 when the requested profileName is not in activeProfileNames', async () => {
      // 'demo' is active; 'unknown-profile' does not exist at all
      seedProfiles(state, [makeProfile('demo')]);

      const res = await request(app)
        .post('/api/chat')
        .send({ message: 'test', profileName: 'unknown-profile' })
        .expect(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('unknown-profile');
    });

    it('returns 404 when profileName is in serveProfiles but not activated', async () => {
      // Register 'demo' to make serveProfiles non-empty and activate a sibling so
      // serveMode = true. Register 'inactive' in serveProfiles but do NOT activate it.
      seedProfiles(state, [makeProfile('demo')]);
      state.serveProfiles = { ...state.serveProfiles, inactive: makeProfile('inactive') };
      // 'inactive' is not in activeProfileNames

      const res = await request(app)
        .post('/api/chat')
        .send({ message: 'test', profileName: 'inactive' })
        .expect(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('inactive');
    });

    it('reaches the session guard (401) when profileName is omitted — proves fallback works', async () => {
      seedProfiles(state, [makeProfile('alpha'), makeProfile('beta')]);
      // No cookie → session guard fires with 401 (not a 404 → profile fallback succeeded)

      const res = await request(app).post('/api/chat').send({ message: 'test' }).expect(401);
      expect(res.body.message).toContain('Admin session required');
    });

    it('reaches the session guard (401) when an explicit active profileName is used', async () => {
      seedProfiles(state, [makeProfile('alpha'), makeProfile('beta')]);
      // 'beta' is valid and active → session guard fires (not 404)

      const res = await request(app)
        .post('/api/chat')
        .send({ message: 'test', profileName: 'beta' })
        .expect(401);
      expect(res.body.message).toContain('Admin session required');
    });

    it('returns 401 when cookie is absent (session guard)', async () => {
      seedProfiles(state, [makeProfile('demo')]);
      // validateSession is never called without a cookie; session is null → 401

      const res = await request(app).post('/api/chat').send({ message: 'test' }).expect(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 200 and chat result when all guards pass', async () => {
      seedProfiles(state, [makeProfile('demo')]);
      mockValidAdminSession(state.userManager!);
      mockSuccessfulChat();

      const res = await request(app)
        .post('/api/chat')
        .set('Cookie', ADMIN_SESSION_COOKIE)
        .send({ message: 'hello', profileName: 'demo' })
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.response).toBe('Hello from AI');
    });

    it('builds the MCP URL using the explicit profileName', async () => {
      seedProfiles(state, [makeProfile('alpha'), makeProfile('beta')]);
      mockValidAdminSession(state.userManager!);
      mockSuccessfulChat();

      await request(app)
        .post('/api/chat')
        .set('Cookie', ADMIN_SESSION_COOKIE)
        .send({ message: 'query beta', profileName: 'beta' })
        .expect(200);

      expect(vi.mocked(createMcpChatTools)).toHaveBeenCalledWith(
        expect.stringContaining('/mcp/beta'),
        expect.any(String),
      );
    });

    it('falls back to the first profile when profileName is absent', async () => {
      seedProfiles(state, [makeProfile('first'), makeProfile('second')]);
      mockValidAdminSession(state.userManager!);
      mockSuccessfulChat();

      await request(app)
        .post('/api/chat')
        .set('Cookie', ADMIN_SESSION_COOKIE)
        .send({ message: 'hello' })
        .expect(200);

      expect(vi.mocked(createMcpChatTools)).toHaveBeenCalledWith(
        expect.stringContaining('/mcp/first'),
        expect.any(String),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    beforeEach(() => {
      mockAiConfig(state);
      seedProfiles(state, [makeProfile('demo')]);
      mockValidAdminSession(state.userManager!);
    });

    it('returns 500 when createMcpChatTools throws', async () => {
      vi.mocked(createMcpChatTools).mockRejectedValue(new Error('MCP connection failed'));

      const res = await request(app)
        .post('/api/chat')
        .set('Cookie', ADMIN_SESSION_COOKIE)
        .send({ message: 'test' })
        .expect(500);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('MCP connection failed');
    });

    it('returns 500 when executeChatTurn throws', async () => {
      vi.mocked(createMcpChatTools).mockResolvedValue({
        tools: [],
        close: vi.fn().mockResolvedValue(undefined),
      });
      vi.mocked(executeChatTurn).mockRejectedValue(new Error('LLM timeout'));

      const res = await request(app)
        .post('/api/chat')
        .set('Cookie', ADMIN_SESSION_COOKIE)
        .send({ message: 'test' })
        .expect(500);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('LLM timeout');
    });

    it('calls close() even when executeChatTurn throws (finally block)', async () => {
      const closeMock = vi.fn().mockResolvedValue(undefined);
      vi.mocked(createMcpChatTools).mockResolvedValue({
        tools: [],
        close: closeMock,
      });
      vi.mocked(executeChatTurn).mockRejectedValue(new Error('crash'));

      await request(app)
        .post('/api/chat')
        .set('Cookie', ADMIN_SESSION_COOKIE)
        .send({ message: 'test' });

      expect(closeMock).toHaveBeenCalledOnce();
    });
  });
});
