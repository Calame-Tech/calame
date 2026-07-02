import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  registerOidcSettingsRoute,
  type OidcConfigManager,
  type OidcSessionDeps,
  type OidcSettingsConfig,
} from '@calame-ee/sso';
import { AppState } from '../../state.js';

/** Stub OidcSessionDeps — the GET/POST /api/oidc-settings tests don't reach session logic. */
const STUB_DEPS: OidcSessionDeps = {
  createSession: () => 'stub-session',
  setSessionCookie: () => {},
  setUserSessionCookie: () => {},
  validateSession: () => null,
  parseCookies: () => ({}),
  verifyPassword: () => false,
  adminSessionCookieName: 'calame_session',
  getUserPasswordHash: () => null,
};

/** Build a minimal OidcConfigManager mock. */
function makeMockManager(storedConfig: OidcSettingsConfig | null = null): OidcConfigManager {
  const config = storedConfig;

  const maskedConfig =
    config === null
      ? null
      : {
          ...config,
          clientSecret:
            config.clientSecret && config.clientSecret.length > 4
              ? config.clientSecret.substring(0, 2) +
                '***' +
                config.clientSecret.substring(config.clientSecret.length - 2)
              : config.clientSecret
                ? '***'
                : '',
        };

  return {
    getConfig: vi.fn(() => config),
    getMaskedConfig: vi.fn(() => maskedConfig),
    setConfig: vi.fn(),
    isConfigured: vi.fn(() => !!(config?.enabled && config.issuerUrl && config.clientId)),
  } as unknown as OidcConfigManager;
}

const DEFAULT_CONFIG: OidcSettingsConfig = {
  enabled: true,
  issuerUrl: 'https://accounts.example.com',
  clientId: 'my-client',
  clientSecret: 'super-secret',
  redirectUri: 'https://app.example.com/callback',
  scopes: 'openid profile email',
  groupClaim: 'groups',
  groupToProfile: { admins: 'admin' },
  autoCreateUsers: true,
};

describe('oidc-settings routes', () => {
  let app: express.Express;
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    app = express();
    app.use(express.json());
    registerOidcSettingsRoute(app, state, STUB_DEPS);
  });

  // ─── GET /api/oidc-settings ────────────────────────────────────────────────

  describe('GET /api/oidc-settings', () => {
    it('returns { success: true, config: null } when manager is not initialized', async () => {
      // oidcConfigManager is null by default in AppState
      const res = await request(app).get('/api/oidc-settings');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.config).toBeNull();
    });

    it('returns masked config when manager has a config', async () => {
      state.oidcConfigManager = makeMockManager(DEFAULT_CONFIG);

      const res = await request(app).get('/api/oidc-settings');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.config).not.toBeNull();
      // clientSecret should be masked
      expect(res.body.config.clientSecret).toContain('***');
      expect(res.body.config.clientSecret).not.toBe('super-secret');
      expect(res.body.config.issuerUrl).toBe('https://accounts.example.com');
    });

    it('returns { success: true, config: null } when no config is stored', async () => {
      state.oidcConfigManager = makeMockManager(null);

      const res = await request(app).get('/api/oidc-settings');
      expect(res.status).toBe(200);
      expect(res.body.config).toBeNull();
    });
  });

  // ─── POST /api/oidc-settings ───────────────────────────────────────────────

  describe('POST /api/oidc-settings', () => {
    it('returns 500 when manager is not initialized', async () => {
      const res = await request(app).post('/api/oidc-settings').send({
        issuerUrl: 'https://accounts.example.com',
        clientId: 'my-client',
      });
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 when issuerUrl is missing', async () => {
      state.oidcConfigManager = makeMockManager(null);

      const res = await request(app).post('/api/oidc-settings').send({
        clientId: 'my-client',
      });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/issuerUrl/);
    });

    it('returns 400 when clientId is missing', async () => {
      state.oidcConfigManager = makeMockManager(null);

      const res = await request(app).post('/api/oidc-settings').send({
        issuerUrl: 'https://accounts.example.com',
      });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/clientId/);
    });

    it('returns 400 when groupToProfile is not a valid object', async () => {
      state.oidcConfigManager = makeMockManager(null);

      const res = await request(app)
        .post('/api/oidc-settings')
        .send({
          issuerUrl: 'https://accounts.example.com',
          clientId: 'my-client',
          groupToProfile: ['invalid', 'array'],
        });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/groupToProfile/);
    });

    it('saves config and returns success on valid input', async () => {
      const mgr = makeMockManager(null);
      state.oidcConfigManager = mgr;

      const res = await request(app)
        .post('/api/oidc-settings')
        .send({
          enabled: true,
          issuerUrl: 'https://accounts.example.com',
          clientId: 'my-client',
          clientSecret: 'super-secret',
          redirectUri: 'https://app.example.com/callback',
          scopes: 'openid profile email',
          groupClaim: 'groups',
          groupToProfile: { admins: 'admin' },
          autoCreateUsers: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mgr.setConfig).toHaveBeenCalledOnce();
    });

    it('defaults scopes and groupClaim when not provided', async () => {
      const mgr = makeMockManager(null);
      state.oidcConfigManager = mgr;

      await request(app).post('/api/oidc-settings').send({
        issuerUrl: 'https://accounts.example.com',
        clientId: 'my-client',
      });

      expect(mgr.setConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          scopes: 'openid profile email',
          groupClaim: 'groups',
        }),
      );
    });

    it('returns 500 when setConfig throws', async () => {
      const mgr = makeMockManager(null);
      (mgr.setConfig as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('DB write error');
      });
      state.oidcConfigManager = mgr;

      const res = await request(app).post('/api/oidc-settings').send({
        issuerUrl: 'https://accounts.example.com',
        clientId: 'my-client',
      });

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('DB write error');
    });
  });

  // ─── POST /api/oidc-settings/reveal ───────────────────────────────────────

  describe('POST /api/oidc-settings/reveal', () => {
    it('returns 400 when password is missing', async () => {
      const res = await request(app).post('/api/oidc-settings/reveal').send({});
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 401 when no session cookie is provided', async () => {
      const res = await request(app)
        .post('/api/oidc-settings/reveal')
        .send({ password: 'admin-pass' });
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });
});
