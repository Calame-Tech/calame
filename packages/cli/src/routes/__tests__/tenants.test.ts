import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createApp } from '../../app.js';
import { AppState } from '../../state.js';
import { CalameDatabase } from '../../database.js';
import { TokenManager } from '../../token.js';
import { UserManager } from '../../user.js';
import { AuditLog } from '../../audit.js';
import { setupAdminAndGetCookie } from './helpers.js';

describe('tenants routes', () => {
  let app: ReturnType<typeof createApp>;
  let state: AppState;
  let originalCwd: string;
  let tmpDir: string;
  let cookie: string;
  let db: CalameDatabase;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = path.join(os.tmpdir(), `calame-tenants-test-${Date.now()}-${Math.random()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    process.chdir(tmpDir);

    state = new AppState();
    db = new CalameDatabase(tmpDir);
    state.db = db;
    state.tokenManager = new TokenManager(db);
    state.userManager = new UserManager(db);
    state.auditLog = new AuditLog(db);
    app = createApp(state);
    cookie = await setupAdminAndGetCookie(app);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // ---------------------------------------------------------------------------
  // GET /api/tenants
  // ---------------------------------------------------------------------------

  describe('GET /api/tenants', () => {
    it('always returns the default tenant, even when every tenanted table is empty', async () => {
      const res = await request(app).get('/api/tenants').set('Cookie', cookie).expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.tenants)).toBe(true);

      // The admin user that the helpers created is itself tenant-tagged under
      // 'default', so the default tenant always has at least one user.
      const def = res.body.tenants.find((t: { id: string }) => t.id === 'default');
      expect(def).toBeDefined();
      // The setup helper creates an admin user → users count >= 1 under default
      expect(def.counts.users).toBeGreaterThanOrEqual(1);
    });

    it('lists every distinct tenant id discovered across tenanted tables', async () => {
      // Seed two non-default tenants by inserting directly. Use configurations
      // which is straightforward to populate.
      db.raw
        .prepare(
          `INSERT INTO configurations (name, label, connections, selected_tables, tenant_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('cfg-a', 'Acme Cfg', '[]', '{}', 'acme-corp');
      db.raw
        .prepare(
          `INSERT INTO configurations (name, label, connections, selected_tables, tenant_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('cfg-b', 'Globex Cfg', '[]', '{}', 'globex');

      const res = await request(app).get('/api/tenants').set('Cookie', cookie).expect(200);

      expect(res.body.success).toBe(true);
      const ids = res.body.tenants.map((t: { id: string }) => t.id).sort();
      expect(ids).toContain('default');
      expect(ids).toContain('acme-corp');
      expect(ids).toContain('globex');
    });

    it('returns counts grouped per resource type', async () => {
      // Two profiles for acme, one configuration for acme.
      db.raw
        .prepare(`INSERT INTO profiles (key, data, tenant_id) VALUES (?, ?, ?)`)
        .run('main', '{}', 'acme-corp');
      db.raw
        .prepare(
          `INSERT INTO configurations (name, label, connections, selected_tables, tenant_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('cfg-a', 'Cfg A', '[]', '{}', 'acme-corp');
      db.raw
        .prepare(
          `INSERT INTO configurations (name, label, connections, selected_tables, tenant_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('cfg-b', 'Cfg B', '[]', '{}', 'acme-corp');

      const res = await request(app).get('/api/tenants').set('Cookie', cookie).expect(200);
      const acme = res.body.tenants.find((t: { id: string }) => t.id === 'acme-corp');
      expect(acme).toBeDefined();
      expect(acme.counts.profiles).toBe(1);
      expect(acme.counts.configurations).toBe(2);
      // totalResources is the sum of every count
      expect(acme.totalResources).toBe(3);
    });

    it("places 'default' first, then sorts alphabetically", async () => {
      db.raw
        .prepare(
          `INSERT INTO configurations (name, label, connections, selected_tables, tenant_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('cfg-1', 'L1', '[]', '{}', 'zeta');
      db.raw
        .prepare(
          `INSERT INTO configurations (name, label, connections, selected_tables, tenant_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('cfg-2', 'L2', '[]', '{}', 'alpha');
      db.raw
        .prepare(
          `INSERT INTO configurations (name, label, connections, selected_tables, tenant_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('cfg-3', 'L3', '[]', '{}', 'mike');

      const res = await request(app).get('/api/tenants').set('Cookie', cookie).expect(200);
      const ids = res.body.tenants.map((t: { id: string }) => t.id);

      // 'default' first
      expect(ids[0]).toBe('default');
      // Then alphabetical: alpha, mike, zeta
      const nonDefault = ids.slice(1);
      const sorted = [...nonDefault].sort((a, b) => a.localeCompare(b));
      expect(nonDefault).toEqual(sorted);
    });

    it('tolerates tables that do not exist (RAG runtime disabled)', async () => {
      // The default install in this test environment does NOT initialize the
      // RAG runtime, so rag_* tables are absent. The endpoint must still work.
      const res = await request(app).get('/api/tenants').set('Cookie', cookie).expect(200);
      expect(res.body.success).toBe(true);
      // No crash, no ragSources count expected.
      for (const t of res.body.tenants) {
        expect(t.counts.ragSources).toBeUndefined();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/tenants/:id
  // ---------------------------------------------------------------------------

  describe('DELETE /api/tenants/:id', () => {
    it('refuses to delete without the X-Confirm-Destructive header', async () => {
      db.raw
        .prepare(
          `INSERT INTO configurations (name, label, connections, selected_tables, tenant_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('cfg-a', 'Cfg A', '[]', '{}', 'acme-corp');

      const res = await request(app)
        .delete('/api/tenants/acme-corp')
        .set('Cookie', cookie)
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('X-Confirm-Destructive');

      // The row must still be there.
      const row = db.raw
        .prepare(`SELECT name FROM configurations WHERE tenant_id = ?`)
        .get('acme-corp');
      expect(row).toBeDefined();
    });

    it('refuses to delete with a confirmation header for a different tenant', async () => {
      db.raw
        .prepare(
          `INSERT INTO configurations (name, label, connections, selected_tables, tenant_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('cfg-a', 'Cfg A', '[]', '{}', 'acme-corp');

      const res = await request(app)
        .delete('/api/tenants/acme-corp')
        .set('Cookie', cookie)
        .set('X-Confirm-Destructive', 'delete-tenant-globex') // wrong tenant in token
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('X-Confirm-Destructive');
    });

    it('hard-deletes every row tagged with the tenant when confirmed', async () => {
      // Seed two configurations + one ai_settings row for acme.
      db.raw
        .prepare(
          `INSERT INTO configurations (name, label, connections, selected_tables, tenant_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('cfg-1', 'Cfg 1', '[]', '{}', 'acme-corp');
      db.raw
        .prepare(
          `INSERT INTO configurations (name, label, connections, selected_tables, tenant_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('cfg-2', 'Cfg 2', '[]', '{}', 'acme-corp');
      db.raw
        .prepare(
          `INSERT INTO ai_settings (name, label, provider, api_key, tenant_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('ai-1', 'AI 1', 'openai', 'sk-x', 'acme-corp');

      // Plus a row under another tenant — must NOT be touched.
      db.raw
        .prepare(
          `INSERT INTO configurations (name, label, connections, selected_tables, tenant_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('cfg-other', 'Other', '[]', '{}', 'globex');

      const res = await request(app)
        .delete('/api/tenants/acme-corp')
        .set('Cookie', cookie)
        .set('X-Confirm-Destructive', 'delete-tenant-acme-corp')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.deleted.configurations).toBe(2);
      expect(res.body.deleted.aiSettings).toBe(1);

      // Verify the rows are gone.
      const remainingAcme = db.raw
        .prepare(`SELECT COUNT(*) AS n FROM configurations WHERE tenant_id = ?`)
        .get('acme-corp') as { n: number };
      expect(remainingAcme.n).toBe(0);

      // Other tenant untouched.
      const otherTenant = db.raw
        .prepare(`SELECT COUNT(*) AS n FROM configurations WHERE tenant_id = ?`)
        .get('globex') as { n: number };
      expect(otherTenant.n).toBe(1);
    });

    it("refuses to delete the 'default' tenant", async () => {
      const res = await request(app)
        .delete('/api/tenants/default')
        .set('Cookie', cookie)
        .set('X-Confirm-Destructive', 'delete-tenant-default')
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Cannot delete the default tenant');
    });

    it('is idempotent: deleting a nonexistent tenant returns 200 with zero counts', async () => {
      const res = await request(app)
        .delete('/api/tenants/never-existed')
        .set('Cookie', cookie)
        .set('X-Confirm-Destructive', 'delete-tenant-never-existed')
        .expect(200);

      expect(res.body.success).toBe(true);
      // Every count entry is 0.
      for (const v of Object.values(res.body.deleted as Record<string, number>)) {
        expect(v).toBe(0);
      }
    });

    it('emits an audit event with the per-table counts', async () => {
      db.raw
        .prepare(
          `INSERT INTO configurations (name, label, connections, selected_tables, tenant_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('cfg-1', 'Cfg 1', '[]', '{}', 'acme-corp');

      await request(app)
        .delete('/api/tenants/acme-corp')
        .set('Cookie', cookie)
        .set('X-Confirm-Destructive', 'delete-tenant-acme-corp')
        .expect(200);

      const { entries } = state.auditLog!.getEntries({ profileName: '_admin' });
      const tenantEvent = entries.find((e) => e.toolName === 'tenant.deleted');
      expect(tenantEvent).toBeDefined();
      expect(tenantEvent?.result).toBe('success');
      expect(tenantEvent?.toolArgs.tenantId).toBe('acme-corp');
      // The resultData JSON carries the per-table counts.
      const data = JSON.parse(tenantEvent?.resultData ?? '{}');
      expect(data.tenantId).toBe('acme-corp');
      expect(data.counts.configurations).toBe(1);
    });

    it('is transactional: when one table fails, all DELETEs roll back', async () => {
      // Seed two configurations under acme.
      db.raw
        .prepare(
          `INSERT INTO configurations (name, label, connections, selected_tables, tenant_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('cfg-1', 'Cfg 1', '[]', '{}', 'acme-corp');
      db.raw
        .prepare(
          `INSERT INTO configurations (name, label, connections, selected_tables, tenant_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('cfg-2', 'Cfg 2', '[]', '{}', 'acme-corp');

      // Simulate a hard failure mid-cascade by replacing the better-sqlite3
      // prepare call with one that throws once configurations have been
      // touched but profiles is being deleted. We monkey-patch raw.prepare
      // temporarily.
      const originalPrepare = db.raw.prepare.bind(db.raw);
      let touchedConfigurations = false;
      // Monkey-patch better-sqlite3's prepare to inject a failure on the
      // second-step DELETE. Type-cast to `any` so we can replace the method
      // without fighting the strongly-typed overloads.
      (db.raw as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
        if (sql.includes('FROM configurations WHERE tenant_id')) {
          touchedConfigurations = true;
        }
        if (touchedConfigurations && sql.includes('FROM ai_settings WHERE tenant_id')) {
          throw new Error('Simulated DB failure mid-cascade');
        }
        return originalPrepare(sql);
      };

      const res = await request(app)
        .delete('/api/tenants/acme-corp')
        .set('Cookie', cookie)
        .set('X-Confirm-Destructive', 'delete-tenant-acme-corp');

      // Restore prepare before any assertions can throw and mask the cleanup.
      (db.raw as unknown as { prepare: typeof originalPrepare }).prepare = originalPrepare;

      expect(res.status).toBe(500);

      // The configurations row must STILL be there — transaction rolled back.
      const remaining = db.raw
        .prepare(`SELECT COUNT(*) AS n FROM configurations WHERE tenant_id = ?`)
        .get('acme-corp') as { n: number };
      expect(remaining.n).toBe(2);
    });

    it('returns 400 when the URL :id is empty (Express route never matches, sanity check)', async () => {
      // An empty :id would route to GET /api/tenants — this test just guards
      // against accidental "delete everything" shapes by confirming the
      // listing endpoint answers instead of the destructive one.
      const res = await request(app).delete('/api/tenants/').set('Cookie', cookie);
      // Express returns 404 for unmatched routes (or 405 method-not-allowed).
      expect([404, 405]).toContain(res.status);
    });
  });
});
