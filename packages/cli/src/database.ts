import Database from 'better-sqlite3';
import path from 'path';
import { runMigrations } from './migration.js';

/**
 * Central SQLite database for Calame internal persistence.
 * Replaces all JSON file storage with a single ACID-compliant database.
 *
 * Uses WAL mode for concurrent read access and synchronous writes
 * (better-sqlite3 is synchronous — no race conditions).
 */
export class CalameDatabase {
  private db: Database.Database;

  constructor(dataDir: string) {
    const dbPath = path.join(dataDir, 'calame.db');
    this.db = new Database(dbPath);

    // Performance & safety pragmas
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    this.initSchema();
    // Apply pending migrations immediately after initial schema is in place
    runMigrations(this);
  }

  /** Expose the raw better-sqlite3 instance for prepared statements in managers. */
  get raw(): Database.Database {
    return this.db;
  }

  /** Close the database connection (for graceful shutdown). */
  close(): void {
    this.db.close();
  }

  /** Get the current schema version. */
  getSchemaVersion(): number {
    const row = this.db.prepare('SELECT MAX(version) as v FROM _migrations').get() as
      | { v: number | null }
      | undefined;
    return row?.v ?? 0;
  }

  /** Record a migration version. */
  setSchemaVersion(version: number): void {
    this.db.prepare('INSERT OR REPLACE INTO _migrations (version, applied_at) VALUES (?, ?)').run(
      version,
      new Date().toISOString(),
    );
  }

  /** Create all tables if they don't exist. */
  private initSchema(): void {
    this.db.exec(`
      -- Schema version tracking
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Audit log
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        profile_name TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_args TEXT NOT NULL DEFAULT '{}',
        result TEXT NOT NULL CHECK (result IN ('success', 'error')),
        result_summary TEXT,
        result_data TEXT,
        duration_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_profile ON audit_log(profile_name);
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_profile_timestamp ON audit_log(profile_name, timestamp);

      -- Users
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'invited')),
        token_hash TEXT NOT NULL,
        token_encrypted TEXT,
        password_hash TEXT,
        created_at TEXT NOT NULL,
        last_active_at TEXT,
        disabled_at TEXT,
        disabled_reason TEXT,
        onboarding_code TEXT,
        onboarding_expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
      CREATE INDEX IF NOT EXISTS idx_users_onboarding ON users(onboarding_code)
        WHERE onboarding_code IS NOT NULL;

      -- User profile access (one-to-many from users)
      CREATE TABLE IF NOT EXISTS user_profile_access (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        profile_name TEXT NOT NULL,
        allowed_tables TEXT,
        allowed_tools TEXT,
        access_mode TEXT NOT NULL CHECK (access_mode IN ('mcp', 'chat', 'both')),
        UNIQUE(user_id, profile_name)
      );
      CREATE INDEX IF NOT EXISTS idx_upa_user ON user_profile_access(user_id);
      CREATE INDEX IF NOT EXISTS idx_upa_profile ON user_profile_access(profile_name);

      -- Legacy tokens
      CREATE TABLE IF NOT EXISTS tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        profile_name TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tokens_profile ON tokens(profile_name);

      -- Write queue
      CREATE TABLE IF NOT EXISTS write_queue (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        profile_name TEXT NOT NULL,
        sql_text TEXT NOT NULL,
        params TEXT NOT NULL DEFAULT '[]',
        table_name TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('insert', 'update', 'delete')),
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
        approved_by TEXT,
        approved_at TEXT,
        execution_result TEXT,
        execution_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_wq_status ON write_queue(status);
      CREATE INDEX IF NOT EXISTS idx_wq_profile ON write_queue(profile_name);

      -- Connections (encrypted connection strings)
      CREATE TABLE IF NOT EXISTS connections (
        name TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        database_type TEXT NOT NULL,
        connection_string TEXT NOT NULL
      );

      -- Profiles (stored as a single JSON blob — deeply nested, consumed whole)
      CREATE TABLE IF NOT EXISTS profiles (
        key TEXT PRIMARY KEY DEFAULT 'main',
        data TEXT NOT NULL
      );

      -- Configurations
      CREATE TABLE IF NOT EXISTS configurations (
        name TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        connections TEXT NOT NULL,
        selected_tables TEXT NOT NULL,
        table_options TEXT,
        column_masking TEXT
      );

      -- AI config (single row, deprecated — kept for migration v6 read)
      CREATE TABLE IF NOT EXISTS ai_config (
        key TEXT PRIMARY KEY DEFAULT 'main',
        provider TEXT NOT NULL,
        api_key TEXT NOT NULL,
        model TEXT,
        base_url TEXT
      );

      -- AI settings (multiple named configs, each MCP can reference several)
      CREATE TABLE IF NOT EXISTS ai_settings (
        name TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        provider TEXT NOT NULL,
        api_key TEXT NOT NULL,
        model TEXT,
        base_url TEXT,
        capabilities TEXT,
        embedding_model TEXT,
        embedding_dimensions INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
}
