import type { AppState } from './state.js';
import type { PendingWriteQuery } from '@calame/core';

/**
 * Execute an APPROVED write from the queue against its target connection.
 *
 * The read path goes through `DatabaseConnector.query()`, which deliberately
 * enforces read-only transactions at the driver level — approved writes are
 * the one place that needs a write-capable execution, so each dialect gets a
 * minimal direct-driver path here. The SQL and params were generated
 * server-side by the write tool (identifiers whitelisted and quoted, values
 * bound) — this function never builds SQL.
 *
 * Target resolution: `entry.connectionName` (stamped when the write was
 * queued) is resolved against the live connections so the write executes on
 * the SAME database it was proposed for. Legacy rows queued before v15 have
 * no connection info and fall back to the cached connection, mirroring the
 * historical behavior.
 */
export function resolveWriteTarget(
  state: AppState,
  entry: Pick<PendingWriteQuery, 'connectionName' | 'databaseType'>,
): { connectionString: string; databaseType: string } {
  if (entry.connectionName) {
    const connState = state.connections.get(entry.connectionName);
    if (!connState) {
      throw new Error(
        `Target connection "${entry.connectionName}" is not connected — reconnect it before approving this write.`,
      );
    }
    return {
      connectionString: connState.connection.connectionString,
      databaseType: entry.databaseType ?? connState.connection.databaseType,
    };
  }
  // Legacy entry (pre-v15): fall back to the cached single-connection state.
  if (!state.cachedConnectionString || !state.cachedDatabaseType) {
    throw new Error('No database connection configured for this write.');
  }
  return {
    connectionString: state.cachedConnectionString,
    databaseType: state.cachedDatabaseType,
  };
}

/** Strip the optional sqlite:// scheme, mirroring the sqlite connector's DSN parsing. */
function sqlitePath(dsn: string): string {
  return dsn.startsWith('sqlite://') ? dsn.slice('sqlite://'.length) : dsn;
}

/**
 * better-sqlite3 only binds numbers, strings, bigints, buffers and null —
 * booleans (legal values for pg/mysql writes, e.g. a `fragile` column) must
 * become 0/1 and undefined must become NULL.
 */
function coerceSqliteParam(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

export async function executeApprovedWrite(
  databaseType: string,
  connectionString: string,
  sql: string,
  params: unknown[],
): Promise<{ rows: unknown[] }> {
  switch (databaseType) {
    case 'postgresql': {
      const { Client } = await import('pg');
      const client = new Client({ connectionString });
      await client.connect();
      try {
        const result = await client.query(sql, params);
        return { rows: result.rows ?? [] };
      } finally {
        await client.end();
      }
    }
    case 'mysql': {
      const mysql = await import('mysql2/promise');
      const conn = await mysql.createConnection(connectionString);
      try {
        // Same param cast the mysql connector uses for its bound values.
        const [rows] = await conn.execute(sql, params as (string | number | null | Buffer)[]);
        return { rows: Array.isArray(rows) ? rows : [rows] };
      } finally {
        await conn.end();
      }
    }
    case 'sqlite': {
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(sqlitePath(connectionString));
      try {
        const stmt = db.prepare(sql);
        const info = stmt.run(...params.map(coerceSqliteParam));
        return { rows: [{ changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) }] };
      } finally {
        db.close();
      }
    }
    default:
      throw new Error(`Unsupported database type for write execution: "${databaseType}"`);
  }
}
