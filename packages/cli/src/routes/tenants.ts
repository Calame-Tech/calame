import type { Express, Request, Response } from 'express';
import type { AppState } from '../state.js';
import { DEFAULT_TENANT_ID } from '../tenancy.js';

/**
 * Tenant administration routes (Phase D of the multi-tenancy story).
 *
 * Phases A/B/C delivered the storage column, route enforcement, and a
 * workspace switcher in the UI. There is intentionally NO `tenants` table —
 * a tenant is implicit, created the moment a row with that `tenant_id` is
 * inserted. The list endpoint therefore aggregates `SELECT DISTINCT
 * tenant_id` across every tenanted table; the delete endpoint hard-deletes
 * every row tagged with the supplied tenant.
 *
 * Why DISTINCT vs a dedicated table?
 *   - It keeps the implicit-tenant invariant: the SAAS surface never has to
 *     "create" a tenant before using it. The same path that wrote the first
 *     row also "registered" the tenant.
 *   - It avoids a foreign-key migration that would force every existing row
 *     to point at a parent that didn't exist yet.
 *   - The cost is a handful of `SELECT DISTINCT tenant_id` queries — each
 *     covered by the `idx_<table>_tenant` index added in migration v12 /
 *     RAG v6, so the planner returns an index-only scan.
 *
 * Hard-delete is the right semantics for MVP: a tenant only exists as long
 * as it has rows. Removing the last row removes the tenant. Soft-delete
 * with a retention window can ship later — the admin already gets a
 * confirmation prompt, the irreversible nature is intentional.
 */

/** Set of tenanted tables on the host side, mirroring migration v12. */
const HOST_TENANT_TABLES = [
  'profiles',
  'configurations',
  'ai_settings',
  'tokens',
  'users',
] as const;

/** Tenanted RAG tables (only present when the EE rag-core package is installed). */
const RAG_TENANT_TABLES = [
  'rag_sources',
  'rag_folders',
  'rag_documents',
  'rag_chunks',
  'rag_jobs',
] as const;

/** Camel-case keys used in the response payload. Must stay aligned with HOST_TENANT_TABLES. */
const COUNT_KEY_BY_TABLE: Record<string, string> = {
  profiles: 'profiles',
  configurations: 'configurations',
  ai_settings: 'aiSettings',
  tokens: 'tokens',
  users: 'users',
  rag_sources: 'ragSources',
  rag_folders: 'ragFolders',
  rag_documents: 'ragDocuments',
  rag_chunks: 'ragChunks',
  rag_jobs: 'ragJobs',
};

/** Shape of the per-tenant counts surfaced to the UI. */
type TenantCounts = Record<string, number>;

/** Probe `sqlite_master` for the existence of a table — works for both regular
 *  and virtual tables. Used so the listing endpoint tolerates an install where
 *  the EE rag-core package is absent (rag_* tables never created). */
function tableExists(raw: import('better-sqlite3').Database, name: string): boolean {
  const row = raw
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

/** True when `tenant_id` is a column on the given table (pragma probe).
 *  Defensive: in theory every tenanted table carries the column from v12 onwards,
 *  but a partial migration could leave a regressed install where the column is
 *  missing. We treat that case as "no rows for this table" rather than crashing
 *  the whole list endpoint. */
function hasTenantColumn(raw: import('better-sqlite3').Database, table: string): boolean {
  const cols = raw.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return cols.some((c) => c.name === 'tenant_id');
}

/**
 * Aggregate per-tenant row counts across every tenanted table that currently
 * exists in the DB. Returns a map keyed by tenant id; the `'default'` key is
 * always present (even when empty) since it's the implicit fallback every
 * unconfigured caller writes under.
 */
function aggregateTenants(
  raw: import('better-sqlite3').Database,
  tables: readonly string[],
): Map<string, TenantCounts> {
  const aggregate = new Map<string, TenantCounts>();
  // Always seed the default tenant — even if every tenanted table is empty,
  // the UI should see `default` so the admin understands the workspace
  // exists implicitly.
  aggregate.set(DEFAULT_TENANT_ID, {});

  for (const table of tables) {
    if (!tableExists(raw, table)) continue;
    if (!hasTenantColumn(raw, table)) continue;

    const key = COUNT_KEY_BY_TABLE[table] ?? table;
    const rows = raw
      .prepare(
        // `tenant_id` is indexed (idx_<table>_tenant) so this is an
        // index-only scan even on tables with millions of rows.
        `SELECT tenant_id AS tenantId, COUNT(*) AS cnt FROM ${table} GROUP BY tenant_id`,
      )
      .all() as Array<{ tenantId: string; cnt: number }>;

    for (const r of rows) {
      const tenantId = r.tenantId ?? DEFAULT_TENANT_ID;
      const existing = aggregate.get(tenantId) ?? {};
      existing[key] = r.cnt;
      aggregate.set(tenantId, existing);
    }
  }

  return aggregate;
}

/** Sum every numeric value in a counts object. Convenience for the UI's "total
 *  resources" column. */
function totalResources(counts: TenantCounts): number {
  let sum = 0;
  for (const v of Object.values(counts)) sum += v;
  return sum;
}

export function registerTenantsRoutes(app: Express, state: AppState): void {
  // ---------------------------------------------------------------------------
  // GET /api/tenants — list every distinct tenant id discovered across the
  // tenanted tables, plus per-resource counts.
  // ---------------------------------------------------------------------------
  app.get('/api/tenants', (req: Request, res: Response) => {
    try {
      const db = state.db;
      if (!db) {
        res.status(500).json({ success: false, message: 'Database not initialized.' });
        return;
      }

      const tables = [...HOST_TENANT_TABLES, ...RAG_TENANT_TABLES];
      const aggregate = aggregateTenants(db.raw, tables);

      // Sort: 'default' first, then alphabetically. Stable output makes the UI
      // tests deterministic and gives the admin a predictable scan order.
      const tenants = [...aggregate.entries()]
        .map(([id, counts]) => ({
          id,
          counts,
          totalResources: totalResources(counts),
        }))
        .sort((a, b) => {
          if (a.id === DEFAULT_TENANT_ID) return -1;
          if (b.id === DEFAULT_TENANT_ID) return 1;
          return a.id.localeCompare(b.id);
        });

      res.json({ success: true, tenants });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('List error', { component: 'tenants', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/tenants/:id — hard-delete every row tagged with this tenant.
  //
  // Destructive: requires an explicit `X-Confirm-Destructive: delete-tenant-<id>`
  // header (anti-fat-finger). The default tenant can never be deleted (it is
  // the implicit fallback every unconfigured caller writes under — deleting it
  // would wipe every single-tenant install).
  //
  // Atomicity:
  //   - Vector embeddings are wiped FIRST (vec0 isn't covered by SQLite FK
  //     cascade — we have to walk rag_documents and call
  //     `vectorStore.deleteByDocument(docId)` for each). A vec wipe failure
  //     is logged but DOES NOT abort the SQL cascade — the orphan vectors
  //     would be eligible for the next vacuum / re-index, but the source
  //     row going away is the higher-priority guarantee. (Mirrors the
  //     soft-delete-cleanup contract in ee/rag-core/src/jobs/.)
  //   - The SQL deletes run inside a single `db.transaction(...)` so a
  //     mid-cascade failure rolls everything back and the admin can retry.
  // ---------------------------------------------------------------------------
  app.delete('/api/tenants/:id', async (req: Request, res: Response) => {
    try {
      // `req.params.id` can be inferred as `string | string[]` by Express's
      // overloaded route handler types — narrow to a single string up front
      // so every downstream binding is unambiguous.
      const rawId = req.params['id'];
      const tenantId = typeof rawId === 'string' ? rawId : '';
      if (!tenantId) {
        res.status(400).json({ success: false, message: 'Tenant id is required.' });
        return;
      }

      // Refuse to delete the implicit-fallback tenant. Deleting it would
      // wipe every row in every single-tenant install (the v12 migration
      // tagged every existing row with 'default').
      if (tenantId === DEFAULT_TENANT_ID) {
        res.status(400).json({ success: false, message: 'Cannot delete the default tenant.' });
        return;
      }

      // Anti-fat-finger confirmation header. The token is parameterised by the
      // tenant id so a stale Postman tab pointing at a different tenant won't
      // accidentally match.
      const expectedConfirm = `delete-tenant-${tenantId}`;
      // `req.headers[k]` can be `string | string[] | undefined`. Normalize to
      // a single string — a repeated header is a configuration error we
      // refuse to interpret.
      const confirmHeader = req.headers['x-confirm-destructive'];
      const actualConfirm = typeof confirmHeader === 'string' ? confirmHeader : null;
      if (actualConfirm !== expectedConfirm) {
        res.status(400).json({
          success: false,
          message: `Set X-Confirm-Destructive header to "${expectedConfirm}" to confirm.`,
        });
        return;
      }

      const db = state.db;
      if (!db) {
        res.status(500).json({ success: false, message: 'Database not initialized.' });
        return;
      }
      const raw = db.raw;

      // -----------------------------------------------------------------
      // Step 1 — vector embeddings cascade (manual, since vec0 isn't
      // covered by SQLite FK CASCADE). Best-effort: a failure here gets
      // logged but does NOT abort the SQL cascade. Orphan vectors will be
      // cleaned up at the next vacuum.
      // -----------------------------------------------------------------
      const vectorStore = state.ragRuntime?.vectorStore;
      if (
        vectorStore &&
        tableExists(raw, 'rag_documents') &&
        hasTenantColumn(raw, 'rag_documents')
      ) {
        const docIds = raw
          .prepare(`SELECT id FROM rag_documents WHERE tenant_id = ?`)
          .all(tenantId) as Array<{ id: string }>;
        for (const { id } of docIds) {
          try {
            vectorStore.deleteByDocument(id);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            state.logger?.warn(`Vector wipe failed for document ${id} during tenant delete`, {
              component: 'tenants',
              tenantId,
              error: msg,
            });
          }
        }
      }

      // -----------------------------------------------------------------
      // Step 2 — SQL cascade inside a single transaction. The order
      // mirrors the FK dependency graph: chunks → documents → folders →
      // jobs → sources, then the host-side tables (which have no inter-
      // table FKs at the tenancy layer). user_profile_access rows cascade
      // via the FK on `users(id)` we declared in the initial schema.
      // -----------------------------------------------------------------
      const counts: Record<string, number> = {};

      // Pre-compute the runtime list of tables that exist AND carry tenant_id
      // (RAG tables are absent on apache-only installs). Same probe used by
      // the listing endpoint — keeps the two paths in lock-step.
      // Order matters when FKs are enforced — delete children before parents.
      // We pin the canonical RAG order explicitly; host tables have no
      // inter-table FKs at the tenancy boundary so any order works.
      const canonicalOrder: readonly string[] = [
        // Host-side tables (no inter-table FKs at the tenancy boundary).
        ...HOST_TENANT_TABLES,
        // RAG cascade order: chunks → documents → folders → jobs → sources.
        'rag_chunks',
        'rag_documents',
        'rag_folders',
        'rag_jobs',
        'rag_sources',
      ];
      const orderedTables = canonicalOrder.filter(
        (t) => tableExists(raw, t) && hasTenantColumn(raw, t),
      );

      const cascade = raw.transaction((tid: string) => {
        for (const table of orderedTables) {
          const result = raw.prepare(`DELETE FROM ${table} WHERE tenant_id = ?`).run(tid);
          const key = COUNT_KEY_BY_TABLE[table] ?? table;
          counts[key] = result.changes;
        }
      });
      cascade(tenantId);

      // -----------------------------------------------------------------
      // Step 3 — audit event. The shape mirrors the rag.cleanup.completed
      // payload so a downstream log shipper can group both event families
      // under the same "tenant data wiped" alert.
      // -----------------------------------------------------------------
      if (state.auditLog) {
        state.auditLog.addEntry({
          profileName: '_admin',
          toolName: 'tenant.deleted',
          toolArgs: { tenantId },
          result: 'success',
          resultSummary: `Tenant "${tenantId}" hard-deleted`,
          resultData: JSON.stringify({ tenantId, counts }),
          durationMs: 0,
        });
        await state.auditLog.save();
      }

      res.json({ success: true, deleted: counts });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Delete error', { component: 'tenants', error: message });
      res.status(500).json({ success: false, message });
    }
  });
}
