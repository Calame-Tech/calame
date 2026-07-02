import type { FilterValue } from '../filter-builder.js';
import { zodEnum, buildQueryArgsShape } from '../schema-builder.js';
import { executeWithAudit } from '../middleware/audit.js';
import { applyMasking, type MaskingRule } from '../middleware/masking.js';
import { formatResponseRows } from '../response-formatter.js';
import type { ToolContext, AccessibleTable } from '../tool-context.js';
import { resolveTable, structuredError, didYouMean, isTextType } from '../tool-context.js';

// We use `as any` in server.tool() calls because the dynamic Zod schemas
// (Record<string, z.ZodTypeAny>) cause TS2589 "excessively deep" errors with
// the MCP SDK's generic overloads. The schemas are correctly constructed at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolArgs = any;

// ---------------------------------------------------------------------------
// Generic `query` tool.
// ---------------------------------------------------------------------------

export function registerQueryGeneric(
  ctx: ToolContext,
  accessible: AccessibleTable[],
  catalogue: string,
): void {
  const {
    server,
    executeQuery,
    dialect,
    onAuditLog,
    profileName,
    responseMode,
    wrapResponse,
    maxOffset,
    scopeGuard,
    toolName,
  } = ctx;

  const eligible = accessible.filter(
    (at) => at.enabledTools.includes('query') && at.allColumnNames.length > 0,
  );
  if (eligible.length === 0) return;
  const tableEnum = zodEnum(eligible.map((at) => at.table.name));
  if (!tableEnum) return;

  const inputShape = buildQueryArgsShape(tableEnum);

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
      const queryableColumnNames = at.allColumnNames.filter((c) => !queryExcludedCols.has(c));
      const allowedFilterColumns = at.filterableCols
        .filter((c) => !queryExcludedCols.has(c.name))
        .map((c) => c.name);

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
        {
          executeQuery,
          dialect,
          onAuditLog,
          profileName,
          toolName: toolName('query'),
          toolArgs: args,
        },
        async (exec) => {
          const cappedLimit = Math.min(limit ?? 20, maxLimit);
          const cappedOffset = Math.min(offset ?? 0, maxOffset);

          const {
            clause: whereClause,
            values,
            nextParamIndex,
          } = scopeGuard.buildWhereClause(tableName, filters, allowedFilterColumns, dialect);
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
            selectExpr = columns.map((c) => dialect.quoteIdent(c)).join(', ');
          } else {
            selectExpr = queryableColumnNames.map((c) => dialect.quoteIdent(c)).join(', ');
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

          const maskedRows = needsMasking
            ? applyMasking(result.rows, queryMaskingRules)
            : result.rows;
          const formattedRows = formatResponseRows(maskedRows, at.labelMap, responseMode);

          // Zero-result hint: if filters returned 0 rows, fetch distinct values
          // for filtered text columns and surface as did-you-mean hints.
          let zeroResultHint = '';
          if (formattedRows.length === 0 && filters && Object.keys(filters).length > 0) {
            try {
              const filteredCols = Object.keys(filters).filter((k) => filters[k] !== undefined);
              const textCols = filteredCols.filter((col) => {
                const colInfo = at.visibleColumns.find((c) => c.name === col);
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
                const vals = r.rows.map((row) => String((row as Record<string, unknown>).val));
                if (vals.length > 0) hints.push(`Possible values for '${col}': ${vals.join(', ')}`);
              }
              if (hints.length > 0) {
                zeroResultHint =
                  '\n\nNo results. ' + hints.join('. ') + '. Retry with one of these exact values.';
              }
            } catch {
              // Non-critical
            }
          }

          const text = wrapResponse(JSON.stringify(formattedRows, null, 2)) + zeroResultHint;
          return {
            content: [{ type: 'text' as const, text }],
            resultSummary: `${formattedRows.length} rows`,
            resultData: text,
          };
        },
      );
    },
  );
}
