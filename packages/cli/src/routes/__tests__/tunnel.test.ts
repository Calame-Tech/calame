import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createApp } from '../../app.js';
import { AppState } from '../../state.js';
import { CalameDatabase } from '../../database.js';
import { TokenManager } from '../../token.js';
import { UserManager } from '../../user.js';
import { loadConfig } from '../../config.js';
import { setupAdminAndGetCookie } from './helpers.js';
import { TunnelManager, type TunnelStartResult, type TunnelStatus } from '../../tunnel/manager.js';
import type { Logger } from '../../logger.js';

function makeFakeLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
}

/**
 * Route-level tests: the child-process layer is never touched here. Instead
 * a fake `TunnelManager` (constructed with `vi.fn()` stand-ins for its own
 * public methods) is injected directly into `state.tunnelManager` before the
 * request — mirrors the claude-desktop route tests' style of seeding state
 * fields directly rather than mocking modules. `manager.test.ts` covers the
 * real TunnelManager's child-process DI in isolation.
 */
function makeFakeTunnelManager(overrides: {
  getStatus?: () => TunnelStatus;
  start?: () => Promise<TunnelStartResult>;
  stop?: () => Promise<void>;
}): TunnelManager {
  const fake = {
    getStatus:
      overrides.getStatus ??
      vi.fn(
        (): TunnelStatus => ({
          running: false,
          url: null,
          startedAt: null,
          available: true,
          unavailableReason: null,
        }),
      ),
    start:
      overrides.start ??
      vi.fn((): Promise<TunnelStartResult> => Promise.reject(new Error('not stubbed'))),
    stop: overrides.stop ?? vi.fn((): Promise<void> => Promise.resolve()),
  };
  // Cast through unknown: this is a hand-rolled test double satisfying the
  // TunnelManager's public surface (getStatus/start/stop), not a real instance.
  return fake as unknown as TunnelManager;
}

describe('tunnel routes', () => {
  let app: ReturnType<typeof createApp>;
  let state: AppState;
  let originalCwd: string;
  let tmpDir: string;
  let cookie: string;
  let db: CalameDatabase;
  let fakeLogger: Logger;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = path.join(os.tmpdir(), `calame-tunnel-test-${Date.now()}-${Math.random()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    process.chdir(tmpDir);

    state = new AppState();
    db = new CalameDatabase(tmpDir);
    state.db = db;
    state.tokenManager = new TokenManager(db);
    state.userManager = new UserManager(db);
    fakeLogger = makeFakeLogger();
    state.logger = fakeLogger;

    const config = loadConfig();
    config.port = 4567;
    config.packaged = false;
    state.config = config;

    app = createApp(state);
    cookie = await setupAdminAndGetCookie(app);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // ---------------------------------------------------------------------------
  // GET /api/tunnel/status
  // ---------------------------------------------------------------------------

  describe('GET /api/tunnel/status', () => {
    it('requires admin auth', async () => {
      await request(app).get('/api/tunnel/status').expect(401);
    });

    it('lazily creates a real TunnelManager and reports it idle/available or unavailable', async () => {
      // No fake injected here — exercises the lazy getOrCreateTunnelManager()
      // path with the real cloudflared-resolve fallback chain. Whatever it
      // resolves to on the test machine, the shape must always match the contract.
      const res = await request(app).get('/api/tunnel/status').set('Cookie', cookie).expect(200);
      expect(res.body).toMatchObject({
        success: true,
        running: false,
        url: null,
        startedAt: null,
      });
      expect(typeof res.body.available).toBe('boolean');
      if (!res.body.available) {
        expect(typeof res.body.unavailableReason).toBe('string');
      } else {
        expect(res.body.unavailableReason).toBeNull();
      }
    });

    it('reflects a fake TunnelManager injected into state', async () => {
      state.tunnelManager = makeFakeTunnelManager({
        getStatus: () => ({
          running: true,
          url: 'https://fake-tunnel.trycloudflare.com',
          startedAt: '2024-01-01T00:00:00.000Z',
          available: true,
          unavailableReason: null,
        }),
      });

      const res = await request(app).get('/api/tunnel/status').set('Cookie', cookie).expect(200);
      expect(res.body).toEqual({
        success: true,
        running: true,
        url: 'https://fake-tunnel.trycloudflare.com',
        startedAt: '2024-01-01T00:00:00.000Z',
        available: true,
        unavailableReason: null,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/tunnel/start
  // ---------------------------------------------------------------------------

  describe('POST /api/tunnel/start', () => {
    it('requires admin auth', async () => {
      await request(app).post('/api/tunnel/start').expect(401);
    });

    it('returns 200 with the URL on success', async () => {
      state.tunnelManager = makeFakeTunnelManager({
        start: vi.fn(
          async (): Promise<TunnelStartResult> => ({
            success: true,
            url: 'https://fake-tunnel.trycloudflare.com',
          }),
        ),
      });

      const res = await request(app).post('/api/tunnel/start').set('Cookie', cookie).expect(200);
      expect(res.body).toEqual({ success: true, url: 'https://fake-tunnel.trycloudflare.com' });
    });

    it('returns 502 when the manager reports a failure and cloudflared IS available (timeout/exit case)', async () => {
      state.tunnelManager = makeFakeTunnelManager({
        getStatus: () => ({
          running: false,
          url: null,
          startedAt: null,
          available: true,
          unavailableReason: null,
        }),
        start: vi.fn(
          async (): Promise<TunnelStartResult> => ({
            success: false,
            message:
              'Timed out waiting for cloudflared to report a tunnel URL after 30000ms.\nsome output',
          }),
        ),
      });

      const res = await request(app).post('/api/tunnel/start').set('Cookie', cookie).expect(502);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Timed out');
    });

    it('returns 503 when cloudflared is not available at all', async () => {
      state.tunnelManager = makeFakeTunnelManager({
        getStatus: () => ({
          running: false,
          url: null,
          startedAt: null,
          available: false,
          unavailableReason: 'cloudflared binary not found',
        }),
        start: vi.fn(
          async (): Promise<TunnelStartResult> => ({
            success: false,
            message: 'cloudflared binary not found',
          }),
        ),
      });

      const res = await request(app).post('/api/tunnel/start').set('Cookie', cookie).expect(503);
      expect(res.body).toEqual({ success: false, message: 'cloudflared binary not found' });
    });

    it("delegates to the manager on every call — idempotency itself is the manager's job (see manager.test.ts)", async () => {
      const startSpy = vi.fn(
        async (): Promise<TunnelStartResult> => ({
          success: true,
          url: 'https://already-running.trycloudflare.com',
        }),
      );
      state.tunnelManager = makeFakeTunnelManager({ start: startSpy });

      await request(app).post('/api/tunnel/start').set('Cookie', cookie).expect(200);
      const res2 = await request(app).post('/api/tunnel/start').set('Cookie', cookie).expect(200);
      expect(res2.body).toEqual({
        success: true,
        url: 'https://already-running.trycloudflare.com',
      });
      expect(startSpy).toHaveBeenCalledTimes(2);
    });

    it('never logs the token in the start success path (URL alone is logged, if anything)', async () => {
      state.tunnelManager = makeFakeTunnelManager({
        start: vi.fn(
          async (): Promise<TunnelStartResult> => ({
            success: true,
            url: 'https://safe-to-log.trycloudflare.com',
          }),
        ),
      });

      await request(app).post('/api/tunnel/start').set('Cookie', cookie).expect(200);

      const infoMock = fakeLogger.info as unknown as { mock: { calls: unknown[][] } };
      for (const call of infoMock.mock.calls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toMatch(/Bearer/i);
        expect(serialized).not.toMatch(/fmcp_/);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/tunnel/stop
  // ---------------------------------------------------------------------------

  describe('POST /api/tunnel/stop', () => {
    it('requires admin auth', async () => {
      await request(app).post('/api/tunnel/stop').expect(401);
    });

    it('returns success and delegates to the manager', async () => {
      const stopSpy = vi.fn((): Promise<void> => Promise.resolve());
      state.tunnelManager = makeFakeTunnelManager({ stop: stopSpy });

      const res = await request(app).post('/api/tunnel/stop').set('Cookie', cookie).expect(200);
      expect(res.body).toEqual({ success: true });
      expect(stopSpy).toHaveBeenCalledTimes(1);
    });

    it('is idempotent: stopping twice in a row both succeed', async () => {
      state.tunnelManager = makeFakeTunnelManager({});
      await request(app).post('/api/tunnel/stop').set('Cookie', cookie).expect(200);
      await request(app).post('/api/tunnel/stop').set('Cookie', cookie).expect(200);
    });
  });
});
