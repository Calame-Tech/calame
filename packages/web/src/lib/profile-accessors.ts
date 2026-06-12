/**
 * Frontend mirror of `@calame/core/sources/accessors`. Reads from the unified
 * `scopes` shape (Phase 5+). The legacy flat fields (`selectedTables`,
 * `tableOptions`, `columnMasking`, `connections`) have been removed from the
 * `Profile` type — all accessors now read exclusively from `scopes`.
 *
 * Lives in `packages/web/` rather than re-exporting from `@calame/core` because
 * the web bundle uses its own structurally-equivalent mirror of `Profile` /
 * `ScopeSelection` (cf. `types/schema.ts`); pulling the core type would force
 * the web package to depend on the full TS definitions of the introspection /
 * PII modules, which it does not need.
 */
import type { Profile, TableToolOptions, ColumnMasking } from '../types/schema.js';

/** Names of all relational tables visible across the profile's scopes. */
export function getProfileTableNames(profile: Profile): string[] {
  const names = new Set<string>();
  if (profile.scopes) {
    for (const scope of Object.values(profile.scopes)) {
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
 * Merged `selectedTables` (table → column list) across all relational scopes
 * of the profile. When multiple scopes expose the same table, columns are
 * unioned. Returns `{}` when the profile has no relational scopes.
 */
export function getProfileSelectedTables(profile: Profile): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!profile.scopes) return result;
  for (const scope of Object.values(profile.scopes)) {
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
 * Merged `tableOptions` across all relational scopes of the profile. Last
 * writer wins per table when multiple scopes define options for the same table.
 * Returns `{}` when no relational scope carries options.
 */
export function getProfileTableOptions(profile: Profile): Record<string, TableToolOptions> {
  const result: Record<string, TableToolOptions> = {};
  if (!profile.scopes) return result;
  for (const scope of Object.values(profile.scopes)) {
    if (scope.kind !== 'relational') continue;
    for (const [table, opts] of Object.entries(scope.tableOptions ?? {})) {
      result[table] = opts;
    }
  }
  return result;
}

/**
 * Merged `columnMasking` across all relational scopes of the profile. Last
 * writer wins per (table, column) pair. Returns `{}` when no masking is
 * configured.
 */
export function getProfileColumnMasking(
  profile: Profile,
): Record<string, Record<string, ColumnMasking>> {
  const result: Record<string, Record<string, ColumnMasking>> = {};
  if (!profile.scopes) return result;
  for (const scope of Object.values(profile.scopes)) {
    if (scope.kind !== 'relational') continue;
    for (const [table, cols] of Object.entries(scope.columnMasking ?? {})) {
      result[table] = { ...(result[table] ?? {}), ...cols };
    }
  }
  return result;
}

/** Source ids of `kind: 'relational'` within the profile's scopes. */
export function getProfileRelationalSources(profile: Profile): string[] {
  if (!profile.sources || !profile.scopes) return [];
  return profile.sources.filter((id) => profile.scopes![id]?.kind === 'relational');
}

/**
 * Pick a target sourceId to write into when populating profile-wide settings
 * (e.g. global masking rules) from the frontend. Strategy:
 *
 *   1. First relational source from the unified shape.
 *   2. `'default'` placeholder — the backend migrator reconciles this against
 *      live connections when the profile is loaded into the runtime, so it is
 *      a safe sentinel even when no source is configured yet.
 */
export function pickMaskingTargetSourceId(profile: Profile): string {
  const relational = getProfileRelationalSources(profile);
  if (relational.length > 0) return relational[0];
  return 'default';
}
