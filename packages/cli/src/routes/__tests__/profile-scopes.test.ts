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
  let state: AppState;
  let cookie: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `calame-scopes-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });

    state = new AppState();
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

    it('accepts an empty sources array (profile with no source assigned)', async () => {
      insertProfiles(db, {
        dev: {
          name: 'dev',
          label: 'Dev',
          sources: ['prod'],
          scopes: {
            prod: { kind: 'relational', selectedTables: { users: ['id'] } },
          },
          selectedTables: {},
        },
      });

      const res = await request(app)
        .post('/api/profiles/dev/scopes')
        .set('Cookie', cookie)
        .send({ sources: [], scopes: {} })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.profile.sources).toEqual([]);
      expect(res.body.profile.scopes).toEqual({});
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

    // ------------------------------------------------------------------------
    // Phase 4: enriched counts
    // ------------------------------------------------------------------------

    it('returns counts and live=true for a relational scope', async () => {
      insertProfiles(db, {
        rel: {
          name: 'rel',
          label: 'Relational',
          sources: ['pg'],
          scopes: {
            pg: {
              kind: 'relational',
              selectedTables: { users: ['id', 'email'], orders: ['id', 'amount', 'status'] },
            },
          },
          connections: ['pg'],
          selectedTables: {},
        },
      });

      const res = await request(app)
        .get('/api/profiles/rel/scopes/preview')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.success).toBe(true);

      const src = res.body.sources.find((s: { id: string }) => s.id === 'pg');
      expect(src).toBeDefined();
      expect(src.kind).toBe('relational');
      // New counts field
      expect(src.counts).toBeDefined();
      expect(src.counts.tables).toBe(2);
      expect(src.counts.columns).toBe(5); // 2 + 3
      // live flag
      expect(src.live).toBe(true);

      // Totals include columns
      expect(res.body.totals.columns).toBe(5);
    });

    it('returns live=false with naive counts when ragRuntime is absent (document scope)', async () => {
      // state.ragRuntime is undefined by default in this test suite (no RAG bootstrap).
      insertProfiles(db, {
        kb2: {
          name: 'kb2',
          label: 'KB 2',
          sources: ['docs1'],
          scopes: {
            docs1: {
              kind: 'document',
              mode: 'allowList',
              allowedFolders: ['api', 'guides', 'faq'],
              allowedDocuments: ['readme.md', 'changelog.md'],
            },
          },
          connections: [],
          selectedTables: {},
        },
      });

      const res = await request(app)
        .get('/api/profiles/kb2/scopes/preview')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.success).toBe(true);

      const src = res.body.sources.find((s: { id: string }) => s.id === 'docs1');
      expect(src).toBeDefined();
      expect(src.kind).toBe('document');
      // Fallback: naive counts from the arrays
      expect(src.counts.folders).toBe(3);
      expect(src.counts.documents).toBe(2);
      expect(src.counts.chunks).toBe(0);
      // live=false signals approximation
      expect(src.live).toBe(false);

      // Totals
      expect(res.body.totals.folders).toBe(3);
      expect(res.body.totals.documents).toBe(2);
      expect(res.body.totals.chunks).toBe(0);
    });

    it('returns live=false for document allowAll scope when ragRuntime is absent', async () => {
      insertProfiles(db, {
        kball: {
          name: 'kball',
          label: 'KB All',
          sources: ['src1'],
          scopes: {
            src1: {
              kind: 'document',
              mode: 'allowAll',
              allowedFolders: [],
              allowedDocuments: [],
            },
          },
          connections: [],
          selectedTables: {},
        },
      });

      const res = await request(app)
        .get('/api/profiles/kball/scopes/preview')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.success).toBe(true);
      const src = res.body.sources.find((s: { id: string }) => s.id === 'src1');
      expect(src).toBeDefined();
      expect(src.live).toBe(false);
      expect(src.counts.chunks).toBe(0);
    });

    // ----------------------------------------------------------------------
    // Live document counts (state.ragRuntime present + RAG tables populated)
    // ----------------------------------------------------------------------

    /**
     * Helper that creates the minimal `rag_*` tables directly on the test DB
     * and inserts a small fixture (1 source, 2 folders, 3 docs, 5 chunks).
     * Mirrors `runRagMigrations` so the preview SQL can resolve.
     */
    function setupRagFixtures(): void {
      db.raw.exec(`CREATE TABLE IF NOT EXISTS rag_folders (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        parent_id TEXT,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.raw.exec(`CREATE TABLE IF NOT EXISTS rag_documents (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        folder_id TEXT,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        hash TEXT NOT NULL,
        etag TEXT,
        last_indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at TEXT
      )`);
      db.raw.exec(`CREATE TABLE IF NOT EXISTS rag_chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        text TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        embedding_dimensions INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);

      // Source `kb` with two folders
      db.raw
        .prepare(
          `INSERT INTO rag_folders (id, source_id, parent_id, path, name) VALUES (?, ?, NULL, ?, ?)`,
        )
        .run('f-faq', 'kb', 'docs/faq', 'faq');
      db.raw
        .prepare(
          `INSERT INTO rag_folders (id, source_id, parent_id, path, name) VALUES (?, ?, NULL, ?, ?)`,
        )
        .run('f-guides', 'kb', 'docs/guides', 'guides');

      // 2 docs in faq, 1 in guides, 1 soft-deleted in faq
      const insDoc = db.raw.prepare(
        `INSERT INTO rag_documents (id, source_id, folder_id, path, name, mime_type, size, hash, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insDoc.run('d1', 'kb', 'f-faq', 'docs/faq/intro.pdf', 'intro.pdf', 'application/pdf', 1024, 'h1', null);
      insDoc.run('d2', 'kb', 'f-faq', 'docs/faq/faq.md', 'faq.md', 'text/markdown', 512, 'h2', null);
      insDoc.run('d3', 'kb', 'f-guides', 'docs/guides/start.md', 'start.md', 'text/markdown', 256, 'h3', null);
      insDoc.run('d4', 'kb', 'f-faq', 'docs/faq/old.pdf', 'old.pdf', 'application/pdf', 768, 'h4', '2026-05-01T00:00:00Z');

      // 5 chunks total: 2 on d1, 2 on d2, 1 on d3, 0 on d4 (soft-deleted)
      const insChunk = db.raw.prepare(
        `INSERT INTO rag_chunks (id, document_id, position, text, token_count, embedding_dimensions)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      insChunk.run('c1', 'd1', 0, 'a', 10, 1536);
      insChunk.run('c2', 'd1', 1, 'b', 10, 1536);
      insChunk.run('c3', 'd2', 0, 'c', 10, 1536);
      insChunk.run('c4', 'd2', 1, 'd', 10, 1536);
      insChunk.run('c5', 'd3', 0, 'e', 10, 1536);
    }

    it('returns live=true with SQL counts for document allowAll scope', async () => {
      setupRagFixtures();
      // Activate the live-count path. The route only checks truthiness.
      state.ragRuntime = {} as unknown as AppState['ragRuntime'];

      insertProfiles(db, {
        kbprof: {
          name: 'kbprof',
          label: 'KB Profile',
          sources: ['kb'],
          scopes: {
            kb: {
              kind: 'document',
              mode: 'allowAll',
              allowedFolders: [],
              allowedDocuments: [],
            },
          },
          connections: [],
          selectedTables: {},
        },
      });

      const res = await request(app)
        .get('/api/profiles/kbprof/scopes/preview')
        .set('Cookie', cookie)
        .expect(200);

      const src = res.body.sources.find((s: { id: string }) => s.id === 'kb');
      expect(src).toBeDefined();
      expect(src.live).toBe(true);
      // Fixture: 3 non-deleted docs (d1, d2, d3) — d4 is soft-deleted
      expect(src.counts.documents).toBe(3);
      expect(src.counts.folders).toBe(2);
      // 5 chunks total but only c1..c4 (on d1, d2) and c5 (on d3) — all visible
      expect(src.counts.chunks).toBe(5);
    });

    it('returns live=true with SQL counts for document allowList scope (folder + explicit doc union)', async () => {
      setupRagFixtures();
      state.ragRuntime = {} as unknown as AppState['ragRuntime'];

      insertProfiles(db, {
        kbpartial: {
          name: 'kbpartial',
          label: 'KB Partial',
          sources: ['kb'],
          scopes: {
            kb: {
              kind: 'document',
              mode: 'allowList',
              // Allow the `guides` folder (resolves to d3) + explicit doc d1 from faq
              allowedFolders: ['docs/guides'],
              allowedDocuments: ['d1'],
            },
          },
          connections: [],
          selectedTables: {},
        },
      });

      const res = await request(app)
        .get('/api/profiles/kbpartial/scopes/preview')
        .set('Cookie', cookie)
        .expect(200);

      const src = res.body.sources.find((s: { id: string }) => s.id === 'kb');
      expect(src).toBeDefined();
      expect(src.live).toBe(true);
      // Union of `docs/guides` (1 doc: d3) + explicit `d1` (1 doc) = 2 docs
      expect(src.counts.documents).toBe(2);
      expect(src.counts.folders).toBe(1);
      // Chunks for the union: d1 has 2 (c1, c2), d3 has 1 (c5) = 3
      expect(src.counts.chunks).toBe(3);
    });

    it('live=true: ignores soft-deleted docs from allowList explicit IDs', async () => {
      setupRagFixtures();
      state.ragRuntime = {} as unknown as AppState['ragRuntime'];

      insertProfiles(db, {
        kbsoft: {
          name: 'kbsoft',
          label: 'KB Soft-deleted',
          sources: ['kb'],
          scopes: {
            kb: {
              kind: 'document',
              mode: 'allowList',
              allowedFolders: [],
              // d4 is soft-deleted — should not be counted
              allowedDocuments: ['d4', 'd1'],
            },
          },
          connections: [],
          selectedTables: {},
        },
      });

      const res = await request(app)
        .get('/api/profiles/kbsoft/scopes/preview')
        .set('Cookie', cookie)
        .expect(200);

      const src = res.body.sources.find((s: { id: string }) => s.id === 'kb');
      expect(src.counts.documents).toBe(1); // only d1 — d4 filtered by deleted_at
      expect(src.counts.chunks).toBe(2); // c1 + c2
    });

    it('new totals fields are present and zero-valued when no data', async () => {
      insertProfiles(db, {
        empty2: {
          name: 'empty2',
          label: 'Empty 2',
          sources: ['x'],
          scopes: {
            x: {
              kind: 'relational',
              selectedTables: {},
            },
          },
          connections: ['x'],
          selectedTables: {},
        },
      });

      const res = await request(app)
        .get('/api/profiles/empty2/scopes/preview')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.totals.columns).toBe(0);
      expect(res.body.totals.chunks).toBe(0);
    });
  });
});
