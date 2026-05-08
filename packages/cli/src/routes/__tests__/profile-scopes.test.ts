import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createApp } from '../../app.js';
import { AppState } from '../../state.js';
import { UserManager } from '../../user.js';
import { CalameDatabase } from '../../database.js';
import { setupAdminAndGetCookie } from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a profile into SQLite and return the key row. */
function insertProfiles(
  db: CalameDatabase,
  profiles: Record<string, Record<string, unknown>>,
): void {
  db.raw
    .prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)")
    .run(JSON.stringify({ profiles }));
}

/** Read the raw profile object from SQLite. */
function readProfiles(db: CalameDatabase): Record<string, Record<string, unknown>> {
  const row = db.raw
    .prepare("SELECT data FROM profiles WHERE key = 'main'")
    .get() as { data: string } | undefined;
  if (!row) return {};
  const data = JSON.parse(row.data) as { profiles?: Record<string, Record<string, unknown>> };
  return data.profiles ?? {};
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('profile-scopes routes', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;
  let db: CalameDatabase;
  let cookie: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `calame-scopes-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });

    const state = new AppState();
    db = new CalameDatabase(tmpDir);
    state.db = db;
    state.userManager = new UserManager(db);
    app = createApp(state);
    cookie = await setupAdminAndGetCookie(app);
  });

  afterEach(async () => {
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // --------------------------------------------------------------------------
  // POST /api/profiles/:name/scopes
  // --------------------------------------------------------------------------

  describe('POST /api/profiles/:name/scopes', () => {
    it('returns 404 when no profiles exist', async () => {
      const res = await request(app)
        .post('/api/profiles/finance/scopes')
        .set('Cookie', cookie)
        .send({ sources: ['default'], scopes: {} })
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/not found/i);
    });

    it('returns 404 when the named profile does not exist', async () => {
      insertProfiles(db, {
        dev: { name: 'dev', label: 'Dev', selectedTables: {} },
      });

      const res = await request(app)
        .post('/api/profiles/ghost/scopes')
        .set('Cookie', cookie)
        .send({ sources: ['default'], scopes: {} })
        .expect(404);

      expect(res.body.success).toBe(false);
    });

    it('returns 400 when sources array is missing', async () => {
      insertProfiles(db, {
        dev: { name: 'dev', label: 'Dev', selectedTables: {} },
      });

      const res = await request(app)
        .post('/api/profiles/dev/scopes')
        .set('Cookie', cookie)
        .send({ scopes: {} }) // missing sources
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Invalid request body');
    });

    it('returns 400 when sources is empty', async () => {
      insertProfiles(db, {
        dev: { name: 'dev', label: 'Dev', selectedTables: {} },
      });

      const res = await request(app)
        .post('/api/profiles/dev/scopes')
        .set('Cookie', cookie)
        .send({ sources: [], scopes: {} })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('updates the profile with new sources and scopes', async () => {
      insertProfiles(db, {
        finance: {
          name: 'finance',
          label: 'Finance',
          connections: ['prod'],
          selectedTables: { invoices: ['id', 'amount'] },
        },
      });

      const newScopes = {
        prod: {
          kind: 'relational',
          selectedTables: { invoices: ['id', 'amount', 'status'] },
        },
      };

      const res = await request(app)
        .post('/api/profiles/finance/scopes')
        .set('Cookie', cookie)
        .send({ sources: ['prod'], scopes: newScopes })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.profile.sources).toEqual(['prod']);
      expect(res.body.profile.scopes.prod.selectedTables.invoices).toContain('status');
    });

    it('persists updated scopes to SQLite', async () => {
      insertProfiles(db, {
        analytics: {
          name: 'analytics',
          label: 'Analytics',
          connections: ['dw'],
          selectedTables: { events: ['id'] },
        },
      });

      await request(app)
        .post('/api/profiles/analytics/scopes')
        .set('Cookie', cookie)
        .send({
          sources: ['dw'],
          scopes: {
            dw: {
              kind: 'relational',
              selectedTables: { events: ['id', 'type', 'timestamp'] },
            },
          },
        })
        .expect(200);

      const profiles = readProfiles(db);
      expect(profiles['analytics'].sources).toEqual(['dw']);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const scope = (profiles['analytics'].scopes as any)['dw'];
      expect(scope.selectedTables.events).toContain('type');
    });

    it('preserves other profile fields (label, responseMode, etc.)', async () => {
      insertProfiles(db, {
        ops: {
          name: 'ops',
          label: 'Operations',
          responseMode: 'raw',
          connections: ['infra'],
          selectedTables: { servers: ['id'] },
        },
      });

      const res = await request(app)
        .post('/api/profiles/ops/scopes')
        .set('Cookie', cookie)
        .send({
          sources: ['infra'],
          scopes: {
            infra: {
              kind: 'relational',
              selectedTables: { servers: ['id', 'hostname'] },
            },
          },
        })
        .expect(200);

      expect(res.body.profile.label).toBe('Operations');
      expect(res.body.profile.responseMode).toBe('raw');
    });

    it('accepts a multi-source payload and persists both scopes', async () => {
      insertProfiles(db, {
        multi: {
          name: 'multi',
          label: 'Multi-source',
          connections: ['db1', 'db2'],
          selectedTables: { users: ['id'] },
        },
      });

      const res = await request(app)
        .post('/api/profiles/multi/scopes')
        .set('Cookie', cookie)
        .send({
          sources: ['db1', 'db2'],
          scopes: {
            db1: { kind: 'relational', selectedTables: { users: ['id', 'email'] } },
            db2: { kind: 'relational', selectedTables: { orders: ['id', 'amount'] } },
          },
        })
        .expect(200);

      expect(res.body.profile.sources).toEqual(['db1', 'db2']);
      expect(res.body.profile.scopes['db1'].selectedTables).toHaveProperty('users');
      expect(res.body.profile.scopes['db2'].selectedTables).toHaveProperty('orders');
    });

    it('normalises a legacy-body POST to the new shape on disk', async () => {
      // Insert a profile in the legacy shape
      insertProfiles(db, {
        legacy: {
          name: 'legacy',
          label: 'Legacy',
          connections: ['old_db'],
          selectedTables: { orders: ['id', 'amount'] },
        },
      });

      // POST scopes using new shape
      await request(app)
        .post('/api/profiles/legacy/scopes')
        .set('Cookie', cookie)
        .send({
          sources: ['old_db'],
          scopes: {
            old_db: {
              kind: 'relational',
              selectedTables: { orders: ['id', 'amount', 'status'] },
            },
          },
        })
        .expect(200);

      // Verify new shape on disk
      const profiles = readProfiles(db);
      expect(profiles['legacy']).toHaveProperty('sources');
      expect(profiles['legacy']).toHaveProperty('scopes');
    });
  });

  // --------------------------------------------------------------------------
  // GET /api/profiles/:name/scopes/preview
  // --------------------------------------------------------------------------

  describe('GET /api/profiles/:name/scopes/preview', () => {
    it('returns 404 when no profiles exist', async () => {
      const res = await request(app)
        .get('/api/profiles/finance/scopes/preview')
        .set('Cookie', cookie)
        .expect(404);

      expect(res.body.success).toBe(false);
    });

    it('returns 404 when the named profile does not exist', async () => {
      insertProfiles(db, {
        dev: { name: 'dev', label: 'Dev', selectedTables: {} },
      });

      const res = await request(app)
        .get('/api/profiles/ghost/scopes/preview')
        .set('Cookie', cookie)
        .expect(404);

      expect(res.body.success).toBe(false);
    });

    it('returns table counts for a relational profile', async () => {
      insertProfiles(db, {
        finance: {
          name: 'finance',
          label: 'Finance',
          sources: ['prod'],
          scopes: {
            prod: {
              kind: 'relational',
              selectedTables: { invoices: ['id'], orders: ['id', 'amount'] },
            },
          },
          connections: ['prod'],
          selectedTables: { invoices: ['id'], orders: ['id', 'amount'] },
        },
      });

      const res = await request(app)
        .get('/api/profiles/finance/scopes/preview')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.totals.tables).toBe(2);
      expect(res.body.totals.folders).toBe(0);
      expect(res.body.totals.documents).toBe(0);

      const prodSource = res.body.sources.find((s: { id: string }) => s.id === 'prod');
      expect(prodSource).toBeDefined();
      expect(prodSource.kind).toBe('relational');
      expect(prodSource.summary.selectedTables).toBe(2);
    });

    it('returns zero counts for a profile with no scopes', async () => {
      insertProfiles(db, {
        empty: {
          name: 'empty',
          label: 'Empty',
          connections: ['default'],
          selectedTables: {},
        },
      });

      const res = await request(app)
        .get('/api/profiles/empty/scopes/preview')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.success).toBe(true);
      // With empty selectedTables, the migrator doesn't create any scope block
      // (buildRelationalScopeBlock returns null for empty objects).
      // sources may be ['default'] from connections, scopes will be empty.
      expect(res.body.totals.tables).toBe(0);
    });

    it('returns document counts for a document-kind scope', async () => {
      insertProfiles(db, {
        kb: {
          name: 'kb',
          label: 'Knowledge Base',
          sources: ['kb1'],
          scopes: {
            kb1: {
              kind: 'document',
              mode: 'allowList',
              allowedFolders: ['docs', 'specs'],
              allowedDocuments: ['readme.md'],
            },
          },
          connections: [],
          selectedTables: {},
        },
      });

      const res = await request(app)
        .get('/api/profiles/kb/scopes/preview')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.totals.folders).toBe(2);
      expect(res.body.totals.documents).toBe(1);
      expect(res.body.totals.tables).toBe(0);

      const kbSource = res.body.sources.find((s: { id: string }) => s.id === 'kb1');
      expect(kbSource.kind).toBe('document');
      expect(kbSource.summary.allowedFolders).toBe(2);
    });

    it('returns sane counts for a multi-source profile', async () => {
      insertProfiles(db, {
        mixed: {
          name: 'mixed',
          label: 'Mixed',
          sources: ['db1', 'kb1'],
          scopes: {
            db1: {
              kind: 'relational',
              selectedTables: { users: ['id'], orders: ['id'] },
            },
            kb1: {
              kind: 'document',
              mode: 'allowList',
              allowedFolders: ['faq'],
              allowedDocuments: [],
            },
          },
          connections: ['db1'],
          selectedTables: { users: ['id'], orders: ['id'] },
        },
      });

      const res = await request(app)
        .get('/api/profiles/mixed/scopes/preview')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.totals.tables).toBe(2);
      expect(res.body.totals.folders).toBe(1);
      expect(res.body.totals.documents).toBe(0);
      expect(res.body.sources).toHaveLength(2);
    });
  });
});
