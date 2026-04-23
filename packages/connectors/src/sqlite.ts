import Database from 'better-sqlite3';
import type { DatabaseSchema, TableInfo, ColumnInfo, Relation } from '@calame/core';
import type { DatabaseConnector, QueryOptions, QueryResult, ConnectionOptions } from './types.js';

// ---------------------------------------------------------------------------
// Internal PRAGMA row shapes
// ---------------------------------------------------------------------------

interface TableMasterRow {
  name: string;
}

interface PragmaTableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number; // 0 | 1
  dflt_value: string | null;
  pk: number; // 0 = not PK, >0 = PK ordinal
}

interface PragmaForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

// ---------------------------------------------------------------------------
// DSN parsing
// ---------------------------------------------------------------------------

/**
 * Extract the filesystem path from a SQLite DSN.
 *
 * Accepted formats:
 *   - sqlite:///absolute/path/db.sqlite   → /absolute/path/db.sqlite
 *   - sqlite://relative/path/db.sqlite    → relative/path/db.sqlite
 *   - sqlite:./relative/path/db.sqlite    → ./relative/path/db.sqlite
 *   - sqlite:/absolute/path/db.sqlite     → /absolute/path/db.sqlite
 *   - /absolute/path/db.sqlite            → /absolute/path/db.sqlite
 *   - relative/path/db.sqlite             → relative/path/db.sqlite
 */
function parseDsn(dsn: string): string {
  if (dsn.startsWith('sqlite://')) {
    // "sqlite:///foo" → "/foo"  (three slashes: scheme + absolute path)
    // "sqlite://foo"  → "foo"   (two slashes:  scheme + relative path)
    return dsn.slice('sqlite://'.length);
  }
  if (dsn.startsWith('sqlite:')) {
    // Short form: "sqlite:./foo" → "./foo", "sqlite:/abs" → "/abs"
    return dsn.slice('sqlite:'.length);
  }
  return dsn;
}

// ---------------------------------------------------------------------------
// SQLiteConnector
// ---------------------------------------------------------------------------

export class SQLiteConnector implements DatabaseConnector {
  readonly name = 'sqlite';
  readonly displayName = 'SQLite';
  readonly placeholderDsn = 'sqlite:///path/to/database.db';

  /**
   * Cached database handles keyed by file path.
   * SQLite is in-process, so "pooling" means reusing the same handle.
   */
  private handles = new Map<string, Database.Database>();

  /** Get or create a cached database handle for the given DSN. */
  private getHandle(dsn: string): Database.Database {
    const filePath = parseDsn(dsn);
    let db = this.handles.get(filePath);
    if (!db) {
      db = new Database(filePath, { readonly: true, fileMustExist: true });
      // WAL mode for better concurrent read performance
      try {
        db.pragma('journal_mode = WAL');
      } catch {
        // readonly databases may not allow changing journal mode — that's fine
      }
      this.handles.set(filePath, db);
    }
    return db;
  }

  // -------------------------------------------------------------------------
  // testConnection
  // -------------------------------------------------------------------------

  // ConnectionOptions is accepted for interface compliance — SSL does not apply to SQLite.
  async testConnection(dsn: string, _options?: ConnectionOptions): Promise<void> {
    const filePath = parseDsn(dsn);
    let db: Database.Database | null = null;
    try {
      // readonly: true prevents creating the file when it doesn't exist.
      db = new Database(filePath, { readonly: true, fileMustExist: true });
      db.prepare('SELECT 1').get();
    } finally {
      db?.close();
    }
  }

  // -------------------------------------------------------------------------
  // introspect
  // -------------------------------------------------------------------------

  // ConnectionOptions is accepted for interface compliance — SSL does not apply to SQLite.
  async introspect(dsn: string, _options?: ConnectionOptions): Promise<DatabaseSchema> {
    const filePath = parseDsn(dsn);
    const db = new Database(filePath, { readonly: true, fileMustExist: true });

    try {
      // 1. Enumerate user tables (exclude internal sqlite_* tables).
      const tableRows = db
        .prepare<[], TableMasterRow>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
        )
        .all();

      const tables: TableInfo[] = [];
      const relations: Relation[] = [];

      for (const { name: tableName } of tableRows) {
        // 2. Column info for this table.
        const pragmaColumns = db
          .prepare<[], PragmaTableInfoRow>(`PRAGMA table_info("${escapeName(tableName)}")`)
          .all();

        const columns: ColumnInfo[] = pragmaColumns.map((row) => ({
          name: row.name,
          type: row.type,
          nullable: row.notnull === 0,
          defaultValue: row.dflt_value,
        }));

        const primaryKeys: string[] = pragmaColumns
          .filter((row) => row.pk > 0)
          .sort((a, b) => a.pk - b.pk) // preserve composite PK order
          .map((row) => row.name);

        tables.push({
          name: tableName,
          schema: 'main',
          columns,
          primaryKeys,
        });

        // 3. Foreign keys for this table → assembled into Relation objects.
        const pragmaFks = db
          .prepare<[], PragmaForeignKeyRow>(`PRAGMA foreign_key_list("${escapeName(tableName)}")`)
          .all();

        for (const fk of pragmaFks) {
          relations.push({
            fromTable: tableName,
            fromColumn: fk.from,
            toTable: fk.table,
            toColumn: fk.to,
          });
        }
      }

      return { tables, relations };
    } finally {
      db.close();
    }
  }

  // -------------------------------------------------------------------------
  // sampleColumnValues
  // -------------------------------------------------------------------------

  // ConnectionOptions is accepted for interface compliance — SSL does not apply to SQLite.
  async sampleColumnValues(
    dsn: string,
    table: string,
    column: string,
    limit: number = 100,
    _options?: ConnectionOptions,
  ): Promise<string[]> {
    const filePath = parseDsn(dsn);
    let db: Database.Database | null = null;
    try {
      db = new Database(filePath, { readonly: true, fileMustExist: true });
      const safeTable = escapeName(table);
      const safeColumn = escapeName(column);
      const rows = db
        .prepare(`SELECT DISTINCT CAST("${safeColumn}" AS TEXT) AS val FROM "${safeTable}" WHERE "${safeColumn}" IS NOT NULL LIMIT ?`)
        .all(limit) as { val: string }[];
      return rows.map((row) => row.val);
    } catch {
      return [];
    } finally {
      db?.close();
    }
  }

  // -------------------------------------------------------------------------
  // query (pooled + timeout)
  // -------------------------------------------------------------------------

  async query(dsn: string, sql: string, options?: QueryOptions): Promise<QueryResult> {
    const db = this.getHandle(dsn);

    if (options?.timeoutMs && options.timeoutMs > 0) {
      const deadline = Date.now() + options.timeoutMs;
      const timeoutMs = options.timeoutMs;

      // Register a custom function that throws when deadline is exceeded.
      // We call it in every result row via a wrapping SELECT.
      try {
        db.function('_calame_timeout', { deterministic: false }, () => {
          if (Date.now() > deadline) {
            throw new Error(
              `Query timed out after ${timeoutMs}ms. ` +
              'Try narrowing your query with filters or reducing the result set.',
            );
          }
          return 1;
        });
      } catch {
        // Function may already be registered from a previous call — that's OK.
      }

      // Wrap the SQL so _calame_timeout() is evaluated for each row.
      const wrappedSql = `SELECT * FROM (${sql}) AS _q WHERE _calame_timeout() = 1`;
      const bindParams = options?.params ?? [];
      try {
        const rows = db.prepare(wrappedSql).all(...bindParams);
        return { rows: rows as Record<string, unknown>[] };
      } catch (err: unknown) {
        // If wrapping fails (e.g., SQL incompatibility), fall back to raw execution.
        if (err instanceof Error && err.message.includes('timed out')) throw err;
        const rows = db.prepare(sql).all(...bindParams);
        return { rows: rows as Record<string, unknown>[] };
      }
    }

    const bindParams = options?.params ?? [];
    const rows = db.prepare(sql).all(...bindParams);
    return { rows: rows as Record<string, unknown>[] };
  }

  // -------------------------------------------------------------------------
  // disconnect
  // -------------------------------------------------------------------------

  async disconnect(): Promise<void> {
    for (const db of this.handles.values()) {
      try {
        db.close();
      } catch {
        // Already closed — ignore
      }
    }
    this.handles.clear();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape a table name for use inside a PRAGMA statement.
 * PRAGMA does not support parameterised queries, so we must sanitise manually.
 * We allow only word characters and spaces; anything else is stripped.
 */
function escapeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_ ]/g, '');
}
