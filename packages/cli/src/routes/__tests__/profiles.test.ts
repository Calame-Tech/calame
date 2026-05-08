import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createApp } from '../../app.js';
import { AppState } from '../../state.js';
import { UserManager } from '../../user.js';
import { CalameDatabase } from '../../database.js';
import { validateProfiles } from '../profiles.js';
import { snakeCaseToLabel } from '@calame/core';
import { setupAdminAndGetCookie } from './helpers.js';

describe('profiles routes', () => {
  let app: ReturnType<typeof createApp>;
  let originalCwd: string;
  let tmpDir: string;
  let db: CalameDatabase;
  let cookie: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = path.join(os.tmpdir(), `calame-profiles-test-${Date.now()}`);
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

  describe('POST /api/profiles/save', () => {
    it('should save profiles to SQLite', async () => {
      const profilesData = {
        connection: { type: 'postgresql', envVar: 'DATABASE_URL' },
        profiles: {
          finance: {
            label: 'Finance',
            selectedTables: { invoices: ['id', 'amount'] },
            tableOptions: {},
          },
        },
      };

      const res = await request(app)
        .post('/api/profiles/save')
        .set('Cookie', cookie)
        .send(profilesData)
        .expect(200);

      expect(res.body.success).toBe(true);

      // Verify data is in SQLite
      const row = db.raw.prepare("SELECT data FROM profiles WHERE key = 'main'").get() as { data: string };
      const saved = JSON.parse(row.data);
      expect(saved.profiles.finance.label).toBe('Finance');
      expect(saved.profiles.finance.selectedTables.invoices).toEqual(['id', 'amount']);
    });

    it('should return error when profiles data is missing', async () => {
      const res = await request(app)
        .post('/api/profiles/save')
        .set('Cookie', cookie)
        .send({})
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Missing profiles');
    });

    it('should overwrite existing profiles', async () => {
      await request(app)
        .post('/api/profiles/save')
        .set('Cookie', cookie)
        .send({
          profiles: { v1: { label: 'V1', selectedTables: {}, tableOptions: {} } },
        });

      await request(app)
        .post('/api/profiles/save')
        .set('Cookie', cookie)
        .send({
          profiles: { v2: { label: 'V2', selectedTables: {}, tableOptions: {} } },
        });

      const row = db.raw.prepare("SELECT data FROM profiles WHERE key = 'main'").get() as { data: string };
      const saved = JSON.parse(row.data);
      expect(saved.profiles.v2).toBeDefined();
      expect(saved.profiles.v1).toBeUndefined();
    });

    it('normalises legacy shape to sources/scopes on save', async () => {
      const profilesData = {
        profiles: {
          legacy: {
            name: 'legacy',
            label: 'Legacy',
            connections: ['prod'],
            selectedTables: { orders: ['id', 'amount'] },
            tableOptions: {},
          },
        },
      };

      await request(app)
        .post('/api/profiles/save')
        .set('Cookie', cookie)
        .send(profilesData)
        .expect(200);

      const row = db.raw.prepare("SELECT data FROM profiles WHERE key = 'main'").get() as { data: string };
      const saved = JSON.parse(row.data) as { profiles: Record<string, Record<string, unknown>> };

      // upgradeProfileShape should have synthesised sources from connections
      expect(Array.isArray(saved.profiles['legacy']['sources'])).toBe(true);
      // scopes should be synthesised from selectedTables
      expect(typeof saved.profiles['legacy']['scopes']).toBe('object');
    });

    it('accepts a new-shape POST body (sources + scopes) without modification', async () => {
      const profilesData = {
        profiles: {
          modern: {
            name: 'modern',
            label: 'Modern',
            sources: ['dw'],
            scopes: {
              dw: {
                kind: 'relational',
                selectedTables: { events: ['id', 'type'] },
              },
            },
            // Provide minimal legacy fields so that the migrator stays idempotent
            connections: ['dw'],
            selectedTables: { events: ['id', 'type'] },
          },
        },
      };

      const res = await request(app)
        .post('/api/profiles/save')
        .set('Cookie', cookie)
        .send(profilesData)
        .expect(200);

      expect(res.body.success).toBe(true);

      const row = db.raw.prepare("SELECT data FROM profiles WHERE key = 'main'").get() as { data: string };
      const saved = JSON.parse(row.data) as { profiles: Record<string, Record<string, unknown>> };
      expect(saved.profiles['modern']['sources']).toEqual(['dw']);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((saved.profiles['modern']['scopes'] as any)['dw'].kind).toBe('relational');
    });

    it('should save multiple profiles', async () => {
      const profilesData = {
        connection: { type: 'postgresql', envVar: 'DATABASE_URL' },
        profiles: {
          finance: { label: 'Finance', selectedTables: { orders: ['id'] }, tableOptions: {} },
          dev: { label: 'Dev', selectedTables: { logs: ['id', 'message'] }, tableOptions: {} },
          support: { label: 'Support', selectedTables: { tickets: ['id'] }, tableOptions: {} },
        },
      };

      const res = await request(app)
        .post('/api/profiles/save')
        .set('Cookie', cookie)
        .send(profilesData)
        .expect(200);

      expect(res.body.success).toBe(true);

      const row = db.raw.prepare("SELECT data FROM profiles WHERE key = 'main'").get() as { data: string };
      const saved = JSON.parse(row.data);
      expect(Object.keys(saved.profiles)).toHaveLength(3);
    });
  });

  describe('GET /api/profiles/load', () => {
    it('should return found: false when no profiles exist', async () => {
      const res = await request(app)
        .get('/api/profiles/load')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.found).toBe(false);
    });

    it('should load existing profiles', async () => {
      const profilesData = {
        connection: { type: 'postgresql', envVar: 'DATABASE_URL' },
        profiles: {
          dev: { label: 'Dev Team', selectedTables: { users: ['id', 'name'] }, tableOptions: {} },
        },
      };

      // Insert directly into SQLite
      db.raw.prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)").run(JSON.stringify(profilesData));

      const res = await request(app)
        .get('/api/profiles/load')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.found).toBe(true);
      expect(res.body.profiles.dev.label).toBe('Dev Team');
      expect(res.body.profiles.dev.selectedTables.users).toEqual(['id', 'name']);
    });

    it('upgrades legacy-shape profiles to new shape on load', async () => {
      // Insert a raw legacy profile (no sources/scopes) directly into SQLite
      const legacyData = {
        profiles: {
          old: {
            name: 'old',
            label: 'Old Profile',
            connections: ['primary'],
            selectedTables: { users: ['id', 'email'] },
            tableOptions: {
              users: { enabledTools: ['query'], maxLimit: 100, filterableColumns: [], groupableColumns: [] },
            },
          },
        },
      };
      db.raw.prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)").run(JSON.stringify(legacyData));

      const res = await request(app)
        .get('/api/profiles/load')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.found).toBe(true);
      // upgradeProfileShape must have synthesised sources from connections
      expect(Array.isArray(res.body.profiles.old.sources)).toBe(true);
      expect(res.body.profiles.old.sources).toContain('primary');
      // scopes must be synthesised from selectedTables
      expect(typeof res.body.profiles.old.scopes).toBe('object');
    });

    it('returns new-shape profiles unchanged on load (idempotent)', async () => {
      const newShapeData = {
        profiles: {
          modern: {
            name: 'modern',
            label: 'Modern',
            sources: ['dw'],
            scopes: {
              dw: {
                kind: 'relational',
                selectedTables: { events: ['id', 'type'] },
              },
            },
            connections: ['dw'],
            selectedTables: { events: ['id', 'type'] },
          },
        },
      };
      db.raw.prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)").run(JSON.stringify(newShapeData));

      const res = await request(app)
        .get('/api/profiles/load')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.found).toBe(true);
      expect(res.body.profiles.modern.sources).toEqual(['dw']);
      expect(res.body.profiles.modern.scopes['dw'].kind).toBe('relational');
    });

    it('should handle malformed JSON gracefully', async () => {
      // Insert malformed JSON into SQLite
      db.raw.prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)").run('{ invalid json }}}');

      const res = await request(app)
        .get('/api/profiles/load')
        .set('Cookie', cookie)
        .expect(500);

      expect(res.body.found).toBe(false);
      expect(res.body.message).toBeDefined();
    });

    it('should roundtrip save then load', async () => {
      const profilesData = {
        connection: { type: 'postgresql', envVar: 'MY_DB_URL' },
        profiles: {
          analytics: {
            label: 'Analytics',
            selectedTables: { events: ['id', 'type', 'timestamp'] },
            tableOptions: {
              events: {
                enabledTools: ['describe', 'aggregate'],
                maxLimit: 50,
                filterableColumns: ['type', 'timestamp'],
                groupableColumns: ['type'],
              },
            },
          },
        },
      };

      await request(app)
        .post('/api/profiles/save')
        .set('Cookie', cookie)
        .send(profilesData)
        .expect(200);

      const res = await request(app)
        .get('/api/profiles/load')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.found).toBe(true);
      expect(res.body.connection.envVar).toBe('MY_DB_URL');
      expect(res.body.profiles.analytics.tableOptions.events.maxLimit).toBe(50);
      expect(res.body.profiles.analytics.tableOptions.events.enabledTools).toEqual(['describe', 'aggregate']);
    });

    it('should return warnings when schema is available and profiles reference missing tables', async () => {
      const state = new AppState();
      const localDb = new CalameDatabase(tmpDir);
      state.db = localDb;
      state.userManager = new UserManager(localDb);
      state.cachedSchema = {
        tables: [
          { name: 'users', schema: 'public', columns: [{ name: 'id', type: 'integer', nullable: false, defaultValue: null }], primaryKeys: ['id'] },
        ],
        relations: [],
      };
      const appWithSchema = createApp(state);
      const schemaCookie = await setupAdminAndGetCookie(appWithSchema);

      const profilesData = {
        profiles: {
          stale: {
            label: 'Stale',
            selectedTables: { deleted_table: ['id', 'name'] },
          },
        },
      };

      // Insert into SQLite (not file)
      localDb.raw.prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)").run(JSON.stringify(profilesData));

      const res = await request(appWithSchema)
        .get('/api/profiles/load')
        .set('Cookie', schemaCookie)
        .expect(200);

      localDb.close();
      expect(res.body.found).toBe(true);
      expect(res.body.warnings).toBeDefined();
      expect(res.body.warnings.length).toBe(1);
      expect(res.body.warnings[0].type).toBe('missing_table');
      expect(res.body.warnings[0].table).toBe('deleted_table');
      expect(res.body.warnings[0].profile).toBe('stale');
    });

    it('should return warnings for missing columns in existing tables', async () => {
      const state = new AppState();
      const localDb = new CalameDatabase(tmpDir);
      state.db = localDb;
      state.userManager = new UserManager(localDb);
      state.cachedSchema = {
        tables: [
          {
            name: 'orders',
            schema: 'public',
            columns: [
              { name: 'id', type: 'integer', nullable: false, defaultValue: null },
              { name: 'amount', type: 'numeric', nullable: false, defaultValue: null },
            ],
            primaryKeys: ['id'],
          },
        ],
        relations: [],
      };
      const appWithSchema = createApp(state);
      const schemaCookie = await setupAdminAndGetCookie(appWithSchema);

      const profilesData = {
        profiles: {
          test: {
            label: 'Test',
            selectedTables: { orders: ['id', 'amount', 'deleted_col', 'also_gone'] },
          },
        },
      };

      localDb.raw.prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)").run(JSON.stringify(profilesData));

      const res = await request(appWithSchema)
        .get('/api/profiles/load')
        .set('Cookie', schemaCookie)
        .expect(200);

      localDb.close();
      expect(res.body.found).toBe(true);
      expect(res.body.warnings.length).toBe(2);
      expect(res.body.warnings.every((w: { type: string }) => w.type === 'missing_column')).toBe(true);
      const cols = res.body.warnings.map((w: { column: string }) => w.column);
      expect(cols).toContain('deleted_col');
      expect(cols).toContain('also_gone');
    });

    it('should return no warnings when all tables and columns exist', async () => {
      const state = new AppState();
      const localDb = new CalameDatabase(tmpDir);
      state.db = localDb;
      state.userManager = new UserManager(localDb);
      state.cachedSchema = {
        tables: [
          {
            name: 'users',
            schema: 'public',
            columns: [
              { name: 'id', type: 'integer', nullable: false, defaultValue: null },
              { name: 'name', type: 'text', nullable: false, defaultValue: null },
            ],
            primaryKeys: ['id'],
          },
        ],
        relations: [],
      };
      const appWithSchema = createApp(state);
      const schemaCookie = await setupAdminAndGetCookie(appWithSchema);

      const profilesData = {
        profiles: {
          valid: { label: 'Valid', selectedTables: { users: ['id', 'name'] } },
        },
      };

      localDb.raw.prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)").run(JSON.stringify(profilesData));

      const res = await request(appWithSchema)
        .get('/api/profiles/load')
        .set('Cookie', schemaCookie)
        .expect(200);

      localDb.close();
      expect(res.body.found).toBe(true);
      expect(res.body.warnings).toEqual([]);
    });
  });
});

describe('PATCH /api/profiles/:name/response-mode', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;
  let db: CalameDatabase;
  let cookie: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `calame-patch-responsemode-${Date.now()}`);
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

  it('should return 404 when no profiles exist', async () => {
    const res = await request(app)
      .patch('/api/profiles/finance/response-mode')
      .set('Cookie', cookie)
      .send({ mode: 'friendly' })
      .expect(404);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/not found/i);
  });

  it('should return 404 when the profile name does not exist', async () => {
    db.raw
      .prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)")
      .run(JSON.stringify({ profiles: { analytics: { label: 'Analytics', selectedTables: {} } } }));

    const res = await request(app)
      .patch('/api/profiles/ghost/response-mode')
      .set('Cookie', cookie)
      .send({ mode: 'raw' })
      .expect(404);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/not found/i);
  });

  it('should return 400 for an invalid mode value', async () => {
    db.raw
      .prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)")
      .run(JSON.stringify({ profiles: { dev: { label: 'Dev', selectedTables: {} } } }));

    const res = await request(app)
      .patch('/api/profiles/dev/response-mode')
      .set('Cookie', cookie)
      .send({ mode: 'verbose' })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Invalid request body');
  });

  it('should return 400 when mode is missing', async () => {
    db.raw
      .prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)")
      .run(JSON.stringify({ profiles: { dev: { label: 'Dev', selectedTables: {} } } }));

    const res = await request(app)
      .patch('/api/profiles/dev/response-mode')
      .set('Cookie', cookie)
      .send({})
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Invalid request body');
  });

  it('should set responseMode to friendly on an existing profile', async () => {
    db.raw
      .prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)")
      .run(JSON.stringify({ profiles: { finance: { label: 'Finance', selectedTables: { invoices: ['id'] } } } }));

    const res = await request(app)
      .patch('/api/profiles/finance/response-mode')
      .set('Cookie', cookie)
      .send({ mode: 'friendly' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.profile.responseMode).toBe('friendly');

    const row = db.raw.prepare("SELECT data FROM profiles WHERE key = 'main'").get() as { data: string };
    const saved = JSON.parse(row.data) as { profiles: Record<string, { responseMode?: string }> };
    expect(saved.profiles.finance.responseMode).toBe('friendly');
  });

  it('should set responseMode to raw on an existing profile', async () => {
    db.raw
      .prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)")
      .run(JSON.stringify({ profiles: { ops: { label: 'Ops', selectedTables: {}, responseMode: 'friendly' } } }));

    const res = await request(app)
      .patch('/api/profiles/ops/response-mode')
      .set('Cookie', cookie)
      .send({ mode: 'raw' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.profile.responseMode).toBe('raw');

    const row = db.raw.prepare("SELECT data FROM profiles WHERE key = 'main'").get() as { data: string };
    const saved = JSON.parse(row.data) as { profiles: Record<string, { responseMode?: string }> };
    expect(saved.profiles.ops.responseMode).toBe('raw');
  });

  it('should preserve other profile fields when updating responseMode', async () => {
    const original = {
      profiles: {
        sales: {
          label: 'Sales',
          selectedTables: { orders: ['id', 'amount'] },
          tableOptions: { orders: { enabledTools: ['query'], maxLimit: 100, filterableColumns: [], groupableColumns: [] } },
        },
      },
    };
    db.raw
      .prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)")
      .run(JSON.stringify(original));

    await request(app)
      .patch('/api/profiles/sales/response-mode')
      .set('Cookie', cookie)
      .send({ mode: 'friendly' })
      .expect(200);

    const row = db.raw.prepare("SELECT data FROM profiles WHERE key = 'main'").get() as { data: string };
    const saved = JSON.parse(row.data) as {
      profiles: Record<string, { label: string; selectedTables: Record<string, string[]>; responseMode?: string }>;
    };
    expect(saved.profiles.sales.label).toBe('Sales');
    expect(saved.profiles.sales.selectedTables.orders).toEqual(['id', 'amount']);
    expect(saved.profiles.sales.responseMode).toBe('friendly');
  });

  it('should persist responseMode and survive a profile reload', async () => {
    db.raw
      .prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)")
      .run(
        JSON.stringify({
          profiles: {
            analytics: {
              label: 'Analytics',
              selectedTables: { events: ['id', 'type'] },
              tableOptions: {},
            },
          },
        }),
      );

    // Set responseMode via PATCH
    await request(app)
      .patch('/api/profiles/analytics/response-mode')
      .set('Cookie', cookie)
      .send({ mode: 'raw' })
      .expect(200);

    // Reload profiles and verify responseMode survived
    const res = await request(app).get('/api/profiles/load').set('Cookie', cookie).expect(200);

    expect(res.body.found).toBe(true);
    expect(res.body.profiles.analytics.responseMode).toBe('raw');
  });

  it('should preserve responseMode when saving the profile via POST /api/profiles/save', async () => {
    db.raw
      .prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)")
      .run(
        JSON.stringify({
          profiles: {
            ops: {
              label: 'Ops',
              selectedTables: { servers: ['id', 'hostname'] },
              tableOptions: {},
              responseMode: 'raw',
            },
          },
        }),
      );

    // Save the profile again with an updated label but without explicitly carrying responseMode
    // (simulate a frontend that reads the profile, modifies label, and re-saves the full object)
    const loadRes = await request(app).get('/api/profiles/load').set('Cookie', cookie).expect(200);

    const updatedProfiles = {
      ...loadRes.body,
      profiles: {
        ops: {
          ...loadRes.body.profiles.ops,
          label: 'Ops Updated',
        },
      },
    };

    await request(app)
      .post('/api/profiles/save')
      .set('Cookie', cookie)
      .send(updatedProfiles)
      .expect(200);

    const row = db.raw.prepare("SELECT data FROM profiles WHERE key = 'main'").get() as {
      data: string;
    };
    const saved = JSON.parse(row.data) as {
      profiles: Record<string, { label: string; responseMode?: string }>;
    };

    expect(saved.profiles.ops.label).toBe('Ops Updated');
    expect(saved.profiles.ops.responseMode).toBe('raw');
  });

  it('should update AppState serveProfiles when the profile is active', async () => {
    const state = new AppState();
    const localDb = new CalameDatabase(tmpDir);
    state.db = localDb;
    state.userManager = new UserManager(localDb);
    state.serveProfiles = {
      live: { name: 'live', label: 'Live', selectedTables: { users: ['id'] } },
    };
    const appWithState = createApp(state);
    const localCookie = await setupAdminAndGetCookie(appWithState);

    localDb.raw
      .prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)")
      .run(JSON.stringify({ profiles: { live: { label: 'Live', selectedTables: { users: ['id'] } } } }));

    await request(appWithState)
      .patch('/api/profiles/live/response-mode')
      .set('Cookie', localCookie)
      .send({ mode: 'friendly' })
      .expect(200);

    expect(state.serveProfiles.live.responseMode).toBe('friendly');
    localDb.close();
  });
});

describe('snakeCaseToLabel', () => {
  it('should convert snake_case to Title Case', () => {
    expect(snakeCaseToLabel('user_orders')).toBe('User Orders');
    expect(snakeCaseToLabel('invoice_line_items')).toBe('Invoice Line Items');
  });

  it('should convert camelCase to Title Case with spaces', () => {
    expect(snakeCaseToLabel('lineItems')).toBe('Line Items');
    expect(snakeCaseToLabel('userProfile')).toBe('User Profile');
  });

  it('should handle single words', () => {
    expect(snakeCaseToLabel('users')).toBe('Users');
    expect(snakeCaseToLabel('orders')).toBe('Orders');
  });

  it('should handle already capitalized words', () => {
    expect(snakeCaseToLabel('ID')).toBe('Id');
    expect(snakeCaseToLabel('amount')).toBe('Amount');
  });
});

describe('validateProfiles', () => {
  const schemaTables = [
    { name: 'users', columns: [{ name: 'id' }, { name: 'name' }, { name: 'email' }] },
    { name: 'orders', columns: [{ name: 'id' }, { name: 'amount' }] },
  ];

  it('should return no warnings for valid profiles', () => {
    const profiles = {
      p1: { selectedTables: { users: ['id', 'name'], orders: ['id'] } },
    };
    const warnings = validateProfiles(profiles, schemaTables);
    expect(warnings).toEqual([]);
  });

  it('should warn about missing tables', () => {
    const profiles = {
      p1: { selectedTables: { users: ['id'], ghost: ['a'] } },
    };
    const warnings = validateProfiles(profiles, schemaTables);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toEqual({ profile: 'p1', type: 'missing_table', table: 'ghost' });
  });

  it('should warn about missing columns', () => {
    const profiles = {
      p1: { selectedTables: { users: ['id', 'deleted_field'] } },
    };
    const warnings = validateProfiles(profiles, schemaTables);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toEqual({ profile: 'p1', type: 'missing_column', table: 'users', column: 'deleted_field' });
  });

  it('should handle multiple profiles with mixed warnings', () => {
    const profiles = {
      finance: { selectedTables: { orders: ['id', 'amount'] } },
      stale: { selectedTables: { removed_table: ['x'], users: ['id', 'gone_col'] } },
    };
    const warnings = validateProfiles(profiles, schemaTables);
    expect(warnings.length).toBe(2);
    expect(warnings.find((w) => w.type === 'missing_table')?.table).toBe('removed_table');
    expect(warnings.find((w) => w.type === 'missing_column')?.column).toBe('gone_col');
  });

  it('should handle profiles with no selectedTables', () => {
    const profiles = {
      empty: { selectedTables: undefined as unknown as Record<string, string[]> },
    };
    const warnings = validateProfiles(profiles, schemaTables);
    expect(warnings).toEqual([]);
  });
});
