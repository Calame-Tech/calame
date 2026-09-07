// ---------------------------------------------------------------------------
// SQL type-name families — the single source of truth for classifying a
// column's declared type across every supported backend.
//
// WHY THIS MODULE EXISTS: these families used to be duplicated as inline
// `t === '...' || t === '...'` chains in five places (pgTypeToZod,
// isNumericType, friendlyTypeLabel, friendlyType, looksLikeCategorical).
// When SQL Server support landed, its type names (`nvarchar`, `bit`,
// `datetime2`, …) were absent from all of them, so `pgTypeToZod` returned
// null for every text column, `filterableCols` came back empty, and the
// filter builder then silently dropped every user filter — queries quietly
// returned unfiltered rows. The same gap existed for MySQL `datetime` /
// `float` / `double` / `tinyint` and SQLite `datetime`.
//
// Adding a backend now means adding its names to the sets below, once.
// Every classifier reads from here, so none can fall out of step again.
//
// Type names are compared lowercase and bare (no length/precision): that is
// what `information_schema.columns.data_type` reports on PostgreSQL, MySQL and
// SQL Server alike (e.g. `nvarchar`, never `nvarchar(255)`).
// ---------------------------------------------------------------------------

/** Textual types, exposed to the LLM as `string`. */
const STRING_TYPES = new Set([
  // PostgreSQL
  'text',
  'varchar',
  'character varying',
  'char',
  'character',
  'name',
  'citext',
  'uuid',
  'xml',
  'inet',
  'cidr',
  'macaddr',
  // MySQL / MariaDB
  'tinytext',
  'mediumtext',
  'longtext',
  'enum',
  'set',
  // SQL Server
  'nvarchar',
  'nchar',
  'ntext',
  'sysname',
  'uniqueidentifier',
]);

/**
 * Date / time types, exposed as ISO-8601 strings.
 *
 * CAVEAT: `timestamp` means a date on PostgreSQL and MySQL but is a synonym
 * for `rowversion` (an 8-byte binary) on SQL Server. These classifiers see
 * only the type name, not the dialect, so a SQL Server `rowversion` column is
 * treated as a date-ish string. Harmless in practice — rowversion columns are
 * concurrency tokens, not analytical data — and disambiguating would mean
 * threading the dialect through every classifier.
 */
const DATE_TYPES = new Set([
  // PostgreSQL
  'timestamp',
  'timestamp with time zone',
  'timestamp without time zone',
  'timestamptz',
  'date',
  'time',
  'time with time zone',
  'time without time zone',
  'timetz',
  'interval',
  // MySQL / MariaDB / SQLite
  'datetime',
  'year',
  // SQL Server
  'datetime2',
  'smalldatetime',
  'datetimeoffset',
]);

/** Integers that can exceed 2^53 — exposed as strings to preserve precision. */
const BIG_INT_TYPES = new Set(['bigint', 'int8', 'bigserial']);

/** Integer types narrow enough to be safe as JS numbers. */
const SMALL_INT_TYPES = new Set([
  // PostgreSQL
  'integer',
  'int',
  'int4',
  'smallint',
  'int2',
  'serial',
  'smallserial',
  'oid',
  // MySQL / MariaDB
  'tinyint',
  'mediumint',
]);

/** Real / fixed-point numeric types. */
const DECIMAL_TYPES = new Set([
  // PostgreSQL
  'real',
  'float4',
  'double precision',
  'float8',
  'numeric',
  'decimal',
  'money',
  // MySQL / MariaDB
  'float',
  'double',
  'dec',
  'fixed',
  // SQL Server
  'smallmoney',
]);

/**
 * Boolean types. SQL Server spells it `bit`; MySQL's `BIT(1)` is used the same
 * way, and filter values are coerced to 0/1 for every non-PostgreSQL backend.
 */
const BOOLEAN_TYPES = new Set(['boolean', 'bool', 'bit']);

/**
 * String types that are technically text but too unwieldy to enumerate as
 * categorical values during the boot-time distinct-values pass.
 */
const NON_CATEGORICAL_STRING_TYPES = new Set([
  'xml',
  'inet',
  'cidr',
  'macaddr',
  'ntext',
  'longtext',
  'mediumtext',
]);

/**
 * Binary and structured types are deliberately absent from every family
 * above, so they classify as unsupported and stay out of filter/aggregate
 * surfaces. Listed here only as documentation of the intent — PostgreSQL
 * `bytea` / `json` / `jsonb`, MySQL `blob` family, SQL Server `binary`,
 * `varbinary`, `image`, `rowversion`, `geography`, `geometry`, `hierarchyid`
 * and `sql_variant`.
 */
export const UNSUPPORTED_TYPE_EXAMPLES = Object.freeze([
  'bytea',
  'json',
  'jsonb',
  'blob',
  'binary',
  'varbinary',
  'image',
  'rowversion',
]);

/** Normalize a declared type for comparison against the families above. */
function normalize(sqlType: string): string {
  return sqlType.trim().toLowerCase();
}

export function isStringType(sqlType: string): boolean {
  return STRING_TYPES.has(normalize(sqlType));
}

export function isDateType(sqlType: string): boolean {
  return DATE_TYPES.has(normalize(sqlType));
}

export function isBigIntType(sqlType: string): boolean {
  return BIG_INT_TYPES.has(normalize(sqlType));
}

export function isBooleanType(sqlType: string): boolean {
  return BOOLEAN_TYPES.has(normalize(sqlType));
}

/**
 * True for any numeric type, including the big integers that are *exposed* as
 * strings — they are still valid SUM/AVG targets.
 */
export function isNumericSqlType(sqlType: string): boolean {
  const t = normalize(sqlType);
  return SMALL_INT_TYPES.has(t) || DECIMAL_TYPES.has(t) || BIG_INT_TYPES.has(t);
}

/** True for string types worth enumerating as low-cardinality categoricals. */
export function isCategoricalStringType(sqlType: string): boolean {
  const t = normalize(sqlType);
  return STRING_TYPES.has(t) && !NON_CATEGORICAL_STRING_TYPES.has(t);
}

/** True for integers narrow enough to plausibly hold a status code / enum. */
export function isSmallIntType(sqlType: string): boolean {
  return SMALL_INT_TYPES.has(normalize(sqlType));
}
