import { Client, Pool } from 'pg';
import type { DatabaseSchema, TableInfo, ColumnInfo, Relation } from '@calame/core';
import type { DatabaseConnector, QueryOptions, QueryResult, ConnectionOptions } from './types.js';

/** Read pool configuration from environment variables. */
function getPoolConfig(): { maxSize: number; idleTimeoutMs: number } {
  const maxSize = parseInt(process.env.CALAME_DB_POOL_SIZE ?? '10', 10) || 10;
  const idleTimeoutMs = parseInt(process.env.CALAME_DB_IDLE_TIMEOUT_MS ?? '30000', 10) || 30000;
  return { maxSize, idleTimeoutMs };
}

export class PostgreSQLConnector implements DatabaseConnector {
  readonly name = 'postgresql';
  readonly displayName = 'PostgreSQL';
  readonly placeholderDsn = 'postgresql://user:password@localhost:5432/mydb';

  /** Connection pools keyed by DSN. */
  private pools = new Map<string, Pool>();

  /** Get or create a connection pool for the given DSN. */
  private getPool(dsn: string, options?: ConnectionOptions): Pool {
    // Use a cache key that includes SSL status so different SSL configurations
    // produce distinct pools rather than reusing an incompatible one.
    const cacheKey = options?.ssl?.enabled ? `${dsn}__ssl` : dsn;
    let pool = this.pools.get(cacheKey);
    if (!pool) {
      const config = getPoolConfig();
      const poolConfig: import('pg').PoolConfig = {
        connectionString: dsn,
        max: config.maxSize,
        idleTimeoutMillis: config.idleTimeoutMs,
      };
      if (options?.ssl?.enabled) {
        poolConfig.ssl = {
          rejectUnauthorized: options.ssl.rejectUnauthorized ?? true,
          ...(options.ssl.ca ? { ca: options.ssl.ca } : {}),
          ...(options.ssl.cert ? { cert: options.ssl.cert } : {}),
          ...(options.ssl.key ? { key: options.ssl.key } : {}),
        };
      }
      pool = new Pool(poolConfig);
      pool.on('error', (err) => {
        console.error('[postgresql] Pool idle client error:', err.message);
      });
      this.pools.set(cacheKey, pool);
    }
    return pool;
  }

  async testConnection(dsn: string, options?: ConnectionOptions): Promise<boolean> {
    const clientConfig: import('pg').ClientConfig = { connectionString: dsn };
    if (options?.ssl?.enabled) {
      clientConfig.ssl = {
        rejectUnauthorized: options.ssl.rejectUnauthorized ?? true,
        ...(options.ssl.ca ? { ca: options.ssl.ca } : {}),
        ...(options.ssl.cert ? { cert: options.ssl.cert } : {}),
        ...(options.ssl.key ? { key: options.ssl.key } : {}),
      };
    }
    const client = new Client(clientConfig);
    try {
      await client.connect();
      await client.query('SELECT 1');
      return true;
    } catch {
      return false;
    } finally {
      await client.end();
    }
  }

  async introspect(dsn: string, options?: ConnectionOptions): Promise<DatabaseSchema> {
    const clientConfig: import('pg').ClientConfig = { connectionString: dsn };
    if (options?.ssl?.enabled) {
      clientConfig.ssl = {
        rejectUnauthorized: options.ssl.rejectUnauthorized ?? true,
        ...(options.ssl.ca ? { ca: options.ssl.ca } : {}),
        ...(options.ssl.cert ? { cert: options.ssl.cert } : {}),
        ...(options.ssl.key ? { key: options.ssl.key } : {}),
      };
    }
    const client = new Client(clientConfig);

    try {
      await client.connect();

      // Fetch tables
      const tablesResult = await client.query<{ table_name: string; table_schema: string }>(
        `SELECT table_name, table_schema
         FROM information_schema.tables
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         AND table_type = 'BASE TABLE'`,
      );

      // Fetch columns
      const columnsResult = await client.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
        table_name: string;
        table_schema: string;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default, table_name, table_schema
         FROM information_schema.columns
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`,
      );

      // Fetch primary keys
      const pksResult = await client.query<{ column_name: string; table_name: string }>(
        `SELECT kcu.column_name, tc.table_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')`,
      );

      // Fetch foreign keys
      const fksResult = await client.query<{
        column_name: string;
        from_table: string;
        to_table: string;
        to_column: string;
      }>(
        `SELECT
           kcu.column_name,
           kcu.table_name AS from_table,
           ccu.table_name AS to_table,
           ccu.column_name AS to_column
         FROM information_schema.key_column_usage kcu
         JOIN information_schema.constraint_column_usage ccu
           ON kcu.constraint_name = ccu.constraint_name
         JOIN information_schema.table_constraints tc
           ON kcu.constraint_name = tc.constraint_name
         WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')`,
      );

      // Build primary keys map
      const pkMap = new Map<string, string[]>();
      for (const row of pksResult.rows) {
        const existing = pkMap.get(row.table_name) ?? [];
        existing.push(row.column_name);
        pkMap.set(row.table_name, existing);
      }

      // Build columns map
      const colMap = new Map<string, ColumnInfo[]>();
      for (const row of columnsResult.rows) {
        const key = `${row.table_schema}.${row.table_name}`;
        const existing = colMap.get(key) ?? [];
        existing.push({
          name: row.column_name,
          type: row.data_type,
          nullable: row.is_nullable === 'YES',
          defaultValue: row.column_default,
        });
        colMap.set(key, existing);
      }

      // Assemble tables
      const tables: TableInfo[] = tablesResult.rows.map((row) => ({
        name: row.table_name,
        schema: row.table_schema,
        columns: colMap.get(`${row.table_schema}.${row.table_name}`) ?? [],
        primaryKeys: pkMap.get(row.table_name) ?? [],
      }));

      // Assemble relations
      const relations: Relation[] = fksResult.rows.map((row) => ({
        fromTable: row.from_table,
        fromColumn: row.column_name,
        toTable: row.to_table,
        toColumn: row.to_column,
      }));

      return { tables, relations };
    } finally {
      await client.end();
    }
  }

  async sampleColumnValues(
    dsn: string,
    table: string,
    column: string,
    limit: number = 100,
    options?: ConnectionOptions,
  ): Promise<string[]> {
    const clientConfig: import('pg').ClientConfig = { connectionString: dsn };
    if (options?.ssl?.enabled) {
      clientConfig.ssl = {
        rejectUnauthorized: options.ssl.rejectUnauthorized ?? true,
        ...(options.ssl.ca ? { ca: options.ssl.ca } : {}),
        ...(options.ssl.cert ? { cert: options.ssl.cert } : {}),
        ...(options.ssl.key ? { key: options.ssl.key } : {}),
      };
    }
    const client = new Client(clientConfig);
    try {
      await client.connect();
      const result = await client.query<{ val: string }>(
        `SELECT DISTINCT "${column}"::text AS val FROM "${table}" WHERE "${column}" IS NOT NULL LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => row.val);
    } catch {
      return [];
    } finally {
      await client.end();
    }
  }

  async query(dsn: string, sql: string, options?: QueryOptions): Promise<QueryResult> {
    const pool = this.getPool(dsn, options?.ssl ? { ssl: options.ssl } : undefined);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION READ ONLY');
      if (options?.timeoutMs && options.timeoutMs > 0) {
        await client.query(`SET statement_timeout = ${Math.floor(options.timeoutMs)}`);
      }
      const result = options?.params && options.params.length > 0
        ? await client.query(sql, options.params)
        : await client.query(sql);
      await client.query('COMMIT');
      return { rows: result.rows };
    } catch (error: unknown) {
      await client.query('ROLLBACK').catch(() => {});
      // Translate timeout errors into a clear message
      if (error instanceof Error && error.message.includes('statement timeout')) {
        throw new Error(
          `Query timed out after ${options?.timeoutMs ?? 0}ms. ` +
          'Try narrowing your query with filters or reducing the result set.',
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  getPoolStats(): { active: number; idle: number; waiting: number; total: number } {
    // Aggregate stats across all pools held by this connector instance.
    let active = 0;
    let idle = 0;
    let waiting = 0;
    let total = 0;
    for (const pool of this.pools.values()) {
      active += pool.totalCount - pool.idleCount;
      idle += pool.idleCount;
      waiting += pool.waitingCount;
      total += pool.totalCount;
    }
    return { active, idle, waiting, total };
  }

  async disconnect(): Promise<void> {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(pools.map((p) => p.end()));
  }
}
