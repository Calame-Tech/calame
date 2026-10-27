import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { registerOAuthRoutes, REGISTER_RATE_LIMIT_RPM } from './oauth.js';
import { AppState } from '../state.js';
import { CalameDatabase } from '../database.js';
import { TokenRateLimiter } from '../rate-limiter.js';
import {
  OAuthClientStore,
  OAUTH_CLIENT_LIMITS,
  REGISTER_LIMITS,
  type OAuthClientLimits,
} from '../oauth-clients.js';

/**
 * Hardening of POST /register (RFC 7591): metadata validation before any
 * write, explicit limits, a per-tenant client cap with purge of never-used
 * old clients (also under concurrent registrations), and the shared rate
 * limiter. Every test runs on a throwaway temp database.
 */

interface Server {
  app: Express;
  state: AppState;
  db: CalameDatabase;
  warn: ReturnType<typeof vi.fn>;
}

function startServer(dataDir: string, clientLimits?: Partial<OAuthClientLimits>): Server {
  const db = new CalameDatabase(dataDir);
  const state = new AppState();
  state.db = db;
  const warn = vi.fn();
  state.logger = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  registerOAuthRoutes(app, state, { clientLimits });
  return { app, state, db, warn };
}

function post(app: Express, body: unknown, tenant?: string) {
  const req = request(app).post('/register');
  if (tenant) req.set('X-Tenant-Id', tenant);
  return req.send(body as object);
}

function count(db: CalameDatabase, tenant?: string): number {
  const row = tenant
    ? db.raw.prepare('SELECT COUNT(*) AS n FROM oauth_clients WHERE tenant_id = ?').get(tenant)
    : db.raw.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get();
  return (row as { n: number }).n;
}

function ids(db: CalameDatabase): string[] {
  return (
    db.raw.prepare('SELECT client_id FROM oauth_clients ORDER BY client_id').all() as {
      client_id: string;
    }[]
  ).map((r) => r.client_id);
}

/** Insert a client directly, with a chosen age and usage. */
function seed(
  db: CalameDatabase,
  clientId: string,
  ageMs: number,
  used: boolean,
  tenant = 'default',
): void {
  const createdAt = new Date(Date.now() - ageMs).toISOString();
  db.raw
    .prepare(
      `INSERT INTO oauth_clients (client_id, tenant_id, redirect_uris, client_name, created_at, last_used_at)
       VALUES (?, ?, '["https://client.example/cb"]', NULL, ?, ?)`,
    )
    .run(clientId, tenant, createdAt, used ? createdAt : null);
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const OK_URI = 'https://client.example/cb';

describe('POST /register — hardening', () => {
  let dataDir: string;
  let servers: Server[];

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calame-oauth-register-'));
    servers = [];
  });

  afterEach(() => {
    for (const s of servers) if (s.db.raw.open) s.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function boot(clientLimits?: Partial<OAuthClientLimits>): Server {
    const s = startServer(dataDir, clientLimits);
    servers.push(s);
    return s;
  }

  describe('redirect_uris validation', () => {
    const longUri = 'https://client.example/' + 'a'.repeat(REGISTER_LIMITS.maxRedirectUriLength);
    const invalid: [string, unknown, RegExp][] = [
      ['missing', {}, /redirect_uris is required/],
      ['null', { redirect_uris: null }, /redirect_uris is required/],
      ['empty array', { redirect_uris: [] }, /non-empty array/],
      ['a string instead of an array', { redirect_uris: OK_URI }, /non-empty array/],
      ['an object', { redirect_uris: { a: OK_URI } }, /non-empty array/],
      [
        'a non-string element',
        { redirect_uris: [OK_URI, 42] },
        /redirect_uris\[1\] must be a string/,
      ],
      ['a relative path', { redirect_uris: ['/cb'] }, /absolute URL/],
      ['a bare word', { redirect_uris: ['cb'] }, /absolute URL/],
      ['a scheme without host', { redirect_uris: ['https:client.example/cb'] }, /with a host/],
      ['javascript:', { redirect_uris: ['javascript:alert(1)'] }, /absolute URL with a host/],
      ['ftp://', { redirect_uris: ['ftp://client.example/cb'] }, /scheme "ftp:" is not allowed/],
      ['a custom scheme', { redirect_uris: ['myapp://cb'] }, /scheme "myapp:" is not allowed/],
      ['http on a public host', { redirect_uris: ['http://client.example/cb'] }, /must use https/],
      ['a fragment', { redirect_uris: ['https://client.example/cb#x'] }, /fragment/],
      ['an empty fragment', { redirect_uris: ['https://client.example/cb#'] }, /fragment/],
      ['user credentials', { redirect_uris: ['https://u:p@client.example/cb'] }, /credentials/],
      ['leading whitespace', { redirect_uris: [' https://client.example/cb'] }, /whitespace/],
      ['an embedded tab', { redirect_uris: ['https://client.ex\tample/cb'] }, /whitespace/],
      ['backslashes', { redirect_uris: ['http:\\\\localhost\\cb'] }, /backslashes/],
      ['an empty string', { redirect_uris: [''] }, /must not be empty/],
      ['a too long URI', { redirect_uris: [longUri] }, /at most 2048 characters/],
      [
        'too many URIs',
        {
          redirect_uris: Array.from(
            { length: REGISTER_LIMITS.maxRedirectUris + 1 },
            (_, i) => `https://client.example/cb${i}`,
          ),
        },
        /at most 10 URLs/,
      ],
    ];

    it.each(invalid)(
      'refuses %s with invalid_redirect_uri and writes nothing',
      async (_l, body, re) => {
        const { app, db } = boot();
        const res = await post(app, body);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_redirect_uri');
        expect(res.body.error_description).toMatch(re);
        expect(count(db)).toBe(0);
      },
    );

    // Spellings the WHATWG parser normalizes to a loopback host, or that only
    // look like one: http must be refused for all of them.
    const lookAlikes = [
      'http://127.1/cb',
      'http://0x7f000001/cb',
      'http://2130706433/cb',
      'http://LOCALHOST/cb',
      'http://localhost./cb',
      'http://localhost.evil.example/cb',
      'http://evil-localhost/cb',
      'http://127.0.0.1.nip.io/cb',
      'http://127.0.0.2/cb',
      'http://0.0.0.0/cb',
      'http://[0:0:0:0:0:0:0:1]/cb',
      'http://[::ffff:127.0.0.1]/cb',
      'http://user@localhost/cb',
      'http://localhost@evil.example/cb',
    ];

    it.each(lookAlikes)('refuses the loopback look-alike %s', async (uri) => {
      const { app, db } = boot();
      const res = await post(app, { redirect_uris: [uri] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_redirect_uri');
      expect(count(db)).toBe(0);
    });

    const accepted = [
      'https://chatgpt.com/connector_platform_oauth_redirect',
      'https://claude.ai/api/mcp/auth_callback',
      'https://client.example:8443/cb?x=1',
      'http://localhost/cb',
      'http://localhost:6274/oauth/callback',
      'http://127.0.0.1:33418/',
      'http://[::1]:8080/cb',
      'http://[::1]/cb',
    ];

    it.each(accepted)('accepts %s', async (uri) => {
      const { app, db } = boot();
      const res = await post(app, { redirect_uris: [uri], client_name: 'X' });
      expect(res.status).toBe(201);
      expect(res.body.redirect_uris).toEqual([uri]);
      expect(count(db)).toBe(1);
    });

    it('accepts the documented maxima (10 URIs of 2048 characters)', async () => {
      const { app } = boot();
      const uris = Array.from({ length: REGISTER_LIMITS.maxRedirectUris }, (_, i) => {
        const base = `https://client.example/${i}/`;
        return base + 'a'.repeat(REGISTER_LIMITS.maxRedirectUriLength - base.length);
      });
      const res = await post(app, { redirect_uris: uris });
      expect(res.status).toBe(201);
      expect(res.body.redirect_uris).toEqual(uris);
    });

    it('does not log the submitted URIs', async () => {
      const { app, warn } = boot();
      await post(app, { redirect_uris: ['http://secret-host.example/cb?token=abc'] });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-host');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('token=abc');
    });
  });

  describe('client metadata validation', () => {
    const invalid: [string, unknown, RegExp][] = [
      [
        'a non-string client_name',
        { redirect_uris: [OK_URI], client_name: 7 },
        /client_name must be a string/,
      ],
      [
        'a too long client_name',
        {
          redirect_uris: [OK_URI],
          client_name: 'n'.repeat(REGISTER_LIMITS.maxClientNameLength + 1),
        },
        /client_name must be at most 200 characters/,
      ],
      [
        'control characters in client_name',
        { redirect_uris: [OK_URI], client_name: 'Chat\nGPT' },
        /control characters/,
      ],
      [
        'a body over the size limit',
        { redirect_uris: [OK_URI], logo_uri: 'x'.repeat(REGISTER_LIMITS.maxBodyBytes) },
        /at most 32768 bytes/,
      ],
      ['a JSON array body', [OK_URI], /JSON object/],
    ];

    it.each(invalid)('refuses %s with invalid_client_metadata', async (_l, body, re) => {
      const { app, db } = boot();
      const res = await post(app, body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_client_metadata');
      expect(res.body.error_description).toMatch(re);
      expect(count(db)).toBe(0);
    });

    it('accepts a 200-character client_name and dedupes redirect_uris', async () => {
      const { app, db } = boot();
      const name = 'n'.repeat(REGISTER_LIMITS.maxClientNameLength);
      const res = await post(app, { redirect_uris: [OK_URI, OK_URI], client_name: name });
      expect(res.status).toBe(201);
      expect(res.body.client_name).toBe(name);
      expect(res.body.redirect_uris).toEqual([OK_URI]);
      expect(count(db)).toBe(1);
    });

    it('defaults a missing client_name', async () => {
      const { app } = boot();
      const res = await post(app, { redirect_uris: [OK_URI] });
      expect(res.status).toBe(201);
      expect(res.body.client_name).toBe('MCP Client');
    });
  });

  describe('client cap and purge', () => {
    it('purges never-used clients older than 30 days on registration, keeping used ones', async () => {
      const { app, db } = boot();
      seed(db, 'stale', 31 * DAY, false);
      seed(db, 'old-but-used', 90 * DAY, true);
      seed(db, 'recent', 2 * DAY, false);
      const res = await post(app, { redirect_uris: [OK_URI] });
      expect(res.status).toBe(201);
      expect(ids(db)).toEqual([res.body.client_id, 'old-but-used', 'recent'].sort());
    });

    it('when full, evicts the oldest never-used client older than 1 hour', async () => {
      const { app, db } = boot({ maxClientsPerTenant: 3 });
      seed(db, 'used-oldest', 10 * DAY, true);
      seed(db, 'unused-old', 5 * DAY, false);
      seed(db, 'unused-older', 6 * DAY, false);
      const res = await post(app, { redirect_uris: [OK_URI] });
      expect(res.status).toBe(201);
      expect(ids(db)).toEqual([res.body.client_id, 'unused-old', 'used-oldest'].sort());
    });

    it('refuses cleanly when full and nothing is purgeable, deleting nothing', async () => {
      const { app, db, warn } = boot({ maxClientsPerTenant: 3 });
      seed(db, 'used-a', 10 * DAY, true);
      seed(db, 'used-b', 9 * DAY, true);
      seed(db, 'unused-recent', 10 * 60 * 1000, false); // 10 min: may be mid-authorization
      const res = await post(app, { redirect_uris: [OK_URI] });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('temporarily_unavailable');
      expect(res.body.error_description).toMatch(/Too many OAuth clients/);
      expect(ids(db)).toEqual(['unused-recent', 'used-a', 'used-b']);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('client limit reached'))).toBe(true);
    });

    it('applies the cap per tenant', async () => {
      const { app, db } = boot({ maxClientsPerTenant: 2 });
      expect((await post(app, { redirect_uris: [OK_URI] }, 'tenant-a')).status).toBe(201);
      expect((await post(app, { redirect_uris: [OK_URI] }, 'tenant-a')).status).toBe(201);
      expect((await post(app, { redirect_uris: [OK_URI] }, 'tenant-a')).status).toBe(503);
      expect((await post(app, { redirect_uris: [OK_URI] }, 'tenant-b')).status).toBe(201);
      expect(count(db, 'tenant-a')).toBe(2);
      expect(count(db, 'tenant-b')).toBe(1);
    });

    it('a full tenant never purges clients of another tenant', async () => {
      const { app, db } = boot({ maxClientsPerTenant: 1 });
      seed(db, 'b-unused-old', 5 * DAY, false, 'tenant-b');
      seed(db, 'a-used', 5 * DAY, true, 'tenant-a');
      expect((await post(app, { redirect_uris: [OK_URI] }, 'tenant-a')).status).toBe(503);
      expect(ids(db)).toEqual(['a-used', 'b-unused-old']);
    });

    it('holds the cap under concurrent registrations from two connections on the same base', async () => {
      const limits = { maxClientsPerTenant: 5 };
      const a = boot(limits);
      const b = boot(limits);
      seed(a.db, 'used', DAY, true);
      const results = await Promise.all(
        Array.from({ length: 24 }, (_, i) =>
          post(i % 2 ? a.app : b.app, { redirect_uris: [`${OK_URI}${i}`] }),
        ),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(4);
      expect(statuses.filter((s) => s === 503)).toHaveLength(20);
      expect(count(a.db)).toBe(5);
      expect(ids(a.db)).toContain('used');
    });

    it('applies the same cap without a database (in-memory store)', () => {
      const store = new OAuthClientStore(() => null, { maxClientsPerTenant: 2 });
      const reg = (id: string) =>
        store.register({
          clientId: id,
          tenantId: 'default',
          redirectUris: [OK_URI],
          clientName: null,
        });
      expect(reg('c1').client).not.toBeNull();
      expect(reg('c2').client).not.toBeNull();
      expect(reg('c3').client).toBeNull(); // both too recent to be purged
      expect(store.get('c1', 'default')).not.toBeNull();
      expect(store.get('c3', 'default')).toBeNull();
    });

    it('documents sane production defaults', () => {
      expect(OAUTH_CLIENT_LIMITS).toEqual({
        maxClientsPerTenant: 200,
        staleAfterMs: 30 * DAY,
        purgeMinAgeMs: HOUR,
      });
    });
  });

  describe('rate limiting', () => {
    it('reuses the shared TokenRateLimiter per client IP', async () => {
      const { app, state, db } = boot();
      state.rateLimiter = new TokenRateLimiter();
      for (let i = 0; i < REGISTER_RATE_LIMIT_RPM; i++) {
        expect((await post(app, { redirect_uris: [OK_URI] })).status).toBe(201);
      }
      const res = await post(app, { redirect_uris: [OK_URI] });
      expect(res.status).toBe(429);
      expect(res.body.error).toBe('too_many_requests');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(count(db)).toBe(REGISTER_RATE_LIMIT_RPM);
    });
  });
});
