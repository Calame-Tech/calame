import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createHash } from 'crypto';
import { TableInfo, Relation, TableToolOptions } from '../introspect/types.js';
import { ColumnMasking } from '../pii/types.js';
import type { AuditLogEntry, PendingWriteQuery } from './types.js';
import { snakeCaseToLabel, friendlyType, buildLabelMap, formatResponseRows } from './response-formatter.js';
import type { ScopeGuard, Dialect } from './scoped-executor.js';
import { ScopeBlockedError, createScopeGuard, buildPlainConditions } from './scoped-executor.js';
import { findJoinPath, computeTransitiveClosure } from './join-path.js';

// We use `as any` in server.tool() calls because the dynamic Zod schemas
// (Record<string, z.ZodTypeAny>) cause TS2589 "excessively deep" errors with
// the MCP SDK's generic overloads. The schemas are correctly constructed at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolArgs = any;

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

interface DynamicToolsOptions {
  server: McpServer;
  tables: TableInfo[];
  relations: Relation[];
  selectedTables: Record<string, string[]>; // which tables/columns are visible
  tableOptions?: Record<string, TableToolOptions>;
  columnMasking?: Record<string, Record<string, ColumnMasking>>;
  executeQuery: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[]; fields: { name: string }[] }>;
  onAuditLog?: (entry: Omit<AuditLogEntry, 'id' | 'timestamp'>) => void;
  onWriteRequest?: (query: Omit<PendingWriteQuery, 'id' | 'timestamp' | 'status'>) => string;
  profileName: string;
  databaseType: 'postgresql' | 'mysql' | 'sqlite';
  /** Response mode: 'friendly' hides technical names, 'raw' shows them. Default 'raw'. */
  responseMode?: 'friendly' | 'raw';
  /** Wrap JSON output with LLM presentation instructions (used in friendly mode). */
  wrapResponse?: (json: string) => string;
  /** Maximum allowed offset for pagination (default 10000). */
  maxOffset?: number;
  /** Row-level data scoping guard. When provided, filters queries to the current user's data. */
  scopeGuard?: ScopeGuard;
  /**
   * Pre-computed distinct values per table/column, baked into the catalogue
   * the LLM sees in the description of `aggregate`/`query`. Caller (serve.ts
   * route) is responsible for running `SELECT DISTINCT ... LIMIT 21` on each
   * filterable string column at MCP server startup. Skipped columns / tables
   * just appear as their friendly type label (no enum hint).
   */
  distinctValuesByTable?: Record<string, Record<string, unknown[]>>;
  /**
   * When the number of visible tables exceeds this threshold, the catalogue
   * baked into the description of `aggregate` / `query` / `join_aggregate`
   * collapses to a one-line-per-table summary (name, column count, FK
   * targets) instead of listing every column inline. The LLM uses
   * `describe(table=<name>)` to recover the full column metadata when it
   * needs it.
   *
   * Without this fallback, profiles with ~100+ visible tables blow past
   * the 32k context window of small models (the per-table verbose entry
   * costs ~280 tokens; 200 tables = 56k tokens of catalogue alone).
   *
   * Default: 100. Set to a very large number to force the verbose form.
   */
  catalogueCompactThreshold?: number;
  /**
   * Optional prefix applied to every registered tool name. When empty (the
   * default), tool names are unchanged (e.g. `query`). When set to a
   * non-empty string, every tool name is prefixed (e.g. `prod_query`).
   *
   * The host computes this based on multi-source detection in the active
   * profile — see packages/cli/src/routes/serve.ts (Phase 3c). Phase 3a only
   * delivers the prefixing mechanism.
   */
  toolNamespace?: string;
}

/** Shared context passed to register* helpers to avoid long parameter lists. */
interface ToolContext {
  server: McpServer;
  executeQuery: DynamicToolsOptions['executeQuery'];
  onAuditLog: DynamicToolsOptions['onAuditLog'];
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
function makeDialect(dbType: 'postgresql' | 'mysql' | 'sqlite'): Dialect {
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

function pgTypeToZod(pgType: string): string | null {
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

function isNumericType(pgType: string): boolean {
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

function isTextType(pgType: string): boolean {
  return pgTypeToZod(pgType) === 'string';
}

// Date bucketing granularities supported by `group_by_bucket` on aggregate /
// join_aggregate. Translates to DATE_TRUNC (Postgres), DATE_FORMAT (MySQL),
// or strftime (SQLite) so the LLM can ask for "monthly", "weekly", "daily"
// trendlines without inventing dialect-specific SQL.
type DateBucket = 'day' | 'week' | 'month' | 'quarter' | 'year';

function dateBucketExpr(dialect: Dialect, granularity: DateBucket, columnExpr: string): string {
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
function detectDateFormat(sqlType: string, sampleValues: unknown[]): string | null {
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
function friendlyTypeLabel(sqlType: string): string {
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
function levenshtein(a: string, b: string): number {
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

function didYouMean(input: string, valid: string[]): string | undefined {
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
function structuredError(payload: Record<string, unknown>): {
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
interface AccessibleTable {
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

// Build the catalogue text baked in `aggregate` and `query` tool descriptions.
// Verbose form mentions every visible column with its type tag, low-cardinality
// enum values when available, and FK arrows so the LLM can plan multi-hop
// queries. Switches to a compact one-line-per-table summary when the visible
// tables exceed `compactThreshold` so very large schemas don't blow the
// manifest past small-model context windows.
function buildCatalogue(
  accessible: AccessibleTable[],
  distinctValuesByTable: Record<string, Record<string, unknown[]>>,
  compactThreshold = 100,
): string {
  const useCompact = accessible.length > compactThreshold;
  if (useCompact) return buildCompactCatalogue(accessible);

  const lines: string[] = ['TABLES & COLUMNS:'];
  for (const at of accessible) {
    const cols: string[] = [];
    for (const col of at.visibleColumns) {
      const friendly = friendlyTypeLabel(col.type);
      const distinct = distinctValuesByTable[at.table.name]?.[col.name];
      const fk = at.relations.find(r => r.fromTable === at.table.name && r.fromColumn === col.name);
      const fkSuffix = fk ? `→${fk.toTable}.${fk.toColumn}` : '';
      let typeLabel: string;
      // Determine whether to encode as enum. Rules:
      // 1. At most 15 distinct values (down from 20 to reduce false-positives).
      // 2. Numeric columns are never enums — unless exactly 2 values {0, 1}
      //    (boolean-encoded integer).
      // 3. Text columns with long values (avg > 30 chars or max > 100 chars)
      //    are free-text, not enums.
      const isNumeric = isNumericType(col.type);
      const isBooleanInt =
        isNumeric &&
        Array.isArray(distinct) &&
        distinct.length === 2 &&
        distinct.every((v) => v === 0 || v === 1 || v === '0' || v === '1');
      const shouldEncodeAsEnum = (() => {
        if (!Array.isArray(distinct) || distinct.length === 0 || distinct.length > 15) return false;
        if (isNumeric && !isBooleanInt) return false;
        if (!isNumeric) {
          // Check for free-text by inspecting the distinct values themselves.
          const strValues = distinct.map((v) => String(v ?? ''));
          const maxLen = Math.max(...strValues.map((s) => s.length));
          const avgLen = strValues.reduce((sum, s) => sum + s.length, 0) / strValues.length;
          if (maxLen > 100 || avgLen > 30) return false;
        }
        return true;
      })();
      if (shouldEncodeAsEnum) {
        typeLabel = `enum:${distinct!.map(v => String(v)).join('|')}`;
      } else {
        typeLabel = friendly;
        // Detect ISO date format for string-typed columns using available samples
        const dateFormat = detectDateFormat(col.type, Array.isArray(distinct) ? distinct : []);
        if (dateFormat) {
          typeLabel = `${friendly}, format=${dateFormat}`;
        }
      }
      const nullableSuffix = col.nullable ? ', nullable' : '';
      cols.push(`${col.name}(${typeLabel}${nullableSuffix})${fkSuffix}`);
    }
    lines.push(`  ${at.table.name}: ${cols.join(', ')}`);
  }
  lines.push('');
  lines.push('OPS: eq, neq, gt, gte, lt, lte (single value), between (value=[min,max]),');
  lines.push('     in (value=array), is_null, is_not_null (omit value),');
  lines.push('     contains, starts_with, ends_with (case-insensitive substring match on text)');
  return lines.join('\n');
}

// Compact catalogue used when the schema has too many tables to list every
// column inline. Each row is one table with its visible-column count and the
// names of the tables it references through outbound FKs. The LLM uses
// `describe(table=<name>)` when it needs the full column metadata.
function buildCompactCatalogue(accessible: AccessibleTable[]): string {
  const lines: string[] = [
    `TABLES (compact mode — ${accessible.length} tables; call describe(table=<name>) for full column metadata):`,
  ];
  for (const at of accessible) {
    const fkTargets = Array.from(
      new Set(
        at.relations
          .filter(r => r.fromTable === at.table.name)
          .map(r => r.toTable),
      ),
    );
    const fkSuffix = fkTargets.length > 0 ? ` → ${fkTargets.join(', ')}` : '';
    lines.push(`  ${at.table.name}: ${at.visibleColumns.length} cols${fkSuffix}`);
  }
  lines.push('');
  lines.push('OPS: eq, neq, gt, gte, lt, lte (single value), between (value=[min,max]),');
  lines.push('     in (value=array), is_null, is_not_null (omit value),');
  lines.push('     contains, starts_with, ends_with (case-insensitive substring match on text)');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Shared constants — referenced in Zod .describe() calls to avoid repeating
// verbose strings multiple times in the tool manifest.
// ---------------------------------------------------------------------------

const AGG_OPS = ['count', 'sum', 'avg', 'min', 'max', 'ratio', 'count_distinct', 'weighted_ratio', 'median', 'stddev', 'variance', 'percentile'] as const;
const AGG_OPS_JOIN = ['count', 'sum', 'avg', 'min', 'max', 'ratio', 'count_distinct', 'weighted_ratio', 'median', 'stddev', 'variance', 'percentile'] as const;
const DATE_BUCKETS = ['day', 'week', 'month', 'quarter', 'year'] as const;
const ORDER_DIRS = ['asc', 'desc'] as const;

const FILTER_OPS_DESC =
  'Filters: eq|neq|gt|gte|lt|lte|between(value=[min,max])|in(value=[])|is_null|is_not_null|contains|starts_with|ends_with';

// ---------------------------------------------------------------------------
// WHERE clause builder runtime types (the build itself lives in scoped-executor)
// ---------------------------------------------------------------------------

type FilterOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'in'
  | 'is_null'
  | 'is_not_null'
  | 'contains'
  | 'starts_with'
  | 'ends_with';

interface FilterValue {
  op: FilterOperator;
  value: unknown;
}

// ---------------------------------------------------------------------------
// Masking runtime
// ---------------------------------------------------------------------------

interface MaskingRule {
  mode: 'none' | 'exclude' | 'hash' | 'truncate' | 'replace' | 'aggregate_only';
  replaceValue?: string;
  showFirst?: number;
  showLast?: number;
}

function buildMaskingRules(columnMasking: Record<string, ColumnMasking>): Record<string, MaskingRule> {
  const rules: Record<string, MaskingRule> = {};
  for (const [colName, masking] of Object.entries(columnMasking)) {
    if (masking.maskingMode === 'none') continue;
    const rule: MaskingRule = { mode: masking.maskingMode };
    if (masking.maskingMode === 'replace' && masking.replaceValue !== undefined) {
      rule.replaceValue = masking.replaceValue;
    }
    if (masking.maskingMode === 'truncate') {
      rule.showFirst = masking.truncateOptions?.showFirst ?? 1;
      rule.showLast = masking.truncateOptions?.showLast ?? 0;
    }
    rules[colName] = rule;
  }
  return rules;
}

function applyMasking(
  rows: Record<string, unknown>[],
  rules: Record<string, MaskingRule>,
): Record<string, unknown>[] {
  if (!rules || Object.keys(rules).length === 0) return rows;

  return rows.map((row) => {
    const masked = { ...row };
    for (const [col, rule] of Object.entries(rules)) {
      if (!(col in masked)) continue;

      switch (rule.mode) {
        case 'exclude':
        case 'aggregate_only':
          delete masked[col];
          break;
        case 'replace':
          masked[col] = rule.replaceValue ?? '[MASKED]';
          break;
        case 'truncate': {
          const val = String(masked[col] ?? '');
          const first = rule.showFirst ?? 0;
          const last = rule.showLast ?? 0;
          if (val.length > first + last) {
            const prefix = val.slice(0, first);
            const suffix = last > 0 ? val.slice(-last) : '';
            masked[col] = prefix + '...' + suffix;
          }
          break;
        }
        case 'hash':
          masked[col] = createHash('sha256')
            .update(String(masked[col] ?? ''))
            .digest('hex');
          break;
        case 'none':
        default:
          break;
      }
    }
    return masked;
  });
}

// ---------------------------------------------------------------------------
// Utility: create a Zod enum from a non-empty array, or return undefined
// ---------------------------------------------------------------------------

function zodEnum<T extends string>(values: T[]): z.ZodTypeAny | undefined {
  if (values.length === 0) return undefined;
  return z.enum(values as unknown as readonly [string, ...string[]]);
}

// ---------------------------------------------------------------------------
// Tool execution wrapper with audit logging and error handling
// ---------------------------------------------------------------------------

async function executeWithAudit(
  opts: {
    executeQuery: DynamicToolsOptions['executeQuery'];
    dialect: Dialect;
    onAuditLog?: DynamicToolsOptions['onAuditLog'];
    profileName: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
  },
  fn: (exec: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[]; fields: { name: string }[] }>) => Promise<{
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

// ===========================================================================
// Phase-2 entry point — registers a small generic tool surface
// (`list_tables`, `describe`, `aggregate`, `query`, optional `write`).
//
// Why generic and not per-table:
// - Slashes the manifest from O(tables × tool kinds) to O(tool kinds), which
//   matters for small-context LLMs (Qwen 7B / Gemini Flash Lite).
// - Drops the `z.union([T, T[]])` -> `anyOf` JSON-Schema pattern that Gemini
//   silently rejects (cf. zod#5807). Filter values are typed as `z.any()` and
//   validated at runtime; the LLM gets the column types/enums from the
//   catalogue baked in the tool descriptions.
// ===========================================================================

function registerCalcTool(
  server: McpServer,
  profileName: string,
  toolName: (suffix: string) => string,
  onAuditLog?: DynamicToolsOptions['onAuditLog'],
): void {
  const inputShape = {
    op: z
      .enum(['sum', 'avg', 'min', 'max', 'count', 'product'])
      .describe('Operation to perform on the values.'),
    values: z
      .array(z.number())
      .describe('Numbers to operate on. Pass every individual value, no pre-aggregation.'),
  };

  const description =
    'Perform arithmetic on a list of numbers. ' +
    'MANDATORY before writing any TOTAL, SUM, AVERAGE, MIN, MAX or PRODUCT in your response — including TOTAL rows in Markdown tables. ' +
    'Example: if rows show counts [120, 340, 501] and you need a total, call calc({op:"sum", values:[120,340,501]}) before writing "Total: 961". ' +
    'Never compute these mentally.';

  server.tool(
    toolName('calc'),
    description,
    inputShape as AnyToolArgs,
    async (args: Record<string, unknown>) => {
      const start = Date.now();
      const op = args['op'] as string;
      const values = args['values'] as number[];

      let result: number;
      switch (op) {
        case 'sum':
          result = values.reduce((acc, v) => acc + v, 0);
          break;
        case 'avg':
          if (values.length === 0) throw new Error('calc: cannot compute average of an empty array');
          result = values.reduce((acc, v) => acc + v, 0) / values.length;
          break;
        case 'min':
          if (values.length === 0) throw new Error('calc: cannot compute min of an empty array');
          result = Math.min(...values);
          break;
        case 'max':
          if (values.length === 0) throw new Error('calc: cannot compute max of an empty array');
          result = Math.max(...values);
          break;
        case 'count':
          result = values.length;
          break;
        case 'product':
          result = values.reduce((acc, v) => acc * v, 1);
          break;
        default:
          throw new Error(`calc: unknown operation "${op}"`);
      }

      if (onAuditLog) {
        onAuditLog({
          profileName,
          toolName: toolName('calc'),
          toolArgs: { op, values },
          result: 'success',
          resultSummary: `${op}([${values.join(', ')}]) = ${result}`,
          resultData: JSON.stringify({ result }),
          durationMs: Date.now() - start,
        });
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ result }) }] };
    },
  );
}

export function registerDynamicTools(options: DynamicToolsOptions): void {
  const dialect = makeDialect(options.databaseType);
  const scopeGuard: ScopeGuard = options.scopeGuard ?? createScopeGuard([]);

  // Tool name helper: when toolNamespace is set, every registered tool gets
  // prefixed with it (e.g. 'prod_' → 'prod_query'). When unset or empty, the
  // name is returned unchanged for full backward compatibility.
  const ns = options.toolNamespace ?? '';
  const toolName = (suffix: string): string => `${ns}${suffix}`;

  const ctx: ToolContext = {
    server: options.server,
    executeQuery: options.executeQuery,
    onAuditLog: options.onAuditLog,
    profileName: options.profileName,
    dialect,
    responseMode: options.responseMode ?? 'raw',
    wrapResponse: options.wrapResponse ?? ((j) => j),
    maxOffset: options.maxOffset ?? 10000,
    scopeGuard,
    toolName,
  };

  registerCalcTool(options.server, options.profileName, toolName, options.onAuditLog);

  const accessible = buildAccessibleTables(options, scopeGuard);
  if (accessible.length === 0) return;

  const distinctValuesByTable = options.distinctValuesByTable ?? {};
  const catalogue = buildCatalogue(
    accessible,
    distinctValuesByTable,
    options.catalogueCompactThreshold,
  );

  registerListTablesGeneric(ctx, accessible);
  registerAggregateGeneric(ctx, accessible, catalogue);
  registerJoinAggregateGeneric(ctx, accessible, options.relations);
  registerQueryGeneric(ctx, accessible, catalogue);
  registerDescribeGeneric(ctx, accessible, distinctValuesByTable);
  if (options.onWriteRequest) {
    registerWriteGeneric(ctx, accessible, options.onWriteRequest);
  }
}

// ---------------------------------------------------------------------------
// Build per-table descriptors used by every generic tool handler.
// Mirrors the per-table prep work the old per-table register* functions did.
// ---------------------------------------------------------------------------

function buildAccessibleTables(
  options: DynamicToolsOptions,
  scopeGuard: ScopeGuard,
): AccessibleTable[] {
  const result: AccessibleTable[] = [];
  for (const table of options.tables) {
    const selectedCols = options.selectedTables[table.name];
    if (!selectedCols || selectedCols.length === 0) continue;

    if (scopeGuard.active) {
      try { scopeGuard.checkTableAccess(table.name); }
      catch (e) {
        if (e instanceof ScopeBlockedError) continue;
        throw e;
      }
    }

    const opts = options.tableOptions?.[table.name];
    const enabledTools = opts?.enabledTools ?? ['describe', 'aggregate', 'query'];
    const tableMasking = options.columnMasking?.[table.name];
    const maskingRules = tableMasking ? buildMaskingRules(tableMasking) : {};

    const excludedCols = new Set<string>();
    if (tableMasking) {
      for (const [colName, m] of Object.entries(tableMasking)) {
        if (m.maskingMode === 'exclude') excludedCols.add(colName);
      }
    }

    const visibleColumns = table.columns.filter(
      c => selectedCols.includes(c.name) && !excludedCols.has(c.name),
    );
    if (visibleColumns.length === 0) continue;

    const labelMap = buildLabelMap(visibleColumns.map(c => ({ name: c.name })));
    const filterableCols = visibleColumns.filter(c => pgTypeToZod(c.type) !== null);
    const numericCols = visibleColumns
      .filter(c => isNumericType(c.type))
      .map(c => c.name);
    const groupableColumns = (
      opts?.groupableColumns && opts.groupableColumns.length > 0
        ? opts.groupableColumns
        : filterableCols.map(c => c.name)
    ).filter(c => !excludedCols.has(c));
    const allColumnNames = visibleColumns.map(c => c.name);
    const tableRelations = options.relations.filter(
      r => r.fromTable === table.name || r.toTable === table.name,
    );

    result.push({
      table,
      opts,
      enabledTools,
      visibleColumns,
      excludedCols,
      tableMasking,
      maskingRules,
      labelMap,
      filterableCols,
      numericCols,
      groupableColumns,
      allColumnNames,
      relations: tableRelations,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Resolve a `table` arg from the LLM into an AccessibleTable; structured
// error otherwise. Capability gate ensures e.g. an aggregate-disabled table
// can't be hit through the `aggregate` tool.
// ---------------------------------------------------------------------------

function resolveTable(
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

// ---------------------------------------------------------------------------
// Generic `list_tables` — names + per-table tool list. Lighter than the
// catalogue (which is in the description of `aggregate`/`query`); kept for
// backward compatibility and quick discovery.
// ---------------------------------------------------------------------------

function registerListTablesGeneric(ctx: ToolContext, accessible: AccessibleTable[]): void {
  const { server, executeQuery, dialect, onAuditLog, profileName, responseMode, wrapResponse, toolName } = ctx;
  const friendly = responseMode === 'friendly';

  const tableList = accessible.map(at => {
    const tools = ['describe', 'aggregate', 'query', 'write'].filter(t => at.enabledTools.includes(t));
    return {
      name: friendly ? snakeCaseToLabel(at.table.name) : at.table.name,
      columns: at.visibleColumns.map(c => (friendly ? snakeCaseToLabel(c.name) : c.name)),
      enabled: tools,
    };
  });

  // Tool descriptions are always English. They form the contract the LLM
  // reads on tools/list and English is both shorter (~30% fewer tokens than
  // French here) and the default training language for tool calling. The
  // `friendly` response mode still drives user-facing output (column labels,
  // payload shape).
  const desc = 'List all tables you have access to. Call this first if you are unsure which tables exist. Detailed schema (column types, enums, FK relations) is available via describe or in the aggregate/query tool descriptions.';

  server.tool(
    toolName('list_tables'),
    desc,
    {},
    async () =>
      executeWithAudit(
        { executeQuery, dialect, onAuditLog, profileName, toolName: toolName('list_tables'), toolArgs: {} },
        async () => {
          const text = wrapResponse(JSON.stringify(tableList, null, 2));
          return {
            content: [{ type: 'text' as const, text }],
            resultSummary: `${tableList.length} tables`,
            resultData: text,
          };
        },
      ),
  );
}

// ---------------------------------------------------------------------------
// Filter-map Zod schema shared by aggregate/query/write. Intentionally untyped
// at the value level — runtime validates against per-column metadata so the
// schema stays free of `anyOf`/`oneOf` constructs that Gemini's
// function-calling rejects.
// ---------------------------------------------------------------------------

function makeFilterMapSchema(): z.ZodTypeAny {
  return z
    .record(
      z.string(),
      z.object({
        op: z.enum([
          'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
          'between', 'in',
          'is_null', 'is_not_null',
          'contains', 'starts_with', 'ends_with',
        ]),
        value: z.any().optional(),
      }),
    )
    .optional();
}

// ---------------------------------------------------------------------------
// Generic `aggregate` tool — single registration, all eligible tables.
// ---------------------------------------------------------------------------

function registerAggregateGeneric(
  ctx: ToolContext,
  accessible: AccessibleTable[],
  catalogue: string,
): void {
  const { server, executeQuery, dialect, onAuditLog, profileName, responseMode, wrapResponse, maxOffset, scopeGuard, toolName } = ctx;

  const eligible = accessible.filter(at => at.enabledTools.includes('aggregate') && at.numericCols.length > 0);
  if (eligible.length === 0) return;
  const tableEnum = zodEnum(eligible.map(at => at.table.name));
  if (!tableEnum) return;

  const inputShape: Record<string, z.ZodTypeAny> = {
    table: tableEnum.describe('Target table. See TABLES & COLUMNS.'),
    aggregation: z
      .enum(AGG_OPS)
      .describe(
        'count|sum|avg|min|max: standard SQL. ' +
          'ratio: (rows matching ratio_filter)/(rows matching filters). ' +
          'count_distinct: COUNT(DISTINCT aggregation_column). ' +
          'weighted_ratio: SUM(numerator_column)/SUM(denominator_column). ' +
          'median|stddev|variance|percentile: statistical aggregations — require PostgreSQL.',
      ),
    aggregation_column: z
      .string()
      .optional()
      .describe('Required for sum/avg/min/max (numeric), count_distinct (any col), median/stddev/variance/percentile (numeric).'),
    numerator_column: z.string().optional().describe('Numeric numerator col for weighted_ratio.'),
    denominator_column: z.string().optional().describe('Numeric denominator col for weighted_ratio.'),
    percentile_p: z
      .number()
      .min(0.01)
      .max(0.99)
      .optional()
      .describe('Required when aggregation is "percentile". Value between 0.01 and 0.99 (e.g. 0.95 for p95).'),
    filters: makeFilterMapSchema().describe(`WHERE filters (denominator for ratio). ${FILTER_OPS_DESC}`),
    ratio_filter: makeFilterMapSchema().describe('Numerator filter for ratio. Same shape as filters.'),
    having_min_total: z
      .number()
      .optional()
      .describe('Min row count per group (HAVING). Drops small-sample groups.'),
    group_by: z.string().optional().describe('Primary GROUP BY column.'),
    group_by_bucket: z
      .enum(DATE_BUCKETS)
      .optional()
      .describe('Date truncation granularity for group_by on a date/timestamp column (DATE_TRUNC).'),
    group_by_secondary: z
      .string()
      .optional()
      .describe('Second GROUP BY column for 2D pivots. Combine with top_n_per_group for top-N rankings.'),
    top_n_per_group: z
      .object({
        partition_by: z.string().describe('Partition column — must match group_by or group_by_secondary.'),
        order_by: z.string().describe('Sort column per partition (use "result" for aggregate value).'),
        n: z.number().describe('Rows to keep per partition (>= 1).'),
      })
      .optional()
      .describe('ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ... DESC) — keeps top N per group.'),
    order_by: z.string().optional().describe('Sort column. Use "result" for the aggregated value.'),
    order_direction: z.enum(ORDER_DIRS).optional(),
    limit: z.number().optional().default(20).describe('Max rows (≤1000).'),
    offset: z
      .number()
      .optional()
      .default(0)
      .describe('Skip first N grouped rows. Use with limit for pagination beyond 1000 groups.'),
    compare_to: z
      .object({
        period: z
          .enum([
            'previous_period',
            'previous_year',
            'previous_calendar_month',
            'previous_calendar_quarter',
            'previous_calendar_year',
          ])
          .describe(
            'previous_period: same duration shifted back (rolling window). ' +
              'previous_year: shift by 1 year (same day/month). ' +
              '"previous_calendar_month": full calendar month before the current range start (e.g. if range starts in April → March). ' +
              '"previous_calendar_quarter": full calendar quarter before current (e.g. Q1 if range starts in Q2). ' +
              '"previous_calendar_year": full calendar year before current (Jan 1 – Dec 31 of prior year). ' +
              'Use calendar variants for business analytics (monthly reports, quarterly reviews). ' +
              'Use previous_period/previous_year for rolling-window comparisons.',
          ),
        date_column: z
          .string()
          .describe('Date column already in filters with op=between whose window is shifted.'),
      })
      .optional()
      .describe(
        'Period-over-period: runs aggregate twice (current + shifted window), returns result/previous/delta_abs/delta_pct. Not compatible with group_by_bucket or top_n_per_group.',
      ),
  };

  // Tool descriptions live in the manifest the LLM reads on tools/list — they
  // stay English regardless of `responseMode` (English is shorter and the
  // default training language for tool calling). User-facing output is still
  // localized via the `friendly` response mode.
  const desc = `Single-table analytics: COUNT, SUM, AVG, MIN, MAX, ratio, conditional ratio (ratio_filter), period-over-period comparison (compare_to), top-N per group (top_n_per_group), HAVING filter (having_min_total), pagination (offset). Use this for any aggregation on ONE table — reach for join_aggregate only when you need columns from a second table. Statistical aggregations (median, stddev, variance, percentile) require PostgreSQL. When counting or ranking individuals (persons, drivers, customers...), group by their unique \`id\` column — name columns (nom, prenom, name) are rarely unique and will merge records with identical names.\n\nKey advanced params with examples:\n- compare_to: {"period": "previous_year", "date_column": "date_creation"} → rolling year-over-year\n- compare_to: {"period": "previous_calendar_month", "date_column": "date_creation"} → full calendar month comparison (e.g. April vs March)\n- top_n_per_group: {"n": 3, "partition_by": "id_depot", "order_by": "result"} → top 3 per group via window function\n- ratio_filter: {"statut": {"op": "eq", "value": "livre"}} → conditional ratio (numerator filter)\n- having_min_total: 100 → HAVING COUNT(*) >= 100\n- offset: 1000 → pagination beyond limit\n\n${catalogue}`;

  server.tool(
    toolName('aggregate'),
    desc,
    inputShape as AnyToolArgs,
    async (args: Record<string, unknown>) => {
      const resolved = resolveTable(args.table, accessible, 'aggregate');
      if (!resolved.ok) return structuredError(resolved.payload);
      const at = resolved.at;
      if (at.numericCols.length === 0) {
        return structuredError({
          error: `Table '${at.table.name}' has no numeric columns and cannot be aggregated`,
          valid_tables: accessible
            .filter(a => a.enabledTools.includes('aggregate') && a.numericCols.length > 0)
            .map(a => a.table.name),
        });
      }

      const tableName = at.table.name;
      const schemaName = at.table.schema || 'public';
      const qualifiedTable = dialect.quoteTable(schemaName, tableName);
      const maxLimit = at.opts?.maxLimit ?? 1000;
      const allowedFilterColumns = at.filterableCols.map(c => c.name);

      const {
        aggregation,
        aggregation_column,
        numerator_column,
        denominator_column,
        percentile_p,
        filters,
        ratio_filter,
        having_min_total,
        group_by,
        group_by_bucket,
        group_by_secondary,
        top_n_per_group,
        order_by,
        order_direction,
        limit,
        offset,
        compare_to,
      } = args as {
        aggregation: string;
        aggregation_column?: string;
        numerator_column?: string;
        denominator_column?: string;
        percentile_p?: number;
        filters?: Record<string, FilterValue | undefined>;
        ratio_filter?: Record<string, FilterValue | undefined>;
        having_min_total?: number;
        group_by?: string;
        group_by_bucket?: DateBucket;
        compare_to?: {
          period:
            | 'previous_period'
            | 'previous_year'
            | 'previous_calendar_month'
            | 'previous_calendar_quarter'
            | 'previous_calendar_year';
          date_column: string;
        };
        group_by_secondary?: string;
        top_n_per_group?: { partition_by: string; order_by: string; n: number };
        order_by?: string;
        order_direction?: string;
        limit?: number;
        offset?: number;
      };

      return executeWithAudit(
        { executeQuery, dialect, onAuditLog, profileName, toolName: toolName('aggregate'), toolArgs: args },
        async (exec) => {
          const cappedLimit = Math.min(limit ?? 20, maxLimit);
          const cappedOffset = Math.min(offset ?? 0, maxOffset ?? 10_000);

          // offset is not compatible with compare_to (pagination of period
          // comparisons is ambiguous — both windows would need separate offsets).
          if (compare_to && cappedOffset > 0) {
            return structuredError({
              error: 'offset is not compatible with compare_to — pagination of period comparisons is ambiguous',
            });
          }

          const { clause: whereClause, values, nextParamIndex } = scopeGuard.buildWhereClause(
            tableName,
            filters,
            allowedFilterColumns,
            dialect,
          );
          // Capture the count of WHERE values so compare_to can splice in a
          // shifted-date version later. All subsequent pushes (ratio_filter
          // doubled values, having_min_total, top_n.n, cappedLimit) appear
          // after this offset; for compare_to we swap [0..whereValueCount]
          // with the prev-window values and reuse `sql` unchanged.
          const whereValueCount = values.length;
          let paramCursor = nextParamIndex;

          let selectExpr: string;
          if (aggregation === 'ratio') {
            if (!ratio_filter || Object.keys(ratio_filter).length === 0) {
              return structuredError({ error: 'ratio_filter is required for aggregation: "ratio"' });
            }
            // The CASE WHEN expression appears twice in the SELECT (once for
            // `result`, once for `numerator`). Each occurrence has its own
            // positional placeholders, so we build the conditions twice with
            // independent paramIndex windows and push the values twice. This
            // keeps SQLite (`?`) and Postgres (`$N`) consistent.
            const first = buildPlainConditions(ratio_filter, allowedFilterColumns, dialect, paramCursor);
            if (first.conditions.length === 0) {
              return structuredError({
                error: 'ratio_filter has no usable conditions',
                valid_columns: allowedFilterColumns,
              });
            }
            values.push(...first.values);
            paramCursor = first.nextParamIndex;
            const second = buildPlainConditions(ratio_filter, allowedFilterColumns, dialect, paramCursor);
            values.push(...second.values);
            paramCursor = second.nextParamIndex;
            const caseFirst = `CASE WHEN ${first.conditions.join(' AND ')} THEN 1 ELSE 0 END`;
            const caseSecond = `CASE WHEN ${second.conditions.join(' AND ')} THEN 1 ELSE 0 END`;
            selectExpr =
              `AVG(1.0 * (${caseFirst})) as result,` +
              ` SUM(${caseSecond}) as numerator,` +
              ` COUNT(*) as denominator`;
          } else if (aggregation === 'weighted_ratio') {
            // SUM(num) / SUM(den) — for fulfillment %, conversion rate,
            // weighted averages. Validates both columns are numeric and emits
            // (result, numerator, denominator) so the LLM can sanity-check
            // sample size and combine with `having_min_total` for top-N
            // rankings that filter out small denominators.
            if (!numerator_column || !denominator_column) {
              return structuredError({
                error: 'weighted_ratio requires both `numerator_column` and `denominator_column`',
                valid_columns: at.numericCols,
              });
            }
            if (!at.numericCols.includes(numerator_column)) {
              return structuredError({
                error: `Invalid numerator_column '${numerator_column}' for table '${tableName}'`,
                valid_columns: at.numericCols,
                did_you_mean: didYouMean(numerator_column, at.numericCols),
              });
            }
            if (!at.numericCols.includes(denominator_column)) {
              return structuredError({
                error: `Invalid denominator_column '${denominator_column}' for table '${tableName}'`,
                valid_columns: at.numericCols,
                did_you_mean: didYouMean(denominator_column, at.numericCols),
              });
            }
            const qiNum = dialect.quoteIdent(numerator_column);
            const qiDen = dialect.quoteIdent(denominator_column);
            // 1.0 multiplier promotes integer SUMs to float so SQLite doesn't
            // round to 0; NULLIF guards against divide-by-zero on empty groups.
            selectExpr =
              `(1.0 * SUM(${qiNum}) / NULLIF(SUM(${qiDen}), 0)) as result,` +
              ` SUM(${qiNum}) as numerator,` +
              ` SUM(${qiDen}) as denominator`;
          } else if (aggregation === 'count_distinct') {
            // COUNT(DISTINCT col) — works on any column type, not just numeric.
            // Validate against the visible-but-not-excluded column list.
            if (!aggregation_column) {
              return structuredError({
                error: 'aggregation_column is required for count_distinct',
                valid_columns: at.allColumnNames,
              });
            }
            if (!at.allColumnNames.includes(aggregation_column)) {
              return structuredError({
                error: `Invalid aggregation_column '${aggregation_column}' for count_distinct on table '${tableName}'`,
                valid_columns: at.allColumnNames,
                did_you_mean: didYouMean(aggregation_column, at.allColumnNames),
              });
            }
            selectExpr = `COUNT(DISTINCT ${dialect.quoteIdent(aggregation_column)}) as result`;
          } else if (aggregation === 'median' || aggregation === 'percentile' || aggregation === 'stddev' || aggregation === 'variance') {
            // Statistical aggregations — require aggregation_column (numeric).
            if (!aggregation_column) {
              return structuredError({
                error: `aggregation_column is required for ${aggregation}`,
                valid_columns: at.numericCols,
              });
            }
            if (!at.numericCols.includes(aggregation_column)) {
              return structuredError({
                error: `Invalid aggregation_column '${aggregation_column}' for table '${tableName}'`,
                valid_columns: at.numericCols,
                did_you_mean: didYouMean(aggregation_column, at.numericCols),
              });
            }
            const statCol = dialect.quoteIdent(aggregation_column);
            if (aggregation === 'median') {
              const expr = dialect.medianExpr(statCol);
              if (!expr) {
                return structuredError({
                  error: `median is not supported on ${dialect.databaseType} — use PostgreSQL for advanced statistical aggregations`,
                });
              }
              selectExpr = `${expr} as result`;
            } else if (aggregation === 'percentile') {
              if (percentile_p == null) {
                return structuredError({
                  error: 'percentile_p is required when aggregation is "percentile" (e.g. 0.95 for p95)',
                });
              }
              const expr = dialect.percentileExpr(statCol, percentile_p);
              if (!expr) {
                return structuredError({
                  error: `percentile is not supported on ${dialect.databaseType} — use PostgreSQL for advanced statistical aggregations`,
                });
              }
              selectExpr = `${expr} as result`;
            } else if (aggregation === 'stddev') {
              const expr = dialect.stddevExpr(statCol);
              if (!expr) {
                return structuredError({
                  error: `stddev is not supported on ${dialect.databaseType} — use PostgreSQL or MySQL for standard deviation`,
                });
              }
              selectExpr = `${expr} as result`;
            } else {
              // variance
              const expr = dialect.varianceExpr(statCol);
              if (!expr) {
                return structuredError({
                  error: `variance is not supported on ${dialect.databaseType} — use PostgreSQL or MySQL for variance`,
                });
              }
              selectExpr = `${expr} as result`;
            }
          } else if (aggregation === 'count' && !aggregation_column) {
            selectExpr = 'COUNT(*) as result';
          } else if (!aggregation_column) {
            return structuredError({
              error: `aggregation_column is required for ${aggregation}`,
              valid_columns: at.numericCols,
            });
          } else {
            if (!at.numericCols.includes(aggregation_column)) {
              return structuredError({
                error: `Invalid aggregation_column '${aggregation_column}' for table '${tableName}'`,
                valid_columns: at.numericCols,
                did_you_mean: didYouMean(aggregation_column, at.numericCols),
              });
            }
            const qiCol = dialect.quoteIdent(aggregation_column);
            selectExpr =
              `${aggregation.toUpperCase()}(${qiCol}) as result,` +
              ` COUNT(*) as count_total,` +
              ` COUNT(${qiCol}) as count_non_null`;
          }

          let groupByClause = '';
          let selectPrefix = '';
          if (group_by) {
            if (!at.groupableColumns.includes(group_by)) {
              return structuredError({
                error: `Invalid group_by '${group_by}' for table '${tableName}'`,
                valid_columns: at.groupableColumns,
                did_you_mean: didYouMean(group_by, at.groupableColumns),
              });
            }
            // group_by_bucket wraps the column in a date-truncation expression
            // so the GROUP BY collapses on the start of each period (day/week/
            // month/quarter/year). Emitted both in the SELECT prefix and the
            // GROUP BY clause, aliased to the bare column name so the result
            // shape stays identical regardless of bucketing.
            const colExpr = group_by_bucket
              ? dateBucketExpr(dialect, group_by_bucket, dialect.quoteIdent(group_by))
              : dialect.quoteIdent(group_by);
            const groupAlias = dialect.quoteIdent(group_by);
            selectPrefix = group_by_bucket
              ? `${colExpr} as ${groupAlias}, `
              : `${colExpr}, `;
            groupByClause = `GROUP BY ${colExpr}`;
          }

          // Optional second GROUP BY column for two-dimensional pivots.
          // Validated against the same allowlist as the primary; appended to
          // the SELECT prefix and GROUP BY clause when both are present.
          if (group_by_secondary) {
            if (!group_by) {
              return structuredError({
                error: '`group_by_secondary` requires `group_by` to be set',
              });
            }
            if (!at.groupableColumns.includes(group_by_secondary)) {
              return structuredError({
                error: `Invalid group_by_secondary '${group_by_secondary}' for table '${tableName}'`,
                valid_columns: at.groupableColumns,
                did_you_mean: didYouMean(group_by_secondary, at.groupableColumns),
              });
            }
            const secCol = dialect.quoteIdent(group_by_secondary);
            selectPrefix = selectPrefix + `${secCol}, `;
            groupByClause = `${groupByClause}, ${secCol}`;
          }

          let havingClause = '';
          if (group_by && typeof having_min_total === 'number' && having_min_total > 0) {
            values.push(having_min_total);
            havingClause = `HAVING COUNT(*) >= ${dialect.param(paramCursor++)}`;
          }

          let orderByClause = '';
          if (order_by) {
            const isResultAlias = order_by === 'result';
            if (!isResultAlias && !at.allColumnNames.includes(order_by)) {
              return structuredError({
                error: `Invalid order_by '${order_by}' for table '${tableName}'`,
                valid_columns: [...at.allColumnNames, 'result'],
                did_you_mean: didYouMean(order_by, [...at.allColumnNames, 'result']),
              });
            }
            const dir = order_direction === 'desc' ? 'DESC' : 'ASC';
            const target = isResultAlias ? 'result' : dialect.quoteIdent(order_by);
            orderByClause = `ORDER BY ${target} ${dir}`;
          } else if (cappedOffset > 0) {
            // Pagination without an explicit ORDER BY yields non-deterministic
            // pages. Default to ORDER BY result DESC so successive pages are
            // consistent and sorted by the aggregate value (most common intent).
            orderByClause = 'ORDER BY result DESC';
          }

          // Validate top_n_per_group, then either compose a window-wrapped
          // query (when set) or use the plain GROUP BY query.
          let sql: string;
          if (top_n_per_group) {
            const partitionCols = [group_by, group_by_secondary].filter(Boolean) as string[];
            if (partitionCols.length === 0) {
              return structuredError({
                error: '`top_n_per_group` requires `group_by` (and optionally `group_by_secondary`) to be set',
              });
            }
            if (!partitionCols.includes(top_n_per_group.partition_by)) {
              return structuredError({
                error: `top_n_per_group.partition_by '${top_n_per_group.partition_by}' must be one of group_by columns`,
                valid_columns: partitionCols,
                did_you_mean: didYouMean(top_n_per_group.partition_by, partitionCols),
              });
            }
            const windowOrder = top_n_per_group.order_by;
            const isResultOrder = windowOrder === 'result';
            if (!isResultOrder && !at.allColumnNames.includes(windowOrder)) {
              return structuredError({
                error: `top_n_per_group.order_by '${windowOrder}' is not a valid column or 'result'`,
                valid_columns: [...at.allColumnNames, 'result'],
                did_you_mean: didYouMean(windowOrder, [...at.allColumnNames, 'result']),
              });
            }
            if (typeof top_n_per_group.n !== 'number' || top_n_per_group.n < 1) {
              return structuredError({ error: '`top_n_per_group.n` must be a positive integer' });
            }
            // SQL portability note: SQLite (and some MySQL versions) don't
            // resolve a SELECT-list alias (`result`) inside that same SELECT's
            // window ORDER BY clause. So we double-wrap: the innermost SELECT
            // does the GROUP BY and produces `result`, the middle layer adds
            // the ROW_NUMBER() referencing the now-stable alias, the outer
            // layer filters rn <= ? and applies the optional ORDER BY / LIMIT.
            const partitionExpr = dialect.quoteIdent(top_n_per_group.partition_by);
            const windowOrderExpr = isResultOrder ? 'result' : dialect.quoteIdent(windowOrder);
            const innerSql = `SELECT ${selectPrefix}${selectExpr} FROM ${qualifiedTable} ${whereClause} ${groupByClause} ${havingClause}`;
            const middleSql = `SELECT *, ROW_NUMBER() OVER (PARTITION BY ${partitionExpr} ORDER BY ${windowOrderExpr} DESC) AS rn FROM (${innerSql}) AS inner_q`;
            values.push(top_n_per_group.n);
            const rnParam = dialect.param(paramCursor++);
            values.push(cappedLimit);
            const limitParam = dialect.param(paramCursor++);
            values.push(cappedOffset);
            const offsetParam = dialect.param(paramCursor);
            sql = `SELECT * FROM (${middleSql}) AS sub WHERE rn <= ${rnParam} ${orderByClause} LIMIT ${limitParam} OFFSET ${offsetParam}`;
          } else {
            values.push(cappedLimit);
            const limitParam = dialect.param(paramCursor++);
            values.push(cappedOffset);
            const offsetParam = dialect.param(paramCursor);
            sql = `SELECT ${selectPrefix}${selectExpr} FROM ${qualifiedTable} ${whereClause} ${groupByClause} ${havingClause} ${orderByClause} LIMIT ${limitParam} OFFSET ${offsetParam}`;
          }
          // Period-over-period: validate, run current + previous in parallel,
          // then merge per group key and compute server-side deltas. Validated
          // upfront so we never run a doomed current query.
          if (compare_to) {
            if (top_n_per_group) {
              return structuredError({
                error: 'compare_to is not compatible with top_n_per_group in v1',
              });
            }
            const dateFilter = filters?.[compare_to.date_column];
            if (
              !dateFilter ||
              dateFilter.op !== 'between' ||
              !Array.isArray(dateFilter.value) ||
              (dateFilter.value as unknown[]).length !== 2
            ) {
              return structuredError({
                error: `compare_to requires a 'between' filter on '${compare_to.date_column}' with exactly 2 values`,
              });
            }
            const [startStr, endStr] = (dateFilter.value as unknown[]).map(String);
            const start = new Date(startStr);
            const end = new Date(endStr);
            if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
              return structuredError({
                error: `compare_to: invalid date format in between filter [${startStr}, ${endStr}]`,
              });
            }
            // Shift the window based on compare_to.period.
            let prevStart: Date;
            let prevEnd: Date;
            if (compare_to.period === 'previous_year') {
              // Same day/month, year minus 1.
              prevStart = new Date(start);
              prevStart.setUTCFullYear(prevStart.getUTCFullYear() - 1);
              prevEnd = new Date(end);
              prevEnd.setUTCFullYear(prevEnd.getUTCFullYear() - 1);
            } else if (compare_to.period === 'previous_calendar_month') {
              // Full calendar month immediately before the month of startDate.
              // e.g. startDate=2026-04-15 → prevStart=2026-03-01, prevEnd=2026-03-31
              const y = start.getUTCFullYear();
              const m = start.getUTCMonth(); // 0-indexed: 0=Jan … 11=Dec
              // Month before: if m===0, wrap to December of prior year.
              const prevMonth = m === 0 ? 11 : m - 1;
              const prevYear = m === 0 ? y - 1 : y;
              prevStart = new Date(Date.UTC(prevYear, prevMonth, 1));
              // Last day of prevMonth: day 0 of the following month.
              prevEnd = new Date(Date.UTC(prevYear, prevMonth + 1, 0));
            } else if (compare_to.period === 'previous_calendar_quarter') {
              // Full calendar quarter before the quarter that contains startDate.
              // Quarters: Q1=Jan-Mar(0-2), Q2=Apr-Jun(3-5), Q3=Jul-Sep(6-8), Q4=Oct-Dec(9-11)
              const y = start.getUTCFullYear();
              const m = start.getUTCMonth(); // 0-indexed
              const currentQuarter = Math.floor(m / 3); // 0=Q1,1=Q2,2=Q3,3=Q4
              const prevQuarter = currentQuarter === 0 ? 3 : currentQuarter - 1;
              const prevQYear = currentQuarter === 0 ? y - 1 : y;
              const prevQStartMonth = prevQuarter * 3; // 0, 3, 6, or 9
              const prevQEndMonth = prevQStartMonth + 2; // 2, 5, 8, or 11
              prevStart = new Date(Date.UTC(prevQYear, prevQStartMonth, 1));
              // Last day of prevQEndMonth.
              prevEnd = new Date(Date.UTC(prevQYear, prevQEndMonth + 1, 0));
            } else if (compare_to.period === 'previous_calendar_year') {
              // Full calendar year before the year of startDate (Jan 1 – Dec 31).
              const prevYear = start.getUTCFullYear() - 1;
              prevStart = new Date(Date.UTC(prevYear, 0, 1));
              prevEnd = new Date(Date.UTC(prevYear, 11, 31));
            } else {
              // previous_period: same duration, ending 1ms before current start.
              const durationMs = end.getTime() - start.getTime();
              prevEnd = new Date(start.getTime() - 1);
              prevStart = new Date(prevEnd.getTime() - durationMs);
            }
            // Format back to YYYY-MM-DD for consistency with typical date columns
            // (date_creation, date_tournee, etc. are stored as ISO date strings).
            const fmt = (d: Date): string => d.toISOString().slice(0, 10);
            const prevStartStr = fmt(prevStart);
            const prevEndStr = fmt(prevEnd);

            // Build prev filters by cloning + replacing the date_column entry
            const prevFilters: Record<string, FilterValue | undefined> = { ...(filters ?? {}) };
            prevFilters[compare_to.date_column] = {
              op: 'between',
              value: [prevStartStr, prevEndStr],
            };
            const prevWhere = scopeGuard.buildWhereClause(
              tableName,
              prevFilters,
              allowedFilterColumns,
              dialect,
            );
            if (prevWhere.values.length !== whereValueCount) {
              return structuredError({
                error: 'compare_to: previous WHERE clause produced a different number of params than current — likely an internal bug',
              });
            }
            const prevValues = [...prevWhere.values, ...values.slice(whereValueCount)];

            // Run current + previous in parallel.
            const [curResult, prevResult] = await Promise.all([
              exec(sql, values),
              exec(sql, prevValues),
            ]);

            // When group_by_bucket is active the previous rows carry bucket dates
            // in the previous period (e.g. "2024-01" for January 2024 vs "2025-01"
            // for January 2025). Shift them forward so they align with current
            // bucket keys before the merge step.
            const shiftBucketDate = (
              value: unknown,
              period:
                | 'previous_year'
                | 'previous_period'
                | 'previous_calendar_month'
                | 'previous_calendar_quarter'
                | 'previous_calendar_year',
              durationMs: number,
            ): unknown => {
              if (typeof value !== 'string') return value;
              const d = new Date(value);
              if (Number.isNaN(d.getTime())) return value;
              if (period === 'previous_year' || period === 'previous_calendar_year') {
                d.setUTCFullYear(d.getUTCFullYear() + 1);
                return d.toISOString().slice(0, 10);
              } else if (period === 'previous_calendar_quarter') {
                const shifted = new Date(d);
                shifted.setUTCMonth(shifted.getUTCMonth() + 3);
                return shifted.toISOString().slice(0, 10);
              } else if (period === 'previous_calendar_month') {
                const shifted = new Date(d);
                shifted.setUTCMonth(shifted.getUTCMonth() + 1);
                return shifted.toISOString().slice(0, 10);
              } else {
                return new Date(d.getTime() + durationMs).toISOString().slice(0, 10);
              }
            };

            const durationMs = end.getTime() - start.getTime();
            const normalizedPrevRows: Record<string, unknown>[] =
              group_by_bucket && group_by
                ? prevResult.rows.map((row) => ({
                    ...row,
                    [group_by]: shiftBucketDate(row[group_by], compare_to.period, durationMs),
                  }))
                : prevResult.rows;

            // Merge: align by group keys, compute deltas.
            const groupKeys = [group_by, group_by_secondary].filter(Boolean) as string[];
            const keyOf = (row: Record<string, unknown>): string =>
              groupKeys.length === 0
                ? '__single__'
                : groupKeys.map((k) => `${k}=${String(row[k] ?? '')}`).join('|');
            const prevByKey = new Map<string, Record<string, unknown>>();
            for (const r of normalizedPrevRows) prevByKey.set(keyOf(r), r);
            const merged: Record<string, unknown>[] = [];
            for (const r of curResult.rows) {
              const k = keyOf(r);
              const p = prevByKey.get(k);
              const cur = typeof r.result === 'number' ? r.result : Number(r.result ?? 0);
              const prev = p && typeof p.result === 'number' ? p.result : Number(p?.result ?? 0);
              const deltaAbs = cur - prev;
              const deltaPct = prev !== 0 ? deltaAbs / prev : null;
              merged.push({
                ...r,
                previous: p?.result ?? 0,
                delta_abs: deltaAbs,
                delta_pct: deltaPct,
              });
              prevByKey.delete(k);
            }
            // Surface previous-only groups (had data in prev window, none in current)
            for (const [, p] of prevByKey) {
              const prev = typeof p.result === 'number' ? p.result : Number(p.result ?? 0);
              merged.push({ ...p, result: 0, previous: prev, delta_abs: -prev, delta_pct: -1 });
            }

            const payload = {
              current_window: [startStr, endStr],
              previous_window: [prevStartStr, prevEndStr],
              compare_to_period: compare_to.period,
              rows: formatResponseRows(merged, at.labelMap, responseMode),
            };
            const text = wrapResponse(JSON.stringify(payload, null, 2));
            return {
              content: [{ type: 'text' as const, text }],
              resultSummary: `${merged.length} rows (cur + prev merged)`,
              resultData: text,
            };
          }

          const result = await exec(sql, values);

          const formattedRows = formatResponseRows(result.rows, at.labelMap, responseMode);
          const text = wrapResponse(JSON.stringify(formattedRows, null, 2));
          return {
            content: [{ type: 'text' as const, text }],
            resultSummary: `${result.rows.length} rows`,
            resultData: text,
          };
        },
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Generic `join_aggregate` tool — INNER JOIN of two FK-linked tables with
// count/sum/avg/min/max + optional GROUP BY. Lets the LLM answer cross-table
// analytical questions ("top couriers by delivered package count") in a
// single call instead of paginating two per-table aggregates and merging
// client-side. Restricted to tables linked by a declared FK so the SQL is
// always sound.
// ---------------------------------------------------------------------------

function registerJoinAggregateGeneric(
  ctx: ToolContext,
  accessible: AccessibleTable[],
  allRelations: Relation[],
): void {
  const { server, executeQuery, dialect, onAuditLog, profileName, responseMode, wrapResponse, maxOffset, scopeGuard, toolName } = ctx;

  // Only tables where aggregate is enabled. Disabling aggregate on a table
  // must also block joins against it.
  const eligible = accessible.filter(at => at.enabledTools.includes('aggregate'));
  if (eligible.length < 2) return;

  // Restrict the table enum to tables that have at least one FK pointing to
  // (or coming from) another eligible table. No FK -> no JOIN possible.
  const eligibleNames = new Set(eligible.map(at => at.table.name));
  // Relations restricted to eligible tables only
  const eligibleRelations = allRelations.filter(
    (r) => eligibleNames.has(r.fromTable) && eligibleNames.has(r.toTable),
  );
  const joinable = computeTransitiveClosure([...eligibleNames], eligibleRelations, 3);
  if (joinable.size < 2) return;

  const tableEnum = zodEnum([...joinable]);
  if (!tableEnum) return;

  // Lookup helpers
  const byName = new Map<string, AccessibleTable>();
  for (const at of eligible) byName.set(at.table.name, at);

  const inputShape: Record<string, z.ZodTypeAny> = {
    primary_table: tableEnum.describe('Left side of the JOIN.'),
    join_table: tableEnum.describe('Right side of the JOIN. Does NOT need to be directly FK-linked to primary_table — the system auto-resolves the FK path through intermediate tables (up to 3 hops). Example: primary=colis, join=zone works even if the FK chain is colis→livreur→zone.'),
    aggregation: z
      .enum(AGG_OPS_JOIN)
      .describe(
        'count|sum|avg|min|max: standard SQL. ' +
          'ratio: conditional ratio across the JOIN — ratio_filter defines the numerator, filters/join_filters define the denominator population; ' +
          'specify ratio_filter_table to indicate which JOIN side ratio_filter applies to (default: primary). ' +
          'count_distinct: COUNT(DISTINCT aggregation_column) on the side given by aggregation_column_table. ' +
          'weighted_ratio: SUM(numerator_column)/SUM(denominator_column) on that same side. ' +
          'median|stddev|variance|percentile: statistical aggregations — require PostgreSQL.',
      ),
    aggregation_column: z
      .string()
      .optional()
      .describe('Required for sum/avg/min/max/count_distinct/median/stddev/variance/percentile. Col from aggregation_column_table side.'),
    numerator_column: z.string().optional().describe('Numeric numerator col for weighted_ratio.'),
    denominator_column: z.string().optional().describe('Numeric denominator col for weighted_ratio.'),
    ratio_filter: makeFilterMapSchema().describe('Numerator filter for ratio aggregation. Columns belong to ratio_filter_table side. Same shape as filters.'),
    ratio_filter_table: z
      .enum(['primary', 'join'])
      .optional()
      .describe('Which JOIN side ratio_filter columns belong to (default: primary).'),
    percentile_p: z
      .number()
      .min(0.01)
      .max(0.99)
      .optional()
      .describe('Required when aggregation is "percentile". Value between 0.01 and 0.99 (e.g. 0.95 for p95).'),
    aggregation_column_table: z
      .enum(['primary', 'join'])
      .optional()
      .default('primary')
      .describe('Which JOIN side the aggregation column(s) belong to.'),
    filters: makeFilterMapSchema().describe('Filters on primary_table.'),
    join_filters: makeFilterMapSchema().describe('Filters on join_table.'),
    group_by_column: z.string().optional().describe('GROUP BY column.'),
    group_by_table: z
      .enum(['primary', 'join'])
      .optional()
      .default('primary')
      .describe('Which JOIN side group_by_column belongs to.'),
    group_by_bucket: z
      .enum(DATE_BUCKETS)
      .optional()
      .describe('Date truncation granularity for group_by_column (DATE_TRUNC).'),
    group_by_secondary_column: z
      .string()
      .optional()
      .describe('Second GROUP BY column for 2D cross-table pivots. Does not support date bucketing.'),
    group_by_secondary_table: z
      .enum(['primary', 'join'])
      .optional()
      .default('primary')
      .describe('Which JOIN side group_by_secondary_column belongs to.'),
    order_direction: z.enum(ORDER_DIRS).optional().describe('Sort by aggregate result.'),
    limit: z.number().optional().default(20).describe('Max rows (≤1000).'),
    offset: z
      .number()
      .optional()
      .default(0)
      .describe('Skip first N grouped rows. Use with limit for pagination beyond 1000 groups.'),
  };

  const desc =
    'Cross-table analytics: aggregate over a JOIN of two tables when you need columns from BOTH sides (e.g. count colis grouped by livreur.nom, or sum revenue grouped by zone.region). ' +
    'Auto-resolves FK chains up to 3 hops — intermediate tables handled automatically. ' +
    'Supports count/sum/avg/min/max/ratio + up to two GROUP BY dimensions (group_by_column + group_by_secondary_column) for 2D pivots. ' +
    'Do NOT use this for single-table aggregations — use aggregate instead. ' +
    'Statistical aggregations (median, stddev, variance, percentile) require PostgreSQL. ' +
    'When counting or ranking individuals (persons, drivers, customers...), group by their unique `id` column — name columns (nom, prenom, name) are rarely unique and will merge records with identical names.\n\n' +
    'Key advanced params with examples:\n' +
    '- ratio + ratio_filter: {aggregation: "ratio", ratio_filter: {"statut": {"op": "eq", "value": "livre"}}, ratio_filter_table: "primary"} → delivery rate cross-table in one call\n' +
    '- group_by_secondary_column: 2D pivot across both JOIN sides (e.g. livreur × zone)\n' +
    '- weighted_ratio: SUM(numerator_column)/SUM(denominator_column) on same JOIN side';

  server.tool(
    toolName('join_aggregate'),
    desc,
    inputShape as AnyToolArgs,
    async (args: Record<string, unknown>) => {
      const {
        primary_table,
        join_table,
        aggregation,
        aggregation_column,
        numerator_column,
        denominator_column,
        percentile_p,
        aggregation_column_table = 'primary',
        filters,
        join_filters,
        ratio_filter,
        ratio_filter_table = 'primary',
        group_by_column,
        group_by_table = 'primary',
        group_by_bucket,
        group_by_secondary_column,
        group_by_secondary_table = 'primary',
        order_direction,
        limit,
        offset,
      } = args as {
        primary_table: string;
        join_table: string;
        aggregation: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'ratio' | 'count_distinct' | 'weighted_ratio' | 'median' | 'stddev' | 'variance' | 'percentile';
        aggregation_column?: string;
        numerator_column?: string;
        denominator_column?: string;
        percentile_p?: number;
        aggregation_column_table?: 'primary' | 'join';
        filters?: Record<string, FilterValue | undefined>;
        join_filters?: Record<string, FilterValue | undefined>;
        ratio_filter?: Record<string, FilterValue | undefined>;
        ratio_filter_table?: 'primary' | 'join';
        group_by_column?: string;
        group_by_table?: 'primary' | 'join';
        group_by_bucket?: DateBucket;
        group_by_secondary_column?: string;
        group_by_secondary_table?: 'primary' | 'join';
        order_direction?: 'asc' | 'desc';
        limit?: number;
        offset?: number;
      };

      return executeWithAudit(
        { executeQuery, dialect, onAuditLog, profileName, toolName: toolName('join_aggregate'), toolArgs: args },
        async (exec) => {
          if (typeof primary_table !== 'string' || typeof join_table !== 'string') {
            return structuredError({
              error: 'Both `primary_table` and `join_table` are required',
              valid_tables: [...joinable],
            });
          }
          if (primary_table === join_table) {
            return structuredError({ error: 'primary_table and join_table must be different' });
          }
          const pAt = byName.get(primary_table);
          const jAt = byName.get(join_table);
          if (!pAt || !joinable.has(primary_table)) {
            return structuredError({
              error: `Table '${primary_table}' is not joinable in this profile`,
              valid_tables: [...joinable],
              did_you_mean: didYouMean(primary_table, [...joinable]),
            });
          }
          if (!jAt || !joinable.has(join_table)) {
            return structuredError({
              error: `Table '${join_table}' is not joinable in this profile`,
              valid_tables: [...joinable],
              did_you_mean: didYouMean(join_table, [...joinable]),
            });
          }

          const joinPath = findJoinPath(primary_table, join_table, eligibleRelations, 3);
          if (!joinPath || joinPath.length === 0) {
            return structuredError({
              error: `No FK join path found between '${primary_table}' and '${join_table}' within 3 hops`,
              hint: 'Ensure tables are linked by foreign keys. Use list_tables to see available tables.',
            });
          }

          // Build alias map: primary_table = t0, intermediates = t1..tN-1, join_table = tN
          const allTablesInPath = [
            primary_table,
            ...joinPath.slice(0, -1).map((h) => h.toTable),
            join_table,
          ];
          // Deduplicate while preserving order
          const uniqueTablesInPath = [
            ...new Map(allTablesInPath.map((t, i) => [t, i] as [string, number])).entries(),
          ]
            .sort((a, b) => a[1] - b[1])
            .map(([t]) => t);

          const aliasOf = new Map<string, string>(uniqueTablesInPath.map((t, i) => [t, `t${i}`]));
          const pAlias = aliasOf.get(primary_table)!; // t0
          const jAlias = aliasOf.get(join_table)!; // tN

          // Resolve aggregation target.
          const aggAt = aggregation_column_table === 'join' ? jAt : pAt;
          const aggAlias = aggregation_column_table === 'join' ? jAlias : pAlias;
          const aggTableName = aggregation_column_table === 'join' ? join_table : primary_table;

          // For ratio aggregation, we pre-build the CASE WHEN conditions before
          // the WHERE clause so we can assign their parameter indices first.
          // The ratio_filter values are pushed ahead of WHERE filter values so
          // that buildPrefixedFilters (which starts at paramIndex=1) is offset
          // by the number of pre-pushed ratio values.
          const ratioPreValues: unknown[] = [];
          let ratioSelectExpr: string | null = null;
          if (aggregation === 'ratio') {
            if (!ratio_filter || Object.keys(ratio_filter).length === 0) {
              return structuredError({ error: 'ratio_filter is required for aggregation: "ratio"' });
            }
            const rfAt = ratio_filter_table === 'join' ? jAt : pAt;
            const rfAlias = ratio_filter_table === 'join' ? jAlias : pAlias;
            const rfTableName = ratio_filter_table === 'join' ? join_table : primary_table;
            const rfAllowed = rfAt.filterableCols.map((c) => c.name);
            // Build ratio conditions twice (two CASE WHEN occurrences, each with
            // its own positional placeholders — mirrors the approach in aggregate).
            let ratioParamCursor = 1;
            const firstConditions: string[] = [];
            for (const [col, filter] of Object.entries(ratio_filter)) {
              if (!filter) continue;
              if (!rfAllowed.includes(col)) {
                return structuredError({
                  error: `ratio_filter column '${col}' is not filterable for table '${rfTableName}'`,
                  valid_columns: rfAllowed,
                  did_you_mean: didYouMean(col, rfAllowed),
                });
              }
              const qi = `${rfAlias}.${dialect.quoteIdent(col)}`;
              if (filter.op === 'eq') {
                firstConditions.push(`${qi} = ${dialect.param(ratioParamCursor++)}`);
                ratioPreValues.push(filter.value);
              } else if (filter.op === 'neq') {
                firstConditions.push(`${qi} != ${dialect.param(ratioParamCursor++)}`);
                ratioPreValues.push(filter.value);
              } else if (filter.op === 'gt') {
                firstConditions.push(`${qi} > ${dialect.param(ratioParamCursor++)}`);
                ratioPreValues.push(filter.value);
              } else if (filter.op === 'gte') {
                firstConditions.push(`${qi} >= ${dialect.param(ratioParamCursor++)}`);
                ratioPreValues.push(filter.value);
              } else if (filter.op === 'lt') {
                firstConditions.push(`${qi} < ${dialect.param(ratioParamCursor++)}`);
                ratioPreValues.push(filter.value);
              } else if (filter.op === 'lte') {
                firstConditions.push(`${qi} <= ${dialect.param(ratioParamCursor++)}`);
                ratioPreValues.push(filter.value);
              } else if (filter.op === 'is_null') {
                firstConditions.push(`${qi} IS NULL`);
              } else if (filter.op === 'is_not_null') {
                firstConditions.push(`${qi} IS NOT NULL`);
              } else {
                return structuredError({
                  error: `ratio_filter op '${filter.op}' is not supported for ratio — use eq, neq, gt, gte, lt, lte, is_null, is_not_null`,
                });
              }
            }
            if (firstConditions.length === 0) {
              return structuredError({ error: 'ratio_filter has no usable conditions' });
            }
            // Second occurrence — same conditions, new parameter indices.
            const secondConditions: string[] = [];
            for (const [col, filter] of Object.entries(ratio_filter)) {
              if (!filter) continue;
              const qi = `${rfAlias}.${dialect.quoteIdent(col)}`;
              if (filter.op === 'eq') {
                secondConditions.push(`${qi} = ${dialect.param(ratioParamCursor++)}`);
                ratioPreValues.push(filter.value);
              } else if (filter.op === 'neq') {
                secondConditions.push(`${qi} != ${dialect.param(ratioParamCursor++)}`);
                ratioPreValues.push(filter.value);
              } else if (filter.op === 'gt') {
                secondConditions.push(`${qi} > ${dialect.param(ratioParamCursor++)}`);
                ratioPreValues.push(filter.value);
              } else if (filter.op === 'gte') {
                secondConditions.push(`${qi} >= ${dialect.param(ratioParamCursor++)}`);
                ratioPreValues.push(filter.value);
              } else if (filter.op === 'lt') {
                secondConditions.push(`${qi} < ${dialect.param(ratioParamCursor++)}`);
                ratioPreValues.push(filter.value);
              } else if (filter.op === 'lte') {
                secondConditions.push(`${qi} <= ${dialect.param(ratioParamCursor++)}`);
                ratioPreValues.push(filter.value);
              } else if (filter.op === 'is_null') {
                secondConditions.push(`${qi} IS NULL`);
              } else if (filter.op === 'is_not_null') {
                secondConditions.push(`${qi} IS NOT NULL`);
              }
            }
            const caseFirst = `CASE WHEN ${firstConditions.join(' AND ')} THEN 1 ELSE 0 END`;
            const caseSecond = `CASE WHEN ${secondConditions.join(' AND ')} THEN 1 ELSE 0 END`;
            ratioSelectExpr =
              `AVG(1.0 * (${caseFirst})) as result,` +
              ` SUM(${caseSecond}) as numerator,` +
              ` COUNT(*) as denominator`;
          }

          let selectExpr: string;
          if (aggregation === 'ratio') {
            // ratioSelectExpr was built above; guaranteed non-null here.
            selectExpr = ratioSelectExpr!;
          } else if (aggregation === 'weighted_ratio') {
            // SUM(num)/SUM(den) on the same JOIN side. Both columns must
            // belong to the table indicated by `aggregation_column_table`.
            if (!numerator_column || !denominator_column) {
              return structuredError({
                error: 'weighted_ratio requires both `numerator_column` and `denominator_column`',
                valid_columns: aggAt.numericCols,
              });
            }
            if (!aggAt.numericCols.includes(numerator_column)) {
              return structuredError({
                error: `Invalid numerator_column '${numerator_column}' for table '${aggTableName}'`,
                valid_columns: aggAt.numericCols,
                did_you_mean: didYouMean(numerator_column, aggAt.numericCols),
              });
            }
            if (!aggAt.numericCols.includes(denominator_column)) {
              return structuredError({
                error: `Invalid denominator_column '${denominator_column}' for table '${aggTableName}'`,
                valid_columns: aggAt.numericCols,
                did_you_mean: didYouMean(denominator_column, aggAt.numericCols),
              });
            }
            const qiNum = `${aggAlias}.${dialect.quoteIdent(numerator_column)}`;
            const qiDen = `${aggAlias}.${dialect.quoteIdent(denominator_column)}`;
            selectExpr =
              `(1.0 * SUM(${qiNum}) / NULLIF(SUM(${qiDen}), 0)) as result,` +
              ` SUM(${qiNum}) as numerator,` +
              ` SUM(${qiDen}) as denominator`;
          } else if (aggregation === 'count_distinct') {
            // COUNT(DISTINCT alias.col) — works on any column on the chosen side.
            if (!aggregation_column) {
              return structuredError({
                error: 'aggregation_column is required for count_distinct',
                valid_columns: aggAt.allColumnNames,
              });
            }
            if (!aggAt.allColumnNames.includes(aggregation_column)) {
              return structuredError({
                error: `Invalid aggregation_column '${aggregation_column}' for count_distinct on table '${aggTableName}'`,
                valid_columns: aggAt.allColumnNames,
                did_you_mean: didYouMean(aggregation_column, aggAt.allColumnNames),
              });
            }
            selectExpr = `COUNT(DISTINCT ${aggAlias}.${dialect.quoteIdent(aggregation_column)}) as result`;
          } else if (aggregation === 'median' || aggregation === 'percentile' || aggregation === 'stddev' || aggregation === 'variance') {
            // Statistical aggregations — require aggregation_column (numeric).
            if (!aggregation_column) {
              return structuredError({
                error: `aggregation_column is required for ${aggregation}`,
                valid_columns: aggAt.numericCols,
              });
            }
            if (!aggAt.numericCols.includes(aggregation_column)) {
              return structuredError({
                error: `Invalid aggregation_column '${aggregation_column}' for table '${aggTableName}'`,
                valid_columns: aggAt.numericCols,
                did_you_mean: didYouMean(aggregation_column, aggAt.numericCols),
              });
            }
            const statCol = `${aggAlias}.${dialect.quoteIdent(aggregation_column)}`;
            if (aggregation === 'median') {
              const expr = dialect.medianExpr(statCol);
              if (!expr) {
                return structuredError({
                  error: `median is not supported on ${dialect.databaseType} — use PostgreSQL for advanced statistical aggregations`,
                });
              }
              selectExpr = `${expr} as result`;
            } else if (aggregation === 'percentile') {
              if (percentile_p == null) {
                return structuredError({
                  error: 'percentile_p is required when aggregation is "percentile" (e.g. 0.95 for p95)',
                });
              }
              const expr = dialect.percentileExpr(statCol, percentile_p);
              if (!expr) {
                return structuredError({
                  error: `percentile is not supported on ${dialect.databaseType} — use PostgreSQL for advanced statistical aggregations`,
                });
              }
              selectExpr = `${expr} as result`;
            } else if (aggregation === 'stddev') {
              const expr = dialect.stddevExpr(statCol);
              if (!expr) {
                return structuredError({
                  error: `stddev is not supported on ${dialect.databaseType} — use PostgreSQL or MySQL for standard deviation`,
                });
              }
              selectExpr = `${expr} as result`;
            } else {
              // variance
              const expr = dialect.varianceExpr(statCol);
              if (!expr) {
                return structuredError({
                  error: `variance is not supported on ${dialect.databaseType} — use PostgreSQL or MySQL for variance`,
                });
              }
              selectExpr = `${expr} as result`;
            }
          } else if (aggregation === 'count' && !aggregation_column) {
            selectExpr = 'COUNT(*) as result';
          } else if (!aggregation_column) {
            return structuredError({
              error: `aggregation_column is required for ${aggregation}`,
              valid_columns: aggAt.numericCols,
            });
          } else {
            if (!aggAt.numericCols.includes(aggregation_column)) {
              return structuredError({
                error: `Invalid aggregation_column '${aggregation_column}' for table '${aggTableName}'`,
                valid_columns: aggAt.numericCols,
                did_you_mean: didYouMean(aggregation_column, aggAt.numericCols),
              });
            }
            selectExpr = `${aggregation.toUpperCase()}(${aggAlias}.${dialect.quoteIdent(aggregation_column)}) as result`;
          }

          // Resolve GROUP BY target.
          let selectPrefix = '';
          let groupByClause = '';
          let groupByOriginal: { table: string; column: string } | null = null;
          let groupBySecondaryOriginal: { table: string; column: string } | null = null;
          if (group_by_column) {
            const gbAt = group_by_table === 'join' ? jAt : pAt;
            const gbAlias = group_by_table === 'join' ? jAlias : pAlias;
            const gbTableName = group_by_table === 'join' ? join_table : primary_table;
            if (!gbAt.groupableColumns.includes(group_by_column)) {
              return structuredError({
                error: `Invalid group_by_column '${group_by_column}' for table '${gbTableName}'`,
                valid_columns: gbAt.groupableColumns,
                did_you_mean: didYouMean(group_by_column, gbAt.groupableColumns),
              });
            }
            const qualified = `${gbAlias}.${dialect.quoteIdent(group_by_column)}`;
            // group_by_bucket wraps the column in a date-truncation expression
            // so the GROUP BY collapses on each period start. Aliased to the
            // bare column name so the result key stays the same regardless of
            // bucketing — also disambiguates from a same-named column on the
            // other side of the JOIN.
            const colExpr = group_by_bucket
              ? dateBucketExpr(dialect, group_by_bucket, qualified)
              : qualified;
            selectPrefix = `${colExpr} as ${dialect.quoteIdent(group_by_column)}, `;
            groupByClause = `GROUP BY ${colExpr}`;
            groupByOriginal = { table: gbTableName, column: group_by_column };
          }

          // Resolve secondary GROUP BY target (no date bucketing supported).
          if (group_by_secondary_column) {
            const gbAt2 = group_by_secondary_table === 'join' ? jAt : pAt;
            const gbAlias2 = group_by_secondary_table === 'join' ? jAlias : pAlias;
            const gbTableName2 = group_by_secondary_table === 'join' ? join_table : primary_table;
            if (!gbAt2.groupableColumns.includes(group_by_secondary_column)) {
              return structuredError({
                error: `Invalid group_by_secondary_column '${group_by_secondary_column}' for table '${gbTableName2}'`,
                valid_columns: gbAt2.groupableColumns,
                did_you_mean: didYouMean(group_by_secondary_column, gbAt2.groupableColumns),
              });
            }
            const qualified2 = `${gbAlias2}.${dialect.quoteIdent(group_by_secondary_column)}`;
            selectPrefix += `${qualified2} as ${dialect.quoteIdent(group_by_secondary_column)}, `;
            groupByClause =
              groupByClause.length > 0
                ? `${groupByClause}, ${qualified2}`
                : `GROUP BY ${qualified2}`;
            groupBySecondaryOriginal = { table: gbTableName2, column: group_by_secondary_column };
          }

          // Build WHERE — prefix every column with its alias so the JOIN is
          // unambiguous. Scope filters first (mandatory), then user filters.
          // When ratio aggregation is used, ratioPreValues are prepended so
          // their positional parameters ($1..$N) come before WHERE params.
          let paramIndex = 1 + ratioPreValues.length;
          const conditions: string[] = [];
          const values: unknown[] = [];
          const scopeInfo = scopeGuard.getScopeInfo();

          const buildPrefixedFilters = (
            tableName: string,
            alias: string,
            userFilters: Record<string, FilterValue | undefined> | undefined,
            allowed: string[],
          ): { ok: true } | { ok: false; payload: Record<string, unknown> } => {
            for (const sf of scopeInfo.filters.filter((f) => f.tableName === tableName)) {
              conditions.push(`${alias}.${dialect.quoteIdent(sf.column)} = ${dialect.param(paramIndex++)}`);
              values.push(sf.value);
            }
            if (!userFilters) return { ok: true };
            const allowedSet = new Set(allowed);
            for (const [col, filter] of Object.entries(userFilters)) {
              if (!filter) continue;
              if (!allowedSet.has(col)) {
                return {
                  ok: false,
                  payload: {
                    error: `Column '${col}' is not filterable for table '${tableName}'`,
                    valid_columns: allowed,
                    did_you_mean: didYouMean(col, allowed),
                  },
                };
              }
              const qi = `${alias}.${dialect.quoteIdent(col)}`;
              switch (filter.op) {
                case 'eq':
                  conditions.push(`${qi} = ${dialect.param(paramIndex++)}`);
                  values.push(filter.value);
                  break;
                case 'neq':
                  conditions.push(`${qi} != ${dialect.param(paramIndex++)}`);
                  values.push(filter.value);
                  break;
                case 'gt':
                  conditions.push(`${qi} > ${dialect.param(paramIndex++)}`);
                  values.push(filter.value);
                  break;
                case 'gte':
                  conditions.push(`${qi} >= ${dialect.param(paramIndex++)}`);
                  values.push(filter.value);
                  break;
                case 'lt':
                  conditions.push(`${qi} < ${dialect.param(paramIndex++)}`);
                  values.push(filter.value);
                  break;
                case 'lte':
                  conditions.push(`${qi} <= ${dialect.param(paramIndex++)}`);
                  values.push(filter.value);
                  break;
                case 'between': {
                  const [min, max] = filter.value as [unknown, unknown];
                  conditions.push(`${qi} >= ${dialect.param(paramIndex++)} AND ${qi} <= ${dialect.param(paramIndex++)}`);
                  values.push(min, max);
                  break;
                }
                case 'in': {
                  const raw = filter.value;
                  const arr: unknown[] = Array.isArray(raw)
                    ? raw
                    : typeof raw === 'string'
                      ? raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
                      : [raw];
                  if (arr.length === 0) {
                    conditions.push('1=0');
                    break;
                  }
                  if (dialect.isPostgres) {
                    conditions.push(`${qi} = ANY(${dialect.param(paramIndex++)})`);
                    values.push(arr);
                  } else {
                    const placeholders = arr.map(() => dialect.param(paramIndex++));
                    conditions.push(`${qi} IN (${placeholders.join(', ')})`);
                    values.push(...arr);
                  }
                  break;
                }
                case 'is_null':
                  conditions.push(`${qi} IS NULL`);
                  break;
                case 'is_not_null':
                  conditions.push(`${qi} IS NOT NULL`);
                  break;
              }
            }
            return { ok: true };
          };

          const r1 = buildPrefixedFilters(primary_table, pAlias, filters, pAt.filterableCols.map(c => c.name));
          if (!r1.ok) return structuredError(r1.payload);
          const r2 = buildPrefixedFilters(join_table, jAlias, join_filters, jAt.filterableCols.map(c => c.name));
          if (!r2.ok) return structuredError(r2.payload);

          // Apply scope filters for intermediate tables in the join path
          // (security: prevent scope bypass via multi-hop joins)
          for (const hop of joinPath.slice(0, -1)) {
            const intermediateTable = hop.toTable;
            if (intermediateTable === primary_table || intermediateTable === join_table) continue;
            const intermediateAlias = aliasOf.get(intermediateTable)!;
            try {
              scopeGuard.checkTableAccess(intermediateTable);
            } catch {
              return structuredError({
                error: `Intermediate table '${intermediateTable}' in join path is blocked by access rules`,
                join_path: uniqueTablesInPath,
              });
            }
            for (const sf of scopeInfo.filters.filter((f) => f.tableName === intermediateTable)) {
              conditions.push(`${intermediateAlias}.${dialect.quoteIdent(sf.column)} = ${dialect.param(paramIndex++)}`);
              values.push(sf.value);
            }
          }

          const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

          const cappedLimit = Math.min(limit ?? 20, 1000);
          const cappedOffset = Math.min(offset ?? 0, maxOffset ?? 10_000);

          // Pagination without ORDER BY yields non-deterministic pages. When
          // offset > 0 and no explicit order is given, default to ORDER BY
          // result DESC (most common intent: top groups first).
          const orderByClause = order_direction
            ? `ORDER BY result ${order_direction === 'desc' ? 'DESC' : 'ASC'}`
            : cappedOffset > 0
              ? 'ORDER BY result DESC'
              : '';

          values.push(cappedLimit);
          const limitParam = dialect.param(paramIndex++);
          values.push(cappedOffset);
          const offsetParam = dialect.param(paramIndex);

          const pSchema = pAt.table.schema || 'public';
          // Build FROM + all INNER JOINs for the multi-hop path
          let fromClause = `FROM ${dialect.quoteTable(pSchema, primary_table)} ${pAlias}`;
          for (const hop of joinPath) {
            const hopFromAlias = aliasOf.get(hop.fromTable)!;
            const hopToAlias = aliasOf.get(hop.toTable)!;
            const hopAt = byName.get(hop.toTable);
            const hopSchema = hopAt?.table.schema || 'public';
            fromClause +=
              ` INNER JOIN ${dialect.quoteTable(hopSchema, hop.toTable)} ${hopToAlias}` +
              ` ON ${hopFromAlias}.${dialect.quoteIdent(hop.fromColumn)} = ${hopToAlias}.${dialect.quoteIdent(hop.toColumn)}`;
          }

          const sql = `SELECT ${selectPrefix}${selectExpr} ${fromClause} ${whereClause} ${groupByClause} ${orderByClause} LIMIT ${limitParam} OFFSET ${offsetParam}`;

          // Prepend ratio pre-values so positional parameters align correctly:
          // ratio CASE WHEN params ($1..$K) must appear before WHERE params.
          const finalValues = ratioPreValues.length > 0 ? [...ratioPreValues, ...values] : values;
          const result = await exec(sql, finalValues);

          // Apply masking ONLY on the GROUP BY columns (aggregates are computed
          // numbers and don't carry PII).
          let rows = result.rows;
          if (groupByOriginal) {
            const at = byName.get(groupByOriginal.table)!;
            const colRule = at.maskingRules[groupByOriginal.column];
            if (colRule) rows = applyMasking(rows, { [groupByOriginal.column]: colRule });
          }
          if (groupBySecondaryOriginal) {
            const at2 = byName.get(groupBySecondaryOriginal.table)!;
            const colRule2 = at2.maskingRules[groupBySecondaryOriginal.column];
            if (colRule2) rows = applyMasking(rows, { [groupBySecondaryOriginal.column]: colRule2 });
          }

          // Friendly mode: surface human labels for the group-by columns.
          const labelMap: Record<string, string> = {};
          if (groupByOriginal) {
            const at = byName.get(groupByOriginal.table)!;
            if (at.labelMap[groupByOriginal.column]) {
              labelMap[groupByOriginal.column] = at.labelMap[groupByOriginal.column];
            }
          }
          if (groupBySecondaryOriginal) {
            const at2 = byName.get(groupBySecondaryOriginal.table)!;
            if (at2.labelMap[groupBySecondaryOriginal.column]) {
              labelMap[groupBySecondaryOriginal.column] = at2.labelMap[groupBySecondaryOriginal.column];
            }
          }
          const formattedRows = formatResponseRows(rows, labelMap, responseMode);

          const responseObj = {
            join_path: uniqueTablesInPath,
            rows: formattedRows,
          };
          const text = wrapResponse(JSON.stringify(responseObj, null, 2));
          return {
            content: [{ type: 'text' as const, text }],
            resultSummary: `${rows.length} rows`,
            resultData: text,
          };
        },
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Generic `query` tool.
// ---------------------------------------------------------------------------

function registerQueryGeneric(
  ctx: ToolContext,
  accessible: AccessibleTable[],
  catalogue: string,
): void {
  const { server, executeQuery, dialect, onAuditLog, profileName, responseMode, wrapResponse, maxOffset, scopeGuard, toolName } = ctx;

  const eligible = accessible.filter(at => at.enabledTools.includes('query') && at.allColumnNames.length > 0);
  if (eligible.length === 0) return;
  const tableEnum = zodEnum(eligible.map(at => at.table.name));
  if (!tableEnum) return;

  const inputShape: Record<string, z.ZodTypeAny> = {
    table: tableEnum.describe('Target table. See TABLES & COLUMNS.'),
    columns: z.array(z.string()).optional().describe('Columns to return (default: all visible).'),
    filters: makeFilterMapSchema().describe(`WHERE filters. ${FILTER_OPS_DESC}`),
    order_by: z.string().optional(),
    order_direction: z.enum(ORDER_DIRS).optional(),
    limit: z.number().optional().default(20).describe('Max rows (≤1000).'),
    offset: z.number().optional().default(0),
    sample: z.boolean().optional().describe('Return random rows.'),
  };

  const desc = `Fetch individual rows from any table with filters, ordering, and pagination. Use this to LIST or SEARCH records (e.g. find all colis for a client, show recent incidents). For counts, sums, averages, or grouped analytics — use aggregate or join_aggregate instead.\n\n${catalogue}`;

  server.tool(
    toolName('query'),
    desc,
    inputShape as AnyToolArgs,
    async (args: Record<string, unknown>) => {
      const resolved = resolveTable(args.table, accessible, 'query');
      if (!resolved.ok) return structuredError(resolved.payload);
      const at = resolved.at;

      const tableName = at.table.name;
      const schemaName = at.table.schema || 'public';
      const qualifiedTable = dialect.quoteTable(schemaName, tableName);
      const maxLimit = at.opts?.maxLimit ?? 1000;

      // aggregate_only mask excludes columns from query SELECT
      const queryExcludedCols = new Set<string>(at.excludedCols);
      if (at.tableMasking) {
        for (const [colName, m] of Object.entries(at.tableMasking)) {
          if (m.maskingMode === 'aggregate_only') queryExcludedCols.add(colName);
        }
      }
      const queryableColumnNames = at.allColumnNames.filter(c => !queryExcludedCols.has(c));
      const allowedFilterColumns = at.filterableCols
        .filter(c => !queryExcludedCols.has(c.name))
        .map(c => c.name);

      const queryMaskingRules: Record<string, MaskingRule> = {};
      for (const [col, rule] of Object.entries(at.maskingRules)) {
        if (rule.mode === 'hash' || rule.mode === 'truncate' || rule.mode === 'replace') {
          queryMaskingRules[col] = rule;
        }
      }
      const needsMasking = Object.keys(queryMaskingRules).length > 0;

      const { columns, filters, order_by, order_direction, limit, offset, sample } = args as {
        columns?: string[];
        filters?: Record<string, FilterValue | undefined>;
        order_by?: string;
        order_direction?: string;
        limit?: number;
        offset?: number;
        sample?: boolean;
      };

      return executeWithAudit(
        { executeQuery, dialect, onAuditLog, profileName, toolName: toolName('query'), toolArgs: args },
        async (exec) => {
          const cappedLimit = Math.min(limit ?? 20, maxLimit);
          const cappedOffset = Math.min(offset ?? 0, maxOffset);

          const { clause: whereClause, values, nextParamIndex } = scopeGuard.buildWhereClause(
            tableName,
            filters,
            allowedFilterColumns,
            dialect,
          );
          let paramIdx = nextParamIndex;

          let selectExpr: string;
          if (columns && columns.length > 0) {
            for (const c of columns) {
              if (!queryableColumnNames.includes(c)) {
                return structuredError({
                  error: `Invalid column '${c}' for table '${tableName}'`,
                  valid_columns: queryableColumnNames,
                  did_you_mean: didYouMean(c, queryableColumnNames),
                });
              }
            }
            selectExpr = columns.map(c => dialect.quoteIdent(c)).join(', ');
          } else {
            selectExpr = queryableColumnNames.map(c => dialect.quoteIdent(c)).join(', ');
          }

          let orderByClause = '';
          if (sample) {
            orderByClause = `ORDER BY ${dialect.random}`;
          } else if (order_by) {
            if (!queryableColumnNames.includes(order_by)) {
              return structuredError({
                error: `Invalid order_by '${order_by}' for table '${tableName}'`,
                valid_columns: queryableColumnNames,
                did_you_mean: didYouMean(order_by, queryableColumnNames),
              });
            }
            const dir = order_direction === 'desc' ? 'DESC' : 'ASC';
            orderByClause = `ORDER BY ${dialect.quoteIdent(order_by)} ${dir}`;
          }

          values.push(cappedLimit);
          const limitParam = dialect.param(paramIdx++);
          values.push(cappedOffset);
          const offsetParam = dialect.param(paramIdx);
          const sql = `SELECT ${selectExpr} FROM ${qualifiedTable} ${whereClause} ${orderByClause} LIMIT ${limitParam} OFFSET ${offsetParam}`;
          const result = await exec(sql, values);

          const maskedRows = needsMasking ? applyMasking(result.rows, queryMaskingRules) : result.rows;
          const formattedRows = formatResponseRows(maskedRows, at.labelMap, responseMode);

          // Zero-result hint: if filters returned 0 rows, fetch distinct values
          // for filtered text columns and surface as did-you-mean hints.
          let zeroResultHint = '';
          if (formattedRows.length === 0 && filters && Object.keys(filters).length > 0) {
            try {
              const filteredCols = Object.keys(filters).filter(k => filters[k] !== undefined);
              const textCols = filteredCols.filter(col => {
                const colInfo = at.visibleColumns.find(c => c.name === col);
                return colInfo && isTextType(colInfo.type);
              });
              const hints: string[] = [];
              const { clause: hintScope, values: hintVals } = scopeGuard.buildScopeOnlyWhereClause(
                tableName,
                dialect,
              );
              for (const col of textCols.slice(0, 5)) {
                const qi = dialect.quoteIdent(col);
                const notNull = `${qi} IS NOT NULL`;
                const where = hintScope ? `${hintScope} AND ${notNull}` : `WHERE ${notNull}`;
                const hintSql = `SELECT DISTINCT ${qi} AS val FROM ${qualifiedTable} ${where} ORDER BY val LIMIT 30`;
                const r = await exec(hintSql, [...hintVals]);
                const vals = r.rows.map(row => String((row as Record<string, unknown>).val));
                if (vals.length > 0) hints.push(`Possible values for '${col}': ${vals.join(', ')}`);
              }
              if (hints.length > 0) {
                zeroResultHint = '\n\nNo results. ' + hints.join('. ') + '. Retry with one of these exact values.';
              }
            } catch {
              // Non-critical
            }
          }

          const text = wrapResponse(JSON.stringify(formattedRows, null, 2)) + zeroResultHint;
          return {
            content: [
              { type: 'text' as const, text },
            ],
            resultSummary: `${formattedRows.length} rows`,
            resultData: text,
          };
        },
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Generic `describe` tool. Returns runtime stats: row count, per-column null
// counts and distinct counts, low-cardinality distinct values (preferring the
// boot-cached set), text samples, numeric min/max/avg, and FK relations.
// ---------------------------------------------------------------------------

function registerDescribeGeneric(
  ctx: ToolContext,
  accessible: AccessibleTable[],
  distinctValuesByTable: Record<string, Record<string, unknown[]>>,
): void {
  const { server, executeQuery, dialect, onAuditLog, profileName, responseMode, wrapResponse, scopeGuard, toolName } = ctx;
  const friendly = responseMode === 'friendly';

  const eligible = accessible.filter(at => at.enabledTools.includes('describe'));
  if (eligible.length === 0) return;
  const tableEnum = zodEnum(eligible.map(at => at.table.name));
  if (!tableEnum) return;

  const inputShape: Record<string, z.ZodTypeAny> = {
    table: tableEnum.describe('Table to describe.'),
  };

  const desc = 'Explore a table schema at runtime: row count, column types, null rates, distinct counts, low-cardinality enum values, text samples, numeric min/max/avg, and FK relations to other tables. Call this when unsure about column names, valid values, or how tables relate.';

  server.tool(
    toolName('describe'),
    desc,
    inputShape as AnyToolArgs,
    async (args: Record<string, unknown>) => {
      const resolved = resolveTable(args.table, accessible, 'describe');
      if (!resolved.ok) return structuredError(resolved.payload);
      const at = resolved.at;

      const tableName = at.table.name;
      const schemaName = at.table.schema || 'public';
      const qualifiedTable = dialect.quoteTable(schemaName, tableName);
      const includeStats = at.enabledTools.includes('aggregate') || at.enabledTools.includes('query');
      const numericCols = includeStats ? at.numericCols : [];
      const textCols = includeStats ? at.visibleColumns.filter(c => isTextType(c.type)).map(c => c.name) : [];

      return executeWithAudit(
        { executeQuery, dialect, onAuditLog, profileName, toolName: toolName('describe'), toolArgs: args },
        async (exec) => {
          const { clause: scopeWhere, values: scopeValues } = scopeGuard.buildScopeOnlyWhereClause(
            tableName,
            dialect,
          );

          const countResult = await exec(
            `SELECT COUNT(*) as total FROM ${qualifiedTable} ${scopeWhere}`,
            scopeValues,
          );
          const rowCount = Number(countResult.rows[0].total);

          const numericStats: Record<string, { min: unknown; max: unknown; avg: unknown }> = {};
          const colStats: Record<string, { nullCount: number; distinctCount: number }> = {};
          const allColsForStats = includeStats ? at.visibleColumns : [];
          if (allColsForStats.length > 0) {
            const parts: string[] = [];
            for (const c of allColsForStats) {
              const qi = dialect.quoteIdent(c.name);
              parts.push(
                `SUM(CASE WHEN ${qi} IS NULL THEN 1 ELSE 0 END) as ${dialect.quoteIdent(`${c.name}__nulls`)}`,
                `COUNT(DISTINCT ${qi}) as ${dialect.quoteIdent(`${c.name}__distinct`)}`,
              );
            }
            for (const col of numericCols) {
              const qi = dialect.quoteIdent(col);
              parts.push(
                `MIN(${qi}) as ${dialect.quoteIdent(`${col}__min`)}`,
                `MAX(${qi}) as ${dialect.quoteIdent(`${col}__max`)}`,
                `AVG(${qi}) as ${dialect.quoteIdent(`${col}__avg`)}`,
              );
            }
            const statsResult = await exec(
              `SELECT ${parts.join(', ')} FROM ${qualifiedTable} ${scopeWhere}`,
              [...scopeValues],
            );
            const row = statsResult.rows[0] as Record<string, unknown>;
            for (const c of allColsForStats) {
              colStats[c.name] = {
                nullCount: Number(row[`${c.name}__nulls`] ?? 0),
                distinctCount: Number(row[`${c.name}__distinct`] ?? 0),
              };
            }
            for (const col of numericCols) {
              const key = friendly ? at.labelMap[col] ?? snakeCaseToLabel(col) : col;
              numericStats[key] = {
                min: row[`${col}__min`],
                max: row[`${col}__max`],
                avg: row[`${col}__avg`],
              };
            }
          }

          const MAX_ENUM = 20;
          const MAX_SAMPLE = 50;
          const distinctByCol: Record<string, unknown[]> = {};
          const sampleByCol: Record<string, string[] | undefined> = {};

          // Reuse the boot-time distinct values when available
          const cached = distinctValuesByTable[tableName] ?? {};
          for (const [col, vals] of Object.entries(cached)) {
            if (Array.isArray(vals) && vals.length > 0 && vals.length <= MAX_ENUM) {
              distinctByCol[col] = vals;
            }
          }

          for (const c of allColsForStats) {
            if (distinctByCol[c.name]) continue;
            const stats = colStats[c.name];
            if (!stats) continue;
            const distinct = stats.distinctCount;
            const isLowCardinality = distinct > 0 && distinct <= MAX_ENUM;
            const isSampleable = isTextType(c.type) && distinct > MAX_ENUM && distinct <= MAX_SAMPLE;
            if (!isLowCardinality && !isSampleable) continue;
            try {
              const qi = dialect.quoteIdent(c.name);
              const notNullCondition = `${qi} IS NOT NULL`;
              const valWhere = scopeWhere ? `${scopeWhere} AND ${notNullCondition}` : `WHERE ${notNullCondition}`;
              const cap = isLowCardinality ? MAX_ENUM : MAX_SAMPLE;
              const valSql = `SELECT DISTINCT ${qi} AS val FROM ${qualifiedTable} ${valWhere} ORDER BY val LIMIT ${cap + 1}`;
              const valResult = await exec(valSql, [...scopeValues]);
              const rawVals = valResult.rows.map((r) => (r as Record<string, unknown>).val);
              if (isLowCardinality) {
                let vals: unknown[] = rawVals;
                const colMaskRule = at.maskingRules[c.name];
                if (
                  colMaskRule &&
                  (colMaskRule.mode === 'hash' || colMaskRule.mode === 'truncate' || colMaskRule.mode === 'replace')
                ) {
                  vals = applyMasking(rawVals.map((v) => ({ [c.name]: v })), { [c.name]: colMaskRule }).map(
                    (r) => r[c.name],
                  );
                }
                distinctByCol[c.name] = vals;
              } else {
                let vals = rawVals.map((v) => String(v));
                const colMaskRule = at.maskingRules[c.name];
                if (
                  colMaskRule &&
                  (colMaskRule.mode === 'hash' || colMaskRule.mode === 'truncate' || colMaskRule.mode === 'replace')
                ) {
                  vals = applyMasking(vals.map((v) => ({ [c.name]: v })), { [c.name]: colMaskRule }).map((r) =>
                    String(r[c.name]),
                  );
                }
                if (vals.length <= MAX_SAMPLE) sampleByCol[c.name] = vals;
              }
            } catch {
              // Skip
            }
          }

          // Legacy textStats shape kept for backward compatibility
          const textStats: Record<string, { distinctCount: number; sampleValues?: string[] }> = {};
          for (const col of textCols) {
            const stats = colStats[col];
            if (!stats) continue;
            const key = friendly ? at.labelMap[col] ?? snakeCaseToLabel(col) : col;
            const sample = sampleByCol[col];
            const lowCardVals = distinctByCol[col];
            const sampleValues = sample
              ? sample
              : lowCardVals
                ? lowCardVals.map((v) => String(v))
                : undefined;
            textStats[key] = sampleValues
              ? { distinctCount: stats.distinctCount, sampleValues }
              : { distinctCount: stats.distinctCount };
          }

          const columnsMetadata = friendly
            ? at.visibleColumns.map(c => {
                const colMeta: Record<string, unknown> = {
                  name: at.labelMap[c.name] ?? snakeCaseToLabel(c.name),
                  column_name: c.name,
                  type: friendlyType(c.type),
                  required: !c.nullable,
                };
                if (distinctByCol[c.name]) colMeta.possibleValues = distinctByCol[c.name];
                else if (sampleByCol[c.name]) colMeta.sampleValues = sampleByCol[c.name];
                const describeSamples = distinctByCol[c.name] ?? sampleByCol[c.name] ?? [];
                const detectedFmt = detectDateFormat(c.type, describeSamples);
                if (detectedFmt) colMeta.date_format = detectedFmt;
                const stats = colStats[c.name];
                if (stats?.distinctCount !== undefined && rowCount > 0) {
                  colMeta.is_unique = stats.distinctCount === rowCount;
                }
                if (stats?.distinctCount === 1 && distinctByCol[c.name]?.length === 1) {
                  colMeta.effectively_constant = true;
                  colMeta.constant_value = distinctByCol[c.name]![0];
                }
                return colMeta;
              })
            : at.visibleColumns.map(c => {
                const stats = colStats[c.name];
                const nullCount = stats?.nullCount;
                const distinctCount = stats?.distinctCount;
                const nullRatio = stats && rowCount > 0 ? Math.round((nullCount! / rowCount) * 10000) / 10000 : undefined;
                const colMeta: Record<string, unknown> = {
                  name: c.name,
                  type: c.type,
                  nullable: c.nullable,
                  defaultValue: c.defaultValue,
                };
                if (nullCount !== undefined) colMeta.null_count = nullCount;
                if (nullRatio !== undefined) colMeta.null_ratio = nullRatio;
                if (distinctCount !== undefined) colMeta.distinct_count = distinctCount;
                if (distinctCount !== undefined && rowCount > 0) colMeta.is_unique = distinctCount === rowCount;
                if (distinctByCol[c.name]) colMeta.distinct_values = distinctByCol[c.name];
                else if (sampleByCol[c.name]) colMeta.sample_values = sampleByCol[c.name];
                // Detect ISO date format for string-typed columns
                const describeSamples = distinctByCol[c.name] ?? sampleByCol[c.name] ?? [];
                const detectedFmt = detectDateFormat(c.type, describeSamples);
                if (detectedFmt) colMeta.date_format = detectedFmt;
                // Signal effectively-constant columns to avoid wasting filter / group-by attempts
                if (distinctCount === 1 && distinctByCol[c.name]?.length === 1) {
                  colMeta.effectively_constant = true;
                  colMeta.constant_value = distinctByCol[c.name]![0];
                }
                return colMeta;
              });

          const relationsMetadata = at.relations.map(r => ({
            from_table: friendly ? snakeCaseToLabel(r.fromTable) : r.fromTable,
            from_table_name: r.fromTable,
            from_column: friendly ? snakeCaseToLabel(r.fromColumn) : r.fromColumn,
            from_column_name: r.fromColumn,
            to_table: friendly ? snakeCaseToLabel(r.toTable) : r.toTable,
            to_table_name: r.toTable,
            to_column: friendly ? snakeCaseToLabel(r.toColumn) : r.toColumn,
            to_column_name: r.toColumn,
          }));

          const displayName = friendly ? snakeCaseToLabel(tableName) : tableName;
          const payload = friendly
            ? { table: displayName, table_name: tableName, columns: columnsMetadata, rowCount, relations: relationsMetadata }
            : { table: tableName, schema: schemaName, columns: columnsMetadata, rowCount, numericStats, textStats, relations: relationsMetadata };

          const text = wrapResponse(JSON.stringify(payload, null, 2));
          return {
            content: [{ type: 'text' as const, text }],
            resultSummary: `${rowCount} rows, ${at.visibleColumns.length} columns`,
            resultData: text,
          };
        },
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Generic `write` tool — proposes INSERT/UPDATE/DELETE for admin approval.
// Nothing executes immediately; the request is queued via onWriteRequest.
// ---------------------------------------------------------------------------

function registerWriteGeneric(
  ctx: ToolContext,
  accessible: AccessibleTable[],
  onWriteRequest: (query: Omit<PendingWriteQuery, 'id' | 'timestamp' | 'status'>) => string,
): void {
  const { server, dialect, onAuditLog, profileName, scopeGuard, toolName } = ctx;

  const eligible = accessible.filter(at => at.enabledTools.includes('write'));
  if (eligible.length === 0) return;
  const tableEnum = zodEnum(eligible.map(at => at.table.name));
  if (!tableEnum) return;

  const inputShape: Record<string, z.ZodTypeAny> = {
    table: tableEnum.describe('Target table.'),
    operation: z.enum(['insert', 'update', 'delete']).describe('Write operation.'),
    description: z.string().describe('What this write does and why.'),
    values: z.record(z.string(), z.any()).optional().describe('Column-value pairs for INSERT or UPDATE.'),
    filters: makeFilterMapSchema().describe('Filters for UPDATE/DELETE (required for those).'),
  };

  const desc = 'Propose a write (INSERT/UPDATE/DELETE). Queued for admin approval — nothing executes immediately.';

  server.tool(
    toolName('write'),
    desc,
    inputShape as AnyToolArgs,
    async (args: Record<string, unknown>) => {
      const resolved = resolveTable(args.table, accessible, 'write');
      if (!resolved.ok) return structuredError(resolved.payload);
      const at = resolved.at;

      const tableName = at.table.name;
      const schemaName = at.table.schema || 'public';
      const qualifiedTable = dialect.quoteTable(schemaName, tableName);
      const validColumnNames = new Set(at.visibleColumns.map(c => c.name));
      const allowedFilterColumns = at.filterableCols.map(c => c.name);

      const start = Date.now();
      const { operation, description, values, filters } = args as {
        operation: 'insert' | 'update' | 'delete';
        description: string;
        values?: Record<string, unknown>;
        filters?: Record<string, FilterValue | undefined>;
      };

      try {
        if ((operation === 'insert' || operation === 'update') && (!values || Object.keys(values).length === 0)) {
          return structuredError({ error: `'${operation}' requires 'values' (column-value pairs)` });
        }
        if ((operation === 'update' || operation === 'delete') && (!filters || Object.keys(filters).length === 0)) {
          return structuredError({ error: `'${operation}' requires 'filters' to identify target rows` });
        }
        if (values) {
          for (const colName of Object.keys(values)) {
            if (!validColumnNames.has(colName)) {
              return structuredError({
                error: `Invalid column '${colName}' for table '${tableName}'`,
                valid_columns: [...validColumnNames],
                did_you_mean: didYouMean(colName, [...validColumnNames]),
              });
            }
          }
        }

        let sql: string;
        const params: unknown[] = [];
        let paramIndex = 1;

        switch (operation) {
          case 'insert': {
            if (scopeGuard.active) {
              const scopeInfo = scopeGuard.getScopeInfo();
              const scopeFilter = scopeInfo.filters.find(f => f.tableName === tableName);
              if (scopeFilter) {
                const currentVal = values![scopeFilter.column];
                if (currentVal !== undefined && currentVal !== scopeFilter.value) {
                  return structuredError({
                    error: `Cannot insert rows for another user. Column '${scopeFilter.column}' must match your identity.`,
                  });
                }
                if (currentVal === undefined) values![scopeFilter.column] = scopeFilter.value;
              }
            }
            const cols = Object.keys(values!);
            const colList = cols.map(c => dialect.quoteIdent(c)).join(', ');
            const paramList = cols.map(() => dialect.param(paramIndex++)).join(', ');
            params.push(...cols.map(c => values![c]));
            sql = `INSERT INTO ${qualifiedTable} (${colList}) VALUES (${paramList})`;
            break;
          }
          case 'update': {
            const setCols = Object.keys(values!);
            const setClause = setCols
              .map(c => {
                params.push(values![c]);
                return `${dialect.quoteIdent(c)} = ${dialect.param(paramIndex++)}`;
              })
              .join(', ');
            const { clause: whereClause, values: whereValues } = scopeGuard.buildWhereClause(
              tableName,
              filters!,
              allowedFilterColumns,
              dialect,
              paramIndex,
            );
            params.push(...whereValues);
            if (!whereClause) {
              return structuredError({ error: 'UPDATE requires at least one valid filter condition' });
            }
            sql = `UPDATE ${qualifiedTable} SET ${setClause} ${whereClause}`;
            break;
          }
          case 'delete': {
            const { clause: whereClause, values: whereValues } = scopeGuard.buildWhereClause(
              tableName,
              filters!,
              allowedFilterColumns,
              dialect,
              paramIndex,
            );
            params.push(...whereValues);
            if (!whereClause) {
              return structuredError({ error: 'DELETE requires at least one valid filter condition' });
            }
            sql = `DELETE FROM ${qualifiedTable} ${whereClause}`;
            break;
          }
        }

        const id = onWriteRequest({
          profileName,
          sql,
          params,
          tableName,
          operation,
          description,
        });
        const durationMs = Date.now() - start;
        const writeResultText = `Write request submitted for approval (ID: ${id}). An admin will review it.\n\nOperation: ${operation.toUpperCase()}\nTable: ${tableName}\nSQL: ${sql}\nParams: ${JSON.stringify(params)}`;
        if (onAuditLog) {
          onAuditLog({
            profileName,
            toolName: toolName('write'),
            toolArgs: args,
            result: 'success',
            resultSummary: `Write request queued (ID: ${id})`,
            resultData: JSON.stringify({ id, operation, tableName, sql, params }),
            durationMs,
          });
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: writeResultText,
            },
          ],
        };
      } catch (err) {
        const durationMs = Date.now() - start;
        if (onAuditLog) {
          onAuditLog({
            profileName,
            toolName: toolName('write'),
            toolArgs: args,
            result: 'error',
            resultSummary: (err as Error).message,
            durationMs,
          });
        }
        return structuredError({ error: (err as Error).message });
      }
    },
  );
}
