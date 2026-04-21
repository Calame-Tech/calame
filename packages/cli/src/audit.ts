import crypto from 'crypto';
import type { Database, Statement } from 'better-sqlite3';
import type { CalameDatabase } from './database.js';

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  profileName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  result: 'success' | 'error';
  resultSummary?: string;
  durationMs: number;
  /** Label of the token that triggered this entry (optional). */
  tokenLabel?: string;
}

/** Row shape returned by better-sqlite3 for audit_log queries. */
interface AuditRow {
  id: string;
  timestamp: string;
  profile_name: string;
  tool_name: string;
  tool_args: string;
  result: 'success' | 'error';
  result_summary: string | null;
  duration_ms: number;
  token_label: string | null;
}

function rowToEntry(row: AuditRow): AuditLogEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    profileName: row.profile_name,
    toolName: row.tool_name,
    toolArgs: JSON.parse(row.tool_args) as Record<string, unknown>,
    result: row.result,
    resultSummary: row.result_summary ?? undefined,
    durationMs: row.duration_ms,
    tokenLabel: row.token_label ?? undefined,
  };
}

export class AuditLog {
  private db: Database;
  private maxEntries: number;

  // Prepared statements cached for performance
  private stmtInsert: Statement;
  private stmtCount: Statement;
  private stmtDeleteOldest: Statement;
  private stmtSelectAll: Statement;

  constructor(database: CalameDatabase, maxEntries: number = 10000) {
    this.db = database.raw;
    this.maxEntries = maxEntries;

    this.stmtInsert = this.db.prepare(`
      INSERT INTO audit_log
        (id, timestamp, profile_name, tool_name, tool_args, result, result_summary, duration_ms, token_label)
      VALUES
        (@id, @timestamp, @profile_name, @tool_name, @tool_args, @result, @result_summary, @duration_ms, @token_label)
    `);

    this.stmtCount = this.db.prepare(`SELECT COUNT(*) AS cnt FROM audit_log`);

    // Delete the oldest entries beyond maxEntries, ordered by timestamp ascending
    this.stmtDeleteOldest = this.db.prepare(`
      DELETE FROM audit_log
      WHERE id IN (
        SELECT id FROM audit_log
        ORDER BY timestamp ASC
        LIMIT ?
      )
    `);

    this.stmtSelectAll = this.db.prepare(`
      SELECT * FROM audit_log ORDER BY timestamp DESC
    `);
  }

  /** No-op — kept for backward compatibility. */
  async load(): Promise<void> {
    // SQLite persistence is immediate; nothing to load
  }

  /** No-op — kept for backward compatibility. */
  async save(): Promise<void> {
    // SQLite writes are synchronous; nothing to flush
  }

  addEntry(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): AuditLogEntry {
    const full: AuditLogEntry = {
      ...entry,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };

    this.stmtInsert.run({
      id: full.id,
      timestamp: full.timestamp,
      profile_name: full.profileName,
      tool_name: full.toolName,
      tool_args: JSON.stringify(full.toolArgs),
      result: full.result,
      result_summary: full.resultSummary ?? null,
      duration_ms: full.durationMs,
      token_label: full.tokenLabel ?? null,
    });

    // Trim oldest entries if we've exceeded maxEntries
    const { cnt } = this.stmtCount.get() as { cnt: number };
    if (cnt > this.maxEntries) {
      this.stmtDeleteOldest.run(cnt - this.maxEntries);
    }

    return full;
  }

  getEntries(options?: {
    profileName?: string;
    limit?: number;
    offset?: number;
    since?: string;
  }): { entries: AuditLogEntry[]; total: number } {
    // Build dynamic WHERE clause
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.profileName) {
      conditions.push('profile_name = ?');
      params.push(options.profileName);
    }
    if (options?.since) {
      conditions.push('timestamp >= ?');
      params.push(options.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Total count for pagination
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM audit_log ${where}`)
      .get(...params) as { cnt: number };
    const total = countRow.cnt;

    // Paginated result, newest first
    const limitClause = options?.limit != null ? `LIMIT ${options.limit}` : '';
    const offsetClause = options?.offset != null ? `OFFSET ${options.offset}` : '';

    const rows = this.db
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY timestamp DESC ${limitClause} ${offsetClause}`)
      .all(...params) as AuditRow[];

    return { entries: rows.map(rowToEntry), total };
  }

  exportJSON(): string {
    const rows = this.stmtSelectAll.all() as AuditRow[];
    return JSON.stringify(rows.map(rowToEntry), null, 2);
  }

  exportCSV(): string {
    const rows = this.stmtSelectAll.all() as AuditRow[];
    const headers = ['id', 'timestamp', 'profileName', 'toolName', 'result', 'durationMs', 'resultSummary'];
    const lines = [headers.join(',')];
    for (const row of rows) {
      const e = rowToEntry(row);
      lines.push(
        [e.id, e.timestamp, e.profileName, e.toolName, e.result, e.durationMs, e.resultSummary ?? '']
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(','),
      );
    }
    return lines.join('\n');
  }

  purgeOlderThan(days: number): number {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db
      .prepare(`DELETE FROM audit_log WHERE timestamp < ?`)
      .run(cutoff);
    return result.changes;
  }
}
