import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createHash } from 'crypto';
import { TableInfo, Relation, TableToolOptions } from '../introspect/types.js';
import { ColumnMasking } from '../pii/types.js';
import type { AuditLogEntry, PendingWriteQuery } from './types.js';
import { snakeCaseToLabel, friendlyType, buildLabelMap, buildReverseLabelMap, formatResponseRows } from './response-formatter.js';
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
}

/** Shared context passed to all register*Tool functions to avoid long parameter lists. */
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
        isPostgres: true,
        quoteIdent: (n) => `"${n}"`,
        quoteTable: (s, t) => `"${s}"."${t}"`,
        param: (i) => `$${i}`,
        random: 'RANDOM()',
      };
    case 'mysql':
      return {
        isPostgres: false,
        quoteIdent: (n) => `\`${n}\``,
        quoteTable: (_s, t) => `\`${t}\``,
        param: () => '?',
        random: 'RAND()',
      };
    case 'sqlite':
      return {
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

// ---------------------------------------------------------------------------
// WHERE clause builder (runtime version, multi-dialect)
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

// NOTE: WHERE clause building has been moved to scoped-executor.ts (ScopeGuard).
// All tools use scopeGuard.buildWhereClause() which handles both scope filters and user filters.

// ---------------------------------------------------------------------------
// Masking runtime (inline — no imports needed)
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

// ---------------------------------------------------------------------------
// Main entry point: registerDynamicTools
// ---------------------------------------------------------------------------

export function registerDynamicTools(options: DynamicToolsOptions): void {
  const {
    server,
    tables,
    relations,
    selectedTables,
    tableOptions,
    columnMasking,
    executeQuery,
    onAuditLog,
    onWriteRequest,
    profileName,
    databaseType,
    responseMode = 'raw',
    wrapResponse = (json: string) => json,
    maxOffset = 10000,
    scopeGuard: providedScopeGuard,
  } = options;

  const dialect = makeDialect(databaseType);

  // Use provided scope guard or create an unscoped one (backward compatible)
  const scopeGuard: ScopeGuard = providedScopeGuard ?? createScopeGuard([]);

  const ctx: ToolContext = {
    server,
    executeQuery,
    onAuditLog,
    profileName,
    dialect,
    responseMode,
    wrapResponse,
    maxOffset,
    scopeGuard,
  };

  // Pre-compute which tables are visible
  const visibleTableNames = Object.keys(selectedTables);
  const visibleTables = tables.filter(t => visibleTableNames.includes(t.name));

  // -----------------------------------------------------------------------
  // Per-table tools — register first so list_tables can reflect ground truth
  // -----------------------------------------------------------------------
  // Tracks which tool names were actually registered for each visible table.
  // Used by list_tables so the discovery output never advertises a tool that
  // is missing from the MCP manifest (previously a silent drift: list_tables
  // promised describe_<table> while no server.tool call was made because the
  // table had no numeric columns or no visible columns).
  const registeredToolsByTable = new Map<string, string[]>();

  for (const table of visibleTables) {
    const selectedCols = selectedTables[table.name];
    if (!selectedCols || selectedCols.length === 0) continue;

    // Scope guard: skip blocked tables (fail-closed)
    if (scopeGuard.active) {
      try {
        scopeGuard.checkTableAccess(table.name);
      } catch (e) {
        if (e instanceof ScopeBlockedError) continue; // Don't register tools for blocked tables
        throw e;
      }
    }

    const opts = tableOptions?.[table.name];
    const enabledTools = opts?.enabledTools ?? ['describe', 'aggregate', 'query'];
    const tableMasking = columnMasking?.[table.name];
    const maskingRules = tableMasking ? buildMaskingRules(tableMasking) : {};

    // Determine excluded columns (completely hidden)
    const excludedCols = new Set<string>();
    if (tableMasking) {
      for (const [colName, m] of Object.entries(tableMasking)) {
        if (m.maskingMode === 'exclude') {
          excludedCols.add(colName);
        }
      }
    }

    // Visible columns = selected AND not excluded
    const visibleColumns = table.columns.filter(
      c => selectedCols.includes(c.name) && !excludedCols.has(c.name),
    );

    const tableRelations = relations.filter(
      r => r.fromTable === table.name || r.toTable === table.name,
    );

    // Build label map for friendly mode
    const labelMap = buildLabelMap(visibleColumns.map(c => ({ name: c.name })));
    const reverseLabelMap = buildReverseLabelMap(labelMap);

    const tableTools: string[] = [];

    if (enabledTools.includes('describe')) {
      registerDescribeTool(ctx, table, visibleColumns, tableRelations, enabledTools, labelMap, maskingRules);
      tableTools.push(`describe_${table.name}`);
    }

    if (enabledTools.includes('aggregate')) {
      // Mirror registerAggregateTool's early return: no aggregate without a numeric column.
      const aggregateNumericCols = visibleColumns.filter(c => isNumericType(c.type));
      if (aggregateNumericCols.length > 0) {
        registerAggregateTool(ctx, table, visibleColumns, opts, maskingRules, excludedCols, labelMap, reverseLabelMap);
        tableTools.push(`aggregate_${table.name}`);
      }
    }

    if (enabledTools.includes('query')) {
      // Mirror registerQueryTool's early return: no query without visible columns.
      if (visibleColumns.length > 0) {
        registerQueryTool(ctx, table, visibleColumns, opts, maskingRules, excludedCols, tableMasking, labelMap, reverseLabelMap);
        tableTools.push(`query_${table.name}`);
      }
    }

    if (enabledTools.includes('write') && onWriteRequest) {
      registerWriteTool(server, table, visibleColumns, onWriteRequest, onAuditLog, profileName, dialect, scopeGuard);
      tableTools.push(`write_${table.name}`);
    }

    if (tableTools.length > 0) {
      registeredToolsByTable.set(table.name, tableTools);
    }
  }

  // -----------------------------------------------------------------------
  // list_tables — reflects the actual manifest, not aspirational settings
  // -----------------------------------------------------------------------
  registerListTables(ctx, visibleTables, selectedTables, columnMasking, registeredToolsByTable);
}

// ---------------------------------------------------------------------------
// list_tables tool
// ---------------------------------------------------------------------------

function registerListTables(
  ctx: ToolContext,
  visibleTables: TableInfo[],
  selectedTables: Record<string, string[]>,
  columnMasking: Record<string, Record<string, ColumnMasking>> | undefined,
  registeredToolsByTable: Map<string, string[]>,
): void {
  const { server, executeQuery, dialect, onAuditLog, profileName, responseMode, scopeGuard } = ctx;
  const friendly = responseMode === 'friendly';

  // Filter out blocked tables when scoping is active
  const accessibleTables = scopeGuard.active
    ? visibleTables.filter(table => {
        try { scopeGuard.checkTableAccess(table.name); return true; }
        catch { return false; }
      })
    : visibleTables;

  // Only list tables that ended up with at least one registered tool — keeps
  // the discovery output and the actual MCP manifest in lockstep.
  const tableList = accessibleTables
    .filter(t => registeredToolsByTable.has(t.name))
    .map(table => {
      const tblMasking = columnMasking?.[table.name];

      const excludedCols = new Set<string>();
      if (tblMasking) {
        for (const [colName, m] of Object.entries(tblMasking)) {
          if (m.maskingMode === 'exclude') {
            excludedCols.add(colName);
          }
        }
      }

      const selectedCols = selectedTables[table.name] ?? [];
      const visibleCols = selectedCols.filter(c => !excludedCols.has(c));

      const tools = registeredToolsByTable.get(table.name) ?? [];

      const displayName = friendly ? snakeCaseToLabel(table.name) : table.name;
      const displayCols = friendly ? visibleCols.map(c => snakeCaseToLabel(c)) : visibleCols;

      // Hint mentions describe only if it is actually available.
      const hint = tools.includes(`describe_${table.name}`)
        ? `Call describe_${table.name} first`
        : undefined;

      const entry: Record<string, unknown> = {
        name: displayName,
        columns: displayCols,
        tools,
      };
      if (hint) entry.hint = hint;
      return entry;
    });

  const listDesc = friendly
    ? 'Lister les tables disponibles. Appeler describe_<table> avant de lancer une requete.'
    : 'List all available tables. Call describe_<table> before querying a table.';

  server.tool(
    'list_tables',
    listDesc,
    {},
    async () => {
      return executeWithAudit(
        { executeQuery, dialect, onAuditLog, profileName, toolName: 'list_tables', toolArgs: {} },
        async () => ({
          content: [{ type: 'text' as const, text: ctx.wrapResponse(JSON.stringify(tableList, null, 2)) }],
          resultSummary: `${tableList.length} tables`,
        }),
      );
    },
  );
}

// ---------------------------------------------------------------------------
// describe_{tableName} tool
// ---------------------------------------------------------------------------

function registerDescribeTool(
  ctx: ToolContext,
  table: TableInfo,
  visibleColumns: TableInfo['columns'],
  tableRelations: Relation[],
  enabledTools: string[],
  labelMap: Record<string, string>,
  maskingRules: Record<string, MaskingRule>,
): void {
  const { server, executeQuery, dialect, onAuditLog, profileName, responseMode, wrapResponse, scopeGuard } = ctx;
  const friendly = responseMode === 'friendly';
  const schemaName = table.schema || 'public';
  const tableName = table.name;
  const displayName = friendly ? snakeCaseToLabel(tableName) : tableName;
  const toolName = `describe_${tableName}`;
  const includeStats = enabledTools.includes('aggregate') || enabledTools.includes('query');

  const numericCols = includeStats
    ? visibleColumns.filter(c => isNumericType(c.type)).map(c => c.name)
    : [];
  const textCols = includeStats
    ? visibleColumns.filter(c => isTextType(c.type)).map(c => c.name)
    : [];

  const qualifiedTable = dialect.quoteTable(schemaName, tableName);

  const describeDesc = friendly
    ? `Obtenir des details sur la structure de ${displayName}. Appeler AVANT de faire une requete.`
    : `Get schema, statistics, and relationships for the ${tableName} table. Call this FIRST before querying.`;

  server.tool(
    toolName,
    describeDesc,
    {},
    async () => {
      return executeWithAudit(
        { executeQuery, dialect, onAuditLog, profileName, toolName, toolArgs: {} },
        async (exec) => {
          // Scope-aware WHERE clause for all describe queries
          const { clause: scopeWhere, values: scopeValues } =
            scopeGuard.buildScopeOnlyWhereClause(tableName, dialect);

          // COUNT (scoped)
          const countResult = await exec(
            `SELECT COUNT(*) as total FROM ${qualifiedTable} ${scopeWhere}`,
            scopeValues,
          );
          const rowCount = Number(countResult.rows[0].total);

          // Combined stats pass: per-column NULL count + distinct count, plus
          // numeric MIN/MAX/AVG. One query, scoped, no per-column round-trip.
          const numericStats: Record<string, { min: unknown; max: unknown; avg: unknown }> = {};
          const colStats: Record<string, { nullCount: number; distinctCount: number }> = {};
          const allColsForStats = includeStats ? visibleColumns : [];
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
              const key = friendly ? (labelMap[col] ?? snakeCaseToLabel(col)) : col;
              numericStats[key] = {
                min: row[`${col}__min`],
                max: row[`${col}__max`],
                avg: row[`${col}__avg`],
              };
            }
          }

          // For low-cardinality columns (any type, distinctCount <= MAX_ENUM),
          // pull the exhaustive distinct value list. For text columns above
          // that threshold but still small (<= MAX_SAMPLE), keep a sample.
          // This eliminates the LLM's "guess the enum" round-trips (fragile
          // 0/1, priorite urgente vs URGENTE, statut echec vs Échec, etc.).
          const MAX_ENUM = 20;
          const MAX_SAMPLE = 50;
          const distinctByCol: Record<string, unknown[]> = {};
          const sampleByCol: Record<string, string[] | undefined> = {};
          for (const c of allColsForStats) {
            const stats = colStats[c.name];
            if (!stats) continue;
            const distinct = stats.distinctCount;
            const isLowCardinality = distinct > 0 && distinct <= MAX_ENUM;
            const isSampleable = isTextType(c.type) && distinct > MAX_ENUM && distinct <= MAX_SAMPLE;
            if (!isLowCardinality && !isSampleable) continue;
            try {
              const qi = dialect.quoteIdent(c.name);
              const notNullCondition = `${qi} IS NOT NULL`;
              const valWhere = scopeWhere
                ? `${scopeWhere} AND ${notNullCondition}`
                : `WHERE ${notNullCondition}`;
              const cap = isLowCardinality ? MAX_ENUM : MAX_SAMPLE;
              const valSql = `SELECT DISTINCT ${qi} AS val FROM ${qualifiedTable} ${valWhere} ORDER BY val LIMIT ${cap + 1}`;
              const valResult = await exec(valSql, [...scopeValues]);
              const rawVals = valResult.rows.map((r) => (r as Record<string, unknown>).val);
              if (isLowCardinality) {
                let vals: unknown[] = rawVals;
                const colMaskRule = maskingRules[c.name];
                if (colMaskRule && (colMaskRule.mode === 'hash' || colMaskRule.mode === 'truncate' || colMaskRule.mode === 'replace')) {
                  vals = applyMasking(rawVals.map((v) => ({ [c.name]: v })), { [c.name]: colMaskRule }).map((r) => r[c.name]);
                }
                distinctByCol[c.name] = vals;
              } else {
                let vals = rawVals.map((v) => String(v));
                const colMaskRule = maskingRules[c.name];
                if (colMaskRule && (colMaskRule.mode === 'hash' || colMaskRule.mode === 'truncate' || colMaskRule.mode === 'replace')) {
                  vals = applyMasking(vals.map((v) => ({ [c.name]: v })), { [c.name]: colMaskRule }).map((r) => String(r[c.name]));
                }
                if (vals.length <= MAX_SAMPLE) sampleByCol[c.name] = vals;
              }
            } catch {
              // Skip sampling errors
            }
          }

          // Legacy textStats shape kept for backward compatibility with any
          // consumer that already parsed it (also surfaced in raw mode payload).
          const textStats: Record<string, { distinctCount: number; sampleValues?: string[] }> = {};
          for (const col of textCols) {
            const stats = colStats[col];
            if (!stats) continue;
            const key = friendly ? (labelMap[col] ?? snakeCaseToLabel(col)) : col;
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

          // Build columns metadata.
          // Raw mode exposes everything the LLM needs to avoid round-trips:
          // native column type, null_count + null_ratio (so AVG/SUM ambiguity
          // is visible), distinct_count, and either an exhaustive
          // distinct_values list (for low-cardinality categorical/boolean
          // columns) or a sample_values list (for text with moderate
          // cardinality). Friendly mode keeps the lighter shape.
          const columnsMetadata = friendly
            ? visibleColumns.map(c => {
                const colMeta: Record<string, unknown> = {
                  name: labelMap[c.name] ?? snakeCaseToLabel(c.name),
                  type: friendlyType(c.type),
                  required: !c.nullable,
                };
                if (distinctByCol[c.name]) {
                  colMeta.possibleValues = distinctByCol[c.name];
                } else if (sampleByCol[c.name]) {
                  colMeta.sampleValues = sampleByCol[c.name];
                }
                return colMeta;
              })
            : visibleColumns.map(c => {
                const stats = colStats[c.name];
                const nullCount = stats?.nullCount;
                const distinctCount = stats?.distinctCount;
                const nullRatio = stats && rowCount > 0
                  ? Math.round((nullCount! / rowCount) * 10000) / 10000
                  : undefined;
                const colMeta: Record<string, unknown> = {
                  name: c.name,
                  type: c.type,
                  nullable: c.nullable,
                  defaultValue: c.defaultValue,
                };
                if (nullCount !== undefined) colMeta.null_count = nullCount;
                if (nullRatio !== undefined) colMeta.null_ratio = nullRatio;
                if (distinctCount !== undefined) colMeta.distinct_count = distinctCount;
                if (distinctByCol[c.name]) {
                  colMeta.distinct_values = distinctByCol[c.name];
                } else if (sampleByCol[c.name]) {
                  colMeta.sample_values = sampleByCol[c.name];
                }
                return colMeta;
              });

          const relationsMetadata = tableRelations.map(r => ({
            fromTable: friendly ? snakeCaseToLabel(r.fromTable) : r.fromTable,
            fromColumn: friendly ? snakeCaseToLabel(r.fromColumn) : r.fromColumn,
            toTable: friendly ? snakeCaseToLabel(r.toTable) : r.toTable,
            toColumn: friendly ? snakeCaseToLabel(r.toColumn) : r.toColumn,
          }));

          const payload = friendly
            ? { table: displayName, columns: columnsMetadata, rowCount, relations: relationsMetadata }
            : { table: tableName, schema: schemaName, columns: columnsMetadata, rowCount, numericStats, textStats, relations: relationsMetadata };

          return {
            content: [{ type: 'text' as const, text: wrapResponse(JSON.stringify(payload, null, 2)) }],
            resultSummary: `${rowCount} rows, ${visibleColumns.length} columns`,
          };
        },
      );
    },
  );
}

// ---------------------------------------------------------------------------
// aggregate_{tableName} tool
// ---------------------------------------------------------------------------

function registerAggregateTool(
  ctx: ToolContext,
  table: TableInfo,
  visibleColumns: TableInfo['columns'],
  opts: TableToolOptions | undefined,
  _maskingRules: Record<string, MaskingRule>,
  excludedCols: Set<string>,
  labelMap: Record<string, string>,
  _reverseLabelMap: Record<string, string>,
): void {
  const { server, executeQuery, dialect, onAuditLog, profileName, responseMode, wrapResponse, scopeGuard } = ctx;
  const friendly = responseMode === 'friendly';
  const schemaName = table.schema || 'public';
  const tableName = table.name;
  const toolName = `aggregate_${tableName}`;
  const maxLimit = opts?.maxLimit ?? 1000;

  // Numeric columns (for aggregation target)
  const numericCols = visibleColumns
    .filter(c => isNumericType(c.type) && !excludedCols.has(c.name))
    .map(c => c.name);

  if (numericCols.length === 0) return; // No aggregate tool if no numeric cols

  // Filterable columns
  const allFilterable = visibleColumns
    .filter(c => pgTypeToZod(c.type) !== null && !excludedCols.has(c.name));
  const filterableCols = opts?.filterableColumns && opts.filterableColumns.length > 0
    ? allFilterable.filter(c => opts.filterableColumns.includes(c.name))
    : allFilterable;

  // Groupable columns
  const groupableColumns = (
    opts?.groupableColumns && opts.groupableColumns.length > 0
      ? opts.groupableColumns
      : filterableCols.map(c => c.name)
  ).filter(c => !excludedCols.has(c));

  // All visible column names for order_by
  const allColumnNames = visibleColumns
    .filter(c => !excludedCols.has(c.name))
    .map(c => c.name);

  const allowedFilterColumns = filterableCols.map(c => c.name);
  const qualifiedTable = dialect.quoteTable(schemaName, tableName);

  // Build Zod schema for filters. We intentionally inline the {op, value}
  // shape per column rather than sharing a meta-tagged instance: weaker
  // LLMs and some MCP clients mis-handle the `allOf + $ref` pattern that
  // Zod v4-mini emits when `meta()` meets `.describe().optional()`,
  // sometimes sending `filters` as a stringified JSON instead of an
  // object. The per-column duplication is paid for in 1a (no per-value
  // describe text), which is enough to fit Qwen-class context windows.
  const filterShape: Record<string, z.ZodTypeAny> = {};
  for (const col of filterableCols) {
    filterShape[col.name] = z.object({
      op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'is_null', 'is_not_null']),
      value: z.any().optional(),
    }).optional();
  }

  const groupByEnum = zodEnum(groupableColumns);
  const numericEnum = zodEnum(numericCols);
  // Order-by accepts any visible column AND the alias 'result' so the LLM can
  // request "top N by computed aggregation" (e.g. ORDER BY COUNT(*) DESC) in
  // a single call instead of pulling all groups and sorting client-side.
  const orderByEnum = zodEnum([...allColumnNames, 'result']);

  if (!numericEnum) return; // Safety: should not happen since we checked above

  const inputShape: Record<string, z.ZodTypeAny> = {
    aggregation: z.enum(['count', 'sum', 'avg', 'min', 'max', 'ratio']).describe(
      'Aggregation kind. Use "ratio" with `ratio_filter` to compute per-group ratios (e.g. failure rate per courier) in a single call instead of two aggregates plus client-side division.',
    ),
    aggregation_column: numericEnum.optional().describe('Required for sum, avg, min, max. Not needed for count or ratio.'),
    filters: z.object(filterShape).optional().describe(
      'WHERE filters applied to ALL rows (denominator for ratio). Each entry is { op, value }. ' +
      'Operators: eq, neq, gt, gte, lt, lte, between (value=[min,max]), in (value=array or CSV), ' +
      'is_null and is_not_null (omit value). Combine with `ratio_filter` for "subset / total" ratios.',
    ),
    ratio_filter: z.object(filterShape).optional().describe(
      'Numerator filter for `aggregation: "ratio"`. Same shape as `filters`. Result = rows matching filters AND ratio_filter divided by rows matching filters only.',
    ),
    having_min_total: z.number().optional().describe(
      'Minimum row count per group (denominator), evaluated as HAVING. Use to drop small-sample groups in ratio rankings (e.g. ignore couriers with fewer than 50 packages).',
    ),
    order_direction: z.enum(['asc', 'desc']).optional(),
    limit: z.number().optional().default(20).describe(`Max rows, capped at ${maxLimit}`),
  };
  if (groupByEnum) inputShape.group_by = groupByEnum.optional();
  if (orderByEnum) inputShape.order_by = orderByEnum.optional().describe(
    'Column name to sort by. Pass "result" to sort by the aggregated value itself (count, sum, avg, ratio, etc.) — required for "top N by count", "top N by ratio", or "top N by total" queries.',
  );

  const displayName = friendly ? snakeCaseToLabel(tableName) : tableName;
  const aggDesc = friendly
    ? `Obtenir des statistiques sur ${displayName} (count, sum, avg, min, max)`
    : `Aggregate data from the ${tableName} table with GROUP BY, SUM, AVG, etc.`;

  server.tool(
    toolName,
    aggDesc,
    inputShape as AnyToolArgs,
    async (args: Record<string, unknown>) => {
      const {
        group_by,
        aggregation,
        aggregation_column,
        filters,
        ratio_filter,
        having_min_total,
        order_by,
        order_direction,
        limit,
      } = args as {
        group_by?: string;
        aggregation: string;
        aggregation_column?: string;
        filters?: Record<string, FilterValue | undefined>;
        ratio_filter?: Record<string, FilterValue | undefined>;
        having_min_total?: number;
        order_by?: string;
        order_direction?: string;
        limit?: number;
      };

      return executeWithAudit(
        { executeQuery, dialect, onAuditLog, profileName, toolName, toolArgs: args },
        async (exec) => {
          const cappedLimit = Math.min(limit ?? 20, maxLimit);

          // WHERE (scope-aware: scope filters are always injected first)
          const { clause: whereClause, values, nextParamIndex } =
            scopeGuard.buildWhereClause(tableName, filters, allowedFilterColumns, dialect);
          let paramCursor = nextParamIndex;

          // SELECT expression.
          // - count: just COUNT(*).
          // - sum/avg/min/max: AGG(col) + COUNT(*) + COUNT(col) so the LLM can
          //   distinguish "AVG over all rows" vs "AVG over non-null rows"
          //   (SQL AVG/SUM/MIN/MAX silently ignore NULLs).
          // - ratio: AVG(CASE WHEN <ratio_filter> THEN 1 ELSE 0 END) on rows
          //   matching `filters`. We also expose `numerator` and `denominator`
          //   counts so the LLM can sanity-check sample size and combine with
          //   `having_min_total` to drop small-sample groups.
          let selectExpr: string;
          if (aggregation === 'ratio') {
            if (!ratio_filter || Object.keys(ratio_filter).length === 0) {
              return {
                content: [{ type: 'text' as const, text: 'ratio_filter is required for aggregation: "ratio".' }],
                isError: true,
              };
            }
            // The CASE WHEN expression appears twice in the SELECT (once for
            // `result`, once for `numerator`). Each occurrence has its own
            // positional placeholders, so we build the conditions twice with
            // independent paramIndex windows and push the values twice. This
            // keeps SQLite (`?`) and Postgres (`$N`) consistent: each `?` /
            // `$N` resolves to one value at its own offset.
            const first = buildPlainConditions(ratio_filter, allowedFilterColumns, dialect, paramCursor);
            if (first.conditions.length === 0) {
              return {
                content: [{ type: 'text' as const, text: 'ratio_filter has no usable conditions (unknown columns?).' }],
                isError: true,
              };
            }
            values.push(...first.values);
            paramCursor = first.nextParamIndex;
            const second = buildPlainConditions(ratio_filter, allowedFilterColumns, dialect, paramCursor);
            values.push(...second.values);
            paramCursor = second.nextParamIndex;

            const caseFirst = `CASE WHEN ${first.conditions.join(' AND ')} THEN 1 ELSE 0 END`;
            const caseSecond = `CASE WHEN ${second.conditions.join(' AND ')} THEN 1 ELSE 0 END`;
            // 1.0 multiplier promotes integer counts to float so SQLite does
            // not return zero on integer division.
            selectExpr =
              `AVG(1.0 * (${caseFirst})) as result,` +
              ` SUM(${caseSecond}) as numerator,` +
              ` COUNT(*) as denominator`;
          } else if (aggregation === 'count' && !aggregation_column) {
            selectExpr = 'COUNT(*) as result';
          } else if (!aggregation_column) {
            return {
              content: [{ type: 'text' as const, text: 'aggregation_column is required for sum, avg, min, max' }],
              isError: true,
            };
          } else {
            // Validate column name
            if (!numericCols.includes(aggregation_column)) {
              return {
                content: [{ type: 'text' as const, text: `Invalid aggregation column: ${aggregation_column}` }],
                isError: true,
              };
            }
            const qiCol = dialect.quoteIdent(aggregation_column);
            selectExpr =
              `${aggregation.toUpperCase()}(${qiCol}) as result,` +
              ` COUNT(*) as count_total,` +
              ` COUNT(${qiCol}) as count_non_null`;
          }

          // GROUP BY
          let groupByClause = '';
          let selectPrefix = '';
          if (group_by) {
            if (!groupableColumns.includes(group_by)) {
              return {
                content: [{ type: 'text' as const, text: `Invalid group_by column: ${group_by}` }],
                isError: true,
              };
            }
            selectPrefix = `${dialect.quoteIdent(group_by)}, `;
            groupByClause = `GROUP BY ${dialect.quoteIdent(group_by)}`;
          }

          // HAVING — drops small-sample groups (sample-size floor for ratios).
          // Only meaningful with GROUP BY; silently ignored otherwise.
          let havingClause = '';
          if (group_by && typeof having_min_total === 'number' && having_min_total > 0) {
            values.push(having_min_total);
            havingClause = `HAVING COUNT(*) >= ${dialect.param(paramCursor++)}`;
          }

          // ORDER BY. The literal alias 'result' is special: it sorts on
          // the aggregated SELECT expression alias (count/sum/avg/min/max/ratio).
          // No identifier quoting because 'result' is a SQL alias, not a
          // column. Other values are validated against the table's columns.
          let orderByClause = '';
          if (order_by) {
            const isResultAlias = order_by === 'result';
            if (!isResultAlias && !allColumnNames.includes(order_by)) {
              return {
                content: [{ type: 'text' as const, text: `Invalid order_by column: ${order_by}` }],
                isError: true,
              };
            }
            const dir = order_direction === 'desc' ? 'DESC' : 'ASC';
            const target = isResultAlias ? 'result' : dialect.quoteIdent(order_by);
            orderByClause = `ORDER BY ${target} ${dir}`;
          }

          // LIMIT
          values.push(cappedLimit);
          const limitParam = dialect.param(paramCursor);

          const sql = `SELECT ${selectPrefix}${selectExpr} FROM ${qualifiedTable} ${whereClause} ${groupByClause} ${havingClause} ${orderByClause} LIMIT ${limitParam}`;
          const result = await exec(sql, values);

          const formattedRows = formatResponseRows(result.rows, labelMap, responseMode);
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
// query_{tableName} tool
// ---------------------------------------------------------------------------

function registerQueryTool(
  ctx: ToolContext,
  table: TableInfo,
  visibleColumns: TableInfo['columns'],
  opts: TableToolOptions | undefined,
  maskingRules: Record<string, MaskingRule>,
  excludedCols: Set<string>,
  tableMasking: Record<string, ColumnMasking> | undefined,
  labelMap: Record<string, string>,
  _reverseLabelMap: Record<string, string>,
): void {
  const { server, executeQuery, dialect, onAuditLog, profileName, responseMode, wrapResponse, maxOffset, scopeGuard } = ctx;
  const friendly = responseMode === 'friendly';
  const schemaName = table.schema || 'public';
  const tableName = table.name;
  const toolName = `query_${tableName}`;
  const maxLimit = opts?.maxLimit ?? 1000;

  // Columns excluded from query (exclude + aggregate_only)
  const queryExcludedCols = new Set<string>(excludedCols);
  if (tableMasking) {
    for (const [colName, m] of Object.entries(tableMasking)) {
      if (m.maskingMode === 'aggregate_only') {
        queryExcludedCols.add(colName);
      }
    }
  }

  // All queryable column names
  const allColumnNames = visibleColumns
    .filter(c => !queryExcludedCols.has(c.name))
    .map(c => c.name);

  if (allColumnNames.length === 0) return;

  // Filterable columns
  const allFilterable = visibleColumns
    .filter(c => pgTypeToZod(c.type) !== null && !queryExcludedCols.has(c.name));
  const filterableCols = opts?.filterableColumns && opts.filterableColumns.length > 0
    ? allFilterable.filter(c => opts.filterableColumns.includes(c.name))
    : allFilterable;

  const allowedFilterColumns = filterableCols.map(c => c.name);
  const qualifiedTable = dialect.quoteTable(schemaName, tableName);

  // Build Zod schema for filters (see comment on the aggregate tool —
  // we intentionally inline the per-column shape rather than sharing
  // a meta-tagged instance, to keep the JSON Schema canonical for
  // weaker LLMs).
  const filterShape: Record<string, z.ZodTypeAny> = {};
  for (const col of filterableCols) {
    filterShape[col.name] = z.object({
      op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'is_null', 'is_not_null']),
      value: z.any().optional(),
    }).optional();
  }

  const columnsEnum = zodEnum(allColumnNames);
  const orderByEnum = zodEnum(allColumnNames);

  const inputShape: Record<string, z.ZodTypeAny> = {
    filters: z.object(filterShape).optional().describe(
      'WHERE filters by column. Each entry is { op, value }. ' +
      'Operators: eq, neq, gt, gte, lt, lte, between (value=[min,max]), in (value=array or CSV), ' +
      'is_null and is_not_null (omit value).',
    ),
    order_direction: z.enum(['asc', 'desc']).optional(),
    limit: z.number().optional().default(20).describe(`Max rows, capped at ${maxLimit}`),
    offset: z.number().optional().default(0),
    sample: z.boolean().optional().describe('If true, return random rows'),
  };
  if (columnsEnum) inputShape.columns = z.array(columnsEnum).optional().describe('Columns to return, defaults to all');
  if (orderByEnum) inputShape.order_by = orderByEnum.optional();

  // Build query masking rules (exclude already removed from column list; only hash/truncate/replace apply)
  const queryMaskingRules: Record<string, MaskingRule> = {};
  for (const [col, rule] of Object.entries(maskingRules)) {
    if (rule.mode === 'hash' || rule.mode === 'truncate' || rule.mode === 'replace') {
      queryMaskingRules[col] = rule;
    }
  }
  const needsMasking = Object.keys(queryMaskingRules).length > 0;

  const displayName = friendly ? snakeCaseToLabel(tableName) : tableName;
  const queryDesc = friendly
    ? `Rechercher des informations dans ${displayName}`
    : `Query rows from the ${tableName} table with filters, ordering, and pagination.`;

  server.tool(
    toolName,
    queryDesc,
    inputShape as AnyToolArgs,
    async (args: Record<string, unknown>) => {
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
        { executeQuery, dialect, onAuditLog, profileName, toolName, toolArgs: args },
        async (exec) => {
          const cappedLimit = Math.min(limit ?? 20, maxLimit);
          const cappedOffset = Math.min(offset ?? 0, maxOffset);

          // WHERE (scope-aware: scope filters are always injected first)
          const { clause: whereClause, values, nextParamIndex } =
            scopeGuard.buildWhereClause(tableName, filters, allowedFilterColumns, dialect);

          let paramIdx = nextParamIndex;

          // SELECT columns — validate each requested column
          let selectExpr: string;
          if (columns && columns.length > 0) {
            for (const c of columns) {
              if (!allColumnNames.includes(c)) {
                const available = friendly
                  ? allColumnNames.map(n => labelMap[n] ?? snakeCaseToLabel(n)).join(', ')
                  : allColumnNames.join(', ');
                return {
                  content: [{ type: 'text' as const, text: friendly ? `Ce champ n'est pas disponible. Champs disponibles : ${available}` : `Invalid column: ${c}. Available: ${available}` }],
                  isError: true,
                };
              }
            }
            selectExpr = columns.map(c => dialect.quoteIdent(c)).join(', ');
          } else {
            // Select only visible columns, not *
            selectExpr = allColumnNames.map(c => dialect.quoteIdent(c)).join(', ');
          }

          // ORDER BY
          let orderByClause = '';
          if (sample) {
            orderByClause = `ORDER BY ${dialect.random}`;
          } else if (order_by) {
            if (!allColumnNames.includes(order_by)) {
              return {
                content: [{ type: 'text' as const, text: `Invalid order_by column: ${order_by}` }],
                isError: true,
              };
            }
            const dir = order_direction === 'desc' ? 'DESC' : 'ASC';
            orderByClause = `ORDER BY ${dialect.quoteIdent(order_by)} ${dir}`;
          }

          // LIMIT and OFFSET
          values.push(cappedLimit);
          const limitParam = dialect.param(paramIdx++);
          values.push(cappedOffset);
          const offsetParam = dialect.param(paramIdx);

          const sql = `SELECT ${selectExpr} FROM ${qualifiedTable} ${whereClause} ${orderByClause} LIMIT ${limitParam} OFFSET ${offsetParam}`;
          const result = await exec(sql, values);

          const maskedRows = needsMasking ? applyMasking(result.rows, queryMaskingRules) : result.rows;
          const formattedRows = formatResponseRows(maskedRows, labelMap, responseMode);

          // Auto-hint on 0 results with filters (scope-aware)
          let zeroResultHint = '';
          if (formattedRows.length === 0 && filters && Object.keys(filters).length > 0) {
            try {
              const filteredColNames = Object.keys(filters).filter(k => filters[k] !== undefined);
              const textFilteredCols = filteredColNames.filter(col => {
                const colInfo = visibleColumns.find(c => c.name === col);
                return colInfo && isTextType(colInfo.type);
              });
              const hints: string[] = [];
              // Build scope WHERE for hint queries
              const { clause: hintScopeWhere, values: hintScopeValues } =
                scopeGuard.buildScopeOnlyWhereClause(tableName, dialect);
              for (const col of textFilteredCols.slice(0, 5)) {
                const qi = dialect.quoteIdent(col);
                const notNullCond = `${qi} IS NOT NULL`;
                let hintWhere: string;
                let hintParams: unknown[];
                if (hintScopeWhere) {
                  hintWhere = `${hintScopeWhere} AND ${notNullCond}`;
                  hintParams = [...hintScopeValues];
                } else {
                  hintWhere = `WHERE ${notNullCond}`;
                  hintParams = [];
                }
                const vSql = `SELECT DISTINCT ${qi} AS val FROM ${qualifiedTable} ${hintWhere} ORDER BY val LIMIT 30`;
                const vRes = await exec(vSql, hintParams);
                const vals = vRes.rows.map(r => String((r as Record<string, unknown>).val));
                if (vals.length > 0) {
                  hints.push(`Possible values for '${col}': ${vals.join(', ')}`);
                }
              }
              if (hints.length > 0) {
                zeroResultHint = '\n\nNo results found. ' + hints.join('. ') + '. Retry with one of these exact values.';
              }
            } catch {
              // Non-critical
            }
          }

          return {
            content: [{ type: 'text' as const, text: wrapResponse(JSON.stringify(formattedRows, null, 2)) + zeroResultHint }],
            resultSummary: `${formattedRows.length} rows`,
          };
        },
      );
    },
  );
}

// ---------------------------------------------------------------------------
// write_{tableName} tool
// ---------------------------------------------------------------------------

function registerWriteTool(
  server: McpServer,
  table: TableInfo,
  visibleColumns: TableInfo['columns'],
  onWriteRequest: (query: Omit<PendingWriteQuery, 'id' | 'timestamp' | 'status'>) => string,
  onAuditLog: DynamicToolsOptions['onAuditLog'],
  profileName: string,
  dialect: Dialect,
  scopeGuard: ScopeGuard,
): void {
  const schemaName = table.schema || 'public';
  const tableName = table.name;
  const toolName = `write_${tableName}`;
  const qualifiedTable = dialect.quoteTable(schemaName, tableName);

  // Build the set of valid column names for validation
  const validColumnNames = new Set(visibleColumns.map(c => c.name));

  // Build filter shape for update/delete (same as query, inline).
  const filterableCols = visibleColumns.filter(c => pgTypeToZod(c.type) !== null);
  const filterShape: Record<string, z.ZodTypeAny> = {};
  for (const col of filterableCols) {
    filterShape[col.name] = z.object({
      op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'is_null', 'is_not_null']),
      value: z.any().optional(),
    }).optional();
  }
  const allowedFilterColumns = filterableCols.map(c => c.name);

  const inputShape: Record<string, z.ZodTypeAny> = {
    operation: z.enum(['insert', 'update', 'delete']).describe('The write operation to perform'),
    description: z.string().describe('Human-readable description of what this write does and why'),
    values: z.record(z.string(), z.any()).optional().describe('Column-value pairs for INSERT or SET clause of UPDATE'),
    filters: z.object(filterShape).optional().describe('Filters for UPDATE/DELETE (same format as query filters). Required for UPDATE and DELETE.'),
  };

  server.tool(
    toolName,
    `Propose a write operation (INSERT/UPDATE/DELETE) on the ${tableName} table. The query will NOT be executed immediately — it will be queued for admin approval.`,
    inputShape as AnyToolArgs,
    async (args: Record<string, unknown>) => {
      const start = Date.now();
      const { operation, description, values, filters } = args as {
        operation: 'insert' | 'update' | 'delete';
        description: string;
        values?: Record<string, unknown>;
        filters?: Record<string, FilterValue | undefined>;
      };

      try {
        // Validate: INSERT and UPDATE require values
        if ((operation === 'insert' || operation === 'update') && (!values || Object.keys(values).length === 0)) {
          return {
            content: [{ type: 'text' as const, text: `Error: "${operation}" operation requires "values" (column-value pairs).` }],
            isError: true,
          };
        }

        // Validate: UPDATE and DELETE require filters
        if ((operation === 'update' || operation === 'delete') && (!filters || Object.keys(filters).length === 0)) {
          return {
            content: [{ type: 'text' as const, text: `Error: "${operation}" operation requires "filters" to identify target rows.` }],
            isError: true,
          };
        }

        // Validate column names in values
        if (values) {
          for (const colName of Object.keys(values)) {
            if (!validColumnNames.has(colName)) {
              return {
                content: [{ type: 'text' as const, text: `Error: Invalid column "${colName}". Available columns: ${[...validColumnNames].join(', ')}` }],
                isError: true,
              };
            }
          }
        }

        // Build parameterized SQL
        let sql: string;
        const params: unknown[] = [];
        let paramIndex = 1;

        switch (operation) {
          case 'insert': {
            // Enforce scope column on INSERT: user cannot insert rows for other users
            if (scopeGuard.active) {
              const scopeInfo = scopeGuard.getScopeInfo();
              const scopeFilter = scopeInfo.filters.find(f => f.tableName === tableName);
              if (scopeFilter) {
                const currentVal = values![scopeFilter.column];
                if (currentVal !== undefined && currentVal !== scopeFilter.value) {
                  return {
                    content: [{ type: 'text' as const, text: `Error: Cannot insert rows for another user. Column "${scopeFilter.column}" must match your identity.` }],
                    isError: true,
                  };
                }
                // Auto-inject scope column if not provided
                if (currentVal === undefined) {
                  values![scopeFilter.column] = scopeFilter.value;
                }
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
              return {
                content: [{ type: 'text' as const, text: 'Error: UPDATE requires at least one valid filter condition.' }],
                isError: true,
              };
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
              return {
                content: [{ type: 'text' as const, text: 'Error: DELETE requires at least one valid filter condition.' }],
                isError: true,
              };
            }
            sql = `DELETE FROM ${qualifiedTable} ${whereClause}`;
            break;
          }
        }

        // Submit to the write queue
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
            toolName,
            toolArgs: args,
            result: 'success',
            resultSummary: `Write request queued (ID: ${id})`,
            durationMs,
          });
        }

        return {
          content: [{
            type: 'text' as const,
            text: `Write request submitted for approval (ID: ${id}). An admin will review it.\n\nOperation: ${operation.toUpperCase()}\nTable: ${tableName}\nSQL: ${sql}\nParams: ${JSON.stringify(params)}`,
          }],
        };
      } catch (err) {
        const durationMs = Date.now() - start;
        if (onAuditLog) {
          onAuditLog({
            profileName,
            toolName,
            toolArgs: args,
            result: 'error',
            resultSummary: (err as Error).message,
            durationMs,
          });
        }
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
