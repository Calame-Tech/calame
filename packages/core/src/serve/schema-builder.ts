import { z } from 'zod';
import { makeFilterMapSchema, FILTER_OPS_DESC } from './filter-builder.js';

// ---------------------------------------------------------------------------
// Tool argument schemas (Zod). One builder per MCP tool, plus the shared
// operator vocabularies and the `zodEnum` helper. The schemas only depend on
// the per-request `tableEnum` (the allowlist of table names the caller may
// target); everything else is static. Extracted from dynamic-tools.ts so the
// tool registrations there keep only handler / orchestration logic.
// ---------------------------------------------------------------------------

// Shared constants — referenced in Zod .describe() calls to avoid repeating
// verbose strings multiple times in the tool manifest.
const AGG_OPS = ['count', 'sum', 'avg', 'min', 'max', 'ratio', 'count_distinct', 'weighted_ratio', 'median', 'stddev', 'variance', 'percentile'] as const;
const AGG_OPS_JOIN = ['count', 'sum', 'avg', 'min', 'max', 'ratio', 'count_distinct', 'weighted_ratio', 'median', 'stddev', 'variance', 'percentile'] as const;
const DATE_BUCKETS = ['day', 'week', 'month', 'quarter', 'year'] as const;
const ORDER_DIRS = ['asc', 'desc'] as const;

/** Create a Zod enum from a non-empty array, or return undefined when empty
 *  (z.enum rejects an empty list). Used to build the per-request table enum. */
export function zodEnum<T extends string>(values: T[]): z.ZodTypeAny | undefined {
  if (values.length === 0) return undefined;
  return z.enum(values as unknown as readonly [string, ...string[]]);
}

/** Argument schema for the single-table `aggregate` tool. */
export function buildAggregateArgsShape(tableEnum: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  return {
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
}

/** Argument schema for the cross-table `join_aggregate` tool. */
export function buildJoinAggregateArgsShape(tableEnum: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  return {
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
}

/** Argument schema for the row-fetch `query` tool. */
export function buildQueryArgsShape(tableEnum: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  return {
    table: tableEnum.describe('Target table. See TABLES & COLUMNS.'),
    columns: z.array(z.string()).optional().describe('Columns to return (default: all visible).'),
    filters: makeFilterMapSchema().describe(`WHERE filters. ${FILTER_OPS_DESC}`),
    order_by: z.string().optional(),
    order_direction: z.enum(ORDER_DIRS).optional(),
    limit: z.number().optional().default(20).describe('Max rows (≤1000).'),
    offset: z.number().optional().default(0),
    sample: z.boolean().optional().describe('Return random rows.'),
  };
}

/** Argument schema for the `describe` tool. */
export function buildDescribeArgsShape(tableEnum: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  return {
    table: tableEnum.describe('Table to describe.'),
  };
}

/** Argument schema for the `write` tool (INSERT/UPDATE/DELETE proposals). */
export function buildWriteArgsShape(tableEnum: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  return {
    table: tableEnum.describe('Target table.'),
    operation: z.enum(['insert', 'update', 'delete']).describe('Write operation.'),
    description: z.string().describe('What this write does and why.'),
    values: z.record(z.string(), z.any()).optional().describe('Column-value pairs for INSERT or UPDATE.'),
    filters: makeFilterMapSchema().describe('Filters for UPDATE/DELETE (required for those).'),
  };
}
