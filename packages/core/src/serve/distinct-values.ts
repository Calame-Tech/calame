import type { TableInfo } from '../introspect/types.js';
import type { ColumnMasking } from '../pii/types.js';

export interface ComputeDistinctValuesOptions {
  /** Tables visible to the profile (already filtered by `selectedTables`). */
  tables: TableInfo[];
  /** Per-table list of column names visible to the profile. */
  selectedTables: Record<string, string[]>;
  /** Per-table column masking — `exclude` mode hides the column entirely. */
  columnMasking?: Record<string, Record<string, ColumnMasking>>;
  /**
   * Connector-level executor. Must produce `{ rows, fields }` like
   * `registerDynamicTools` expects.
   */
  executeQuery: (
    sql: string,
    params: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; fields: { name: string }[] }>;
  databaseType: 'postgresql' | 'mysql' | 'sqlite';
  /** Cap on per-column distinct values kept; columns above are skipped. */
  maxValues?: number;
  /** Per-column timeout (ms). Skipped silently on overrun. */
  perQueryTimeoutMs?: number;
}

/**
 * Walk every visible categorical column of every visible table and run
 * `SELECT DISTINCT … LIMIT maxValues+1`. Columns that come back with at most
 * `maxValues` distinct values are kept; others are skipped (the threshold + 1
 * trick avoids a separate COUNT pass).
 *
 * The result feeds the catalogue baked into the description of `aggregate`,
 * `query`, `join_aggregate` so the LLM sees `enum:livre|echec|…` instead of
 * a generic `string` and can't silently send an unknown value.
 *
 * Errors on individual columns are swallowed — a single permission glitch on
 * one column shouldn't blow up the whole MCP handshake.
 */
export async function computeDistinctValues(
  opts: ComputeDistinctValuesOptions,
): Promise<Record<string, Record<string, unknown[]>>> {
  const maxValues = opts.maxValues ?? 20;
  const result: Record<string, Record<string, unknown[]>> = {};

  for (const table of opts.tables) {
    const selectedCols = opts.selectedTables[table.name];
    if (!selectedCols || selectedCols.length === 0) continue;

    const tableMasking = opts.columnMasking?.[table.name];
    const excludedCols = new Set<string>();
    if (tableMasking) {
      for (const [colName, m] of Object.entries(tableMasking)) {
        if (m.maskingMode === 'exclude') excludedCols.add(colName);
      }
    }

    const visibleColumns = table.columns.filter(
      (c) => selectedCols.includes(c.name) && !excludedCols.has(c.name) && looksLikeCategorical(c.type),
    );
    if (visibleColumns.length === 0) continue;

    const tableValues: Record<string, unknown[]> = {};
    const qualifiedTable = quoteTable(table.schema, table.name, opts.databaseType);

    for (const col of visibleColumns) {
      const qi = quoteIdent(col.name, opts.databaseType);
      const sql =
        `SELECT DISTINCT ${qi} AS val FROM ${qualifiedTable} ` +
        `WHERE ${qi} IS NOT NULL ORDER BY val LIMIT ${maxValues + 1}`;
      try {
        const queryPromise = opts.executeQuery(sql, []);
        const r = opts.perQueryTimeoutMs
          ? await Promise.race([
              queryPromise,
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), opts.perQueryTimeoutMs),
              ),
            ])
          : await queryPromise;
        const vals = r.rows.map((row) => (row as Record<string, unknown>).val);
        // Skip columns with too many distinct values — they're not enum-like.
        if (vals.length > 0 && vals.length <= maxValues) {
          tableValues[col.name] = vals;
        }
      } catch {
        // Per-column failure: skip silently. Catalogue falls back to type label.
      }
    }

    if (Object.keys(tableValues).length > 0) {
      result[table.name] = tableValues;
    }
  }
  return result;
}

/**
 * Heuristic: only run the distinct-values pass on columns whose SQL type is
 * likely to be a low-cardinality categorical. Floats, blobs, dates, JSON,
 * etc. are skipped to keep the boot pass fast on large schemas.
 */
function looksLikeCategorical(sqlType: string): boolean {
  const t = sqlType.toLowerCase();
  // String-like
  if (
    t === 'text' || t === 'varchar' || t === 'character varying' ||
    t === 'char' || t === 'character' || t === 'name' || t === 'citext' ||
    t === 'uuid'
  ) return true;
  // Integer types — covers bool-as-int (0/1), status codes, small enums.
  if (
    t === 'integer' || t === 'int' || t === 'int4' ||
    t === 'smallint' || t === 'int2' || t === 'tinyint' ||
    t === 'serial' || t === 'smallserial'
  ) return true;
  // Boolean
  if (t === 'boolean' || t === 'bool') return true;
  return false;
}

function quoteIdent(name: string, dbType: string): string {
  return dbType === 'mysql' ? '`' + name + '`' : '"' + name + '"';
}

function quoteTable(schema: string | undefined, table: string, dbType: string): string {
  const t = quoteIdent(table, dbType);
  if (dbType === 'postgresql' && schema) {
    return quoteIdent(schema, dbType) + '.' + t;
  }
  return t;
}
