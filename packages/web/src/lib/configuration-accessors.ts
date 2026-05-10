/**
 * Accessors for the `Configuration` type, reading from the unified `scopes`
 * shape (Phase 5+). All helpers return safe empty fallbacks so call sites never
 * hit `Object.keys(undefined)`.
 *
 * Mirrors the profile-level accessor pattern in `profile-accessors.ts` but
 * targeting `Configuration` objects (named data profiles) rather than `Profile`
 * objects (serve profiles).
 */
import type { Configuration, TableToolOptions, ColumnMasking } from '../types/schema.js';

/** All distinct table names visible across the configuration's relational scopes. */
export function getConfigurationTableNames(cfg: Configuration): string[] {
  const names = new Set<string>();
  if (cfg.scopes) {
    for (const scope of Object.values(cfg.scopes)) {
      if (scope.kind === 'relational') {
        for (const table of Object.keys(scope.selectedTables ?? {})) {
          names.add(table);
        }
      }
    }
  }
  return Array.from(names);
}

/**
 * Merged `selectedTables` (table → column list) across all relational scopes.
 * When multiple scopes expose the same table, columns are unioned.
 */
export function getConfigurationSelectedTables(cfg: Configuration): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!cfg.scopes) return result;
  for (const scope of Object.values(cfg.scopes)) {
    if (scope.kind !== 'relational') continue;
    for (const [table, cols] of Object.entries(scope.selectedTables ?? {})) {
      if (!result[table]) {
        result[table] = [...cols];
      } else {
        const existing = new Set(result[table]);
        for (const col of cols) existing.add(col);
        result[table] = Array.from(existing);
      }
    }
  }
  return result;
}

/**
 * Merged `tableOptions` across all relational scopes. Last writer wins per
 * table when multiple scopes define options for the same table.
 */
export function getConfigurationTableOptions(cfg: Configuration): Record<string, TableToolOptions> {
  const result: Record<string, TableToolOptions> = {};
  if (!cfg.scopes) return result;
  for (const scope of Object.values(cfg.scopes)) {
    if (scope.kind !== 'relational') continue;
    for (const [table, opts] of Object.entries(scope.tableOptions ?? {})) {
      result[table] = opts;
    }
  }
  return result;
}

/**
 * Merged `columnMasking` across all relational scopes. Last writer wins per
 * (table, column) pair when multiple scopes define masking for the same column.
 */
export function getConfigurationColumnMasking(
  cfg: Configuration,
): Record<string, Record<string, ColumnMasking>> {
  const result: Record<string, Record<string, ColumnMasking>> = {};
  if (!cfg.scopes) return result;
  for (const scope of Object.values(cfg.scopes)) {
    if (scope.kind !== 'relational') continue;
    for (const [table, cols] of Object.entries(scope.columnMasking ?? {})) {
      result[table] = { ...(result[table] ?? {}), ...cols };
    }
  }
  return result;
}

/** Source ids of `kind: 'relational'` scopes in this configuration. */
export function getConfigurationRelationalSources(cfg: Configuration): string[] {
  if (!cfg.sources || !cfg.scopes) return [];
  return cfg.sources.filter((id) => cfg.scopes![id]?.kind === 'relational');
}
