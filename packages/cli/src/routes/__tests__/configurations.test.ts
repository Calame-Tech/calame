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

describe('configurations routes', () => {
  let app: ReturnType<typeof createApp>;
  let originalCwd: string;
  let tmpDir: string;
  let db: CalameDatabase;
  let cookie: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = path.join(os.tmpdir(), `calame-configurations-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    process.chdir(tmpDir);

    const state = new AppState();
    db = new CalameDatabase(tmpDir);
    state.db = db;
    state.userManager = new UserManager(db);
    app = createApp(state);
    cookie = await setupAdminAndGetCookie(app);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // ---------------------------------------------------------------------------
  // GET /api/configurations
  // ---------------------------------------------------------------------------

  describe('GET /api/configurations', () => {
    it('returns an empty object when no configurations exist', async () => {
      const res = await request(app)
        .get('/api/configurations')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.configurations).toEqual({});
    });

    it('returns stored configurations with sources/scopes (upgraded on read)', async () => {
      // Insert a legacy row directly into SQLite
      db.raw
        .prepare(
          `INSERT INTO configurations (name, label, connections, selected_tables, table_options, column_masking)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'finance',
          'Finance',
          JSON.stringify(['prod']),
          JSON.stringify({ invoices: ['id', 'amount'] }),
          null,
          null,
        );

      const res = await request(app)
        .get('/api/configurations')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.success).toBe(true);
      const cfg = res.body.configurations['finance'];
      expect(cfg).toBeDefined();
      // upgradeConfigurationShape must synthesise sources/scopes on read
      expect(Array.isArray(cfg.sources)).toBe(true);
      expect(cfg.sources).toContain('prod');
      expect(typeof cfg.scopes).toBe('object');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/configurations — legacy shape (connections + selectedTables)
  // ---------------------------------------------------------------------------

  describe('POST /api/configurations — legacy shape', () => {
    it('creates a configuration with the legacy shape and returns success', async () => {
      const res = await request(app)
        .post('/api/configurations')
        .set('Cookie', cookie)
        .send({
          name: 'analytics',
          label: 'Analytics',
          connections: ['warehouse'],
          selectedTables: { events: ['id', 'type'] },
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.name).toBe('analytics');
      expect(res.body.overwritten).toBe(false);
    });

    it('normalises legacy shape to sources/scopes on write — GET reflects unified shape', async () => {
      await request(app)
        .post('/api/configurations')
        .set('Cookie', cookie)
        .send({
          name: 'legacy',
          connections: ['db1'],
          selectedTables: { users: ['id', 'email'] },
        })
        .expect(200);

      const row = db.raw
        .prepare('SELECT connections, selected_tables, sources_scopes FROM configurations WHERE name = ?')
        .get('legacy') as { connections: string; selected_tables: string; sources_scopes: string | null };

      // Phase 5: upgradeConfigurationShape strips legacy root fields and folds
      // them into sources/scopes. The SQLite NOT-NULL columns receive empty
      // fallbacks; the real data lives in the sources_scopes blob.
      expect(JSON.parse(row.connections)).toEqual([]);
      expect(JSON.parse(row.selected_tables)).toEqual({});
      expect(row.sources_scopes).not.toBeNull();

      // Verify via GET that the unified shape is returned correctly.
      const res = await request(app)
        .get('/api/configurations')
        .set('Cookie', cookie)
        .expect(200);

      const cfg = res.body.configurations['legacy'];
      expect(Array.isArray(cfg.sources)).toBe(true);
      expect(cfg.sources).toContain('db1');
      expect(typeof cfg.scopes).toBe('object');
    });

    it('sets overwritten: true when the configuration already exists', async () => {
      await request(app)
        .post('/api/configurations')
        .set('Cookie', cookie)
        .send({ name: 'dup', connections: ['x'], selectedTables: {} });

      const res = await request(app)
        .post('/api/configurations')
        .set('Cookie', cookie)
        .send({ name: 'dup', connections: ['x'], selectedTables: {} })
        .expect(200);

      expect(res.body.overwritten).toBe(true);
    });

    it('uses name as label when label is absent', async () => {
      await request(app)
        .post('/api/configurations')
        .set('Cookie', cookie)
        .send({ name: 'no-label', connections: ['x'], selectedTables: {} })
        .expect(200);

      const row = db.raw
        .prepare('SELECT label FROM configurations WHERE name = ?')
        .get('no-label') as { label: string };

      expect(row.label).toBe('no-label');
    });

    it('writes tenant_id = "default" on the row (Phase A multi-tenancy)', async () => {
      // Backward-compat assertion: every fresh INSERT must land under the
      // Phase A default tenant. If this flips, somewhere in the write path
      // started reading the request's tenant — which would be Phase B
      // territory and must be done deliberately.
      await request(app)
        .post('/api/configurations')
        .set('Cookie', cookie)
        .send({ name: 'tenant-check', connections: ['db1'], selectedTables: { t: ['id'] } })
        .expect(200);

      const row = db.raw
        .prepare('SELECT tenant_id FROM configurations WHERE name = ?')
        .get('tenant-check') as { tenant_id: string };

      expect(row.tenant_id).toBe('default');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/configurations — Phase 5 unified shape (sources + scopes)
  // ---------------------------------------------------------------------------

  describe('POST /api/configurations — Phase 5 unified shape (sources + scopes)', () => {
    it('accepts a payload with sources + scopes and returns success', async () => {
      const res = await request(app)
        .post('/api/configurations')
        .set('Cookie', cookie)
        .send({
          name: 'modern',
          label: 'Modern',
          sources: ['dw'],
          scopes: {
            dw: {
              kind: 'relational',
              selectedTables: { orders: ['id', 'amount'] },
            },
          },
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.name).toBe('modern');
    });

    it('persists sources/scopes — GET returns the unified shape unchanged', async () => {
      await request(app)
        .post('/api/configurations')
        .set('Cookie', cookie)
        .send({
          name: 'unified',
          sources: ['warehouse'],
          scopes: {
            warehouse: {
              kind: 'relational',
              selectedTables: { events: ['id', 'ts'] },
            },
          },
        })
        .expect(200);

      const res = await request(app)
        .get('/api/configurations')
        .set('Cookie', cookie)
        .expect(200);

      const cfg = res.body.configurations['unified'];
      expect(cfg.sources).toEqual(['warehouse']);
      expect(cfg.scopes['warehouse'].kind).toBe('relational');
      expect(cfg.scopes['warehouse'].selectedTables.events).toEqual(['id', 'ts']);
    });

    it('accepts a payload with only scopes (no sources array) and returns success', async () => {
      const res = await request(app)
        .post('/api/configurations')
        .set('Cookie', cookie)
        .send({
          name: 'scopes-only',
          scopes: {
            mydb: {
              kind: 'relational',
              selectedTables: { logs: ['id'] },
            },
          },
        })
        .expect(200);

      expect(res.body.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/configurations — validation errors (400)
  // ---------------------------------------------------------------------------

  describe('POST /api/configurations — validation errors', () => {
    it('returns 400 when name is missing', async () => {
      const res = await request(app)
        .post('/api/configurations')
        .set('Cookie', cookie)
        .send({ connections: ['x'], selectedTables: {} })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/name/i);
    });

    it('returns 400 when name is not a string', async () => {
      const res = await request(app)
        .post('/api/configurations')
        .set('Cookie', cookie)
        .send({ name: 42, connections: ['x'], selectedTables: {} })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('returns 400 when neither legacy nor unified fields are provided', async () => {
      const res = await request(app)
        .post('/api/configurations')
        .set('Cookie', cookie)
        .send({ name: 'empty' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/connections.*selectedTables.*sources.*scopes/i);
    });

    it('returns 400 when connections is present but empty and scopes is absent', async () => {
      const res = await request(app)
        .post('/api/configurations')
        .set('Cookie', cookie)
        .send({ name: 'bad', connections: [], selectedTables: {} })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('returns 400 when sources is present but empty and scopes is absent', async () => {
      const res = await request(app)
        .post('/api/configurations')
        .set('Cookie', cookie)
        .send({ name: 'bad', sources: [] })
        .expect(400);

      expect(res.body.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/configurations/:name
  // ---------------------------------------------------------------------------

  describe('DELETE /api/configurations/:name', () => {
    it('deletes an existing configuration and returns success', async () => {
      await request(app)
        .post('/api/configurations')
        .set('Cookie', cookie)
        .send({ name: 'to-delete', connections: ['x'], selectedTables: {} })
        .expect(200);

      const res = await request(app)
        .delete('/api/configurations/to-delete')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.success).toBe(true);

      const row = db.raw
        .prepare('SELECT name FROM configurations WHERE name = ?')
        .get('to-delete');
      expect(row).toBeUndefined();
    });

    it('returns 404 when the configuration does not exist', async () => {
      const res = await request(app)
        .delete('/api/configurations/ghost')
        .set('Cookie', cookie)
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/ghost/);
    });
  });
});
