import type { CalameDatabase } from './database.js';

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
}
