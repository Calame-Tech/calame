import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { registerOAuthRoutes } from './oauth.js';
import { AppState } from '../state.js';
import { CalameDatabase } from '../database.js';

/**
 * Client validation at /authorize: an unknown client_id and a redirect_uri that
 * differs for a known client are distinct failures (JSON + logs, no secret),
 * errors are never redirected, calame mode refuses an unknown client before
 * showing the login form, and a client persisted before a restart completes
 * the normal flow in every authMode (open, calame, sso, oauth) up to /token.
 */

const PKCE_VERIFIER = 'client-errors-verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
const PKCE_CHALLENGE = crypto.createHash('sha256').update(PKCE_VERIFIER).digest('base64url');
const REDIRECT = 'https://client.example/cb';
const OTHER_REDIRECT = 'https://attacker.example/steal?leak=1';
const UNKNOWN_CLIENT = 'client_' + 'f'.repeat(32);
const PASSWORD = 'S3cret-password!';

interface LogEntry {
  msg: string;
  meta?: Record<string, unknown>;
}

interface Server {
  app: Express;
  state: AppState;
  db: CalameDatabase;
  logs: LogEntry[];
  authenticate: ReturnType<typeof vi.fn>;
}

class FakeOidc {
  async getAuthorizationUrl(state: string): Promise<string> {
    return `https://idp.example/authorize?state=${state}`;
  }
  async exchangeCode(): Promise<{ idToken: string }> {
    return { idToken: 'id-token' };
  }
  async verifyIdToken(): Promise<{ sub: string }> {
    return { sub: 'oidc-sub-1' };
  }
}

function startServer(dataDir: string): Server {
  const db = new CalameDatabase(dataDir);
  const state = new AppState();
  state.db = db;
  const logs: LogEntry[] = [];
  const record = (msg: string, meta?: Record<string, unknown>) => logs.push({ msg, meta });
  state.logger = { debug: record, info: record, warn: record, error: record } as never;
  state.serveProfiles = {
    openp: { authMode: 'open' } as never,
    calamep: { authMode: 'calame' } as never,
    ssop: { authMode: 'sso' } as never,
    oauthp: {
      authMode: 'oauth',
      oauthConfig: {
        provider: 'github',
        clientId: 'provider-client',
        clientSecret: 'provider-secret',
        authorizationUrl: 'https://provider.example/authorize',
        tokenUrl: 'https://provider.example/token',
        userinfoUrl: 'https://provider.example/userinfo',
      },
    } as never,
  };
  state.ssoRuntime = { OidcProvider: FakeOidc } as never;
  state.oidcConfigManager = {
    getConfig: () => ({ enabled: true, issuerUrl: 'https://idp.example', clientId: 'idp-client' }),
  } as never;
  const authenticate = vi.fn((email: string, password: string) =>
    email === 'rafael@example.com' && password === PASSWORD ? { id: 'u1', status: 'active' } : null,
  );
  state.userManager = {
    authenticateByEmail: authenticate,
    getUserToken: () => 'fmcp_user_token',
    getUserByOidcSubject: () => ({ id: 'u1', status: 'active' }),
    save: async () => undefined,
  } as never;
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  registerOAuthRoutes(app, state);
  return { app, state, db, logs, authenticate };
}

async function register(app: Express): Promise<string> {
  const res = await request(app)
    .post('/register')
    .send({ redirect_uris: [REDIRECT], client_name: 'ChatGPT' });
  expect(res.status).toBe(201);
  return res.body.client_id as string;
}

function authorizeGet(app: Express, profile: string, clientId: string, redirectUri = REDIRECT) {
  return request(app).get('/authorize').query({
    profile,
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: PKCE_CHALLENGE,
    code_challenge_method: 'S256',
    state: 'client-state',
  });
}

function authorizeCalamePost(app: Express, clientId: string, redirectUri = REDIRECT) {
  return request(app).post('/authorize').type('form').send({
    client_id: clientId,
    redirect_uri: redirectUri,
    state: 'client-state',
    code_challenge: PKCE_CHALLENGE,
    auth_mode: 'calame',
    profile: 'calamep',
    email: 'rafael@example.com',
    password: PASSWORD,
  });
}

function codeFrom(location: string): string {
  const url = new URL(location);
  expect(url.origin + url.pathname).toBe(REDIRECT);
  expect(url.searchParams.get('state')).toBe('client-state');
  const code = url.searchParams.get('code');
  expect(code).toBeTruthy();
  return code as string;
}

function exchange(app: Express, code: string) {
  return request(app).post('/token').type('form').send({
    grant_type: 'authorization_code',
    code,
    code_verifier: PKCE_VERIFIER,
    redirect_uri: REDIRECT,
  });
}

/** Assert a JSON 400 error that is NOT redirected anywhere. */
function expectJsonError(res: request.Response, description: RegExp): void {
  expect(res.status).toBe(400);
  expect(res.headers.location).toBeUndefined();
  expect(res.type).toBe('application/json');
  expect(res.body.error).toBe('invalid_request');
  expect(res.body.error_description).toMatch(description);
}

const UNKNOWN_RE = /Unknown client_id.*recreate/i;
const MISMATCH_RE = /^redirect_uri does not match registered client\.$/;

describe('OAuth /authorize — unknown client vs redirect_uri mismatch', () => {
  let dataDir: string;
  let servers: Server[];

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calame-oauth-client-errors-'));
    servers = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const s of servers) if (s.db.raw.open) s.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function boot(): Server {
    const s = startServer(dataDir);
    servers.push(s);
    return s;
  }

  it.each(['openp', 'ssop', 'oauthp', 'calamep'])(
    'GET /authorize (%s) distinguishes unknown client from a different redirect_uri',
    async (profile) => {
      const { app } = boot();
      const clientId = await register(app);

      expectJsonError(await authorizeGet(app, profile, UNKNOWN_CLIENT), UNKNOWN_RE);
      expectJsonError(await authorizeGet(app, profile, clientId, OTHER_REDIRECT), MISMATCH_RE);
      expectJsonError(
        await request(app).get('/authorize').query({
          profile,
          response_type: 'code',
          redirect_uri: REDIRECT,
          code_challenge: PKCE_CHALLENGE,
        }),
        /client_id is required/,
      );
    },
  );

  it('calame mode: GET /authorize refuses an unknown client before the login form', async () => {
    const { app } = boot();
    const clientId = await register(app);

    const unknown = await authorizeGet(app, 'calamep', UNKNOWN_CLIENT);
    expectJsonError(unknown, UNKNOWN_RE);
    expect(unknown.text).not.toContain('<form');
    expect(unknown.text).not.toContain('password');

    const known = await authorizeGet(app, 'calamep', clientId);
    expect(known.status).toBe(200);
    expect(known.type).toBe('text/html');
    expect(known.text).toContain('name="password"');
  });

  it('calame mode: POST /authorize rejects the client before checking credentials', async () => {
    const { app, authenticate } = boot();
    const clientId = await register(app);

    expectJsonError(await authorizeCalamePost(app, UNKNOWN_CLIENT), UNKNOWN_RE);
    expectJsonError(await authorizeCalamePost(app, clientId, OTHER_REDIRECT), MISMATCH_RE);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('token mode: POST /authorize distinguishes the two causes too', async () => {
    const { app } = boot();
    const clientId = await register(app);
    const post = (id: string, uri: string) =>
      request(app).post('/authorize').type('form').send({
        client_id: id,
        redirect_uri: uri,
        code_challenge: PKCE_CHALLENGE,
        auth_mode: 'token',
        forge_token: 'fmcp_secret_token',
      });

    expectJsonError(await post(UNKNOWN_CLIENT, REDIRECT), UNKNOWN_RE);
    expectJsonError(await post(clientId, OTHER_REDIRECT), MISMATCH_RE);
  });

  it('logs the failure cause without secrets', async () => {
    const { app, logs } = boot();
    const clientId = await register(app);

    await authorizeCalamePost(app, UNKNOWN_CLIENT);
    await authorizeCalamePost(app, clientId, OTHER_REDIRECT);

    const warnings = logs.filter((l) => l.msg.startsWith('[OAuth]'));
    expect(warnings.map((l) => l.meta?.reason)).toEqual([
      'unknown_client',
      'redirect_uri_mismatch',
    ]);
    expect(warnings[0].msg).toMatch(/unknown client_id/);
    expect(warnings[1].msg).toMatch(/redirect_uri differs/);
    expect(warnings[0].meta).toMatchObject({ clientId: UNKNOWN_CLIENT, tenantId: 'default' });
    expect(warnings[1].meta?.redirectOrigin).toBe('https://attacker.example');

    const dump = JSON.stringify(logs);
    for (const secret of [PASSWORD, PKCE_CHALLENGE, 'client-state', 'leak=1', 'rafael@']) {
      expect(dump).not.toContain(secret);
    }
  });

  it('a persisted client completes every authMode flow after a restart', async () => {
    const before = boot();
    const clientId = await register(before.app);
    before.db.close();
    const { app } = boot();

    // open: immediate redirect with a code.
    const open = await authorizeGet(app, 'openp', clientId);
    expect(open.status).toBe(302);
    expect((await exchange(app, codeFrom(open.headers.location))).body.access_token).toBe(
      '__open__',
    );

    // calame: login form, then credentials, then code.
    expect((await authorizeGet(app, 'calamep', clientId)).status).toBe(200);
    const calame = await authorizeCalamePost(app, clientId);
    expect(calame.status).toBe(302);
    expect((await exchange(app, codeFrom(calame.headers.location))).body.access_token).toBe(
      'fmcp_user_token',
    );

    // sso: redirect to the IdP, then the callback mints the code.
    const sso = await authorizeGet(app, 'ssop', clientId);
    expect(sso.status).toBe(302);
    const ssoState = new URL(sso.headers.location).searchParams.get('state');
    const ssoCb = await request(app)
      .get('/authorize/sso-callback')
      .query({ code: 'idp-code', state: ssoState });
    expect(ssoCb.status).toBe(302);
    const ssoTok = await exchange(app, codeFrom(ssoCb.headers.location));
    expect(ssoTok.status).toBe(200);
    expect(ssoTok.body.access_token).toBe('fmcp_user_token');

    // oauth: redirect to the provider, then the callback mints the code.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).endsWith('/token')
          ? new Response(JSON.stringify({ access_token: 'provider-access' }))
          : new Response(JSON.stringify({ id: 42 })),
      ),
    );
    const oauth = await authorizeGet(app, 'oauthp', clientId);
    expect(oauth.status).toBe(302);
    const providerUrl = new URL(oauth.headers.location);
    expect(providerUrl.origin).toBe('https://provider.example');
    const oauthCb = await request(app)
      .get('/authorize/oauth-callback')
      .query({ code: 'provider-code', state: providerUrl.searchParams.get('state') });
    expect(oauthCb.status).toBe(302);
    const oauthTok = await exchange(app, codeFrom(oauthCb.headers.location));
    expect(oauthTok.status).toBe(200);
    expect(oauthTok.body.access_token).toBe('fmcp_user_token');
  });

  it('/token keeps its PKCE and redirect_uri checks for a persisted client', async () => {
    const before = boot();
    const clientId = await register(before.app);
    before.db.close();
    const { app } = boot();

    const first = await authorizeGet(app, 'openp', clientId);
    const badVerifier = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code: codeFrom(first.headers.location),
        code_verifier: 'wrong-verifier',
        redirect_uri: REDIRECT,
      });
    expect(badVerifier.status).toBe(400);
    expect(badVerifier.body.error).toBe('invalid_grant');

    const second = await authorizeGet(app, 'openp', clientId);
    const badRedirect = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code: codeFrom(second.headers.location),
        code_verifier: PKCE_VERIFIER,
        redirect_uri: OTHER_REDIRECT,
      });
    expect(badRedirect.status).toBe(400);
    expect(badRedirect.body.error).toBe('invalid_grant');
  });
});
