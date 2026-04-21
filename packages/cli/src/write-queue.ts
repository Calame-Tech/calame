import crypto from 'crypto';
import type { Database, Statement } from 'better-sqlite3';
import type { CalameDatabase } from './database.js';
import type { PendingWriteQuery } from '@calame/core';

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
  approved_by: string | null;
  approved_at: string | null;
  execution_result: string | null;
  execution_error: string | null;
}

function rowToEntry(row: WriteQueueRow): PendingWriteQuery {
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
    approvedBy: row.approved_by ?? undefined,
    approvedAt: row.approved_at ?? undefined,
    executionResult: row.execution_result ?? undefined,
    executionError: row.execution_error ?? undefined,
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
      `INSERT INTO write_queue (id, timestamp, profile_name, sql_text, params, table_name, operation, description, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
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
    );
    return id;
  }

  getPending(): PendingWriteQuery[] {
    const rows = this.stmtSelectPending.all() as WriteQueueRow[];
    return rows.map(rowToEntry);
  }

  getAll(options?: { limit?: number; offset?: number; status?: string }): { entries: PendingWriteQuery[]; total: number } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.status) {
      conditions.push('status = ?');
      params.push(options.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM write_queue ${where}`)
      .get(...params) as { cnt: number };
    const total = countRow.cnt;

    const limitClause = options?.limit != null ? `LIMIT ${options.limit}` : '';
    const offsetClause = options?.offset != null ? `OFFSET ${options.offset}` : '';

    const rows = this.db
      .prepare(`SELECT * FROM write_queue ${where} ORDER BY timestamp DESC ${limitClause} ${offsetClause}`)
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

    this.stmtUpdate.run('approved', null, approvedAt, executionResult ?? null, executionError ?? null, id);

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
