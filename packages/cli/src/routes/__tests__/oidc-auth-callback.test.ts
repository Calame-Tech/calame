/**
 * Tests for the OIDC callback profile sync logic in /api/auth/oidc/callback.
 *
 * The OidcProvider is injected as a mock via the `providerFactory` option
 * exposed by @calame-ee/sso, so no real network calls are made.
 *
 * Three user paths are exercised:
 *   1. Brand-new user (no existing account) — additive grant + ssoAutoGrant
 *   2. Existing user found by OIDC subject — destructive IdP-scope sync
 *   3. Existing user found by email (not yet linked) — subject linking + destructive sync
 *
 * IdP scope = values of groupToProfile. Profiles in scope are fully managed by
 * the IdP: added when the JWT grants them, removed when it does not.
 * Profiles outside scope are admin-controlled and never touched by SSO.
 * ssoAutoGrant (redirect to /chat/<X> with authMode=sso) applies to NEW users only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import express from 'express';
import type { ServeProfile } from '@calame/core';
import {
  registerOidcAuthRoutes,
  type OidcSessionDeps,
  type OidcAuthRouteOptions,
} from '@calame-ee/sso';

import { AppState } from '../../state.js';
import { CalameDatabase } from '../../database.js';
import { UserManager } from '../../user.js';
import {
  createSession,
  setSessionCookie,
  setUserSessionCookie,
  validateSession,
} from '../../session.js';
import { parseCookies } from '../../utils/cookies.js';
import { verifyPassword } from '../../crypto.js';

interface MockProvider {
  generateCodeVerifier: ReturnType<typeof vi.fn>;
  getAuthorizationUrl: ReturnType<typeof vi.fn>;
  exchangeCode: ReturnType<typeof vi.fn>;
  verifyIdToken: ReturnType<typeof vi.fn>;
  getGroups: ReturnType<typeof vi.fn>;
  mapGroupsToProfiles: ReturnType<typeof vi.fn>;
  getGroupToProfile: ReturnType<typeof vi.fn>;
  extractCustomAttributes: ReturnType<typeof vi.fn>;
}

let mockProvider: MockProvider;
function getMockProvider(): MockProvider {
  return mockProvider;
}

/** Build a fresh mock provider with sane defaults. */
function makeMockProvider(): MockProvider {
  return {
    generateCodeVerifier: vi.fn(() => 'test-verifier'),
    // Include the state param in the redirect URL so initiateLogin can extract it.
    getAuthorizationUrl: vi.fn(
      async (stateParam: string) =>
        `https://idp.example.com/auth?state=${stateParam}&response_type=code`,
    ),
    exchangeCode: vi.fn(async () => ({
      idToken: 'mock-id-token',
      accessToken: 'mock-access-token',
    })),
    verifyIdToken: vi.fn(async () => ({
      sub: 'oidc-subject-123',
      email: 'sso-user@example.com',
      name: 'SSO User',
      iss: 'https://idp.example.com',
      aud: 'test-client',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })),
    getGroups: vi.fn(() => [] as string[]),
    mapGroupsToProfiles: vi.fn(() => [] as string[]),
    getGroupToProfile: vi.fn(() => ({}) as Record<string, string>),
    extractCustomAttributes: vi.fn(() => null as Record<string, string> | null),
  };
}

/** Minimal config that makes buildOidcProvider hit the env-var branch and call our factory. */
function makeOidcConfig() {
  return {
    oidcEnabled: true,
    oidcIssuerUrl: 'https://idp.example.com',
    oidcClientId: 'test-client',
    oidcRedirectUri: 'https://app.example.com/api/auth/oidc/callback',
    oidcScopes: 'openid profile email',
    oidcGroupClaim: 'groups',
    oidcGroupMap: '{}',
    oidcAutoCreateUsers: true,
  };
}

function makeProfile(name: string, authMode: ServeProfile['authMode']): ServeProfile {
  return {
    name,
    label: name,
    selectedTables: {},
    authMode,
  } as unknown as ServeProfile;
}

/** Build the OidcSessionDeps from real host helpers + a stub admin password lookup. */
function makeSsoDeps(state: AppState): OidcSessionDeps {
  return {
    createSession,
    setSessionCookie,
    setUserSessionCookie,
    validateSession,
    parseCookies,
    verifyPassword,
    adminSessionCookieName: 'calame_session',
    getUserPasswordHash: (userId: string) => {
      const row = state.db?.raw
        .prepare('SELECT password_hash FROM users WHERE id = ?')
        .get(userId) as { password_hash: string | null } | undefined;
      return row?.password_hash ?? null;
    },
  };
}

/** Create a minimal express app with just the OIDC auth routes wired to a mock provider. */
function buildTestApp(state: AppState, mp: MockProvider): express.Express {
  const app = express();
  app.use(express.json());
  const deps = makeSsoDeps(state);
  const options: OidcAuthRouteOptions = {
    providerFactory: () =>
      mp as unknown as ReturnType<OidcAuthRouteOptions['providerFactory'] & {}>,
  };
  registerOidcAuthRoutes(app, state, deps, options);
  return app;
}

/**
 * Simulate the PKCE login dance: call /api/auth/oidc/login and capture the
 * state param from the redirect Location header.
 */
async function initiateLogin(
  app: express.Express,
  redirect: string,
): Promise<{ stateParam: string }> {
  const res = await request(app).get('/api/auth/oidc/login').query({ redirect }).redirects(0);

  const location = res.headers['location'] as string | undefined;
  if (!location) throw new Error('No Location header from /login');
  const url = new URL(location, 'https://idp.example.com');
  const stateParam = url.searchParams.get('state');
  if (!stateParam) throw new Error('No state param in redirect URL');
  return { stateParam };
}

describe('OIDC callback — SSO auto-grant logic', () => {
  let app: express.Express;
  let state: AppState;
  let db: CalameDatabase;
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = path.join(os.tmpdir(), `calame-oidc-callback-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    process.chdir(tmpDir);

    state = new AppState();
    db = new CalameDatabase(tmpDir);
    state.db = db;
    state.userManager = new UserManager(db);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (state as any)._config = makeOidcConfig();

    mockProvider = makeMockProvider();
    app = buildTestApp(state, mockProvider);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  /** Run a full login+callback cycle and return the final redirect location. */
  async function runCallbackCycle(redirect: string): Promise<{ location: string }> {
    const { stateParam } = await initiateLogin(app, redirect);

    const res = await request(app)
      .get('/api/auth/oidc/callback')
      .query({ code: 'fake-code', state: stateParam })
      .redirects(0);

    return { location: (res.headers['location'] as string | undefined) ?? '' };
  }

  // ─── new user path ─────────────────────────────────────────────────────────

  describe('new user (auto-created)', () => {
    it('grants access to the SSO profile when redirect is /chat/<profileName> and authMode is sso', async () => {
      const profileName = 'testmysql';
      state.serveProfiles = { [profileName]: makeProfile(profileName, 'sso') };

      await runCallbackCycle(`/chat/${profileName}`);

      const users = state.userManager!.listUsers();
      expect(users).toHaveLength(1);
      const [user] = users;
      expect(user.profiles.some((p) => p.profileName === profileName)).toBe(true);
    });

    it('does NOT grant access when the profile authMode is not sso', async () => {
      const profileName = 'tokenprofile';
      state.serveProfiles = { [profileName]: makeProfile(profileName, 'token') };

      await runCallbackCycle(`/chat/${profileName}`);

      const users = state.userManager!.listUsers();
      expect(users).toHaveLength(1);
      const [user] = users;
      expect(user.profiles.some((p) => p.profileName === profileName)).toBe(false);
      expect(user.profiles.some((p) => p.profileName === 'default')).toBe(true);
    });

    it('falls back to "default" profile when redirect does not match /chat/<name>', async () => {
      const profileName = 'someprofile';
      state.serveProfiles = { [profileName]: makeProfile(profileName, 'sso') };

      await runCallbackCycle('/dashboard');

      const users = state.userManager!.listUsers();
      expect(users).toHaveLength(1);
      const [user] = users;
      expect(user.profiles.some((p) => p.profileName === 'default')).toBe(true);
      expect(user.profiles.some((p) => p.profileName === profileName)).toBe(false);
    });

    it('grants access to SSO profile even when group mapping already yielded other profiles', async () => {
      const profileName = 'ssoProf';
      state.serveProfiles = { [profileName]: makeProfile(profileName, 'sso') };
      getMockProvider().mapGroupsToProfiles.mockReturnValue(['other-profile']);

      await runCallbackCycle(`/chat/${profileName}`);

      const users = state.userManager!.listUsers();
      expect(users).toHaveLength(1);
      const [user] = users;
      expect(user.profiles.some((p) => p.profileName === 'other-profile')).toBe(true);
      expect(user.profiles.some((p) => p.profileName === profileName)).toBe(true);
    });

    it('does not add a duplicate SSO profile when group mapping already contains it', async () => {
      const profileName = 'shared';
      state.serveProfiles = { [profileName]: makeProfile(profileName, 'sso') };
      getMockProvider().mapGroupsToProfiles.mockReturnValue([profileName]);

      await runCallbackCycle(`/chat/${profileName}`);

      const users = state.userManager!.listUsers();
      expect(users).toHaveLength(1);
      const accesses = users[0].profiles.filter((p) => p.profileName === profileName);
      expect(accesses).toHaveLength(1);
    });
  });

  // ─── existing user found by subject ────────────────────────────────────────

  describe('existing user found by OIDC subject', () => {
    it('removes access from existing user when group mapping no longer grants it', async () => {
      const profileName = 'testmysql';
      state.serveProfiles = { [profileName]: makeProfile(profileName, 'sso') };

      getMockProvider().getGroupToProfile.mockReturnValue({ engineering: profileName });
      getMockProvider().getGroups.mockReturnValue([]);
      getMockProvider().mapGroupsToProfiles.mockReturnValue([]);

      const userManager = state.userManager!;
      const { id } = userManager.createUser({
        name: 'Existing',
        email: 'sso-user@example.com',
        role: 'user',
        profiles: [{ profileName, allowedTables: null, allowedTools: null, accessMode: 'both' }],
      });
      userManager.consumeOnboardingCode(userManager.getUserById(id)!.onboardingCode!);
      userManager.setOidcSubject(id, 'oidc-subject-123');

      await runCallbackCycle('/dashboard');

      const user = state.userManager!.getUserById(id)!;
      expect(user.profiles.some((p) => p.profileName === profileName)).toBe(false);
    });

    it('removes access when user is no longer in the mapped group', async () => {
      const profileName = 'testmysql';
      state.serveProfiles = { [profileName]: makeProfile(profileName, 'sso') };

      getMockProvider().getGroupToProfile.mockReturnValue({ engineering: profileName });
      getMockProvider().getGroups.mockReturnValue([]);
      getMockProvider().mapGroupsToProfiles.mockReturnValue([]);

      const userManager = state.userManager!;
      const { id } = userManager.createUser({
        name: 'Existing',
        email: 'sso-user@example.com',
        role: 'user',
        profiles: [{ profileName, allowedTables: null, allowedTools: null, accessMode: 'both' }],
      });
      userManager.consumeOnboardingCode(userManager.getUserById(id)!.onboardingCode!);
      userManager.setOidcSubject(id, 'oidc-subject-123');

      await runCallbackCycle('/dashboard');

      const user = state.userManager!.getUserById(id)!;
      expect(user.profiles.some((p) => p.profileName === profileName)).toBe(false);
    });

    it('preserves admin-added profiles outside IdP scope while removing revoked IdP profiles', async () => {
      const idpProfile = 'testmysql';
      const adminProfile = 'admin-only';
      state.serveProfiles = {
        [idpProfile]: makeProfile(idpProfile, 'sso'),
        [adminProfile]: makeProfile(adminProfile, 'token'),
      };

      getMockProvider().getGroupToProfile.mockReturnValue({ engineering: idpProfile });
      getMockProvider().getGroups.mockReturnValue([]);
      getMockProvider().mapGroupsToProfiles.mockReturnValue([]);

      const userManager = state.userManager!;
      const { id } = userManager.createUser({
        name: 'Existing',
        email: 'sso-user@example.com',
        role: 'user',
        profiles: [
          {
            profileName: adminProfile,
            allowedTables: null,
            allowedTools: null,
            accessMode: 'both',
          },
          { profileName: idpProfile, allowedTables: null, allowedTools: null, accessMode: 'both' },
        ],
      });
      userManager.consumeOnboardingCode(userManager.getUserById(id)!.onboardingCode!);
      userManager.setOidcSubject(id, 'oidc-subject-123');

      await runCallbackCycle('/dashboard');

      const user = state.userManager!.getUserById(id)!;
      expect(user.profiles.some((p) => p.profileName === adminProfile)).toBe(true);
      expect(user.profiles.some((p) => p.profileName === idpProfile)).toBe(false);
    });

    it('admin revoke is permanent for profiles outside IdP scope', async () => {
      const adminProfile = 'admin-only';
      state.serveProfiles = { [adminProfile]: makeProfile(adminProfile, 'token') };

      getMockProvider().getGroups.mockReturnValue([]);
      getMockProvider().mapGroupsToProfiles.mockReturnValue([]);

      const userManager = state.userManager!;
      const { id } = userManager.createUser({
        name: 'Existing',
        email: 'sso-user@example.com',
        role: 'user',
        profiles: [
          {
            profileName: adminProfile,
            allowedTables: null,
            allowedTools: null,
            accessMode: 'both',
          },
        ],
      });
      userManager.consumeOnboardingCode(userManager.getUserById(id)!.onboardingCode!);
      userManager.setOidcSubject(id, 'oidc-subject-123');

      userManager.removeProfileAccess(id, adminProfile);

      await runCallbackCycle('/dashboard');

      const user = state.userManager!.getUserById(id)!;
      expect(user.profiles.some((p) => p.profileName === adminProfile)).toBe(false);
    });

    it('additively grants group-mapped profiles to existing user', async () => {
      const profileName = 'analytics';
      state.serveProfiles = { [profileName]: makeProfile(profileName, 'sso') };

      getMockProvider().getGroupToProfile.mockReturnValue({ engineering: profileName });
      getMockProvider().getGroups.mockReturnValue(['engineering']);
      getMockProvider().mapGroupsToProfiles.mockReturnValue([profileName]);

      const userManager = state.userManager!;
      const { id } = userManager.createUser({
        name: 'Engineer',
        email: 'sso-user@example.com',
        role: 'user',
        profiles: [
          { profileName: 'other', allowedTables: null, allowedTools: null, accessMode: 'both' },
        ],
      });
      userManager.consumeOnboardingCode(userManager.getUserById(id)!.onboardingCode!);
      userManager.setOidcSubject(id, 'oidc-subject-123');

      await runCallbackCycle('/dashboard');

      const user = state.userManager!.getUserById(id)!;
      expect(user.profiles.some((p) => p.profileName === profileName)).toBe(true);
      expect(user.profiles.some((p) => p.profileName === 'other')).toBe(true);
    });

    it('preserves admin-added profiles not in SSO mapping', async () => {
      const ssoProfile = 'analytics';
      const adminProfile = 'admin-only';
      state.serveProfiles = {
        [ssoProfile]: makeProfile(ssoProfile, 'sso'),
        [adminProfile]: makeProfile(adminProfile, 'token'),
      };

      getMockProvider().getGroupToProfile.mockReturnValue({ engineering: ssoProfile });
      getMockProvider().getGroups.mockReturnValue(['engineering']);
      getMockProvider().mapGroupsToProfiles.mockReturnValue([ssoProfile]);

      const userManager = state.userManager!;
      const { id } = userManager.createUser({
        name: 'Engineer',
        email: 'sso-user@example.com',
        role: 'user',
        profiles: [
          {
            profileName: adminProfile,
            allowedTables: null,
            allowedTools: null,
            accessMode: 'both',
          },
        ],
      });
      userManager.consumeOnboardingCode(userManager.getUserById(id)!.onboardingCode!);
      userManager.setOidcSubject(id, 'oidc-subject-123');

      await runCallbackCycle('/dashboard');

      const user = state.userManager!.getUserById(id)!;
      expect(user.profiles.some((p) => p.profileName === ssoProfile)).toBe(true);
      expect(user.profiles.some((p) => p.profileName === adminProfile)).toBe(true);
    });

    it('does NOT auto-grant ssoAutoGrant target to existing user (ssoAutoGrant is new-users only)', async () => {
      const profileName = 'ssoProfile';
      state.serveProfiles = { [profileName]: makeProfile(profileName, 'sso') };

      getMockProvider().getGroups.mockReturnValue([]);
      getMockProvider().mapGroupsToProfiles.mockReturnValue([]);

      const userManager = state.userManager!;
      const { id } = userManager.createUser({
        name: 'Existing',
        email: 'sso-user@example.com',
        role: 'user',
        profiles: [
          { profileName: 'other', allowedTables: null, allowedTools: null, accessMode: 'both' },
        ],
      });
      userManager.consumeOnboardingCode(userManager.getUserById(id)!.onboardingCode!);
      userManager.setOidcSubject(id, 'oidc-subject-123');

      await runCallbackCycle(`/chat/${profileName}`);

      const user = state.userManager!.getUserById(id)!;
      expect(user.profiles.some((p) => p.profileName === profileName)).toBe(false);
      expect(user.profiles.some((p) => p.profileName === 'other')).toBe(true);
    });

    it('refreshes custom attributes from JWT claims on each login', async () => {
      const userManager = state.userManager!;
      const { id } = userManager.createUser({
        name: 'Existing',
        email: 'sso-user@example.com',
        role: 'user',
        profiles: [
          { profileName: 'other', allowedTables: null, allowedTools: null, accessMode: 'both' },
        ],
        customAttributes: { dept: 'old', tenure: '5y' },
      });
      userManager.consumeOnboardingCode(userManager.getUserById(id)!.onboardingCode!);
      userManager.setOidcSubject(id, 'oidc-subject-123');

      getMockProvider().extractCustomAttributes.mockReturnValue({ dept: 'new', phone: '123' });

      await runCallbackCycle('/dashboard');

      getMockProvider().extractCustomAttributes.mockReturnValue(null);

      const user = state.userManager!.getUserById(id)!;
      expect(user.customAttributes).toEqual({ dept: 'new', tenure: '5y', phone: '123' });
    });

    it('does not touch custom attributes when JWT has no claims', async () => {
      const userManager = state.userManager!;
      const { id } = userManager.createUser({
        name: 'Existing',
        email: 'sso-user@example.com',
        role: 'user',
        profiles: [
          { profileName: 'other', allowedTables: null, allowedTools: null, accessMode: 'both' },
        ],
        customAttributes: { dept: 'eng' },
      });
      userManager.consumeOnboardingCode(userManager.getUserById(id)!.onboardingCode!);
      userManager.setOidcSubject(id, 'oidc-subject-123');

      getMockProvider().extractCustomAttributes.mockReturnValue(null);

      await runCallbackCycle('/dashboard');

      const user = state.userManager!.getUserById(id)!;
      expect(user.customAttributes).toEqual({ dept: 'eng' });
    });
  });

  // ─── existing user found by email ──────────────────────────────────────────

  describe('existing user found by email (not yet linked)', () => {
    it('links OIDC subject and grants group-mapped profile (email-match path)', async () => {
      const profileName = 'emailSso';
      state.serveProfiles = { [profileName]: makeProfile(profileName, 'sso') };

      getMockProvider().getGroupToProfile.mockReturnValue({ engineering: profileName });
      getMockProvider().getGroups.mockReturnValue(['engineering']);
      getMockProvider().mapGroupsToProfiles.mockReturnValue([profileName]);

      const userManager = state.userManager!;
      const { id } = userManager.createUser({
        name: 'Email User',
        email: 'sso-user@example.com',
        role: 'user',
        profiles: [
          { profileName: 'other', allowedTables: null, allowedTools: null, accessMode: 'both' },
        ],
      });
      userManager.consumeOnboardingCode(userManager.getUserById(id)!.onboardingCode!);

      await runCallbackCycle('/dashboard');

      const user = state.userManager!.getUserById(id)!;
      expect(user.oidcSubject).toBe('oidc-subject-123');
      expect(user.profiles.some((p) => p.profileName === profileName)).toBe(true);
      expect(user.profiles.some((p) => p.profileName === 'other')).toBe(true);
    });

    it('syncs destructively for email-found user — removes revoked IdP profile', async () => {
      const idpProfile = 'testmysql';
      state.serveProfiles = { [idpProfile]: makeProfile(idpProfile, 'sso') };

      getMockProvider().getGroupToProfile.mockReturnValue({ engineering: idpProfile });
      getMockProvider().getGroups.mockReturnValue([]);
      getMockProvider().mapGroupsToProfiles.mockReturnValue([]);

      const userManager = state.userManager!;
      const { id } = userManager.createUser({
        name: 'Email User',
        email: 'sso-user@example.com',
        role: 'user',
        profiles: [
          { profileName: idpProfile, allowedTables: null, allowedTools: null, accessMode: 'both' },
        ],
      });
      userManager.consumeOnboardingCode(userManager.getUserById(id)!.onboardingCode!);

      await runCallbackCycle('/dashboard');

      const user = state.userManager!.getUserById(id)!;
      expect(user.oidcSubject).toBe('oidc-subject-123');
      expect(user.profiles.some((p) => p.profileName === idpProfile)).toBe(false);
    });

    it('does NOT auto-grant ssoAutoGrant target to email-found user (ssoAutoGrant is new-users only)', async () => {
      const profileName = 'emailSsoTarget';
      state.serveProfiles = { [profileName]: makeProfile(profileName, 'sso') };

      getMockProvider().getGroups.mockReturnValue([]);
      getMockProvider().mapGroupsToProfiles.mockReturnValue([]);

      const userManager = state.userManager!;
      const { id } = userManager.createUser({
        name: 'Email User',
        email: 'sso-user@example.com',
        role: 'user',
        profiles: [
          { profileName: 'other', allowedTables: null, allowedTools: null, accessMode: 'both' },
        ],
      });
      userManager.consumeOnboardingCode(userManager.getUserById(id)!.onboardingCode!);

      await runCallbackCycle(`/chat/${profileName}`);

      const user = state.userManager!.getUserById(id)!;
      expect(user.profiles.some((p) => p.profileName === profileName)).toBe(false);
      expect(user.profiles.some((p) => p.profileName === 'other')).toBe(true);
    });

    it('refreshes custom attributes from JWT claims when found by email', async () => {
      const userManager = state.userManager!;
      const { id } = userManager.createUser({
        name: 'Email User',
        email: 'sso-user@example.com',
        role: 'user',
        profiles: [
          { profileName: 'other', allowedTables: null, allowedTools: null, accessMode: 'both' },
        ],
        customAttributes: { team: 'core' },
      });
      userManager.consumeOnboardingCode(userManager.getUserById(id)!.onboardingCode!);

      getMockProvider().extractCustomAttributes.mockReturnValue({ team: 'platform', region: 'eu' });

      await runCallbackCycle('/dashboard');

      getMockProvider().extractCustomAttributes.mockReturnValue(null);

      const user = state.userManager!.getUserById(id)!;
      expect(user.oidcSubject).toBe('oidc-subject-123');
      expect(user.customAttributes).toEqual({ team: 'platform', region: 'eu' });
    });
  });

  // ─── redirect safety ───────────────────────────────────────────────────────

  describe('redirect safety — no SSO grant for weird paths', () => {
    it.each([
      ['/chat/bad!name'],
      ['/chat/'],
      ['/chat'],
      ['//chat/profile'],
      ['/chat/profile/extra'],
    ])('does not auto-grant for redirect %j', async () => {
      const profileName = 'legit';
      state.serveProfiles = { [profileName]: makeProfile(profileName, 'sso') };

      const { stateParam } = await initiateLogin(app, '/safe-path');

      const res = await request(app)
        .get('/api/auth/oidc/callback')
        .query({ code: 'fake-code', state: stateParam })
        .redirects(0);

      expect([302, 303]).toContain(res.status);

      const users = state.userManager!.listUsers();
      if (users.length > 0) {
        const [user] = users;
        expect(user.profiles.some((p) => p.profileName === profileName)).toBe(false);
      }
    });
  });

  // ─── error cases ───────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('returns 400 when code or state is missing', async () => {
      const res = await request(app).get('/api/auth/oidc/callback').query({ code: 'only-code' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for an invalid or expired state param', async () => {
      const res = await request(app)
        .get('/api/auth/oidc/callback')
        .query({ code: 'fake-code', state: 'nonexistent-state' });
      expect(res.status).toBe(400);
    });

    it('returns 400 when IdP error param is present', async () => {
      const res = await request(app)
        .get('/api/auth/oidc/callback')
        .query({ error: 'access_denied' });
      expect(res.status).toBe(400);
    });

    it('returns 500 when exchangeCode throws', async () => {
      getMockProvider().exchangeCode.mockRejectedValue(new Error('Token exchange failed'));

      const { stateParam } = await initiateLogin(app, '/chat/someprofile');
      const res = await request(app)
        .get('/api/auth/oidc/callback')
        .query({ code: 'fake-code', state: stateParam })
        .redirects(0);

      expect(res.status).toBe(500);
    });
  });
});
