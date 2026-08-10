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

/**
 * Prefixed onto `description` for an entry whose persisted payload could not
 * be parsed, so the corruption is visible in every list view without the UI
 * needing to know about the `actionCorrupt` flag.
 */
const CORRUPT_ACTION_PREFIX = '[corrupt action] ';

/**
 * Message surfaced when an admin tries to approve a corrupt entry. Exported so
 * the route and its tests agree on the wording.
 */
export const CORRUPT_ACTION_MESSAGE =
  'corrupt action payload — this entry cannot be executed. Reject it instead.';

/** `JSON.parse` that reports failure instead of throwing. */
function parseJsonColumn<T>(raw: string, fallback: T): { value: T; corrupt: boolean } {
  try {
    return { value: JSON.parse(raw) as T, corrupt: false };
  } catch {
    return { value: fallback, corrupt: true };
  }
}

/** The compat `kind: 'sql'` action synthesized from a row's flat columns. */
function sqlActionFromRow(row: WriteQueueRow, params: unknown[]): PendingWriteAction {
  return {
    kind: 'sql',
    sql: row.sql_text,
    params,
    tableName: row.table_name,
    operation: row.operation,
    connectionName: row.connection_name ?? undefined,
    databaseType: row.database_type ?? undefined,
  };
}

function rowToEntry(row: WriteQueueRow): PendingWriteQuery {
  // Slice 1: `kind: 'mcp-tool'` rows carry their action in `action_json`.
  // Every other row (legacy or freshly-queued SQL writes) synthesizes a
  // `kind: 'sql'` action from the flat columns at read time — see the
  // `PendingWriteAction` doc comment in @calame/core for the rationale.
  //
  // Both JSON columns are parsed defensively. An unparseable payload used to
  // throw straight out of here, which took down getById/getPending/getAll —
  // i.e. ONE corrupt row 500'd the entire Pending view for every other entry.
  // Now the row degrades: it stays listable (with a visible marker) but is
  // flagged non-executable, and only rejection remains available.
  const parsedParams = parseJsonColumn<unknown[]>(row.params, []);
  let corrupt = parsedParams.corrupt;
  const params = Array.isArray(parsedParams.value) ? parsedParams.value : [];

  let action: PendingWriteAction;
  if (row.action_json) {
    const parsed = parseJsonColumn<unknown>(row.action_json, null);
    const value = parsed.value;
    // A payload that parses to something other than an object with a string
    // `kind` is as unusable as one that does not parse at all — treat both the
    // same way rather than letting a shapeless value reach the dispatcher.
    const usable =
      !parsed.corrupt &&
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { kind?: unknown }).kind === 'string';
    if (usable) {
      action = value as PendingWriteAction;
    } else {
      corrupt = true;
      action = sqlActionFromRow(row, params);
    }
  } else {
    action = sqlActionFromRow(row, params);
  }

  return {
    id: row.id,
    timestamp: row.timestamp,
    profileName: row.profile_name,
    sql: row.sql_text,
    params,
    tableName: row.table_name,
    operation: row.operation,
    description: corrupt ? CORRUPT_ACTION_PREFIX + row.description : row.description,
    status: row.status,
    tenantId: row.tenant_id ?? undefined,
    connectionName: row.connection_name ?? undefined,
    databaseType: row.database_type ?? undefined,
    approvedBy: row.approved_by ?? undefined,
    approvedAt: row.approved_at ?? undefined,
    executionResult: row.execution_result ?? undefined,
    executionError: row.execution_error ?? undefined,
    action,
    ...(corrupt ? { actionCorrupt: true } : {}),
  };
}

export class WriteQueue {
  private db: Database;

  private stmtInsert: Statement;
  private stmtSelectPending: Statement;
  private stmtSelectById: Statement;
  private stmtUpdate: Statement;
  private stmtClaim: Statement;
  private stmtRecordResult: Statement;
  private stmtReject: Statement;

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
    // Atomic claim: the conditional WHERE makes pending→approved a
    // single-winner transition. Concurrent approves (or an approve racing a
    // reject) resolve at the database level — exactly one caller sees
    // changes === 1 and proceeds to execute; everyone else backs off. This
    // matters most for mcp-tool entries whose execution is an upstream
    // network call (seconds-long window), but the SQL path shares the same
    // race shape and uses the same claim.
    this.stmtClaim = this.db.prepare(
      `UPDATE write_queue SET status = 'approved', approved_at = ? WHERE id = ? AND status = 'pending'`,
    );
    this.stmtRecordResult = this.db.prepare(
      `UPDATE write_queue SET execution_result = ?, execution_error = ? WHERE id = ?`,
    );
    this.stmtReject = this.db.prepare(
      `UPDATE write_queue SET status = 'rejected' WHERE id = ? AND status = 'pending'`,
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

  /**
   * Shared approval transition (SQL and mcp-tool paths).
   *
   * Claims the entry ATOMICALLY (conditional pending→approved UPDATE) before
   * running the executor: exactly one concurrent caller wins the claim; the
   * losers — a double-click, a second admin, or a reject that landed first —
   * get `null` and never execute. The prior check-then-act shape left a
   * window (up to the whole upstream call) where two approves both executed
   * the write and a concurrent reject was silently overwritten.
   *
   * The existing semantic is preserved: the entry becomes 'approved' even
   * when execution fails — the failure is recorded in `executionError`.
   */
  private async approveWith(
    id: string,
    run: (row: WriteQueueRow) => Promise<string>,
  ): Promise<PendingWriteQuery | null> {
    const row = this.stmtSelectById.get(id) as WriteQueueRow | undefined;
    if (!row || row.status !== 'pending') return null;

    const approvedAt = new Date().toISOString();
    const claim = this.stmtClaim.run(approvedAt, id);
    if (claim.changes !== 1) return null; // lost the race to a concurrent approve/reject

    let executionResult: string | undefined;
    let executionError: string | undefined;
    try {
      executionResult = await run(row);
    } catch (err) {
      executionError = (err as Error).message;
    }

    this.stmtRecordResult.run(executionResult ?? null, executionError ?? null, id);

    const updated = this.stmtSelectById.get(id) as WriteQueueRow;
    return rowToEntry(updated);
  }

  async approve(
    id: string,
    executeQuery: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>,
  ): Promise<PendingWriteQuery | null> {
    return this.approveWith(id, async (row) => {
      const result = await executeQuery(row.sql_text, JSON.parse(row.params) as unknown[]);
      return JSON.stringify(result.rows);
    });
  }

  /**
   * Approve a `kind: 'mcp-tool'` entry (Slice 1). Same claim + result
   * recording as `approve()` (via `approveWith`), but takes a zero-arg
   * executor: the tool name/args/target config live on `action`, resolved by
   * the caller (see `resolveMcpWriteTarget` in `write-executor.ts`), not in
   * the SQL columns.
   */
  async approveMcpTool(
    id: string,
    execute: () => Promise<string>,
  ): Promise<PendingWriteQuery | null> {
    return this.approveWith(id, () => execute());
  }

  reject(id: string): PendingWriteQuery | null {
    const row = this.stmtSelectById.get(id) as WriteQueueRow | undefined;
    if (!row || row.status !== 'pending') return null;

    // Conditional transition: a reject that races an in-flight approve loses
    // cleanly (returns null) instead of stomping the approved status.
    const result = this.stmtReject.run(id);
    if (result.changes !== 1) return null;

    const updated = this.stmtSelectById.get(id) as WriteQueueRow;
    return rowToEntry(updated);
  }
}
