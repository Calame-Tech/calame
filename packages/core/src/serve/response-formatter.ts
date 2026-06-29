/**
 * Response Abstraction Mode — utility functions for the friendly/raw toggle.
 *
 * In "friendly" mode tool responses hide technical database identifiers
 * (table names, column names, SQL types) and expose human-readable labels
 * instead.  In "raw" mode every function is a no-op and the original data
 * passes through untouched.
 */

// ---------------------------------------------------------------------------
// snakeCaseToLabel
// ---------------------------------------------------------------------------

/**
 * Convert a snake_case or camelCase identifier to a human-readable Title Case
 * label.
 *
 * Examples:
 *   "user_accounts"   -> "User Accounts"
 *   "firstName"       -> "First Name"
 *   "created_at"      -> "Created At"
 *   "billing_invoices"-> "Billing Invoices"
 *   "id"              -> "Id"
 *   "userID"          -> "User Id"
 */
export function snakeCaseToLabel(name: string): string {
  if (!name) return name;

  // First, split on underscores
  const byUnderscore = name.split('_');

  // Then, within each segment, split on camelCase boundaries
  // e.g. "firstName" -> ["first", "Name"] -> ["first", "name"]
  const words: string[] = [];
  for (const segment of byUnderscore) {
    if (!segment) continue;
    // Insert a space before any uppercase letter that follows a lowercase letter or digit
    // and before any sequence of uppercase letters followed by a lowercase letter
    const split = segment
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(' ');
    words.push(...split.filter((w) => w.length > 0));
  }

  // Capitalize the first letter of every word, lowercase the rest
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// ---------------------------------------------------------------------------
// friendlyType
// ---------------------------------------------------------------------------

/**
 * Translate a SQL column type to a simple human-readable term (in French, as
 * per project communication guidelines for end-user–facing content).
 *
 * "integer", "bigint", "numeric", "decimal" -> "Nombre"
 * "text", "varchar", "char"                -> "Texte"
 * "boolean"                               -> "Oui/Non"
 * "timestamp", "date", "time"             -> "Date"
 * "json", "jsonb"                         -> "Donnees"
 * default                                 -> "Texte"
 */
export function friendlyType(sqlType: string): string {
  const t = sqlType.toLowerCase().trim();

  if (
    t === 'integer' ||
    t === 'int' ||
    t === 'int2' ||
    t === 'int4' ||
    t === 'int8' ||
    t === 'smallint' ||
    t === 'bigint' ||
    t === 'serial' ||
    t === 'smallserial' ||
    t === 'bigserial' ||
    t === 'numeric' ||
    t === 'decimal' ||
    t === 'real' ||
    t === 'float4' ||
    t === 'float8' ||
    t === 'double precision' ||
    t === 'money' ||
    t === 'oid'
  ) {
    return 'Nombre';
  }

  if (t === 'boolean' || t === 'bool') {
    return 'Oui/Non';
  }

  if (
    t === 'timestamp' ||
    t === 'timestamp with time zone' ||
    t === 'timestamp without time zone' ||
    t === 'timestamptz' ||
    t === 'date' ||
    t === 'time' ||
    t === 'time with time zone' ||
    t === 'time without time zone' ||
    t === 'timetz' ||
    t === 'interval'
  ) {
    return 'Date';
  }

  if (t === 'json' || t === 'jsonb') {
    return 'Donnees';
  }

  // All remaining types (text, varchar, char, uuid, inet, etc.) -> Texte
  return 'Texte';
}

// ---------------------------------------------------------------------------
// buildLabelMap
// ---------------------------------------------------------------------------

/**
 * Build a map of { columnName -> label } for a table's columns.
 *
 * If a column entry carries a custom `label`, that value is used directly.
 * Otherwise the label is auto-generated via `snakeCaseToLabel`.
 */
export function buildLabelMap(
  columns: Array<{ name: string; label?: string }>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const col of columns) {
    map[col.name] = col.label ?? snakeCaseToLabel(col.name);
  }
  return map;
}

// ---------------------------------------------------------------------------
// buildReverseLabelMap
// ---------------------------------------------------------------------------

/**
 * Build the inverse map of `buildLabelMap`: { label -> columnName }.
 *
 * Used to translate user-supplied labels back to real column names before
 * building SQL queries.
 *
 * If two columns share the same label (should not happen in practice), the
 * last one wins.
 */
export function buildReverseLabelMap(labelMap: Record<string, string>): Record<string, string> {
  const reverse: Record<string, string> = {};
  for (const [colName, label] of Object.entries(labelMap)) {
    reverse[label] = colName;
  }
  return reverse;
}

// ---------------------------------------------------------------------------
// formatResponseRows
// ---------------------------------------------------------------------------

/**
 * Return rows with column keys preserved as-is (snake_case from the database).
 *
 * Keys are NEVER renamed — neither in 'raw' nor in 'friendly' mode — so that
 * LLM chaining works correctly: a field name read from a query result can be
 * used verbatim as a filter key in the next tool call.
 *
 * The `labelMap` and `mode` parameters are kept for API compatibility but no
 * longer drive key renaming.  Empty arrays are returned unchanged.
 */
export function formatResponseRows(
  rows: Record<string, unknown>[],
  _labelMap: Record<string, string>,
  _mode: 'friendly' | 'raw',
): Record<string, unknown>[] {
  return rows;
}
