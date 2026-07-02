import type { CalameDatabase } from './database.js';
import { DEFAULT_TENANT_ID } from './tenancy.js';

/**
 * Placeholder for future schema migrations.
 *
 * JSON file migration has been removed — the project uses SQLite exclusively.
 * This function handles forward schema migrations (e.g., adding columns, indexes)
 * when the database schema evolves in future versions.
 */
/** Check if a column exists on a table. */
function hasColumn(db: CalameDatabase, table: string, column: string): boolean {
  const cols = db.raw.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

/** Check if a table exists on the SQLite schema. */
function hasTable(db: CalameDatabase, name: string): boolean {
  const row = db.raw
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

/** Add a column only if it doesn't already exist (idempotent ALTER TABLE). */
function addColumnIfMissing(db: CalameDatabase, table: string, column: string, type: string): void {
  if (!hasColumn(db, table, column)) {
    db.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export function runMigrations(db: CalameDatabase): void {
  const currentVersion = db.getSchemaVersion();

  if (currentVersion < 1) {
    // Version 1: initial SQLite schema (created by database.ts initSchema)
    db.setSchemaVersion(1);
  }

  if (currentVersion < 2) {
    // Version 2: Sprint 1 — token label on audit, ssl_config on connections,
    // rate_limit_rpm on users; Sprint 2 adds ssh_config on connections.
    // All ALTER TABLE calls are idempotent to survive partial migration failures.
    addColumnIfMissing(db, 'audit_log', 'token_label', 'TEXT');
    db.raw.exec('CREATE INDEX IF NOT EXISTS idx_audit_token ON audit_log(token_label)');
    addColumnIfMissing(db, 'connections', 'ssl_config', 'TEXT');
    addColumnIfMissing(db, 'users', 'rate_limit_rpm', 'INTEGER');
    addColumnIfMissing(db, 'connections', 'ssh_config', 'TEXT');
    db.setSchemaVersion(2);
  }

  if (currentVersion < 3) {
    // Version 3: Sprint 3 — oidc_subject column on users for OIDC/SSO integration.
    addColumnIfMissing(db, 'users', 'oidc_subject', 'TEXT');
    db.setSchemaVersion(3);
  }

  if (currentVersion < 4) {
    // Version 4: encrypted copy of token for admin reveal functionality.
    addColumnIfMissing(db, 'tokens', 'token_encrypted', 'TEXT');
    db.setSchemaVersion(4);
  }

  if (currentVersion < 5) {
    // Version 5: Data Scoping — custom attributes on users for row-level isolation.
    // JSON map of arbitrary key-value pairs (e.g. {"client_id": "CLT-00042"}).
    addColumnIfMissing(db, 'users', 'custom_attributes', 'TEXT');
    db.setSchemaVersion(5);
  }

  if (currentVersion < 6) {
    // Version 6: multiple named AI settings. Copy the legacy single ai_config row
    // (if any) into ai_settings as a 'default' entry so existing installs keep working.
    db.raw.exec(`CREATE TABLE IF NOT EXISTS ai_settings (
      name TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      provider TEXT NOT NULL,
      api_key TEXT NOT NULL,
      model TEXT,
      base_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    const existing = db.raw
      .prepare(`SELECT provider, api_key, model, base_url FROM ai_config WHERE key='main'`)
      .get() as
      | { provider: string; api_key: string; model: string | null; base_url: string | null }
      | undefined;
    if (existing) {
      db.raw
        .prepare(
          `INSERT OR IGNORE INTO ai_settings (name, label, provider, api_key, model, base_url)
           VALUES ('default', 'Default', ?, ?, ?, ?)`,
        )
        .run(existing.provider, existing.api_key, existing.model, existing.base_url);
    }
    db.setSchemaVersion(6);
  }

  if (currentVersion < 7) {
    // Version 7: store raw result payload in audit_log for expandable rows in the UI.
    addColumnIfMissing(db, 'audit_log', 'result_data', 'TEXT');
    db.setSchemaVersion(7);
  }

  if (currentVersion < 8) {
    // Version 8: AI settings can declare capabilities (chat / embeddings) and an embedding model.
    // Used by the upcoming RAG feature to pick eligible AI settings for vectorization.
    addColumnIfMissing(db, 'ai_settings', 'capabilities', 'TEXT');
    addColumnIfMissing(db, 'ai_settings', 'embedding_model', 'TEXT');
    db.setSchemaVersion(8);
  }

  if (currentVersion < 9) {
    // Version 9: cache the discovered embedding vector dimension on each AI setting.
    // Populated on POST/PUT /api/ai-settings when capabilities includes 'embeddings' via a
    // probe call to /v1/embeddings. Replaces the previous hardcoded KNOWN_MODEL_DIMS map.
    addColumnIfMissing(db, 'ai_settings', 'embedding_dimensions', 'INTEGER');
    db.setSchemaVersion(9);
  }

  if (currentVersion < 10) {
    // Version 10: Phase 5 unified Sources shape — add `sources_scopes` column to the
    // `configurations` table. This JSON column stores the post-migration
    // { sources: string[], scopes: Record<id, ScopeSelection> } blob so that
    // configurations created via the Phase 5 frontend payload (which carries only
    // sources/scopes, not the legacy connections/selectedTables) survive a round-trip
    // through SQLite without data loss.
    // The legacy NOT-NULL columns (connections, selected_tables) are kept to avoid a
    // breaking schema change; they receive empty-array/empty-object fallbacks on write
    // when only the unified shape is present.
    addColumnIfMissing(db, 'configurations', 'sources_scopes', 'TEXT');
    db.setSchemaVersion(10);
  }

  if (currentVersion < 11) {
    // Version 11: Phase 5 EE RAG Tranche 2 — add `rerank_model` column to the
    // `ai_settings` table. Stores the Cohere reranker model identifier (e.g.
    // 'rerank-multilingual-v3.0') alongside the existing embedding fields. The
    // RAG runtime resolves this column to build a Cohere reranker that
    // post-processes hybrid-search candidates. Nullable — rerank is opt-in.
    addColumnIfMissing(db, 'ai_settings', 'rerank_model', 'TEXT');
    db.setSchemaVersion(11);
  }

  if (currentVersion < 12) {
    // Version 12: Multi-tenancy foundation (Phase A).
    //
    // Adds a `tenant_id TEXT NOT NULL DEFAULT 'default'` column to every
    // host-side table that holds per-tenant configuration. Existing rows
    // transparently migrate under the literal 'default' tenant. NO route
    // enforces tenant filtering yet — this migration is intentionally additive
    // so it can be reverted by an `ALTER TABLE … DROP COLUMN tenant_id` on
    // each table.
    //
    // Phase B will resolve the tenant from `req.auth` (or an `X-Tenant-Id`
    // header) via `getTenantId(req)` and wire `WHERE tenant_id = ?` clauses
    // into every read path. The indexes below exist now so that filtering
    // doesn't kill query performance when it eventually lands.
    //
    // The companion RAG-side migration (`ee/rag-core/src/storage/schema.ts`
    // v5→v6) covers the `rag_*` tables.
    const hostTables = ['profiles', 'configurations', 'ai_settings', 'tokens', 'users'] as const;
    const tenantType = `TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_ID}'`;
    for (const table of hostTables) {
      if (hasTable(db, table)) {
        addColumnIfMissing(db, table, 'tenant_id', tenantType);
      }
    }

    // Compound `(tenant_id, name)` indexes on the two name-keyed tables.
    // Intentionally NON-UNIQUE in Phase A: tenants are not yet enforced at
    // the route layer, and `profiles`/`configurations` already enforce
    // uniqueness on `name` alone via their PRIMARY KEY. Once Phase B enables
    // route-level scoping, the future migration that flips the PK can also
    // promote this index to UNIQUE — at which point names will be allowed to
    // collide across tenant boundaries.
    if (hasTable(db, 'profiles')) {
      db.raw.exec(`CREATE INDEX IF NOT EXISTS idx_profiles_tenant_key ON profiles(tenant_id, key)`);
    }
    if (hasTable(db, 'configurations')) {
      db.raw.exec(
        `CREATE INDEX IF NOT EXISTS idx_configurations_tenant_name ON configurations(tenant_id, name)`,
      );
    }
    if (hasTable(db, 'ai_settings')) {
      db.raw.exec(`CREATE INDEX IF NOT EXISTS idx_ai_settings_tenant ON ai_settings(tenant_id)`);
    }
    if (hasTable(db, 'tokens')) {
      db.raw.exec(`CREATE INDEX IF NOT EXISTS idx_tokens_tenant ON tokens(tenant_id)`);
    }
    if (hasTable(db, 'users')) {
      db.raw.exec(`CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)`);
    }

    db.setSchemaVersion(12);
  }
}
