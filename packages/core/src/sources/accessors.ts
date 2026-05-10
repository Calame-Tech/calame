/**
 * Read accessors for `ServeProfile` that bridge the unified `scopes` shape
 * with the legacy flat fields (`selectedTables`, `tableOptions`,
 * `columnMasking`, `connections`).
 *
 * Call sites should prefer these over direct property reads so that:
 *   1. Anything dropped in Phase 5 (the deprecated flat fields) is migrated
 *      in a single sweep — replace `profile.selectedTables` with
 *      `getProfileSelectedTables(profile)` etc., and the field can be removed
 *      from the type without further code changes.
 *   2. Profiles authored in either shape behave identically downstream.
 *
 * Behaviour: each accessor first reads from `profile.scopes` (Phase 2+
 * canonical shape), aggregating across every relational scope when the
 * profile spans multiple DB sources. When `scopes` is empty / absent,
 * it falls back to the corresponding legacy flat field. Returns `undefined`
 * (or an empty container) when neither shape carries data.
 */

import type { TableToolOptions } from '../introspect/types.js';
import type { ColumnMasking } from '../pii/types.js';
import type { ScopeSelection } from './types.js';

/**
 * Structural sub-shape these accessors actually read. Decoupled from
 * `ServeProfile` so call sites can pass partial profile-like objects
 * (`mergeConfigurations` results, raw JSON entries on the read boundary)
 * without dragging the full ServeProfile shape.
 *
 * The legacy fields (`connections`, `selectedTables`, …) are kept as
 * **optional reads** for one purpose only: bridging profiles that haven't
 * been through `upgradeProfileShape` yet. New writes should populate
 * `sources` / `scopes` exclusively — the migrator runs at every storage
 * boundary and reconciles the two shapes.
 */
export interface ProfileScopeShape {
  sources?: string[];
  scopes?: Record<string, ScopeSelection>;
  connections?: string[];
  selectedTables?: Record<string, string[]>;
  tableOptions?: Record<string, TableToolOptions>;
  columnMasking?: Record<string, Record<string, ColumnMasking>>;
}

/** Names of all relational tables visible across the profile's scopes. */
export function getProfileTableNames(profile: ProfileScopeShape): string[] {
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
  if (names.size === 0 && profile.selectedTables) {
    for (const table of Object.keys(profile.selectedTables)) {
      names.add(table);
    }
  }
  return Array.from(names);
}

/**
 * Flat `tableName -> columns[]` projection across every relational scope.
 * Two scopes referencing the same table is theoretically possible (multi-DB
 * profile with tables sharing names): in that case the columns are merged
 * with later scopes winning for duplicates. Mirrors the historic
 * `profile.selectedTables` shape.
 */
export function getProfileSelectedTables(
  profile: ProfileScopeShape,
): Record<string, string[]> {
  if (profile.scopes) {
    const out: Record<string, string[]> = {};
    let hasAny = false;
    for (const scope of Object.values(profile.scopes)) {
      if (scope.kind !== 'relational' || !scope.selectedTables) continue;
      for (const [table, cols] of Object.entries(scope.selectedTables)) {
        out[table] = cols;
        hasAny = true;
      }
    }
    if (hasAny) return out;
  }
  return profile.selectedTables ?? {};
}

/** Same shape as the legacy `profile.tableOptions`. */
export function getProfileTableOptions(
  profile: ProfileScopeShape,
): Record<string, TableToolOptions> | undefined {
  if (profile.scopes) {
    const out: Record<string, TableToolOptions> = {};
    let hasAny = false;
    for (const scope of Object.values(profile.scopes)) {
      if (scope.kind !== 'relational' || !scope.tableOptions) continue;
      for (const [table, opts] of Object.entries(scope.tableOptions)) {
        out[table] = opts;
        hasAny = true;
      }
    }
    if (hasAny) return out;
  }
  return profile.tableOptions;
}

/** Same shape as the legacy `profile.columnMasking`. */
export function getProfileColumnMasking(
  profile: ProfileScopeShape,
): Record<string, Record<string, ColumnMasking>> | undefined {
  if (profile.scopes) {
    const out: Record<string, Record<string, ColumnMasking>> = {};
    let hasAny = false;
    for (const scope of Object.values(profile.scopes)) {
      if (scope.kind !== 'relational' || !scope.columnMasking) continue;
      for (const [table, masking] of Object.entries(scope.columnMasking)) {
        out[table] = masking;
        hasAny = true;
      }
    }
    if (hasAny) return out;
  }
  return profile.columnMasking;
}

/**
 * The active source ids of `kind: 'relational'` from the unified shape, or
 * the legacy `profile.connections` array as fallback. Returns an empty
 * array when neither shape carries data.
 */
export function getProfileRelationalSources(profile: ProfileScopeShape): string[] {
  if (profile.sources && profile.scopes) {
    const out: string[] = [];
    for (const sourceId of profile.sources) {
      const scope = profile.scopes[sourceId];
      if (scope?.kind === 'relational') out.push(sourceId);
    }
    if (out.length > 0) return out;
  }
  return profile.connections ?? [];
}
