import { Relation } from '../../introspect/types.js';
import type { FilterValue } from '../filter-builder.js';
import { zodEnum, buildJoinAggregateArgsShape } from '../schema-builder.js';
import { executeWithAudit } from '../middleware/audit.js';
import { applyMasking } from '../middleware/masking.js';
import { formatResponseRows } from '../response-formatter.js';
import { findJoinPath, computeTransitiveClosure } from '../join-path.js';
import type { ToolContext, AccessibleTable, DateBucket } from '../tool-context.js';
import { structuredError, didYouMean, dateBucketExpr } from '../tool-context.js';

// We use `as any` in server.tool() calls because the dynamic Zod schemas
// (Record<string, z.ZodTypeAny>) cause TS2589 "excessively deep" errors with
// the MCP SDK's generic overloads. The schemas are correctly constructed at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolArgs = any;

// ---------------------------------------------------------------------------
// Generic `join_aggregate` tool — INNER JOIN of two FK-linked tables with
// count/sum/avg/min/max + optional GROUP BY. Lets the LLM answer cross-table
// analytical questions ("top couriers by delivered package count") in a
// single call instead of paginating two per-table aggregates and merging
// client-side. Restricted to tables linked by a declared FK so the SQL is
// always sound.
// ---------------------------------------------------------------------------

export function registerJoinAggregateGeneric(
  ctx: ToolContext,
  accessible: AccessibleTable[],
  allRelations: Relation[],
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

  // Only tables where aggregate is enabled. Disabling aggregate on a table
  // must also block joins against it.
  const eligible = accessible.filter((at) => at.enabledTools.includes('aggregate'));
  if (eligible.length < 2) return;

  // Restrict the table enum to tables that have at least one FK pointing to
  // (or coming from) another eligible table. No FK -> no JOIN possible.
  const eligibleNames = new Set(eligible.map((at) => at.table.name));
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

  const inputShape = buildJoinAggregateArgsShape(tableEnum);

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
        aggregation:
          | 'count'
          | 'sum'
          | 'avg'
          | 'min'
          | 'max'
          | 'ratio'
          | 'count_distinct'
          | 'weighted_ratio'
          | 'median'
          | 'stddev'
          | 'variance'
          | 'percentile';
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
        {
          executeQuery,
          dialect,
          onAuditLog,
          profileName,
          toolName: toolName('join_aggregate'),
          toolArgs: args,
        },
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
              return structuredError({
                error: 'ratio_filter is required for aggregation: "ratio"',
              });
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
          } else if (
            aggregation === 'median' ||
            aggregation === 'percentile' ||
            aggregation === 'stddev' ||
            aggregation === 'variance'
          ) {
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
                  error:
                    'percentile_p is required when aggregation is "percentile" (e.g. 0.95 for p95)',
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
              conditions.push(
                `${alias}.${dialect.quoteIdent(sf.column)} = ${dialect.param(paramIndex++)}`,
              );
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
                  conditions.push(
                    `${qi} >= ${dialect.param(paramIndex++)} AND ${qi} <= ${dialect.param(paramIndex++)}`,
                  );
                  values.push(min, max);
                  break;
                }
                case 'in': {
                  const raw = filter.value;
                  const arr: unknown[] = Array.isArray(raw)
                    ? raw
                    : typeof raw === 'string'
                      ? raw
                          .split(',')
                          .map((s) => s.trim())
                          .filter((s) => s.length > 0)
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

          const r1 = buildPrefixedFilters(
            primary_table,
            pAlias,
            filters,
            pAt.filterableCols.map((c) => c.name),
          );
          if (!r1.ok) return structuredError(r1.payload);
          const r2 = buildPrefixedFilters(
            join_table,
            jAlias,
            join_filters,
            jAt.filterableCols.map((c) => c.name),
          );
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
              conditions.push(
                `${intermediateAlias}.${dialect.quoteIdent(sf.column)} = ${dialect.param(paramIndex++)}`,
              );
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
            if (colRule2)
              rows = applyMasking(rows, { [groupBySecondaryOriginal.column]: colRule2 });
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
              labelMap[groupBySecondaryOriginal.column] =
                at2.labelMap[groupBySecondaryOriginal.column];
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
