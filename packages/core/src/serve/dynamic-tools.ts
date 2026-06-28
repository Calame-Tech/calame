import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TableInfo, Relation, TableToolOptions } from '../introspect/types.js';
import { ColumnMasking } from '../pii/types.js';
import type { AuditLogEntry, PendingWriteQuery } from './types.js';
import { buildLabelMap } from './response-formatter.js';
import type { ScopeGuard } from './scoped-executor.js';
import { ScopeBlockedError, createScopeGuard } from './scoped-executor.js';
import { buildMaskingRules } from './middleware/masking.js';
import type { ToolContext, AccessibleTable } from './tool-context.js';
import {
  makeDialect,
  pgTypeToZod,
  isNumericType,
  detectDateFormat,
  friendlyTypeLabel,
} from './tool-context.js';
import { registerListTablesGeneric } from './tools/list-tables.js';
import { registerAggregateGeneric } from './tools/aggregate.js';
import { registerJoinAggregateGeneric } from './tools/join-aggregate.js';
import { registerQueryGeneric } from './tools/query.js';
import { registerDescribeGeneric } from './tools/describe.js';
import { registerWriteGeneric } from './tools/write.js';

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

// ---------------------------------------------------------------------------
// Catalogue builders — baked into the `aggregate` and `query` tool descriptions.
// ---------------------------------------------------------------------------

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

export function registerCalcTool(
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
