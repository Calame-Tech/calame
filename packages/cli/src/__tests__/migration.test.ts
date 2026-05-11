import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';
import { CalameDatabase } from '../database.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a CalameDatabase against a throw-away on-disk SQLite file. */
function makeFreshDb(): { db: CalameDatabase; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calame-migration-test-'));
  const db = new CalameDatabase(tmpDir);
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

interface PragmaCol {
  name: string;
  // We don't care about the other fields, but better-sqlite3 returns them.
  type: string;
  dflt_value: unknown;
  notnull: number;
}

function tableInfo(db: CalameDatabase, table: string): PragmaCol[] {
  return db.raw.pragma(`table_info(${table})`) as PragmaCol[];
}

function hasColumn(db: CalameDatabase, table: string, column: string): boolean {
  return tableInfo(db, table).some((c) => c.name === column);
}

function hasIndex(db: CalameDatabase, name: string): boolean {
  const row = db.raw
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('host migration v12 — tenant_id foundation', () => {
  it('adds tenant_id column to profiles, configurations, ai_settings, tokens, users', () => {
    const { db, cleanup } = makeFreshDb();
    try {
      // On a fresh DB the migration runner has already executed up to the
      // current head (v12). All target tables must carry tenant_id.
      const tables = ['profiles', 'configurations', 'ai_settings', 'tokens', 'users'] as const;
      for (const table of tables) {
        expect(hasColumn(db, table, 'tenant_id')).toBe(true);
      }
    } finally {
      cleanup();
    }
  });

  it('tenant_id defaults to "default" on rows that omit it', () => {
    const { db, cleanup } = makeFreshDb();
    try {
      // Insert a token without specifying tenant_id — the DEFAULT clause
      // must kick in. This is the safety net for any legacy INSERT site we
      // haven't migrated yet (none in this tranche, but the contract is
      // documented).
      db.raw
        .prepare(
          `INSERT INTO tokens (id, token_hash, profile_name, label, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('tok-1', 'h1', 'main', 'test', new Date().toISOString());
      const row = db.raw
        .prepare(`SELECT tenant_id FROM tokens WHERE id = ?`)
        .get('tok-1') as { tenant_id: string } | undefined;
      expect(row?.tenant_id).toBe('default');
    } finally {
      cleanup();
    }
  });

  it('creates the tenant-related indexes', () => {
    const { db, cleanup } = makeFreshDb();
    try {
      const expected = [
        'idx_profiles_tenant_key',
        'idx_configurations_tenant_name',
        'idx_ai_settings_tenant',
        'idx_tokens_tenant',
        'idx_users_tenant',
      ];
      for (const name of expected) {
        expect(hasIndex(db, name)).toBe(true);
      }
    } finally {
      cleanup();
    }
  });

  it('is idempotent — re-running runMigrations on a v12 DB does not throw', async () => {
    const { db, cleanup } = makeFreshDb();
    try {
      // The constructor already ran the migrations once. Run them again
      // through the same code path and confirm the schema is stable.
      const { runMigrations } = await import('../migration.js');
      expect(() => runMigrations(db)).not.toThrow();
      // Confirm the column did not get duplicated (a SQLite duplicate-
      // column error would have thrown above; this just double-checks).
      const cols = tableInfo(db, 'tokens');
      const tenantCols = cols.filter((c) => c.name === 'tenant_id');
      expect(tenantCols).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('upgrades a pre-v12 DB by adding tenant_id with default "default" on existing rows', async () => {
    const { runMigrations } = await import('../migration.js');
    // Build a database that stops at v11 — replicate the v11 schema by hand
    // so we don't depend on the production migration code (which is what
    // we're testing).
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calame-pre-v12-'));
    const dbPath = path.join(tmpDir, 'calame.db');
    const raw = new Database(dbPath);
    try {
      raw.pragma('foreign_keys = ON');
      raw.exec(`
        CREATE TABLE _migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE tokens (
          id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL,
          profile_name TEXT NOT NULL,
          label TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE profiles (key TEXT PRIMARY KEY DEFAULT 'main', data TEXT NOT NULL);
        CREATE TABLE configurations (
          name TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          connections TEXT NOT NULL,
          selected_tables TEXT NOT NULL
        );
        CREATE TABLE ai_settings (
          name TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          provider TEXT NOT NULL,
          api_key TEXT NOT NULL
        );
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          role TEXT NOT NULL,
          status TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO _migrations (version) VALUES (1), (2), (3), (4), (5), (6), (7), (8), (9), (10), (11);
        INSERT INTO tokens (id, token_hash, profile_name, label, created_at)
          VALUES ('tok-legacy', 'h', 'main', 'legacy', '2026-01-01T00:00:00Z');
      `);

      // Pre-condition: no tenant_id columns.
      const colsBefore = raw.pragma('table_info(tokens)') as PragmaCol[];
      expect(colsBefore.some((c) => c.name === 'tenant_id')).toBe(false);

      // Wrap raw in a minimal CalameDatabase-shaped object — runMigrations
      // only touches `.raw`, `.getSchemaVersion()`, `.setSchemaVersion()`.
      const dbShim = {
        raw,
        getSchemaVersion: (): number => {
          const row = raw.prepare('SELECT MAX(version) AS v FROM _migrations').get() as
            | { v: number | null }
            | undefined;
          return row?.v ?? 0;
        },
        setSchemaVersion: (v: number): void => {
          raw
            .prepare('INSERT OR REPLACE INTO _migrations (version, applied_at) VALUES (?, ?)')
            .run(v, new Date().toISOString());
        },
      } as unknown as Parameters<typeof runMigrations>[0];

      runMigrations(dbShim);

      // Post-condition: tenant_id column present, existing row defaulted.
      const colsAfter = raw.pragma('table_info(tokens)') as PragmaCol[];
      expect(colsAfter.some((c) => c.name === 'tenant_id')).toBe(true);
      const legacyRow = raw
        .prepare(`SELECT tenant_id FROM tokens WHERE id = ?`)
        .get('tok-legacy') as { tenant_id: string };
      expect(legacyRow.tenant_id).toBe('default');
    } finally {
      raw.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
