import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createHash } from 'crypto';
import { TableInfo, Relation, TableToolOptions } from '../introspect/types.js';
import { ColumnMasking } from '../pii/types.js';
import type { AuditLogEntry, PendingWriteQuery } from './types.js';
import { snakeCaseToLabel, friendlyType, buildLabelMap, formatResponseRows } from './response-formatter.js';
import type { ScopeGuard, Dialect } from './scoped-executor.js';
import { ScopeBlockedError, createScopeGuard, buildPlainConditions } from './scoped-executor.js';

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
      };
    case 'mysql':
      return {
        databaseType: 'mysql',
        isPostgres: false,
        quoteIdent: (n) => `\`${n}\``,
        quoteTable: (_s, t) => `\`${t}\``,
        param: () => '?',
        random: 'RAND()',
      };
    case 'sqlite':
      return {
        databaseType: 'sqlite',
        isPostgres: false,
        quoteIdent: (n) => `"${n}"`,
        quoteTable: (_s, t) => `"${t}"`,
        param: () => '?',
        random: 'RANDOM()',
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
      if (Array.isArray(distinct) && distinct.length > 0 && distinct.length <= 20) {
        typeLabel = `enum:${distinct.map(v => String(v)).join('|')}`;
      } else {
        typeLabel = friendly;
      }
      cols.push(`${col.name}(${typeLabel})${fkSuffix}`);
    }
    lines.push(`  ${at.table.name}: ${cols.join(', ')}`);
  }
  lines.push('');
  lines.push('OPS: eq, neq, gt, gte, lt, lte (single value), between (value=[min,max]),');
  lines.push('     in (value=array), is_null, is_not_null (omit value)');
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
  lines.push('     in (value=array), is_null, is_not_null (omit value)');
  return lines.join('\n');
}

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
  | 'is_not_null';

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

export function registerDynamicTools(options: DynamicToolsOptions): void {
  const dialect = makeDialect(options.databaseType);
  const scopeGuard: ScopeGuard = options.scopeGuard ?? createScopeGuard([]);
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
  };

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
  registerJoinAggregateGeneric(ctx, accessible, options.relations, catalogue);
  registerQueryGeneric(ctx, accessible, catalogue);
  registerDescribeGeneric(ctx, accessible, distinctValuesByTable);
  if (options.onWriteRequest) {
    registerWriteGeneric(ctx, accessible, options.onWriteRequest, catalogue);
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
  const { server, executeQuery, dialect, onAuditLog, profileName, responseMode, wrapResponse } = ctx;
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
  const desc = 'List available tables. Detailed catalogue (types, enums) is in the description of `aggregate` / `query` tools.';

  server.tool(
    'list_tables',
    desc,
    {},
    async () =>
      executeWithAudit(
        { executeQuery, dialect, onAuditLog, profileName, toolName: 'list_tables', toolArgs: {} },
        async () => ({
          content: [{ type: 'text' as const, text: wrapResponse(JSON.stringify(tableList, null, 2)) }],
          resultSummary: `${tableList.length} tables`,
        }),
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
        op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'is_null', 'is_not_null']),
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
  const { server, executeQuery, dialect, onAuditLog, profileName, responseMode, wrapResponse, scopeGuard } = ctx;

  const eligible = accessible.filter(at => at.enabledTools.includes('aggregate') && at.numericCols.length > 0);
  if (eligible.length === 0) return;
  const tableEnum = zodEnum(eligible.map(at => at.table.name));
  if (!tableEnum) return;

  const inputShape: Record<string, z.ZodTypeAny> = {
    table: tableEnum.describe('Target table. See TABLES & COLUMNS.'),
    aggregation: z
      .enum(['count', 'sum', 'avg', 'min', 'max', 'ratio'])
      .describe('Aggregation kind. Use "ratio" with `ratio_filter` for per-group ratios in one call.'),
    aggregation_column: z
      .string()
      .optional()
      .describe('Required for sum / avg / min / max. Numeric column of `table`.'),
    filters: makeFilterMapSchema().describe(
      'WHERE filters (denominator for ratio). Each entry is { op, value }. ' +
        'OPS: eq, neq, gt, gte, lt, lte (single value), between (value=[min,max]), in (value=array), is_null, is_not_null (omit value).',
    ),
    ratio_filter: makeFilterMapSchema().describe(
      'Numerator filter for `aggregation: "ratio"`. Same shape as `filters`.',
    ),
    having_min_total: z
      .number()
      .optional()
      .describe('Minimum row count per group, evaluated as HAVING. Drops small-sample groups in ratio rankings.'),
    group_by: z.string().optional().describe('Column to group by.'),
    group_by_bucket: z
      .enum(['day', 'week', 'month', 'quarter', 'year'])
      .optional()
      .describe(
        'When set together with `group_by` on a date / timestamp column, ' +
          'truncates the value to the start of the period (DATE_TRUNC). ' +
          'Use this for time-series questions like "sales per month", ' +
          '"errors per day", etc.',
      ),
    order_by: z
      .string()
      .optional()
      .describe('Column to sort by. Pass "result" to sort by the aggregated value (count/sum/avg/ratio).'),
    order_direction: z.enum(['asc', 'desc']).optional(),
    limit: z.number().optional().default(20).describe('Max rows.'),
  };

  // Tool descriptions live in the manifest the LLM reads on tools/list — they
  // stay English regardless of `responseMode` (English is shorter and the
  // default training language for tool calling). User-facing output is still
  // localized via the `friendly` response mode.
  const examples =
    'EXAMPLES:\n  Count by group, top 5:  {"table":"<TABLE>","aggregation":"count","group_by":"<COL>","order_by":"result","order_direction":"desc","limit":5}\n  Failure rate per group with sample-size floor:  {"table":"<TABLE>","aggregation":"ratio","group_by":"<GRP>","ratio_filter":{"<COL>":{"op":"eq","value":"<VAL>"}},"having_min_total":50}';

  const desc = `Aggregate any table with GROUP BY, SUM, AVG, ratio, etc.\n\n${catalogue}\n\n${examples}`;

  server.tool(
    'aggregate',
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
        filters,
        ratio_filter,
        having_min_total,
        group_by,
        group_by_bucket,
        order_by,
        order_direction,
        limit,
      } = args as {
        aggregation: string;
        aggregation_column?: string;
        filters?: Record<string, FilterValue | undefined>;
        ratio_filter?: Record<string, FilterValue | undefined>;
        having_min_total?: number;
        group_by?: string;
        group_by_bucket?: DateBucket;
        order_by?: string;
        order_direction?: string;
        limit?: number;
      };

      return executeWithAudit(
        { executeQuery, dialect, onAuditLog, profileName, toolName: 'aggregate', toolArgs: args },
        async (exec) => {
          const cappedLimit = Math.min(limit ?? 20, maxLimit);

          const { clause: whereClause, values, nextParamIndex } = scopeGuard.buildWhereClause(
            tableName,
            filters,
            allowedFilterColumns,
            dialect,
          );
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
          }

          values.push(cappedLimit);
          const limitParam = dialect.param(paramCursor);
          const sql = `SELECT ${selectPrefix}${selectExpr} FROM ${qualifiedTable} ${whereClause} ${groupByClause} ${havingClause} ${orderByClause} LIMIT ${limitParam}`;
          const result = await exec(sql, values);

          const formattedRows = formatResponseRows(result.rows, at.labelMap, responseMode);
          return {
            content: [{ type: 'text' as const, text: wrapResponse(JSON.stringify(formattedRows, null, 2)) }],
            resultSummary: `${result.rows.length} rows`,
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
  catalogue: string,
): void {
  const { server, executeQuery, dialect, onAuditLog, profileName, responseMode, wrapResponse, scopeGuard } = ctx;

  // Only tables where aggregate is enabled. Disabling aggregate on a table
  // must also block joins against it.
  const eligible = accessible.filter(at => at.enabledTools.includes('aggregate'));
  if (eligible.length < 2) return;

  // Restrict the table enum to tables that have at least one FK pointing to
  // (or coming from) another eligible table. No FK -> no JOIN possible.
  const eligibleNames = new Set(eligible.map(at => at.table.name));
  const joinable = new Set<string>();
  for (const r of allRelations) {
    if (eligibleNames.has(r.fromTable) && eligibleNames.has(r.toTable)) {
      joinable.add(r.fromTable);
      joinable.add(r.toTable);
    }
  }
  if (joinable.size < 2) return;

  const tableEnum = zodEnum([...joinable]);
  if (!tableEnum) return;

  // Lookup helpers
  const byName = new Map<string, AccessibleTable>();
  for (const at of eligible) byName.set(at.table.name, at);

  function findRelation(a: string, b: string): { aColumn: string; bColumn: string } | null {
    for (const r of allRelations) {
      if (r.fromTable === a && r.toTable === b) return { aColumn: r.fromColumn, bColumn: r.toColumn };
      if (r.fromTable === b && r.toTable === a) return { aColumn: r.toColumn, bColumn: r.fromColumn };
    }
    return null;
  }

  const inputShape: Record<string, z.ZodTypeAny> = {
    primary_table: tableEnum.describe('Left side of the JOIN.'),
    join_table: tableEnum.describe('Right side of the JOIN. Must be linked to primary_table by an FK.'),
    aggregation: z.enum(['count', 'sum', 'avg', 'min', 'max']),
    aggregation_column: z
      .string()
      .optional()
      .describe('Required for sum / avg / min / max. Column from the table given by `aggregation_column_table`.'),
    aggregation_column_table: z
      .enum(['primary', 'join'])
      .optional()
      .default('primary')
      .describe('Which side of the JOIN the aggregation_column belongs to.'),
    filters: makeFilterMapSchema().describe('Filters applied to primary_table.'),
    join_filters: makeFilterMapSchema().describe('Filters applied to join_table.'),
    group_by_column: z.string().optional().describe('Optional column to GROUP BY.'),
    group_by_table: z
      .enum(['primary', 'join'])
      .optional()
      .default('primary')
      .describe('Which side of the JOIN the group_by_column belongs to.'),
    group_by_bucket: z
      .enum(['day', 'week', 'month', 'quarter', 'year'])
      .optional()
      .describe('When set with `group_by_column` on a date column, truncates to the start of the period (DATE_TRUNC).'),
    order_direction: z
      .enum(['asc', 'desc'])
      .optional()
      .describe('Sort by the aggregate result. Useful for top-N questions.'),
    limit: z.number().optional().default(20).describe('Max rows, capped at 1000.'),
  };

  const desc = `Aggregate over an INNER JOIN of two FK-linked tables (count/sum/avg/min/max with optional GROUP BY). Use this for cross-table analytics instead of paginating per-table tools.\n\n${catalogue}`;

  server.tool(
    'join_aggregate',
    desc,
    inputShape as AnyToolArgs,
    async (args: Record<string, unknown>) => {
      const {
        primary_table,
        join_table,
        aggregation,
        aggregation_column,
        aggregation_column_table = 'primary',
        filters,
        join_filters,
        group_by_column,
        group_by_table = 'primary',
        group_by_bucket,
        order_direction,
        limit,
      } = args as {
        primary_table: string;
        join_table: string;
        aggregation: 'count' | 'sum' | 'avg' | 'min' | 'max';
        aggregation_column?: string;
        aggregation_column_table?: 'primary' | 'join';
        filters?: Record<string, FilterValue | undefined>;
        join_filters?: Record<string, FilterValue | undefined>;
        group_by_column?: string;
        group_by_table?: 'primary' | 'join';
        group_by_bucket?: DateBucket;
        order_direction?: 'asc' | 'desc';
        limit?: number;
      };

      return executeWithAudit(
        { executeQuery, dialect, onAuditLog, profileName, toolName: 'join_aggregate', toolArgs: args },
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

          const rel = findRelation(primary_table, join_table);
          if (!rel) {
            return structuredError({
              error: `No declared foreign-key relation between '${primary_table}' and '${join_table}'`,
              hint: 'join_aggregate only joins tables linked by an FK. Try chaining via an intermediate table.',
            });
          }

          const pAlias = 'p';
          const jAlias = 'j';

          // Resolve aggregation target.
          const aggAt = aggregation_column_table === 'join' ? jAt : pAt;
          const aggAlias = aggregation_column_table === 'join' ? jAlias : pAlias;
          const aggTableName = aggregation_column_table === 'join' ? join_table : primary_table;

          let selectExpr: string;
          if (aggregation === 'count' && !aggregation_column) {
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

          // Build WHERE — prefix every column with its alias so the JOIN is
          // unambiguous. Scope filters first (mandatory), then user filters.
          let paramIndex = 1;
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

          const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

          const orderByClause = order_direction
            ? `ORDER BY result ${order_direction === 'desc' ? 'DESC' : 'ASC'}`
            : '';

          const cappedLimit = Math.min(limit ?? 20, 1000);
          values.push(cappedLimit);
          const limitParam = dialect.param(paramIndex);

          const pSchema = pAt.table.schema || 'public';
          const jSchema = jAt.table.schema || 'public';
          const fromClause =
            `FROM ${dialect.quoteTable(pSchema, primary_table)} ${pAlias} ` +
            `INNER JOIN ${dialect.quoteTable(jSchema, join_table)} ${jAlias} ` +
            `ON ${pAlias}.${dialect.quoteIdent(rel.aColumn)} = ${jAlias}.${dialect.quoteIdent(rel.bColumn)}`;

          const sql = `SELECT ${selectPrefix}${selectExpr} ${fromClause} ${whereClause} ${groupByClause} ${orderByClause} LIMIT ${limitParam}`;

          const result = await exec(sql, values);

          // Apply masking ONLY on the GROUP BY column (aggregates are computed
          // numbers and don't carry PII).
          let rows = result.rows;
          if (groupByOriginal) {
            const at = byName.get(groupByOriginal.table)!;
            const colRule = at.maskingRules[groupByOriginal.column];
            if (colRule) rows = applyMasking(rows, { [groupByOriginal.column]: colRule });
          }

          // Friendly mode: surface human labels for the group-by column.
          const labelMap: Record<string, string> = {};
          if (groupByOriginal) {
            const at = byName.get(groupByOriginal.table)!;
            if (at.labelMap[groupByOriginal.column]) {
              labelMap[groupByOriginal.column] = at.labelMap[groupByOriginal.column];
            }
          }
          const formattedRows = formatResponseRows(rows, labelMap, responseMode);

          return {
            content: [{ type: 'text' as const, text: wrapResponse(JSON.stringify(formattedRows, null, 2)) }],
            resultSummary: `${rows.length} rows`,
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
  const { server, executeQuery, dialect, onAuditLog, profileName, responseMode, wrapResponse, maxOffset, scopeGuard } = ctx;

  const eligible = accessible.filter(at => at.enabledTools.includes('query') && at.allColumnNames.length > 0);
  if (eligible.length === 0) return;
  const tableEnum = zodEnum(eligible.map(at => at.table.name));
  if (!tableEnum) return;

  const inputShape: Record<string, z.ZodTypeAny> = {
    table: tableEnum.describe('Target table. See TABLES & COLUMNS.'),
    columns: z.array(z.string()).optional().describe('Columns to return. Defaults to all visible.'),
    filters: makeFilterMapSchema().describe(
      'WHERE filters by column. Each entry is { op, value }. OPS as in `aggregate`.',
    ),
    order_by: z.string().optional(),
    order_direction: z.enum(['asc', 'desc']).optional(),
    limit: z.number().optional().default(20).describe('Max rows.'),
    offset: z.number().optional().default(0),
    sample: z.boolean().optional().describe('If true, return random rows.'),
  };

  const desc = `Query rows from any table with filters, ordering, and pagination.\n\n${catalogue}\n\nEXAMPLE:\n  Filter + limit:  {"table":"<TABLE>","filters":{"<COL>":{"op":"eq","value":"<VAL>"}},"limit":10}`;

  server.tool(
    'query',
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
        { executeQuery, dialect, onAuditLog, profileName, toolName: 'query', toolArgs: args },
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

          return {
            content: [
              { type: 'text' as const, text: wrapResponse(JSON.stringify(formattedRows, null, 2)) + zeroResultHint },
            ],
            resultSummary: `${formattedRows.length} rows`,
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
  const { server, executeQuery, dialect, onAuditLog, profileName, responseMode, wrapResponse, scopeGuard } = ctx;
  const friendly = responseMode === 'friendly';

  const eligible = accessible.filter(at => at.enabledTools.includes('describe'));
  if (eligible.length === 0) return;
  const tableEnum = zodEnum(eligible.map(at => at.table.name));
  if (!tableEnum) return;

  const inputShape: Record<string, z.ZodTypeAny> = {
    table: tableEnum.describe('Table to describe.'),
  };

  const desc = 'Get runtime statistics for any visible table: row count, per-column null/distinct stats, low-cardinality enum values, text samples, numeric min/max/avg, FK relations.';

  server.tool(
    'describe',
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
        { executeQuery, dialect, onAuditLog, profileName, toolName: 'describe', toolArgs: args },
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
                  type: friendlyType(c.type),
                  required: !c.nullable,
                };
                if (distinctByCol[c.name]) colMeta.possibleValues = distinctByCol[c.name];
                else if (sampleByCol[c.name]) colMeta.sampleValues = sampleByCol[c.name];
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
                if (distinctByCol[c.name]) colMeta.distinct_values = distinctByCol[c.name];
                else if (sampleByCol[c.name]) colMeta.sample_values = sampleByCol[c.name];
                return colMeta;
              });

          const relationsMetadata = at.relations.map(r => ({
            fromTable: friendly ? snakeCaseToLabel(r.fromTable) : r.fromTable,
            fromColumn: friendly ? snakeCaseToLabel(r.fromColumn) : r.fromColumn,
            toTable: friendly ? snakeCaseToLabel(r.toTable) : r.toTable,
            toColumn: friendly ? snakeCaseToLabel(r.toColumn) : r.toColumn,
          }));

          const displayName = friendly ? snakeCaseToLabel(tableName) : tableName;
          const payload = friendly
            ? { table: displayName, columns: columnsMetadata, rowCount, relations: relationsMetadata }
            : { table: tableName, schema: schemaName, columns: columnsMetadata, rowCount, numericStats, textStats, relations: relationsMetadata };

          return {
            content: [{ type: 'text' as const, text: wrapResponse(JSON.stringify(payload, null, 2)) }],
            resultSummary: `${rowCount} rows, ${at.visibleColumns.length} columns`,
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
  catalogue: string,
): void {
  const { server, dialect, onAuditLog, profileName, scopeGuard } = ctx;

  const eligible = accessible.filter(at => at.enabledTools.includes('write'));
  if (eligible.length === 0) return;
  const tableEnum = zodEnum(eligible.map(at => at.table.name));
  if (!tableEnum) return;

  const inputShape: Record<string, z.ZodTypeAny> = {
    table: tableEnum.describe('Target table.'),
    operation: z.enum(['insert', 'update', 'delete']).describe('Write operation kind.'),
    description: z.string().describe('Human-readable description of what this write does and why.'),
    values: z.record(z.string(), z.any()).optional().describe('Column-value pairs for INSERT or UPDATE SET.'),
    filters: makeFilterMapSchema().describe('Filters for UPDATE / DELETE. Required for those.'),
  };

  const desc = `Propose a write (INSERT/UPDATE/DELETE) on a table. The query is queued for admin approval; nothing is executed immediately.\n\n${catalogue}`;

  server.tool(
    'write',
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
        if (onAuditLog) {
          onAuditLog({
            profileName,
            toolName: 'write',
            toolArgs: args,
            result: 'success',
            resultSummary: `Write request queued (ID: ${id})`,
            durationMs,
          });
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `Write request submitted for approval (ID: ${id}). An admin will review it.\n\nOperation: ${operation.toUpperCase()}\nTable: ${tableName}\nSQL: ${sql}\nParams: ${JSON.stringify(params)}`,
            },
          ],
        };
      } catch (err) {
        const durationMs = Date.now() - start;
        if (onAuditLog) {
          onAuditLog({
            profileName,
            toolName: 'write',
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
