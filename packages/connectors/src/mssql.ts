import sql from 'mssql';
import type { DatabaseSchema, TableInfo, ColumnInfo, Relation } from '@calame/core';
import type { DatabaseConnector, QueryOptions, QueryResult, ConnectionOptions } from './types.js';

// ---------------------------------------------------------------------------
// Microsoft SQL Server connector (driver: `mssql`, tedious under the hood).
//
// AUTHENTICATION SCOPE — v1 supports **SQL Server authentication only**
// (a login/password pair carried in the DSN). Windows / Active Directory
// integrated authentication (`Integrated Security=SSPI`,
// `Trusted_Connection=yes`, Azure AD token auth) is explicitly OUT OF SCOPE
// for this release: `parseDsn` rejects those DSNs with an actionable error
// rather than silently falling back to an anonymous connection.
//
// SCHEMA NAMING — SQL Server namespaces every table under a schema (`dbo` by
// default). We mirror the PostgreSQL connector exactly: `TableInfo.name`
// holds the BARE table name and `TableInfo.schema` holds the owning schema.
// The serve layer re-joins them through `dialect.quoteTable(schema, table)`,
// which renders `[schema].[table]` for every table including `dbo` ones. We do
// NOT flatten non-dbo tables into a `schema.table` string: the DatabaseSchema
// model already carries the schema as a first-class field, so flattening would
// break column lookups, scope-guard table keys and FK relation matching.
// ---------------------------------------------------------------------------

/** Schemas owned by SQL Server itself — never surfaced as user tables. */
const SYSTEM_SCHEMAS = [
  'sys',
  'INFORMATION_SCHEMA',
  'guest',
  'db_accessadmin',
  'db_backupoperator',
  'db_datareader',
  'db_datawriter',
  'db_ddladmin',
  'db_denydatareader',
  'db_denydatawriter',
  'db_owner',
  'db_securityadmin',
];

/** Read pool configuration from environment variables. */
function getPoolConfig(): { maxSize: number; idleTimeoutMs: number } {
  const maxSize = parseInt(process.env.CALAME_DB_POOL_SIZE ?? '10', 10) || 10;
  const idleTimeoutMs = parseInt(process.env.CALAME_DB_IDLE_TIMEOUT_MS ?? '30000', 10) || 30000;
  return { maxSize, idleTimeoutMs };
}

/**
 * Quote a SQL Server identifier with brackets, escaping any embedded `]`
 * by doubling it (`my]col` → `[my]]col]`). Bracket quoting is the T-SQL
 * equivalent of Postgres double quotes / MySQL backticks.
 */
export function quoteMssqlIdent(name: string): string {
  return `[${name.replace(/]/g, ']]')}]`;
}

// ---------------------------------------------------------------------------
// DSN parsing — two accepted forms
// ---------------------------------------------------------------------------

/** Keys that signal Windows / AD integrated auth, which v1 does not support. */
const INTEGRATED_AUTH_KEYS = ['integrated security', 'trusted_connection', 'trustedconnection'];

/**
 * Split an ADO-style connection string into key/value pairs.
 *
 * Values may be wrapped in braces (`Password={p;w}`) — the ADO convention for
 * values containing `;` or `=`. Inside braces a literal `}` is written `}}`.
 */
function splitAdoPairs(dsn: string): Map<string, string> {
  const pairs = new Map<string, string>();
  let i = 0;

  while (i < dsn.length) {
    // Skip separators / whitespace between pairs
    while (i < dsn.length && (dsn[i] === ';' || /\s/.test(dsn[i]))) i++;
    if (i >= dsn.length) break;

    const eq = dsn.indexOf('=', i);
    if (eq === -1) break;
    const key = dsn.slice(i, eq).trim().toLowerCase();
    i = eq + 1;

    let value: string;
    if (dsn[i] === '{') {
      // Braced value — consume until an unescaped closing brace
      i++;
      let out = '';
      while (i < dsn.length) {
        if (dsn[i] === '}') {
          if (dsn[i + 1] === '}') {
            out += '}';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        out += dsn[i++];
      }
      value = out;
      // Skip to the next separator
      while (i < dsn.length && dsn[i] !== ';') i++;
    } else {
      const end = dsn.indexOf(';', i);
      const stop = end === -1 ? dsn.length : end;
      value = dsn.slice(i, stop).trim();
      i = stop;
    }

    if (key) pairs.set(key, value);
  }

  return pairs;
}

/** Parse an ADO `Encrypt=true` style flag. */
function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === 'yes' || v === '1') return true;
  if (v === 'false' || v === 'no' || v === '0') return false;
  return undefined;
}

/**
 * Split the ADO `Server` value into host / port / named instance.
 * Accepts `host`, `host,1433`, `host\SQLEXPRESS` and `tcp:host,1433`.
 */
function parseServerValue(raw: string): { server: string; port?: number; instanceName?: string } {
  let value = raw.trim().replace(/^tcp:/i, '');
  let port: number | undefined;
  let instanceName: string | undefined;

  const comma = value.lastIndexOf(',');
  if (comma !== -1) {
    const parsed = parseInt(value.slice(comma + 1).trim(), 10);
    if (!Number.isNaN(parsed)) {
      port = parsed;
      value = value.slice(0, comma);
    }
  }

  const backslash = value.indexOf('\\');
  if (backslash !== -1) {
    instanceName = value.slice(backslash + 1).trim();
    value = value.slice(0, backslash);
  }

  return {
    server: value.trim(),
    ...(port !== undefined ? { port } : {}),
    ...(instanceName ? { instanceName } : {}),
  };
}

/**
 * Build an mssql driver config from either supported DSN form:
 *
 *   1. ADO style — `Server=localhost,1433;Database=mydb;User Id=sa;Password=…;Encrypt=true;TrustServerCertificate=true`
 *   2. URL style — `mssql://user:pass@localhost:1433/mydb?encrypt=true&trustServerCertificate=true`
 *
 * Both are documented in `placeholderDsn`. Parsing failures throw immediately:
 * they are configuration mistakes, not transient network faults.
 */
export function parseDsn(dsn: string): sql.config {
  const trimmed = dsn.trim();
  return /^(mssql|sqlserver):\/\//i.test(trimmed) ? parseUrlDsn(trimmed) : parseAdoDsn(trimmed);
}

function rejectIntegratedAuth(): never {
  throw new Error(
    'Windows / Active Directory integrated authentication is not supported in this version. ' +
      'Use SQL Server authentication instead (e.g. "User Id=sa;Password=…").',
  );
}

function parseUrlDsn(dsn: string): sql.config {
  const url = new URL(dsn);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));

  if (!database) {
    throw new Error(
      'DSN must include a database name (e.g. mssql://user:pass@localhost:1433/mydb)',
    );
  }

  const user = url.username ? decodeURIComponent(url.username) : '';
  const password = url.password ? decodeURIComponent(url.password) : '';
  if (!user || !password) {
    throw new Error(
      'DSN must include a SQL Server login and password ' +
        '(e.g. mssql://user:pass@localhost:1433/mydb). ' +
        'Windows / Active Directory authentication is not supported in this version.',
    );
  }

  const params = url.searchParams;
  // The URL form spells options as query params; accept the ADO casing too.
  const get = (...names: string[]): string | undefined => {
    for (const n of names) {
      const hit = params.get(n) ?? params.get(n.toLowerCase());
      if (hit !== null && hit !== undefined) return hit;
    }
    return undefined;
  };

  const encrypt = parseBool(get('encrypt'));
  const trustServerCertificate = parseBool(
    get('trustServerCertificate', 'trustservercertificate', 'trusted'),
  );
  const instanceName = get('instanceName', 'instancename') || undefined;

  return buildConfig({
    server: url.hostname,
    port: url.port ? parseInt(url.port, 10) : undefined,
    database,
    user,
    password,
    encrypt,
    trustServerCertificate,
    instanceName,
  });
}

function parseAdoDsn(dsn: string): sql.config {
  const pairs = splitAdoPairs(dsn);
  if (pairs.size === 0) {
    throw new Error(
      'Unrecognised SQL Server connection string. Expected either ' +
        '"Server=host,1433;Database=db;User Id=user;Password=pass" or ' +
        '"mssql://user:pass@host:1433/db".',
    );
  }

  for (const key of INTEGRATED_AUTH_KEYS) {
    if (parseBool(pairs.get(key)) === true || pairs.get(key)?.toLowerCase() === 'sspi') {
      rejectIntegratedAuth();
    }
  }

  const rawServer =
    pairs.get('server') ?? pairs.get('data source') ?? pairs.get('addr') ?? pairs.get('address');
  if (!rawServer) {
    throw new Error('DSN must include a "Server" (e.g. "Server=localhost,1433").');
  }
  const { server, port, instanceName } = parseServerValue(rawServer);

  const database = pairs.get('database') ?? pairs.get('initial catalog');
  if (!database) {
    throw new Error('DSN must include a "Database" (e.g. "Database=mydb").');
  }

  const user = pairs.get('user id') ?? pairs.get('uid') ?? pairs.get('user');
  const password = pairs.get('password') ?? pairs.get('pwd');
  if (!user || !password) {
    throw new Error(
      'DSN must include "User Id" and "Password" — this version supports SQL Server ' +
        'authentication only (Windows / Active Directory authentication is not supported).',
    );
  }

  return buildConfig({
    server,
    port,
    database,
    user,
    password,
    encrypt: parseBool(pairs.get('encrypt')),
    trustServerCertificate: parseBool(pairs.get('trustservercertificate')),
    instanceName,
    connectionTimeoutMs: toMs(pairs.get('connection timeout') ?? pairs.get('connect timeout')),
  });
}

/** ADO expresses `Connection Timeout` in seconds; the driver wants milliseconds. */
function toMs(seconds: string | undefined): number | undefined {
  if (seconds === undefined) return undefined;
  const parsed = parseInt(seconds.trim(), 10);
  return Number.isNaN(parsed) ? undefined : parsed * 1000;
}

interface ParsedDsnParts {
  server: string;
  port?: number | undefined;
  database: string;
  user: string;
  password: string;
  encrypt?: boolean | undefined;
  trustServerCertificate?: boolean | undefined;
  instanceName?: string | undefined;
  connectionTimeoutMs?: number | undefined;
}

function buildConfig(parts: ParsedDsnParts): sql.config {
  if (!parts.server) {
    throw new Error('DSN must include a server host.');
  }
  const poolConfig = getPoolConfig();

  // `encrypt` defaults to true (tedious 18 / mssql 11 default) so connections
  // are secure unless the operator explicitly opts out in the DSN.
  return {
    server: parts.server,
    ...(parts.port !== undefined ? { port: parts.port } : {}),
    database: parts.database,
    user: parts.user,
    password: parts.password,
    ...(parts.connectionTimeoutMs !== undefined
      ? { connectionTimeout: parts.connectionTimeoutMs }
      : {}),
    options: {
      encrypt: parts.encrypt ?? true,
      trustServerCertificate: parts.trustServerCertificate ?? false,
      ...(parts.instanceName ? { instanceName: parts.instanceName } : {}),
      // One statement per request — matches the read-only posture of the
      // other connectors (mysql sets multipleStatements: false).
      enableArithAbort: true,
    },
    pool: {
      max: poolConfig.maxSize,
      min: 0,
      idleTimeoutMillis: poolConfig.idleTimeoutMs,
    },
  };
}

/**
 * Layer the caller's SslConfig over a parsed DSN config. The DSN itself may
 * already carry `Encrypt` / `TrustServerCertificate`; an explicit SslConfig
 * from the connection record wins.
 */
function applySsl(config: sql.config, connOptions?: ConnectionOptions): sql.config {
  if (!connOptions?.ssl?.enabled) return config;
  const ssl = connOptions.ssl;
  const rejectUnauthorized = ssl.rejectUnauthorized ?? true;
  return {
    ...config,
    options: {
      ...config.options,
      encrypt: true,
      // SQL Server has no separate "verify CA" switch: trusting the server
      // certificate is the inverse of rejectUnauthorized.
      trustServerCertificate: !rejectUnauthorized,
      ...(ssl.ca || ssl.cert || ssl.key
        ? {
            cryptoCredentialsDetails: {
              ...(ssl.ca ? { ca: ssl.ca } : {}),
              ...(ssl.cert ? { cert: ssl.cert } : {}),
              ...(ssl.key ? { key: ssl.key } : {}),
            },
          }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Row shapes returned from INFORMATION_SCHEMA queries
// ---------------------------------------------------------------------------

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
  table_schema: string;
}

interface PrimaryKeyRow {
  column_name: string;
  table_name: string;
  table_schema: string;
}

interface ForeignKeyRow {
  column_name: string;
  from_table: string;
  to_table: string;
  to_column: string;
}

/** Key a table by schema so same-named tables in different schemas stay distinct. */
function tableKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}

const SYSTEM_SCHEMA_LIST = SYSTEM_SCHEMAS.map((s) => `'${s}'`).join(', ');

export class MSSQLConnector implements DatabaseConnector {
  readonly name = 'mssql';
  readonly displayName = 'SQL Server';
  /**
   * Both accepted DSN forms are shown so the connection form documents the
   * ADO-style string operators normally copy out of SSMS as well as the URL
   * form used by the other Calame connectors.
   */
  readonly placeholderDsn =
    'Server=localhost,1433;Database=mydb;User Id=sa;Password=…;Encrypt=true;TrustServerCertificate=true — or mssql://user:password@localhost:1433/mydb?encrypt=true&trustServerCertificate=true';

  /** Connection pools keyed by DSN. */
  private pools = new Map<string, sql.ConnectionPool>();
  /** In-flight pool connections, so concurrent callers share one handshake. */
  private connecting = new Map<string, Promise<sql.ConnectionPool>>();

  /**
   * Cache key for a pool. SSL-enabled configurations get their own key so they
   * never collide with a plaintext pool for the same DSN.
   */
  private cacheKeyFor(dsn: string, connOptions?: ConnectionOptions): string {
    return connOptions?.ssl?.enabled ? `${dsn}__ssl` : dsn;
  }

  /**
   * Drop a pool from the cache and close it, so the next call rebuilds a fresh
   * one. Closing is what actually reclaims connections the driver still counts
   * as borrowed — the idle timeout never touches those.
   */
  private evictPool(cacheKey: string, expected?: sql.ConnectionPool): void {
    const pool = this.pools.get(cacheKey);
    if (!pool || (expected && pool !== expected)) return;
    this.pools.delete(cacheKey);
    void pool.close().catch(() => {});
  }

  /** Get or create a connected pool for the given DSN. */
  private async getPool(dsn: string, connOptions?: ConnectionOptions): Promise<sql.ConnectionPool> {
    const cacheKey = this.cacheKeyFor(dsn, connOptions);
    const existing = this.pools.get(cacheKey);
    if (existing) return existing;

    const pending = this.connecting.get(cacheKey);
    if (pending) return pending;

    const config = applySsl(parseDsn(dsn), connOptions);
    const promise = (async () => {
      const pool = new sql.ConnectionPool(config);
      // A pool that errors while idle must not stay in the cache, or every
      // later call reuses a dead handle. Evict it so the next call rebuilds.
      pool.on('error', (err: Error) => {
        console.error('[mssql] Pool error:', err.message);
        this.evictPool(cacheKey, pool);
      });
      try {
        await pool.connect();
      } catch (error) {
        // Never leak the half-open pool when the handshake fails.
        await pool.close().catch(() => {});
        throw error;
      }
      this.pools.set(cacheKey, pool);
      return pool;
    })();
    this.connecting.set(cacheKey, promise);

    try {
      return await promise;
    } catch (error) {
      this.pools.delete(cacheKey);
      throw error;
    } finally {
      this.connecting.delete(cacheKey);
    }
  }

  /**
   * Verify reachability by opening a standalone connection and running SELECT 1.
   *
   * DSN parsing errors (missing database, integrated auth) are thrown
   * immediately since they indicate a configuration mistake. Connection /
   * query failures are rethrown so callers can surface the reason.
   */
  async testConnection(dsn: string, connOptions?: ConnectionOptions): Promise<void> {
    const config = applySsl(parseDsn(dsn), connOptions);
    const pool = new sql.ConnectionPool(config);
    try {
      await pool.connect();
      await pool.request().query('SELECT 1');
    } finally {
      try {
        await pool.close();
      } catch {
        /* swallow cleanup failures */
      }
    }
  }

  /**
   * Introspect the database described by `dsn` and return a DatabaseSchema.
   * All four queries read INFORMATION_SCHEMA in the connected database, so no
   * user-supplied identifier is ever interpolated into SQL.
   */
  async introspect(dsn: string, connOptions?: ConnectionOptions): Promise<DatabaseSchema> {
    const config = applySsl(parseDsn(dsn), connOptions);
    const pool = new sql.ConnectionPool(config);

    try {
      await pool.connect();

      // 1. Tables
      const tablesResult = await pool.request().query<TableRow>(
        `SELECT TABLE_NAME AS table_name, TABLE_SCHEMA AS table_schema
         FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_TYPE = 'BASE TABLE'
         AND TABLE_SCHEMA NOT IN (${SYSTEM_SCHEMA_LIST})`,
      );

      // 2. Columns
      const columnsResult = await pool.request().query<ColumnRow>(
        `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type,
                IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default,
                TABLE_NAME AS table_name, TABLE_SCHEMA AS table_schema
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA NOT IN (${SYSTEM_SCHEMA_LIST})
         ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
      );

      // 3. Primary keys
      const pksResult = await pool.request().query<PrimaryKeyRow>(
        `SELECT kcu.COLUMN_NAME AS column_name, kcu.TABLE_NAME AS table_name,
                kcu.TABLE_SCHEMA AS table_schema
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
           ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
           AND tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
         WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
         AND tc.TABLE_SCHEMA NOT IN (${SYSTEM_SCHEMA_LIST})
         ORDER BY kcu.ORDINAL_POSITION`,
      );

      // 4. Foreign keys. INFORMATION_SCHEMA models FKs through
      // REFERENTIAL_CONSTRAINTS, which points at the *unique* constraint on the
      // referenced side; joining KEY_COLUMN_USAGE twice recovers both ends.
      const fksResult = await pool.request().query<ForeignKeyRow>(
        `SELECT fk.COLUMN_NAME AS column_name,
                fk.TABLE_NAME AS from_table,
                pk.TABLE_NAME AS to_table,
                pk.COLUMN_NAME AS to_column
         FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE fk
           ON rc.CONSTRAINT_NAME = fk.CONSTRAINT_NAME
           AND rc.CONSTRAINT_SCHEMA = fk.CONSTRAINT_SCHEMA
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE pk
           ON rc.UNIQUE_CONSTRAINT_NAME = pk.CONSTRAINT_NAME
           AND rc.UNIQUE_CONSTRAINT_SCHEMA = pk.CONSTRAINT_SCHEMA
           AND fk.ORDINAL_POSITION = pk.ORDINAL_POSITION
         WHERE fk.TABLE_SCHEMA NOT IN (${SYSTEM_SCHEMA_LIST})`,
      );

      // --- Assemble primary key map: schema.table → column names ---
      const pkMap = new Map<string, string[]>();
      for (const row of pksResult.recordset) {
        const key = tableKey(row.table_schema, row.table_name);
        const cols = pkMap.get(key) ?? [];
        cols.push(row.column_name);
        pkMap.set(key, cols);
      }

      // --- Assemble column map: schema.table → ColumnInfo[] ---
      const colMap = new Map<string, ColumnInfo[]>();
      for (const row of columnsResult.recordset) {
        const key = tableKey(row.table_schema, row.table_name);
        const cols = colMap.get(key) ?? [];
        cols.push({
          name: row.column_name,
          type: row.data_type,
          nullable: row.is_nullable === 'YES',
          defaultValue: row.column_default,
        });
        colMap.set(key, cols);
      }

      // --- Assemble tables (bare name + schema, mirroring PostgreSQL) ---
      const tables: TableInfo[] = tablesResult.recordset.map((row) => {
        const key = tableKey(row.table_schema, row.table_name);
        return {
          name: row.table_name,
          schema: row.table_schema,
          columns: colMap.get(key) ?? [],
          primaryKeys: pkMap.get(key) ?? [],
        };
      });

      // --- Assemble relations ---
      const relations: Relation[] = fksResult.recordset.map((row) => ({
        fromTable: row.from_table,
        fromColumn: row.column_name,
        toTable: row.to_table,
        toColumn: row.to_column,
      }));

      return { tables, relations };
    } finally {
      try {
        await pool.close();
      } catch {
        /* swallow cleanup failures */
      }
    }
  }

  async sampleColumnValues(
    dsn: string,
    table: string,
    column: string,
    limit: number = 100,
    connOptions?: ConnectionOptions,
  ): Promise<string[]> {
    const config = applySsl(parseDsn(dsn), connOptions);
    const pool = new sql.ConnectionPool(config);
    try {
      await pool.connect();
      // Identifiers cannot be bound as parameters, so they are bracket-quoted
      // (with `]` doubled) — the T-SQL-safe escape. `table` may arrive
      // schema-qualified ("sales.orders"); each part is quoted separately.
      const qualified = table
        .split('.')
        .map((part) => quoteMssqlIdent(part))
        .join('.');
      const qi = quoteMssqlIdent(column);
      // TOP is the natural capped read in T-SQL — no ORDER BY required,
      // unlike OFFSET/FETCH. TOP takes a bound parameter when parenthesised.
      const result = await pool
        .request()
        .input('limit', sql.Int, limit)
        .query<{ val: string }>(
          `SELECT DISTINCT TOP (@limit) CAST(${qi} AS NVARCHAR(4000)) AS val ` +
            `FROM ${qualified} WHERE ${qi} IS NOT NULL`,
        );
      return result.recordset.map((row) => row.val);
    } catch {
      return [];
    } finally {
      try {
        await pool.close();
      } catch {
        /* swallow cleanup failures */
      }
    }
  }

  /**
   * Execute a read-only query.
   *
   * SQL Server has no `SET TRANSACTION READ ONLY` statement, so read-only
   * enforcement is achieved by always ROLLING BACK the wrapping transaction:
   * a SELECT is unaffected, while any write that slipped through is discarded
   * rather than committed. This is the T-SQL analogue of the read-only
   * transaction the PostgreSQL and MySQL connectors open.
   *
   * The serve layer emits neutral positional placeholders as `@p1 … @pN`
   * (see `makeDialect('mssql').param`), so `params[i]` binds to `@p{i+1}`.
   */
  async query(dsn: string, sqlText: string, options?: QueryOptions): Promise<QueryResult> {
    const connOptions = options?.ssl ? { ssl: options.ssl } : undefined;
    const cacheKey = this.cacheKeyFor(dsn, connOptions);
    const pool = await this.getPool(dsn, connOptions);
    const transaction = new sql.Transaction(pool);

    // BEGIN gets its own guard. `Transaction.begin()` borrows a connection from
    // the pool *before* issuing BEGIN TRANSACTION, and mssql/tedious does not
    // release that connection if the round-trip itself fails — the slot stays
    // marked borrowed for the life of the process, since `idleTimeoutMillis`
    // only ever reclaims idle connections. Evicting the pool closes it, which
    // is the only thing that reclaims a borrowed slot, and the next call then
    // builds a fresh pool.
    try {
      await transaction.begin();
    } catch (error: unknown) {
      this.evictPool(cacheKey, pool);
      throw new Error(
        'Failed to open a read transaction on SQL Server: ' +
          (error instanceof Error ? error.message : String(error)),
        { cause: error },
      );
    }

    let began = true;
    try {
      const request = new sql.Request(transaction);
      if (options?.timeoutMs && options.timeoutMs > 0) {
        // tedious enforces the request timeout client-side.
        (request as unknown as { timeout?: number }).timeout = Math.floor(options.timeoutMs);
      }
      const params = options?.params ?? [];
      params.forEach((value, index) => {
        request.input(`p${index + 1}`, value ?? null);
      });

      const result = await request.query<Record<string, unknown>>(sqlText);

      // Always roll back — see the read-only note above.
      began = false;
      await transaction.rollback().catch(() => {});

      return { rows: result.recordset ? Array.from(result.recordset) : [] };
    } catch (error: unknown) {
      if (began) {
        await transaction.rollback().catch(() => {});
      }
      // Translate driver timeout errors into the shared user-facing message.
      if (
        error instanceof Error &&
        (error.message.includes('Timeout: Request failed to complete') ||
          error.message.includes('Request timeout') ||
          (error as { code?: string }).code === 'ETIMEOUT')
      ) {
        throw new Error(
          `Query timed out after ${options?.timeoutMs ?? 0}ms. ` +
            'Try narrowing your query with filters or reducing the result set.',
        );
      }
      throw error;
    }
  }

  getPoolStats(): { active: number; idle: number; waiting: number; total: number } {
    // mssql exposes first-class pool counters — no internal poking needed.
    let active = 0;
    let idle = 0;
    let waiting = 0;
    let total = 0;
    for (const pool of this.pools.values()) {
      active += pool.borrowed;
      idle += pool.available;
      waiting += pool.pending;
      total += pool.size;
    }
    return { active, idle, waiting, total };
  }

  async disconnect(): Promise<void> {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(pools.map((p) => p.close().catch(() => {})));
  }
}

export const mssqlConnector = new MSSQLConnector();
