import type { Dialect } from '../filter-builder.js';
import type { ExecuteQuery } from '../scoped-executor.js';
import type { AuditLogEntry } from '../types.js';

// ---------------------------------------------------------------------------
// Audit middleware — wraps a tool's query execution: times it, runs the body,
// records an audit log entry (success or error), and converts a thrown DB
// error into a structured error response so handlers never leak raw failures.
// ---------------------------------------------------------------------------

export interface ExecuteWithAuditOptions {
  executeQuery: ExecuteQuery;
  /** Accepted for call-site symmetry with the tool context; not used here. */
  dialect?: Dialect;
  onAuditLog?: (entry: Omit<AuditLogEntry, 'id' | 'timestamp'>) => void;
  profileName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}

export async function executeWithAudit(
  opts: ExecuteWithAuditOptions,
  fn: (exec: ExecuteQuery) => Promise<{
    content: { type: 'text'; text: string }[];
    isError?: boolean;
    resultSummary?: string;
    resultData?: string;
  }>,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const start = Date.now();
  const { executeQuery, onAuditLog, profileName, toolName, toolArgs } = opts;

  try {
    const result = await fn(executeQuery);

    if (onAuditLog) {
      onAuditLog({
        profileName,
        toolName,
        toolArgs,
        result: result.isError ? 'error' : 'success',
        resultSummary: result.resultSummary,
        resultData: result.resultData,
        durationMs: Date.now() - start,
      });
    }

    return { content: result.content, isError: result.isError };
  } catch (err) {
    if (onAuditLog) {
      onAuditLog({
        profileName,
        toolName,
        toolArgs,
        result: 'error',
        resultSummary: (err as Error).message,
        durationMs: Date.now() - start,
      });
    }

    return {
      content: [{ type: 'text' as const, text: `Database error: ${(err as Error).message}` }],
      isError: true,
    };
  }
}
