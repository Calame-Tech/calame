import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TableInfo, Relation, TableToolOptions } from '../introspect/types.js';
import { ColumnMasking } from '../pii/types.js';
import type { AuditLogEntry } from './types.js';
import type { Dialect, FilterValue } from './filter-builder.js';
import type { ExecuteQuery, ScopeGuard } from './scoped-executor.js';
import type { MaskingRule } from './middleware/masking.js';
import {
  isStringType,
  isDateType,
  isBigIntType,
  isBooleanType,
  isNumericSqlType,
} from './sql-types.js';

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
// (see packages/connectors/src/{postgresql,mysql,sqlite,mssql}.ts query()
// methods). Each connector wraps queries in BEGIN/SET TRANSACTION READ ONLY/
// COMMIT, opens SQLite databases with { readonly: true }, or — on SQL Server,
// which has no read-only transaction mode — always rolls the transaction back.

/** `LIMIT x OFFSET y` pagination, shared by PostgreSQL / MySQL / SQLite. */
function limitOffsetPagination(
  orderByClause: string,
  limitParam: string,
  offsetParam: string,
): string {
  return `${orderByClause} LIMIT ${limitParam} OFFSET ${offsetParam}`.trim();
}

/** `||` string concatenation, shared by PostgreSQL / MySQL / SQLite. */
function pipeConcat(...parts: string[]): string {
  return parts.join(' || ');
}

/**
 * PostgreSQL / MySQL / SQLite treat every character of a LIKE value literally
 * apart from `%` and `_`, which are intentionally left as wildcards.
 */
function noLikeEscape(value: string): string {
  return value;
}

/**
 * SQL Server is the one backend where `[` opens a character class inside a
 * LIKE pattern, so a filter value like "Acme [Retired]" would match different
 * rows there than everywhere else. `[[]` is T-SQL's own idiom for a literal
 * `[` and needs no ESCAPE clause.
 *
 * Escaping `[` alone is sufficient: with no unescaped `[` left in the pattern,
 * a class can never be opened, which in turn makes `]` and `^` unambiguously
 * literal (they are only special inside a class). `%` and `_` keep their
 * existing wildcard behaviour, matching the other three dialects.
 */
function mssqlLikeEscape(value: string): string {
  return value.replace(/\[/g, '[[]');
}

export function makeDialect(dbType: 'postgresql' | 'mysql' | 'sqlite' | 'mssql'): Dialect {
  switch (dbType) {
    case 'postgresql':
      return {
        databaseType: 'postgresql',
        isPostgres: true,
        quoteIdent: (n) => `"${n}"`,
        quoteTable: (s, t) => `"${s}"."${t}"`,
        defaultSchema: 'public',
        param: (i) => `$${i}`,
        random: 'RANDOM()',
        concat: pipeConcat,
        escapeLikeValue: noLikeEscape,
        paginate: limitOffsetPagination,
        topPrefix: () => '',
        limitSuffix: (n) => `LIMIT ${n}`,
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
        defaultSchema: 'public',
        param: () => '?',
        random: 'RAND()',
        concat: pipeConcat,
        escapeLikeValue: noLikeEscape,
        paginate: limitOffsetPagination,
        topPrefix: () => '',
        limitSuffix: (n) => `LIMIT ${n}`,
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
        defaultSchema: 'public',
        param: () => '?',
        random: 'RANDOM()',
        concat: pipeConcat,
        escapeLikeValue: noLikeEscape,
        paginate: limitOffsetPagination,
        topPrefix: () => '',
        limitSuffix: (n) => `LIMIT ${n}`,
        supportsPercentile: false,
        medianExpr: () => null,
        percentileExpr: () => null,
        stddevExpr: () => null,
        varianceExpr: () => null,
      };
    case 'mssql':
      return {
        databaseType: 'mssql',
        isPostgres: false,
        // T-SQL bracket quoting; a literal `]` inside a name is doubled.
        quoteIdent: (n) => `[${n.replace(/]/g, ']]')}]`,
        quoteTable: (s, t) => `[${s.replace(/]/g, ']]')}].[${t.replace(/]/g, ']]')}]`,
        defaultSchema: 'dbo',
        // The `mssql` driver binds named parameters; the connector registers
        // them as p1..pN in positional order (see mssql.ts query()).
        param: (i) => `@p${i}`,
        // RAND() is evaluated once per statement in T-SQL, so it cannot shuffle
        // rows. NEWID() is the standard random-ordering idiom.
        random: 'NEWID()',
        concat: (...parts) => parts.join(' + '),
        escapeLikeValue: mssqlLikeEscape,
        // OFFSET/FETCH is the only parameterizable pagination in T-SQL and it
        // is only legal after an ORDER BY, so synthesize a no-op ordering when
        // the caller has none.
        paginate: (orderByClause, limitParam, offsetParam) => {
          const orderBy = orderByClause.trim() || 'ORDER BY (SELECT NULL)';
          return `${orderBy} OFFSET ${offsetParam} ROWS FETCH NEXT ${limitParam} ROWS ONLY`;
        },
        // TOP needs no ORDER BY, so capped reads without an offset stay simple.
        topPrefix: (n) => `TOP (${n}) `,
        limitSuffix: () => '',
        // PERCENTILE_CONT exists but only as a window function
        // (`WITHIN GROUP (...) OVER (PARTITION BY ...)`), which does not
        // compose with the GROUP BY shape the aggregate tool emits.
        supportsPercentile: false,
        medianExpr: () => null,
        percentileExpr: () => null,
        // T-SQL spells the sample statistics STDEV / VAR.
        stddevExpr: (col) => `STDEV(${col})`,
        varianceExpr: (col) => `VAR(${col})`,
      };
  }
}

// ---------------------------------------------------------------------------
// Column type classification. The type-name families live in ./sql-types.ts —
// see the note there on why they are centralised rather than inlined here.
// ---------------------------------------------------------------------------

/**
 * Map a declared SQL type to the JSON type exposed in MCP tool schemas, or
 * null when the type cannot be filtered on (binary, JSON, spatial, …).
 *
 * A null here removes the column from `filterableCols`, so a type name missing
 * from ./sql-types.ts makes filters on that column unusable — which is exactly
 * how SQL Server shipped broken before those names were added.
 *
 * Named `pgTypeToZod` for history; it covers every supported backend.
 */
export function pgTypeToZod(pgType: string): string | null {
  // Strings and date/times are both surfaced as `string`; dates as ISO 8601.
  if (isStringType(pgType) || isDateType(pgType)) return 'string';
  // Big integers stay strings so precision beyond 2^53 survives the round trip.
  if (isBigIntType(pgType)) return 'string';
  if (isNumericSqlType(pgType)) return 'number';
  if (isBooleanType(pgType)) return 'boolean';
  // Complex types not supported for filters
  return null;
}

export function isNumericType(pgType: string): boolean {
  return isNumericSqlType(pgType);
}

export function isTextType(pgType: string): boolean {
  return pgTypeToZod(pgType) === 'string';
}

// Date bucketing granularities supported by `group_by_bucket` on aggregate /
// join_aggregate. Translates to DATE_TRUNC (Postgres), DATE_FORMAT (MySQL),
// or strftime (SQLite) so the LLM can ask for "monthly", "weekly", "daily"
// trendlines without inventing dialect-specific SQL.
export type DateBucket = 'day' | 'week' | 'month' | 'quarter' | 'year';

/**
 * SQL Server date bucketing. Produces the same canonical period strings as the
 * MySQL / SQLite branches ('2026-03-14', '2026-W11', '2026-03-01', '2026-Q1',
 * '2026-01-01') so GROUP BY collapses identically and ORDER BY sorts
 * chronologically. Style 23 is ISO `yyyy-mm-dd`.
 */
function mssqlDateBucketExpr(granularity: DateBucket, columnExpr: string): string {
  const year = `CONVERT(varchar(4), YEAR(${columnExpr}))`;
  switch (granularity) {
    case 'day':
      return `CONVERT(varchar(10), ${columnExpr}, 23)`;
    case 'week':
      // Zero-pad the ISO week so '2026-W09' sorts before '2026-W10'.
      return `(${year} + '-W' + RIGHT('0' + CONVERT(varchar(2), DATEPART(ISO_WEEK, ${columnExpr})), 2))`;
    case 'month':
      return `(CONVERT(varchar(7), ${columnExpr}, 23) + '-01')`;
    case 'quarter':
      return `(${year} + '-Q' + CONVERT(varchar(1), DATEPART(QUARTER, ${columnExpr})))`;
    case 'year':
      return `(${year} + '-01-01')`;
  }
}

export function dateBucketExpr(
  dialect: Dialect,
  granularity: DateBucket,
  columnExpr: string,
): string {
  // Postgres has a native DATE_TRUNC for every granularity we expose.
  if (dialect.databaseType === 'postgresql') {
    return `DATE_TRUNC('${granularity}', ${columnExpr})`;
  }

  // SQL Server: DATETRUNC() is 2022+ only, so render the same canonical
  // strings the MySQL / SQLite branches produce using CONVERT + DATEPART,
  // which work on every supported SQL Server version.
  if (dialect.databaseType === 'mssql') {
    return mssqlDateBucketExpr(granularity, columnExpr);
  }

  // MySQL and SQLite don't have DATE_TRUNC. We render a canonical formatted
  // string per period so GROUP BY collapses identically and ORDER BY sorts
  // chronologically. The formats below assume the column already holds a
  // valid date / datetime / ISO-8601 string; non-date inputs return NULL,
  // matching how Calame handles malformed SQL today.
  const fmt = (() => {
    switch (granularity) {
      case 'day':
        return '%Y-%m-%d';
      case 'week':
        return '%Y-W%W';
      case 'month':
        return '%Y-%m-01';
      case 'quarter':
        return null; // synthesised below
      case 'year':
        return '%Y-01-01';
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
  const nonNull = sampleValues.filter((v) => v !== null && v !== undefined && v !== '');
  if (nonNull.length === 0) return null;

  const threshold = 0.8;
  const strs = nonNull.map((v) => String(v));

  const countMatch = (re: RegExp) => strs.filter((s) => re.test(s)).length;

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
  if (isNumericType(sqlType)) return 'number';
  if (isBooleanType(sqlType)) return 'bool';
  if (isDateType(sqlType)) return 'date';
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
/**
 * Reject a filter that targets a column this profile cannot filter on.
 *
 * Returns the structured-error payload for the first offending column, or null
 * when every filter is usable.
 *
 * WHY THIS IS AN ERROR AND NOT A SKIP: `buildWhereConditions` drops
 * non-allowlisted columns from the WHERE clause as a security backstop. When
 * the tools relied on that silently, a filtered query returned UNFILTERED
 * rows while reporting success — the worst kind of wrong answer, and how SQL
 * Server support shipped returning every row for any `contains` filter. On an
 * UPDATE/DELETE a partially dropped filter would widen the row set instead.
 *
 * `join_aggregate` already rejected such filters; this shares that contract
 * (and its wording) with `query`, `aggregate` and `write`.
 *
 * DISCLOSURE: a column is "not filterable" whether it is masked, excluded
 * from the profile, of an unsupported type, or absent from the table entirely.
 * The response is byte-identical in all four cases and lists only columns the
 * caller may already see, so this never reveals that a hidden column exists —
 * the same stance the `columns` argument validation already takes.
 */
export function rejectUnfilterableColumns(
  userFilters: Record<string, FilterValue | undefined> | undefined,
  allowed: string[],
  tableName: string,
): Record<string, unknown> | null {
  if (!userFilters) return null;
  const allowedSet = new Set(allowed);
  for (const [col, filter] of Object.entries(userFilters)) {
    if (!filter) continue;
    if (!allowedSet.has(col)) {
      return {
        error: `Column '${col}' is not filterable for table '${tableName}'`,
        valid_columns: allowed,
        did_you_mean: didYouMean(col, allowed),
      };
    }
  }
  return null;
}

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
): { ok: true; at: AccessibleTable } | { ok: false; payload: Record<string, unknown> } {
  const validTables = accessible
    .filter((a) => a.enabledTools.includes(capability))
    .map((a) => a.table.name);

  if (typeof name !== 'string' || name.length === 0) {
    return {
      ok: false,
      payload: { error: '`table` argument is required', valid_tables: validTables },
    };
  }
  const at = accessible.find((a) => a.table.name === name);
  if (!at) {
    const dym = didYouMean(
      name,
      accessible.map((a) => a.table.name),
    );
    return {
      ok: false,
      payload: { error: `Unknown table '${name}'`, valid_tables: validTables, did_you_mean: dym },
    };
  }
  if (!at.enabledTools.includes(capability)) {
    return {
      ok: false,
      payload: {
        error: `Table '${name}' does not support '${capability}'`,
        valid_tables: validTables,
      },
    };
  }
  return { ok: true, at };
}
