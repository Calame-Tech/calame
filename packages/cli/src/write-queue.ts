import crypto from 'crypto';
import type { Database, Statement } from 'better-sqlite3';
import type { CalameDatabase } from './database.js';
import type { PendingWriteQuery, PendingWriteAction } from '@calame/core';

/** Row shape returned by better-sqlite3 for write_queue queries. */
interface WriteQueueRow {
  id: string;
  timestamp: string;
  profile_name: string;
  sql_text: string;
  params: string;
  table_name: string;
  operation: 'insert' | 'update' | 'delete';
  description: string;
  status: 'pending' | 'approved' | 'rejected';
  tenant_id: string | null;
  connection_name: string | null;
  database_type: string | null;
  approved_by: string | null;
  approved_at: string | null;
  execution_result: string | null;
  execution_error: string | null;
  /** Slice 1 (migration v16) — serialized `PendingWriteAction`. NULL for legacy/SQL rows. */
  action_json: string | null;
}

function rowToEntry(row: WriteQueueRow): PendingWriteQuery {
  // Slice 1: `kind: 'mcp-tool'` rows carry their action in `action_json`.
  // Every other row (legacy or freshly-queued SQL writes) synthesizes a
  // `kind: 'sql'` action from the flat columns at read time — see the
  // `PendingWriteAction` doc comment in @calame/core for the rationale.
  const action: PendingWriteAction = row.action_json
    ? (JSON.parse(row.action_json) as PendingWriteAction)
    : {
        kind: 'sql',
        sql: row.sql_text,
        params: JSON.parse(row.params) as unknown[],
        tableName: row.table_name,
        operation: row.operation,
        connectionName: row.connection_name ?? undefined,
        databaseType: row.database_type ?? undefined,
      };

  return {
    id: row.id,
    timestamp: row.timestamp,
    profileName: row.profile_name,
    sql: row.sql_text,
    params: JSON.parse(row.params) as unknown[],
    tableName: row.table_name,
    operation: row.operation,
    description: row.description,
    status: row.status,
    tenantId: row.tenant_id ?? undefined,
    connectionName: row.connection_name ?? undefined,
    databaseType: row.database_type ?? undefined,
    approvedBy: row.approved_by ?? undefined,
    approvedAt: row.approved_at ?? undefined,
    executionResult: row.execution_result ?? undefined,
    executionError: row.execution_error ?? undefined,
    action,
  };
}

export class WriteQueue {
  private db: Database;

  private stmtInsert: Statement;
  private stmtSelectPending: Statement;
  private stmtSelectById: Statement;
  private stmtUpdate: Statement;

  constructor(database: CalameDatabase) {
    this.db = database.raw;

    this.stmtInsert = this.db.prepare(
      `INSERT INTO write_queue (id, timestamp, profile_name, sql_text, params, table_name, operation, description, tenant_id, connection_name, database_type, action_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    );
    this.stmtSelectPending = this.db.prepare(`SELECT * FROM write_queue WHERE status = 'pending'`);
    this.stmtSelectById = this.db.prepare(`SELECT * FROM write_queue WHERE id = ?`);
    this.stmtUpdate = this.db.prepare(
      `UPDATE write_queue SET status = ?, approved_by = ?, approved_at = ?, execution_result = ?, execution_error = ? WHERE id = ?`,
    );
  }

  /** No-op — kept for backward compatibility. */
  async load(): Promise<void> {}

  /** No-op — kept for backward compatibility. */
  async save(): Promise<void> {}

  addRequest(request: Omit<PendingWriteQuery, 'id' | 'timestamp' | 'status'>): string {
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    this.stmtInsert.run(
      id,
      timestamp,
      request.profileName,
      request.sql,
      JSON.stringify(request.params),
      request.tableName,
      request.operation,
      request.description,
      request.tenantId ?? 'default',
      request.connectionName ?? null,
      request.databaseType ?? null,
      // Slice 1: only `kind: 'mcp-tool'` (non-SQL) actions are persisted here.
      // A `kind: 'sql'` action, if ever passed explicitly, is redundant with
      // the flat columns above and is not stored — `rowToEntry` re-synthesizes
      // it on read regardless.
      request.action && request.action.kind !== 'sql' ? JSON.stringify(request.action) : null,
    );
    return id;
  }

  /** When `tenantId` is provided, only that tenant's pending entries are returned. */
  getPending(tenantId?: string): PendingWriteQuery[] {
    const rows = (
      tenantId !== undefined
        ? this.db
            .prepare(`SELECT * FROM write_queue WHERE status = 'pending' AND tenant_id = ?`)
            .all(tenantId)
        : this.stmtSelectPending.all()
    ) as WriteQueueRow[];
    return rows.map(rowToEntry);
  }

  /** Fetch a single entry without side effects — used for route-level tenant checks. */
  getById(id: string): PendingWriteQuery | null {
    const row = this.stmtSelectById.get(id) as WriteQueueRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  getAll(options?: { limit?: number; offset?: number; status?: string; tenantId?: string }): {
    entries: PendingWriteQuery[];
    total: number;
  } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.status) {
      conditions.push('status = ?');
      params.push(options.status);
    }
    if (options?.tenantId !== undefined) {
      conditions.push('tenant_id = ?');
      params.push(options.tenantId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM write_queue ${where}`)
      .get(...params) as { cnt: number };
    const total = countRow.cnt;

    const limitClause = options?.limit != null ? `LIMIT ${options.limit}` : '';
    const offsetClause = options?.offset != null ? `OFFSET ${options.offset}` : '';

    const rows = this.db
      .prepare(
        `SELECT * FROM write_queue ${where} ORDER BY timestamp DESC ${limitClause} ${offsetClause}`,
      )
      .all(...params) as WriteQueueRow[];

    return { entries: rows.map(rowToEntry), total };
  }

  async approve(
    id: string,
    executeQuery: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>,
  ): Promise<PendingWriteQuery | null> {
    const row = this.stmtSelectById.get(id) as WriteQueueRow | undefined;
    if (!row || row.status !== 'pending') return null;

    const approvedAt = new Date().toISOString();
    let executionResult: string | undefined;
    let executionError: string | undefined;

    try {
      const result = await executeQuery(row.sql_text, JSON.parse(row.params) as unknown[]);
      executionResult = JSON.stringify(result.rows);
    } catch (err) {
      executionError = (err as Error).message;
    }

    this.stmtUpdate.run(
      'approved',
      null,
      approvedAt,
      executionResult ?? null,
      executionError ?? null,
      id,
    );

    const updated = this.stmtSelectById.get(id) as WriteQueueRow;
    return rowToEntry(updated);
  }

  /**
   * Approve a `kind: 'mcp-tool'` entry (Slice 1). Mirrors `approve()`'s status
   * transition and executionResult/executionError persistence exactly, but
   * takes a zero-arg executor instead of `(sql, params)`: the tool
   * name/args/target config for an mcp-tool entry live on `action`, resolved
   * by the caller (see `resolveMcpWriteTarget` in `write-executor.ts`), not in
   * the SQL columns. Kept as a separate method so `approve()` — and therefore
   * the entire SQL write path — is untouched.
   */
  async approveMcpTool(
    id: string,
    execute: () => Promise<string>,
  ): Promise<PendingWriteQuery | null> {
    const row = this.stmtSelectById.get(id) as WriteQueueRow | undefined;
    if (!row || row.status !== 'pending') return null;

    const approvedAt = new Date().toISOString();
    let executionResult: string | undefined;
    let executionError: string | undefined;

    try {
      executionResult = await execute();
    } catch (err) {
      executionError = (err as Error).message;
    }

    this.stmtUpdate.run(
      'approved',
      null,
      approvedAt,
      executionResult ?? null,
      executionError ?? null,
      id,
    );

    const updated = this.stmtSelectById.get(id) as WriteQueueRow;
    return rowToEntry(updated);
  }

  reject(id: string): PendingWriteQuery | null {
    const row = this.stmtSelectById.get(id) as WriteQueueRow | undefined;
    if (!row || row.status !== 'pending') return null;

    this.stmtUpdate.run('rejected', null, null, null, null, id);

    const updated = this.stmtSelectById.get(id) as WriteQueueRow;
    return rowToEntry(updated);
  }
}
