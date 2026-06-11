import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { registerOAuthRoutes } from './oauth.js';
import { AppState } from '../state.js';

/**
 * Security regression tests (Phase 3): OAuth open-redirect + PKCE bypass.
 *
 * These exercise the fail-closed redirect_uri validation and the mandatory
 * PKCE / redirect_uri checks on the /token endpoint.
 */

function buildApp(state: AppState): Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  registerOAuthRoutes(app, state);
  return app;
}

function newState(): AppState {
  const state = new AppState();
  state.serveProfiles = {
    openp: { authMode: 'open' } as never,
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
  return state;
}

/** Register a client and return its issued client_id. */
async function registerClient(app: Express, redirectUris: string[]): Promise<string> {
  const res = await request(app).post('/register').send({ redirect_uris: redirectUris });
  expect(res.status).toBe(201);
  return res.body.client_id as string;
}

describe('OAuth security — redirect_uri validation (GET /authorize)', () => {
  let state: AppState;
  let app: Express;

  beforeEach(() => {
    state = newState();
    app = buildApp(state);
  });

  it('open mode without client_id -> 400', async () => {
    const res = await request(app).get('/authorize').query({
      profile: 'openp',
      response_type: 'code',
      redirect_uri: 'https://client.example/cb',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('oauth mode with unregistered redirect_uri -> 400', async () => {
    const clientId = await registerClient(app, ['https://client.example/cb']);
    const res = await request(app).get('/authorize').query({
      profile: 'oauthp',
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://attacker.example/steal',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('sso mode with unregistered redirect_uri -> 400', async () => {
    // Make buildOidcProvider() return a (fake) provider so the flow reaches the
    // redirect_uri validation instead of short-circuiting on a 503.
    class FakeOidc {
      async getAuthorizationUrl(): Promise<string> {
        return 'https://idp.example/authorize';
      }
    }
    state.ssoRuntime = { OidcProvider: FakeOidc } as never;
    state.oidcConfigManager = {
      getConfig: () => ({ enabled: true, issuerUrl: 'https://idp.example', clientId: 'idp-client' }),
    } as never;

    const clientId = await registerClient(app, ['https://client.example/cb']);
    const res = await request(app).get('/authorize').query({
      profile: 'ssop',
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://attacker.example/steal',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });
});

describe('OAuth security — /token PKCE + redirect_uri', () => {
  let state: AppState;
  let app: Express;

  beforeEach(() => {
    state = newState();
    app = buildApp(state);
  });

  /** Drive the open-mode flow to mint an auth code; returns the code. */
  async function mintCode(opts: {
    clientId: string;
    redirectUri: string;
    codeChallenge?: string;
  }): Promise<string> {
    const res = await request(app).get('/authorize').query({
      profile: 'openp',
      response_type: 'code',
      client_id: opts.clientId,
      redirect_uri: opts.redirectUri,
      ...(opts.codeChallenge ? { code_challenge: opts.codeChallenge } : {}),
    });
    expect(res.status).toBe(302);
    const location = res.headers.location as string;
    const code = new URL(location).searchParams.get('code');
    expect(code).toBeTruthy();
    return code as string;
  }

  it('with codeChallenge but no code_verifier -> 400', async () => {
    const redirectUri = 'https://client.example/cb';
    const clientId = await registerClient(app, [redirectUri]);
    const code = await mintCode({ clientId, redirectUri, codeChallenge: 'some-challenge' });

    const res = await request(app).post('/token').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      // code_verifier intentionally omitted
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('with redirect_uri different from /authorize -> 400', async () => {
    const redirectUri = 'https://client.example/cb';
    const clientId = await registerClient(app, [redirectUri]);
    // No code_challenge -> PKCE check is skipped, isolating the redirect_uri check.
    const code = await mintCode({ clientId, redirectUri });

    const res = await request(app).post('/token').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://attacker.example/steal',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });
});
