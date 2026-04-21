import mysql from 'mysql2/promise';
import type { DatabaseSchema, TableInfo, ColumnInfo, Relation } from '@calame/core';
import type { DatabaseConnector, QueryOptions, QueryResult, ConnectionOptions } from './types.js';

// Row shapes returned from information_schema queries
interface TableRow {
  table_name: string;
  table_schema: string;
}

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  table_name: string;
}

interface PrimaryKeyRow {
  column_name: string;
  table_name: string;
}

interface ForeignKeyRow {
  column_name: string;
  from_table: string;
  to_table: string;
  to_column: string;
}

/** Read pool configuration from environment variables. */
function getPoolConfig(): { maxSize: number; idleTimeoutMs: number } {
  const maxSize = parseInt(process.env.CALAME_DB_POOL_SIZE ?? '10', 10) || 10;
  const idleTimeoutMs = parseInt(process.env.CALAME_DB_IDLE_TIMEOUT_MS ?? '30000', 10) || 30000;
  return { maxSize, idleTimeoutMs };
}

function parseDsn(dsn: string): mysql.ConnectionOptions {
  // Expected format: mysql://user:password@host:port/database
  const url = new URL(dsn);

  if (url.protocol !== 'mysql:') {
    throw new Error(`Unsupported protocol "${url.protocol}" — expected "mysql:"`);
  }

  const port = url.port ? parseInt(url.port, 10) : 3306;
  const database = url.pathname.replace(/^\//, '');

  if (!database) {
    throw new Error('DSN must include a database name (e.g. mysql://user:pass@host:3306/mydb)');
  }

  return {
    host: url.hostname,
    port,
    user: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    database,
    // Disable multiplexing — one logical connection per operation
    multipleStatements: false,
  };
}

export class MySQLConnector implements DatabaseConnector {
  readonly name = 'mysql';
  readonly displayName = 'MySQL / MariaDB';
  readonly placeholderDsn = 'mysql://user:password@localhost:3306/mydb';

  /** Connection pools keyed by DSN. */
  private pools = new Map<string, mysql.Pool>();

  /** Get or create a connection pool for the given DSN. */
  private getPool(dsn: string, connOptions?: ConnectionOptions): mysql.Pool {
    // Use a distinct cache key when SSL is enabled so configurations don't collide.
    const cacheKey = connOptions?.ssl?.enabled ? `${dsn}__ssl` : dsn;
    let pool = this.pools.get(cacheKey);
    if (!pool) {
      const config = getPoolConfig();
      const parsedOptions = parseDsn(dsn);
      const poolConfig: mysql.PoolOptions = {
        ...parsedOptions,
        connectionLimit: config.maxSize,
        idleTimeout: config.idleTimeoutMs,
        waitForConnections: true,
        queueLimit: 100, // cap pending connections to prevent queue explosion
      };
      if (connOptions?.ssl?.enabled) {
        poolConfig.ssl = {
          rejectUnauthorized: connOptions.ssl.rejectUnauthorized ?? true,
          ...(connOptions.ssl.ca ? { ca: connOptions.ssl.ca } : {}),
          ...(connOptions.ssl.cert ? { cert: connOptions.ssl.cert } : {}),
          ...(connOptions.ssl.key ? { key: connOptions.ssl.key } : {}),
        };
      }
      pool = mysql.createPool(poolConfig);
      this.pools.set(cacheKey, pool);
    }
    return pool;
  }

  /**
   * Verify reachability by opening a connection and running SELECT 1.
   *
   * DSN parsing errors (wrong protocol, missing database) are thrown immediately
   * since they indicate a configuration mistake, not a transient network failure.
   * Only actual connection / query failures are caught and converted to `false`.
   */
  async testConnection(dsn: string, connOptions?: ConnectionOptions): Promise<boolean> {
    // Validate and parse the DSN outside the try/catch so misconfiguration
    // surfaces as a thrown error rather than silently returning false.
    const options = parseDsn(dsn);

    if (connOptions?.ssl?.enabled) {
      (options as mysql.ConnectionOptions).ssl = {
        rejectUnauthorized: connOptions.ssl.rejectUnauthorized ?? true,
        ...(connOptions.ssl.ca ? { ca: connOptions.ssl.ca } : {}),
        ...(connOptions.ssl.cert ? { cert: connOptions.ssl.cert } : {}),
        ...(connOptions.ssl.key ? { key: connOptions.ssl.key } : {}),
      };
    }

    let connection: mysql.Connection | undefined;
    try {
      connection = await mysql.createConnection(options);
      await connection.query('SELECT 1');
      return true;
    } catch {
      return false;
    } finally {
      await connection?.end();
    }
  }

  /**
   * Introspect the database described by `dsn` and return a DatabaseSchema.
   * All four queries run against the current database (DATABASE()) so no
   * user-supplied identifiers are ever interpolated into SQL strings.
   */
  async introspect(dsn: string, connOptions?: ConnectionOptions): Promise<DatabaseSchema> {
    const parsedOptions = parseDsn(dsn);
    if (connOptions?.ssl?.enabled) {
      (parsedOptions as mysql.ConnectionOptions).ssl = {
        rejectUnauthorized: connOptions.ssl.rejectUnauthorized ?? true,
        ...(connOptions.ssl.ca ? { ca: connOptions.ssl.ca } : {}),
        ...(connOptions.ssl.cert ? { cert: connOptions.ssl.cert } : {}),
        ...(connOptions.ssl.key ? { key: connOptions.ssl.key } : {}),
      };
    }
    const connection = await mysql.createConnection(parsedOptions);

    try {
      // 1. Tables
      const [tableRows] = await connection.query<mysql.RowDataPacket[]>(
        `SELECT table_name, table_schema
         FROM information_schema.tables
         WHERE table_schema = DATABASE()
         AND table_type = 'BASE TABLE'`,
      );

      // 2. Columns
      const [columnRows] = await connection.query<mysql.RowDataPacket[]>(
        `SELECT column_name, data_type, is_nullable, column_default, table_name
         FROM information_schema.columns
         WHERE table_schema = DATABASE()`,
      );

      // 3. Primary keys
      const [pkRows] = await connection.query<mysql.RowDataPacket[]>(
        `SELECT kcu.column_name, kcu.table_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema = DATABASE()`,
      );

      // 4. Foreign keys
      const [fkRows] = await connection.query<mysql.RowDataPacket[]>(
        `SELECT kcu.column_name,
                kcu.table_name AS from_table,
                kcu.referenced_table_name AS to_table,
                kcu.referenced_column_name AS to_column
         FROM information_schema.key_column_usage kcu
         JOIN information_schema.table_constraints tc
           ON kcu.constraint_name = tc.constraint_name
           AND kcu.table_schema = tc.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = DATABASE()`,
      );

      // --- Assemble primary key map: tableName → column names ---
      const pkMap = new Map<string, string[]>();
      for (const row of pkRows as PrimaryKeyRow[]) {
        const cols = pkMap.get(row.table_name) ?? [];
        cols.push(row.column_name);
        pkMap.set(row.table_name, cols);
      }

      // --- Assemble column map: tableName → ColumnInfo[] ---
      const colMap = new Map<string, ColumnInfo[]>();
      for (const row of columnRows as ColumnRow[]) {
        const cols = colMap.get(row.table_name) ?? [];
        cols.push({
          name: row.column_name,
          type: row.data_type,
          nullable: row.is_nullable === 'YES',
          defaultValue: row.column_default,
        });
        colMap.set(row.table_name, cols);
      }

      // --- Assemble tables ---
      const tables: TableInfo[] = (tableRows as TableRow[]).map((row) => ({
        name: row.table_name,
        schema: row.table_schema,
        columns: colMap.get(row.table_name) ?? [],
        primaryKeys: pkMap.get(row.table_name) ?? [],
      }));

      // --- Assemble relations ---
      const relations: Relation[] = (fkRows as ForeignKeyRow[]).map((row) => ({
        fromTable: row.from_table,
        fromColumn: row.column_name,
        toTable: row.to_table,
        toColumn: row.to_column,
      }));

      return { tables, relations };
    } finally {
      await connection.end();
    }
  }

  async sampleColumnValues(
    dsn: string,
    table: string,
    column: string,
    limit: number = 100,
    connOptions?: ConnectionOptions,
  ): Promise<string[]> {
    const options = parseDsn(dsn);
    if (connOptions?.ssl?.enabled) {
      (options as mysql.ConnectionOptions).ssl = {
        rejectUnauthorized: connOptions.ssl.rejectUnauthorized ?? true,
        ...(connOptions.ssl.ca ? { ca: connOptions.ssl.ca } : {}),
        ...(connOptions.ssl.cert ? { cert: connOptions.ssl.cert } : {}),
        ...(connOptions.ssl.key ? { key: connOptions.ssl.key } : {}),
      };
    }
    let connection: mysql.Connection | undefined;
    try {
      connection = await mysql.createConnection(options);
      const [rows] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT DISTINCT CAST(?? AS CHAR) AS val FROM ?? WHERE ?? IS NOT NULL LIMIT ?',
        [column, table, column, limit],
      );
      return rows.map((row) => row.val as string);
    } catch {
      return [];
    } finally {
      await connection?.end();
    }
  }

  async query(dsn: string, sql: string, options?: QueryOptions): Promise<QueryResult> {
    const pool = this.getPool(dsn, options?.ssl ? { ssl: options.ssl } : undefined);
    const connection = await pool.getConnection();
    try {
      await connection.query('SET TRANSACTION READ ONLY');
      await connection.beginTransaction();
      if (options?.timeoutMs && options.timeoutMs > 0) {
        await connection.query(`SET SESSION max_execution_time = ${Math.max(1000, options.timeoutMs)}`);
      }
      const [rows] = options?.params && options.params.length > 0
        ? await connection.execute(sql, options.params as (string | number | null | Buffer)[])
        : await connection.execute(sql);
      await connection.commit();
      return { rows: rows as Record<string, unknown>[] };
    } catch (error: unknown) {
      await connection.rollback().catch(() => {});
      // Translate MySQL timeout errors
      if (error instanceof Error && (error.message.includes('Query execution was interrupted') || error.message.includes('max_execution_time exceeded'))) {
        throw new Error(
          `Query timed out after ${options?.timeoutMs ?? 0}ms. ` +
          'Try narrowing your query with filters or reducing the result set.',
        );
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  getPoolStats(): { active: number; idle: number; waiting: number; total: number } {
    // mysql2 exposes pool internals via the underlying pool object.
    // _allConnections, _freeConnections, and _connectionQueue are internal
    // but stable across mysql2 versions; fall back to zeros if unavailable.
    let active = 0;
    let idle = 0;
    let waiting = 0;
    let total = 0;
    for (const pool of this.pools.values()) {
      const p = pool as unknown as {
        pool?: {
          _allConnections?: { length: number };
          _freeConnections?: { length: number };
          _connectionQueue?: { length: number };
        };
      };
      const inner = p.pool;
      if (inner) {
        const allCount = inner._allConnections?.length ?? 0;
        const freeCount = inner._freeConnections?.length ?? 0;
        const queueCount = inner._connectionQueue?.length ?? 0;
        total += allCount;
        idle += freeCount;
        active += allCount - freeCount;
        waiting += queueCount;
      }
    }
    return { active, idle, waiting, total };
  }

  async disconnect(): Promise<void> {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(pools.map((p) => p.end()));
  }
}

export const mysqlConnector = new MySQLConnector();
