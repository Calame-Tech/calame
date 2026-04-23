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

describe('POST /api/profiles/:name/preview', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;
  let db: CalameDatabase;
  let cookie: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `calame-preview-test-${Date.now()}`);
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

  it('should return 404 when no profiles exist in the database', async () => {
    const res = await request(app)
      .post('/api/profiles/nonexistent/preview')
      .set('Cookie', cookie)
      .expect(404);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/not found/i);
  });

  it('should return 404 when profiles exist but requested profile is missing', async () => {
    // Insert profiles data that does not include "nonexistent"
    const profilesData = {
      profiles: {
        dev: {
          label: 'Dev',
          selectedTables: { users: ['id', 'name'] },
        },
      },
    };
    db.raw
      .prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)")
      .run(JSON.stringify(profilesData));

    const res = await request(app)
      .post('/api/profiles/nonexistent/preview')
      .set('Cookie', cookie)
      .expect(404);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/not found/i);
  });

  it('should return success with preview structure for a known profile (no active connection)', async () => {
    const profilesData = {
      profiles: {
        analytics: {
          label: 'Analytics',
          connections: ['default'],
          selectedTables: {
            orders: ['id', 'amount', 'status'],
          },
          tableOptions: {
            orders: {
              enabledTools: ['describe', 'query'],
              maxLimit: 100,
              filterableColumns: ['status'],
              groupableColumns: [],
            },
          },
        },
      },
    };
    db.raw
      .prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)")
      .run(JSON.stringify(profilesData));

    const res = await request(app)
      .post('/api/profiles/analytics/preview')
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.preview).toBeDefined();
    expect(res.body.preview.profileName).toBe('analytics');
    expect(Array.isArray(res.body.preview.tables)).toBe(true);
    expect(res.body.preview.tables).toHaveLength(1);

    const table = res.body.preview.tables[0];
    expect(table.name).toBe('orders');
    expect(table.enabledTools).toContain('describe');
    expect(table.enabledTools).toContain('query');
    // Row count and sampleRow will be 0/null because there is no active DB connection
    expect(table.rowCount).toBe(0);
    expect(table.sampleRow).toBeNull();
  });

  it('should show column visibility with masking config', async () => {
    const profilesData = {
      profiles: {
        secure: {
          label: 'Secure',
          connections: ['default'],
          selectedTables: {
            users: ['id', 'email', 'ssn'],
          },
          columnMasking: {
            users: {
              ssn: { maskingMode: 'exclude' },
              email: { maskingMode: 'hash' },
            },
          },
        },
      },
    };
    db.raw
      .prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)")
      .run(JSON.stringify(profilesData));

    // Add a fake connection to state so column info can be resolved
    const state = new AppState();
    const stateDb = new CalameDatabase(tmpDir);
    state.db = stateDb;
    state.userManager = new UserManager(stateDb);
    // Insert profile data into this state's db too
    stateDb.raw
      .prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)")
      .run(JSON.stringify(profilesData));

    state.addConnection('default', {
      connection: {
        name: 'default',
        label: 'Default',
        databaseType: 'postgresql',
        connectionString: 'postgresql://localhost/test',
      },
      schema: {
        tables: [
          {
            name: 'users',
            schema: 'public',
            columns: [
              { name: 'id', type: 'integer', nullable: false, defaultValue: null },
              { name: 'email', type: 'text', nullable: false, defaultValue: null },
              { name: 'ssn', type: 'text', nullable: true, defaultValue: null },
            ],
            primaryKeys: ['id'],
          },
        ],
        relations: [],
      },
      piiDetections: null,
    });

    const stateApp = createApp(state);
    const stateCookie = await setupAdminAndGetCookie(stateApp);

    const res = await request(stateApp)
      .post('/api/profiles/secure/preview')
      .set('Cookie', stateCookie)
      .expect(200);

    stateDb.close();

    expect(res.body.success).toBe(true);
    const table = res.body.preview.tables[0];
    expect(table.name).toBe('users');

    const idCol = table.columns.find((c: { name: string }) => c.name === 'id');
    const emailCol = table.columns.find((c: { name: string }) => c.name === 'email');
    const ssnCol = table.columns.find((c: { name: string }) => c.name === 'ssn');

    expect(idCol?.visible).toBe(true);
    expect(idCol?.masking).toBeUndefined();

    expect(emailCol?.visible).toBe(true);
    expect(emailCol?.masking).toBe('hash');

    expect(ssnCol?.visible).toBe(false);
  });

  it('should require authentication', async () => {
    const res = await request(app)
      .post('/api/profiles/test/preview')
      .expect(401);

    expect(res.body).toBeDefined();
  });
});
