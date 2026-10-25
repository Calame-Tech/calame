import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import express, { type Express } from 'express';
import request from 'supertest';
import { registerOAuthRoutes } from './oauth.js';
import { AppState } from '../state.js';
import { CalameDatabase } from '../database.js';

/**
 * Persistence of dynamically registered OAuth clients (RFC 7591): a client
 * registered via POST /register must survive a restart, i.e. a brand-new
 * AppState + database handle + route instance on the same on-disk database.
 */

const PKCE_VERIFIER = 'persist-verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
const PKCE_CHALLENGE = crypto.createHash('sha256').update(PKCE_VERIFIER).digest('base64url');
const REDIRECT = 'https://client.example/cb';

/** One "server process": fresh state, fresh DB handle, fresh route instance. */
interface Server {
  app: Express;
  state: AppState;
  db: CalameDatabase;
}

function startServer(dataDir: string): Server {
  const db = new CalameDatabase(dataDir);
  const state = new AppState();
  state.db = db;
  state.serveProfiles = {
    openp: { authMode: 'open' } as never,
    calamep: { authMode: 'calame' } as never,
  };
  // Minimal user manager stub for the calame (email + password) flow.
  state.userManager = {
    authenticateByEmail: (email: string, password: string) =>
      email === 'rafael@example.com' && password === 'pw' ? { id: 'u1', status: 'active' } : null,
    getUserToken: () => 'fmcp_user_token',
  } as never;
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  registerOAuthRoutes(app, state);
  return { app, state, db };
}

async function register(app: Express, tenant?: string): Promise<string> {
  const req = request(app).post('/register');
  if (tenant) req.set('X-Tenant-Id', tenant);
  const res = await req.send({ redirect_uris: [REDIRECT], client_name: 'ChatGPT' });
  expect(res.status).toBe(201);
  return res.body.client_id as string;
}

/** Open-mode authorize; returns the response (302 with ?code= on success). */
function authorizeOpen(app: Express, clientId: string, tenant?: string) {
  const req = request(app).get('/authorize');
  if (tenant) req.set('X-Tenant-Id', tenant);
  return req.query({
    profile: 'openp',
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: PKCE_CHALLENGE,
    code_challenge_method: 'S256',
    state: 'xyz',
  });
}

function codeFrom(location: string): string {
  const code = new URL(location).searchParams.get('code');
  expect(code).toBeTruthy();
  return code as string;
}

function exchange(app: Express, code: string, verifier = PKCE_VERIFIER) {
  return request(app).post('/token').type('form').send({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
  });
}

function lastUsedAt(db: CalameDatabase, clientId: string): string | null | undefined {
  const row = db.raw
    .prepare('SELECT last_used_at FROM oauth_clients WHERE client_id = ?')
    .get(clientId) as { last_used_at: string | null } | undefined;
  return row?.last_used_at;
}

describe('OAuth dynamic clients — persistence', () => {
  let dataDir: string;
  let servers: Server[];

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calame-oauth-clients-'));
    servers = [];
  });

  afterEach(() => {
    for (const s of servers) if (s.db.raw.open) s.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function boot(): Server {
    const s = startServer(dataDir);
    servers.push(s);
    return s;
  }

  it('stores the client in SQLite and recognises it immediately (no restart)', async () => {
    const { app, db } = boot();
    const clientId = await register(app);

    const row = db.raw
      .prepare('SELECT * FROM oauth_clients WHERE client_id = ?')
      .get(clientId) as Record<string, unknown>;
    expect(row.tenant_id).toBe('default');
    expect(JSON.parse(row.redirect_uris as string)).toEqual([REDIRECT]);
    expect(row.client_name).toBe('ChatGPT');
    expect(typeof row.created_at).toBe('string');
    expect(row.last_used_at).toBeNull();

    const auth = await authorizeOpen(app, clientId);
    expect(auth.status).toBe(302);
    const tok = await exchange(app, codeFrom(auth.headers.location));
    expect(tok.status).toBe(200);
    expect(tok.body.access_token).toBe('__open__');
  });

  it('a client registered before a restart completes a new authorize + token flow after it', async () => {
    const before = boot();
    const clientId = await register(before.app);
    const preRestart = await authorizeOpen(before.app, clientId);
    const oldCode = codeFrom(preRestart.headers.location);

    // Simulated restart: close the DB, then a brand-new state, DB handle and
    // route instance on the same data directory.
    before.db.close();
    const after = boot();
    expect(after.app).not.toBe(before.app);

    // In-memory state is really gone: a code issued before the restart is invalid.
    const stale = await exchange(after.app, oldCode);
    expect(stale.status).toBe(400);
    expect(stale.body.error).toBe('invalid_grant');

    const auth = await authorizeOpen(after.app, clientId);
    expect(auth.status).toBe(302);
    expect(auth.headers.location.startsWith(REDIRECT)).toBe(true);
    const tok = await exchange(after.app, codeFrom(auth.headers.location));
    expect(tok.status).toBe(200);
    expect(tok.body.token_type).toBe('Bearer');
  });

  it('calame mode: POST /authorize succeeds after restart with the persisted client', async () => {
    const before = boot();
    const clientId = await register(before.app);
    before.db.close();

    const after = boot();
    const auth = await request(after.app).post('/authorize').type('form').send({
      client_id: clientId,
      redirect_uri: REDIRECT,
      state: 'abc',
      code_challenge: PKCE_CHALLENGE,
      auth_mode: 'calame',
      profile: 'calamep',
      email: 'rafael@example.com',
      password: 'pw',
    });
    expect(auth.status).toBe(302);
    const tok = await exchange(after.app, codeFrom(auth.headers.location));
    expect(tok.status).toBe(200);
    expect(tok.body.access_token).toBe('fmcp_user_token');
  });

  it('sets last_used_at only on a successful /token exchange', async () => {
    const { app, db } = boot();
    const clientId = await register(app);

    const auth = await authorizeOpen(app, clientId);
    expect(lastUsedAt(db, clientId)).toBeNull();

    // Failed exchange (wrong PKCE verifier) is not a use.
    const bad = await exchange(app, codeFrom(auth.headers.location), 'wrong-verifier');
    expect(bad.status).toBe(400);
    expect(lastUsedAt(db, clientId)).toBeNull();

    const auth2 = await authorizeOpen(app, clientId);
    const ok = await exchange(app, codeFrom(auth2.headers.location));
    expect(ok.status).toBe(200);
    const used = lastUsedAt(db, clientId);
    expect(used).toBeTruthy();
    expect(Number.isNaN(Date.parse(used as string))).toBe(false);
  });

  it('a client unknown to the database is rejected', async () => {
    const { app } = boot();
    const res = await authorizeOpen(app, 'client_' + '0'.repeat(32));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('does not recognise a client across tenants', async () => {
    const { app } = boot();
    const clientId = await register(app, 'tenant-a');

    expect((await authorizeOpen(app, clientId, 'tenant-b')).status).toBe(400);
    expect((await authorizeOpen(app, clientId)).status).toBe(400); // default tenant
    expect((await authorizeOpen(app, clientId, 'tenant-a')).status).toBe(302);

    const defaultClient = await register(app);
    expect((await authorizeOpen(app, defaultClient, 'tenant-a')).status).toBe(400);
  });
});

describe('host migration v19 — oauth_clients', () => {
  it('creates oauth_clients on an existing v18 database without losing data', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calame-pre-v19-'));
    try {
      // Build a genuine v18 database: full schema, then roll back v19.
      const seed = new CalameDatabase(dataDir);
      seed.raw.exec('DROP TABLE oauth_clients; DELETE FROM _migrations WHERE version >= 19;');
      seed.raw
        .prepare(
          `INSERT INTO auth_sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
        )
        .run('h1', null, 1, 2);
      seed.raw
        .prepare(
          `INSERT INTO tokens (id, token_hash, profile_name, label, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run('t1', 'hash', 'heymiles', 'legacy', '2026-01-01T00:00:00.000Z');
      seed.close();

      const check = new Database(path.join(dataDir, 'calame.db'));
      expect(
        check.prepare(`SELECT name FROM sqlite_master WHERE name = 'oauth_clients'`).get(),
      ).toBeUndefined();
      check.close();

      const db = new CalameDatabase(dataDir);
      try {
        expect(db.getSchemaVersion()).toBe(19);
        const cols = (db.raw.pragma('table_info(oauth_clients)') as Array<{ name: string }>).map(
          (c) => c.name,
        );
        expect(cols).toEqual([
          'client_id',
          'tenant_id',
          'redirect_uris',
          'client_name',
          'created_at',
          'last_used_at',
        ]);
        expect(db.raw.prepare('SELECT id_hash FROM auth_sessions').all()).toEqual([
          { id_hash: 'h1' },
        ]);
        expect(db.raw.prepare('SELECT id, label FROM tokens').all()).toEqual([
          { id: 't1', label: 'legacy' },
        ]);
      } finally {
        db.close();
      }

      // Re-opening is idempotent and keeps the registered clients.
      const again = new CalameDatabase(dataDir);
      again.raw
        .prepare(
          `INSERT INTO oauth_clients (client_id, redirect_uris, created_at) VALUES ('c1', '[]', 'x')`,
        )
        .run();
      again.close();
      const third = new CalameDatabase(dataDir);
      expect(third.raw.prepare('SELECT client_id, tenant_id FROM oauth_clients').all()).toEqual([
        { client_id: 'c1', tenant_id: 'default' },
      ]);
      third.close();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
