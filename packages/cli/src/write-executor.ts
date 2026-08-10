import type { AppState } from './state.js';
import type { PendingWriteQuery } from '@calame/core';
import type { McpProxyAdapterConfig } from '@calame/connectors';

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

/**
 * Resolve the decrypted upstream config for an APPROVED `kind: 'mcp-tool'`
 * write (Slice 1). The queue row never carries the upstream URL/headers —
 * only `action.sourceId` — so approval must re-resolve `Source.configEncrypted`
 * here, exactly the same "reference, not config" rule `resolveWriteTarget`
 * already applies to `connectionName` for SQL writes (write-queue v15).
 *
 * Uses the identical storage path `registration.ts`'s `resolveAdapterConfig`
 * uses for `scope.kind === 'mcp'`: Slice 0 has no dedicated persistence table
 * for non-relational sources, so an MCP source's encrypted config lives in
 * `rag_sources.config_encrypted` (the one existing "unified sources" table),
 * decrypted via the RAG runtime's `decryptConfig`.
 *
 * Throws — never returns null/undefined — so the caller can fail the
 * approval cleanly (nothing persisted, nothing executed) before ever
 * touching the upstream. Mirrors `resolveWriteTarget`'s "target connection is
 * gone" failure mode: this function runs BEFORE `WriteQueue.approveMcpTool`
 * is invoked, so a thrown error here leaves the queue entry untouched at
 * `status: 'pending'` — the admin can fix the source and retry approval.
 */
export function resolveMcpWriteTarget(state: AppState, sourceId: string): McpProxyAdapterConfig {
  if (!state.ragRuntime || !state.db) {
    throw new Error(
      `MCP source "${sourceId}" is not available — the RAG runtime is not initialized.`,
    );
  }
  let row: { config_encrypted: string } | undefined;
  try {
    row = state.db.raw
      .prepare<
        [string],
        { config_encrypted: string }
      >('SELECT config_encrypted FROM rag_sources WHERE id = ? LIMIT 1')
      .get(sourceId);
  } catch {
    // Defensive: rag_sources may not exist (RAG schema never initialized).
    row = undefined;
  }
  if (!row) {
    throw new Error(`MCP source "${sourceId}" is gone — reconnect it before approving this write.`);
  }
  const decrypted = state.ragRuntime.decryptConfig(row.config_encrypted);
  return JSON.parse(decrypted) as McpProxyAdapterConfig;
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
