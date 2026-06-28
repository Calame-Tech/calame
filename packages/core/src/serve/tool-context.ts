import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TableInfo, Relation, TableToolOptions } from '../introspect/types.js';
import { ColumnMasking } from '../pii/types.js';
import type { AuditLogEntry } from './types.js';
import type { Dialect } from './filter-builder.js';
import type { ExecuteQuery, ScopeGuard } from './scoped-executor.js';
import type { MaskingRule } from './middleware/masking.js';

// We use `as any` in server.tool() calls because the dynamic Zod schemas
// (Record<string, z.ZodTypeAny>) cause TS2589 "excessively deep" errors with
// the MCP SDK's generic overloads. The schemas are correctly constructed at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolArgs = any;

/** Shared context passed to register* helpers to avoid long parameter lists. */
export interface ToolContext {
  server: McpServer;
  executeQuery: ExecuteQuery;
  onAuditLog?: (entry: Omit<AuditLogEntry, 'id' | 'timestamp'>) => void;
  profileName: string;
  dialect: Dialect;
  responseMode: 'friendly' | 'raw';
  wrapResponse: (json: string) => string;
  maxOffset: number;
  scopeGuard: ScopeGuard;
  /** Applies the optional toolNamespace prefix to a tool name suffix. */
  toolName: (suffix: string) => string;
}

// ---------------------------------------------------------------------------
// Database dialect helpers
// ---------------------------------------------------------------------------

// NOTE: Read-only enforcement lives at the connector layer
// (see packages/connectors/src/{postgresql,mysql,sqlite}.ts query() methods).
// Each connector wraps queries in BEGIN/SET TRANSACTION READ ONLY/COMMIT or
// opens SQLite databases with { readonly: true }.
export function makeDialect(dbType: 'postgresql' | 'mysql' | 'sqlite'): Dialect {
  switch (dbType) {
    case 'postgresql':
      return {
        databaseType: 'postgresql',
        isPostgres: true,
        quoteIdent: (n) => `"${n}"`,
        quoteTable: (s, t) => `"${s}"."${t}"`,
        param: (i) => `$${i}`,
        random: 'RANDOM()',
        supportsPercentile: true,
        medianExpr: (col) => `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${col})`,
        percentileExpr: (col, p) => `PERCENTILE_CONT(${p}) WITHIN GROUP (ORDER BY ${col})`,
        stddevExpr: (col) => `STDDEV_SAMP(${col})`,
        varianceExpr: (col) => `VAR_SAMP(${col})`,
      };
    case 'mysql':
      return {
        databaseType: 'mysql',
        isPostgres: false,
        quoteIdent: (n) => `\`${n}\``,
        quoteTable: (_s, t) => `\`${t}\``,
        param: () => '?',
        random: 'RAND()',
        supportsPercentile: false,
        medianExpr: () => null,
        percentileExpr: () => null,
        stddevExpr: (col) => `STDDEV_SAMP(${col})`,
        varianceExpr: (col) => `VAR_SAMP(${col})`,
      };
    case 'sqlite':
      return {
        databaseType: 'sqlite',
        isPostgres: false,
        quoteIdent: (n) => `"${n}"`,
        quoteTable: (_s, t) => `"${t}"`,
        param: () => '?',
        random: 'RANDOM()',
        supportsPercentile: false,
        medianExpr: () => null,
        percentileExpr: () => null,
        stddevExpr: () => null,
        varianceExpr: () => null,
      };
  }
}

// ---------------------------------------------------------------------------
// pgTypeToZod — same mapping as packages/core/src/generate/tools.ts
// ---------------------------------------------------------------------------

export function pgTypeToZod(pgType: string): string | null {
  const t = pgType.toLowerCase();

  // String types
  if (
    t === 'text' || t === 'varchar' || t === 'character varying' ||
    t === 'char' || t === 'character' || t === 'name' || t === 'citext' ||
    t === 'uuid' || t === 'xml' || t === 'inet' || t === 'cidr' ||
    t === 'macaddr'
  ) return 'string';

  // Date/time types — exposed as ISO 8601 strings
  if (
    t === 'timestamp' || t === 'timestamp with time zone' ||
    t === 'timestamp without time zone' || t === 'timestamptz' ||
    t === 'date' || t === 'time' || t === 'time with time zone' ||
    t === 'time without time zone' || t === 'timetz' || t === 'interval'
  ) return 'string';

  // Big integer types — exposed as string to preserve precision
  if (t === 'bigint' || t === 'int8' || t === 'bigserial') return 'string';

  // Numeric types
  if (
    t === 'integer' || t === 'int' || t === 'int4' ||
    t === 'smallint' || t === 'int2' ||
    t === 'serial' || t === 'smallserial' ||
    t === 'real' || t === 'float4' ||
    t === 'double precision' || t === 'float8' ||
    t === 'numeric' || t === 'decimal' || t === 'money' || t === 'oid'
  ) return 'number';

  // Boolean
  if (t === 'boolean' || t === 'bool') return 'boolean';

  // Complex types not supported for filters
  return null;
}

export function isNumericType(pgType: string): boolean {
  const t = pgType.toLowerCase();
  return (
    t === 'integer' || t === 'int' || t === 'int4' ||
    t === 'smallint' || t === 'int2' ||
    t === 'serial' || t === 'smallserial' ||
    t === 'bigint' || t === 'int8' || t === 'bigserial' ||
    t === 'real' || t === 'float4' ||
    t === 'double precision' || t === 'float8' ||
    t === 'numeric' || t === 'decimal' || t === 'money'
  );
}

export function isTextType(pgType: string): boolean {
  return pgTypeToZod(pgType) === 'string';
}

// Date bucketing granularities supported by `group_by_bucket` on aggregate /
// join_aggregate. Translates to DATE_TRUNC (Postgres), DATE_FORMAT (MySQL),
// or strftime (SQLite) so the LLM can ask for "monthly", "weekly", "daily"
// trendlines without inventing dialect-specific SQL.
export type DateBucket = 'day' | 'week' | 'month' | 'quarter' | 'year';

export function dateBucketExpr(dialect: Dialect, granularity: DateBucket, columnExpr: string): string {
  // Postgres has a native DATE_TRUNC for every granularity we expose.
  if (dialect.databaseType === 'postgresql') {
    return `DATE_TRUNC('${granularity}', ${columnExpr})`;
  }

  // MySQL and SQLite don't have DATE_TRUNC. We render a canonical formatted
  // string per period so GROUP BY collapses identically and ORDER BY sorts
  // chronologically. The formats below assume the column already holds a
  // valid date / datetime / ISO-8601 string; non-date inputs return NULL,
  // matching how Calame handles malformed SQL today.
  const fmt = (() => {
    switch (granularity) {
      case 'day': return '%Y-%m-%d';
      case 'week': return '%Y-W%W';
      case 'month': return '%Y-%m-01';
      case 'quarter': return null; // synthesised below
      case 'year': return '%Y-01-01';
    }
  })();

  // Quarter has no single format string — synthesise YYYY-Q# from year + month.
  if (granularity === 'quarter') {
    if (dialect.databaseType === 'mysql') {
      return `CONCAT(YEAR(${columnExpr}), '-Q', QUARTER(${columnExpr}))`;
    }
    // sqlite
    return `(strftime('%Y', ${columnExpr}) || '-Q' || ((CAST(strftime('%m', ${columnExpr}) AS INTEGER) - 1) / 3 + 1))`;
  }

  if (!fmt) return columnExpr; // unreachable, narrowing safety
  if (dialect.databaseType === 'mysql') {
    return `DATE_FORMAT(${columnExpr}, '${fmt}')`;
  }
  // sqlite
  return `strftime('${fmt}', ${columnExpr})`;
}

// ---------------------------------------------------------------------------
// Date format detection for text/varchar columns that contain ISO dates.
// Returns a format string if ≥ 80% of non-null sample values match a pattern.
// ---------------------------------------------------------------------------

/** Detects the ISO date format hidden in string-typed columns (TEXT, VARCHAR). */
export function detectDateFormat(sqlType: string, sampleValues: unknown[]): string | null {
  if (!isTextType(sqlType)) return null;
  const nonNull = sampleValues.filter(v => v !== null && v !== undefined && v !== '');
  if (nonNull.length === 0) return null;

  const threshold = 0.8;
  const strs = nonNull.map(v => String(v));

  const countMatch = (re: RegExp) => strs.filter(s => re.test(s)).length;

  // Datetime first (more specific than date)
  if (countMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/) / strs.length >= threshold) {
    return 'YYYY-MM-DDTHH:mm:ss';
  }
  if (countMatch(/^\d{4}-\d{2}-\d{2}/) / strs.length >= threshold) {
    return 'YYYY-MM-DD';
  }
  if (countMatch(/^\d{2}:\d{2}/) / strs.length >= threshold) {
    return 'HH:mm';
  }
  return null;
}

// Friendly column-type label baked into the Phase-2 catalogue (string in tool
// description). Distinguishes 'date' from generic 'string' so the LLM doesn't
// pass `[min,max]` between filters as numbers on date columns.
export function friendlyTypeLabel(sqlType: string): string {
  const t = sqlType.toLowerCase();
  if (isNumericType(sqlType)) return 'number';
  if (t === 'boolean' || t === 'bool') return 'bool';
  if (
    t === 'timestamp' || t === 'timestamp with time zone' ||
    t === 'timestamp without time zone' || t === 'timestamptz' ||
    t === 'date' || t === 'time' || t === 'time with time zone' ||
    t === 'time without time zone' || t === 'timetz'
  ) return 'date';
  return 'string';
}

// Levenshtein for did-you-mean hints in structured errors. Small data sets
// (≤ 20 columns / ≤ 50 tables) so the O(n·m) dp is fine.
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const dp: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    dp[i] = new Array(b.length + 1).fill(0);
    dp[i][0] = i;
  }
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

export function didYouMean(input: string, valid: string[]): string | undefined {
  if (!input || valid.length === 0) return undefined;
  const target = input.toLowerCase();
  let best: { name: string; dist: number } | undefined;
  for (const name of valid) {
    const dist = levenshtein(target, name.toLowerCase());
    if (!best || dist < best.dist) best = { name, dist };
  }
  if (!best) return undefined;
  // Only suggest if reasonably close. Allows ~1 typo per 3 chars; capped at 3.
  const threshold = Math.min(3, Math.max(2, Math.floor(input.length / 3)));
  return best.dist <= threshold ? best.name : undefined;
}

// Returns a tool result that is structured-error-shaped (single text content,
// JSON body, isError=true). Designed to be parsed by an LLM follow-up turn.
export function structuredError(payload: Record<string, unknown>): {
  content: { type: 'text'; text: string }[];
  isError: true;
  resultSummary?: string;
} {
  const summary = typeof payload.error === 'string' ? payload.error.slice(0, 80) : 'invalid args';
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    isError: true,
    resultSummary: summary,
  };
}

// Per-table view computed once at registerDynamicTools time. Carries
// everything the generic tool handlers need to validate `table` arg and run
// the right SQL.
export interface AccessibleTable {
  table: TableInfo;
  opts: TableToolOptions | undefined;
  enabledTools: string[];
  visibleColumns: TableInfo['columns'];
  excludedCols: Set<string>;
  tableMasking: Record<string, ColumnMasking> | undefined;
  maskingRules: Record<string, MaskingRule>;
  labelMap: Record<string, string>;
  filterableCols: TableInfo['columns'];
  numericCols: string[];
  groupableColumns: string[];
  allColumnNames: string[];
  relations: Relation[];
}

// ---------------------------------------------------------------------------
// Resolve a `table` arg from the LLM into an AccessibleTable; structured
// error otherwise. Capability gate ensures e.g. an aggregate-disabled table
// can't be hit through the `aggregate` tool.
// ---------------------------------------------------------------------------

export function resolveTable(
  name: unknown,
  accessible: AccessibleTable[],
  capability: 'aggregate' | 'query' | 'describe' | 'write',
):
  | { ok: true; at: AccessibleTable }
  | { ok: false; payload: Record<string, unknown> } {
  const validTables = accessible
    .filter(a => a.enabledTools.includes(capability))
    .map(a => a.table.name);

  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, payload: { error: '`table` argument is required', valid_tables: validTables } };
  }
  const at = accessible.find(a => a.table.name === name);
  if (!at) {
    const dym = didYouMean(name, accessible.map(a => a.table.name));
    return {
      ok: false,
      payload: { error: `Unknown table '${name}'`, valid_tables: validTables, did_you_mean: dym },
    };
  }
  if (!at.enabledTools.includes(capability)) {
    return {
      ok: false,
      payload: { error: `Table '${name}' does not support '${capability}'`, valid_tables: validTables },
    };
  }
  return { ok: true, at };
}
