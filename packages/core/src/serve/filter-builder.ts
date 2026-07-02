import { z } from 'zod';

// ---------------------------------------------------------------------------
// Filter primitives — the single home for turning structured filter operators
// into parameterized SQL. Both the scope-aware WHERE assembly
// (`scoped-executor.ts`) and the MCP tool layer (`dynamic-tools.ts`) build on
// these. Keeping the types and the condition builder together removes the
// previous duplication where `FilterOperator`/`FilterValue` were declared in
// two places and could silently drift apart.
// ---------------------------------------------------------------------------

export type FilterOperator =
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

export interface FilterValue {
  op: FilterOperator;
  value: unknown;
}

export interface Dialect {
  /** Backend type. Lets call sites pick exact syntax (e.g. SQLite strftime
   *  vs MySQL DATE_FORMAT) when a uniform SQL function is missing. */
  databaseType: 'postgresql' | 'mysql' | 'sqlite';
  /** True for PostgreSQL (affects IN clause: uses ANY($n) vs IN (?, ?...)) */
  isPostgres: boolean;
  /** Quote an identifier (table or column name) */
  quoteIdent: (name: string) => string;
  /** Quote a schema-qualified table name */
  quoteTable: (schema: string, table: string) => string;
  /** Return the next parameter placeholder and advance the counter */
  param: (index: number) => string;
  /** RANDOM() function name */
  random: string;
  /**
   * Statistical aggregation support. True for PostgreSQL (ordered-set
   * aggregate functions), false for MySQL and SQLite.
   */
  supportsPercentile: boolean;
  /** PERCENTILE_CONT(0.5) or equivalent for median. Returns null if unsupported. */
  medianExpr: (col: string) => string | null;
  /** PERCENTILE_CONT(p) or equivalent. Returns null if unsupported. */
  percentileExpr: (col: string, p: number) => string | null;
  /** STDDEV_SAMP or equivalent. Returns null if unsupported. */
  stddevExpr: (col: string) => string | null;
  /** VAR_SAMP or equivalent. Returns null if unsupported. */
  varianceExpr: (col: string) => string | null;
}

/** Human-readable list of supported filter operators (for MCP tool descriptions). */
export const FILTER_OPS_DESC =
  'Filters: eq|neq|gt|gte|lt|lte|between(value=[min,max])|in(value=[])|is_null|is_not_null|contains|starts_with|ends_with';

/**
 * Filter-map Zod schema shared by aggregate/query/write. Intentionally untyped
 * at the value level — runtime validates against per-column metadata so the
 * schema stays free of `anyOf`/`oneOf` constructs that Gemini's
 * function-calling rejects.
 */
export function makeFilterMapSchema(): z.ZodTypeAny {
  return z
    .record(
      z.string(),
      z.object({
        op: z.enum([
          'eq',
          'neq',
          'gt',
          'gte',
          'lt',
          'lte',
          'between',
          'in',
          'is_null',
          'is_not_null',
          'contains',
          'starts_with',
          'ends_with',
        ]),
        value: z.any().optional(),
      }),
    )
    .optional();
}

// ---------------------------------------------------------------------------
// WHERE condition builder
// ---------------------------------------------------------------------------

/**
 * Coerce a filter value for binding. SQLite and MySQL drivers reject native
 * JS booleans (better-sqlite3 throws "can only bind numbers, strings,
 * bigints, buffers, and null"). LLMs naturally pass `true`/`false` for
 * BOOLEAN-like columns that are actually stored as INTEGER 0/1, so we
 * normalize them here. PostgreSQL has a native bool type and accepts
 * booleans directly, so we leave them alone there.
 */
function coerceValue(value: unknown, dialect: Dialect): unknown {
  if (typeof value === 'boolean' && !dialect.isPostgres) {
    return value ? 1 : 0;
  }
  return value;
}

/**
 * Build WHERE-style conditions (no leading WHERE keyword, no scope filters).
 * Same security guarantees as the scope-aware path: column allowlist check
 * and parameterized binding (no concat). Exported for tools that need to
 * inject the conditions inside a SELECT expression (e.g. ratio aggregation
 * uses `SUM(CASE WHEN <conds> THEN 1 ELSE 0 END)`).
 */
export function buildPlainConditions(
  filters: Record<string, FilterValue | undefined>,
  allowedColumns: string[],
  dialect: Dialect,
  startParamIndex: number,
): { conditions: string[]; values: unknown[]; nextParamIndex: number } {
  return buildWhereConditions(filters, allowedColumns, dialect, startParamIndex);
}

export function buildWhereConditions(
  filters: Record<string, FilterValue | undefined>,
  allowedColumns: string[],
  dialect: Dialect,
  startParamIndex: number,
): { conditions: string[]; values: unknown[]; nextParamIndex: number } {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = startParamIndex;
  const allowed = new Set(allowedColumns);

  for (const [column, filter] of Object.entries(filters)) {
    if (!filter || !allowed.has(column)) continue;

    const qi = dialect.quoteIdent(column);

    switch (filter.op) {
      case 'eq':
        conditions.push(`${qi} = ${dialect.param(paramIndex++)}`);
        values.push(coerceValue(filter.value, dialect));
        break;
      case 'neq':
        conditions.push(`${qi} != ${dialect.param(paramIndex++)}`);
        values.push(coerceValue(filter.value, dialect));
        break;
      case 'gt':
        conditions.push(`${qi} > ${dialect.param(paramIndex++)}`);
        values.push(coerceValue(filter.value, dialect));
        break;
      case 'gte':
        conditions.push(`${qi} >= ${dialect.param(paramIndex++)}`);
        values.push(coerceValue(filter.value, dialect));
        break;
      case 'lt':
        conditions.push(`${qi} < ${dialect.param(paramIndex++)}`);
        values.push(coerceValue(filter.value, dialect));
        break;
      case 'lte':
        conditions.push(`${qi} <= ${dialect.param(paramIndex++)}`);
        values.push(coerceValue(filter.value, dialect));
        break;
      case 'between': {
        const [min, max] = filter.value as [unknown, unknown];
        conditions.push(
          `${qi} >= ${dialect.param(paramIndex++)} AND ${qi} <= ${dialect.param(paramIndex++)}`,
        );
        values.push(coerceValue(min, dialect), coerceValue(max, dialect));
        break;
      }
      case 'in': {
        // Normalize value to an array — accept both an array and a comma-separated string
        const rawIn = filter.value;
        const valueArray: unknown[] = Array.isArray(rawIn)
          ? rawIn
          : typeof rawIn === 'string'
            ? rawIn
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s.length > 0)
            : [rawIn];

        if (valueArray.length === 0) {
          // Empty IN list — intentionally matches nothing
          conditions.push('1=0');
          break;
        }

        const coercedArray = valueArray.map((v) => coerceValue(v, dialect));

        if (dialect.isPostgres) {
          conditions.push(`${qi} = ANY(${dialect.param(paramIndex++)})`);
          values.push(coercedArray);
        } else {
          const placeholders = coercedArray.map(() => dialect.param(paramIndex++));
          conditions.push(`${qi} IN (${placeholders.join(', ')})`);
          values.push(...coercedArray);
        }
        break;
      }
      case 'is_null':
        conditions.push(`${qi} IS NULL`);
        break;
      case 'is_not_null':
        conditions.push(`${qi} IS NOT NULL`);
        break;
      // String-pattern matching. We render case-insensitive `ILIKE` on
      // Postgres and `LIKE LOWER(...)` on MySQL / SQLite. The user value is
      // bound parameterized — the wildcards (`%`) are added in SQL, never in
      // the bound value, so this stays free of injection risk.
      case 'contains': {
        const v = String(filter.value ?? '');
        if (dialect.isPostgres) {
          conditions.push(`${qi} ILIKE '%' || ${dialect.param(paramIndex++)} || '%'`);
          values.push(v);
        } else {
          conditions.push(`LOWER(${qi}) LIKE '%' || LOWER(${dialect.param(paramIndex++)}) || '%'`);
          values.push(v);
        }
        break;
      }
      case 'starts_with': {
        const v = String(filter.value ?? '');
        if (dialect.isPostgres) {
          conditions.push(`${qi} ILIKE ${dialect.param(paramIndex++)} || '%'`);
          values.push(v);
        } else {
          conditions.push(`LOWER(${qi}) LIKE LOWER(${dialect.param(paramIndex++)}) || '%'`);
          values.push(v);
        }
        break;
      }
      case 'ends_with': {
        const v = String(filter.value ?? '');
        if (dialect.isPostgres) {
          conditions.push(`${qi} ILIKE '%' || ${dialect.param(paramIndex++)}`);
          values.push(v);
        } else {
          conditions.push(`LOWER(${qi}) LIKE '%' || LOWER(${dialect.param(paramIndex++)})`);
          values.push(v);
        }
        break;
      }
    }
  }

  return { conditions, values, nextParamIndex: paramIndex };
}
