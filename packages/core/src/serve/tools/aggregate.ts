import type { FilterValue } from '../filter-builder.js';
import { buildPlainConditions } from '../filter-builder.js';
import { zodEnum, buildAggregateArgsShape } from '../schema-builder.js';
import { executeWithAudit } from '../middleware/audit.js';
import { formatResponseRows } from '../response-formatter.js';
import type { ToolContext, AccessibleTable, DateBucket } from '../tool-context.js';
import { resolveTable, structuredError, didYouMean, dateBucketExpr } from '../tool-context.js';

// We use `as any` in server.tool() calls because the dynamic Zod schemas
// (Record<string, z.ZodTypeAny>) cause TS2589 "excessively deep" errors with
// the MCP SDK's generic overloads. The schemas are correctly constructed at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolArgs = any;

// ---------------------------------------------------------------------------
// Generic `aggregate` tool — single registration, all eligible tables.
// ---------------------------------------------------------------------------

export function registerAggregateGeneric(
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
    (at) => at.enabledTools.includes('aggregate') && at.numericCols.length > 0,
  );
  if (eligible.length === 0) return;
  const tableEnum = zodEnum(eligible.map((at) => at.table.name));
  if (!tableEnum) return;

  const inputShape = buildAggregateArgsShape(tableEnum);

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
            .filter((a) => a.enabledTools.includes('aggregate') && a.numericCols.length > 0)
            .map((a) => a.table.name),
        });
      }

      const tableName = at.table.name;
      const schemaName = at.table.schema || 'public';
      const qualifiedTable = dialect.quoteTable(schemaName, tableName);
      const maxLimit = at.opts?.maxLimit ?? 1000;
      const allowedFilterColumns = at.filterableCols.map((c) => c.name);

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
        {
          executeQuery,
          dialect,
          onAuditLog,
          profileName,
          toolName: toolName('aggregate'),
          toolArgs: args,
        },
        async (exec) => {
          const cappedLimit = Math.min(limit ?? 20, maxLimit);
          const cappedOffset = Math.min(offset ?? 0, maxOffset ?? 10_000);

          // offset is not compatible with compare_to (pagination of period
          // comparisons is ambiguous — both windows would need separate offsets).
          if (compare_to && cappedOffset > 0) {
            return structuredError({
              error:
                'offset is not compatible with compare_to — pagination of period comparisons is ambiguous',
            });
          }

          const {
            clause: whereClause,
            values,
            nextParamIndex,
          } = scopeGuard.buildWhereClause(tableName, filters, allowedFilterColumns, dialect);
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
              return structuredError({
                error: 'ratio_filter is required for aggregation: "ratio"',
              });
            }
            // The CASE WHEN expression appears twice in the SELECT (once for
            // `result`, once for `numerator`). Each occurrence has its own
            // positional placeholders, so we build the conditions twice with
            // independent paramIndex windows and push the values twice. This
            // keeps SQLite (`?`) and Postgres (`$N`) consistent.
            const first = buildPlainConditions(
              ratio_filter,
              allowedFilterColumns,
              dialect,
              paramCursor,
            );
            if (first.conditions.length === 0) {
              return structuredError({
                error: 'ratio_filter has no usable conditions',
                valid_columns: allowedFilterColumns,
              });
            }
            values.push(...first.values);
            paramCursor = first.nextParamIndex;
            const second = buildPlainConditions(
              ratio_filter,
              allowedFilterColumns,
              dialect,
              paramCursor,
            );
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
            selectPrefix = group_by_bucket ? `${colExpr} as ${groupAlias}, ` : `${colExpr}, `;
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
                error:
                  '`top_n_per_group` requires `group_by` (and optionally `group_by_secondary`) to be set',
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
                error:
                  'compare_to: previous WHERE clause produced a different number of params than current — likely an internal bug',
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
