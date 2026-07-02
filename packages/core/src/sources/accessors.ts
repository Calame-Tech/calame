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
export function getProfileSelectedTables(profile: ProfileScopeShape): Record<string, string[]> {
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

// ---------------------------------------------------------------------------
// Configuration accessors — mirror of the Profile accessors above
//
// These read from `ServeConfiguration` which carries both the unified shape
// (sources + scopes, Phase 2+) and the legacy flat fields (connections,
// selectedTables, tableOptions, columnMasking) as optional fields. The
// latter are present only on pre-migration v10 rows; absent on all rows
// written after Phase 5 (upgradeConfigurationShape deletes them on write).
//
// Behaviour: each accessor first reads from `cfg.scopes` (Phase 2+ canonical
// shape), aggregating across every relational scope. When `scopes` is empty /
// absent, it falls back to the corresponding legacy flat field. Returns an
// empty container (never undefined, except columnMasking) when neither shape
// carries data.
//
// Note: a local structural interface is used rather than `import type { ServeConfiguration }`
// to avoid a circular module dependency (serve/types.ts imports from sources/index.js
// via inline import, which re-exports this file). The structural shape is the same.
// ---------------------------------------------------------------------------

/**
 * Structural sub-shape these accessors actually read. Decoupled from
 * `ServeConfiguration` so call sites can pass partial configuration-like objects
 * without dragging the full ServeConfiguration shape.
 *
 * The legacy fields (`connections`, `selectedTables`, …) are kept as
 * **optional reads** for one purpose only: bridging configurations that haven't
 * been through `upgradeConfigurationShape` yet. New writes should populate
 * `sources` / `scopes` exclusively.
 */
export interface ConfigScopeShape {
  sources?: string[];
  scopes?: Record<string, ScopeSelection>;
  connections?: string[];
  selectedTables?: Record<string, string[]>;
  tableOptions?: Record<string, TableToolOptions>;
  columnMasking?: Record<string, Record<string, ColumnMasking>>;
}

/** Names of all relational tables visible across the configuration's scopes. */
export function getConfigurationTableNames(cfg: ConfigScopeShape): string[] {
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
  if (names.size === 0 && cfg.selectedTables) {
    for (const table of Object.keys(cfg.selectedTables)) {
      names.add(table);
    }
  }
  return Array.from(names);
}

/**
 * Flat `tableName -> columns[]` projection across every relational scope.
 * When two scopes reference the same table, later scopes win for duplicates.
 * Mirrors the historic `cfg.selectedTables` shape.
 */
export function getConfigurationSelectedTables(cfg: ConfigScopeShape): Record<string, string[]> {
  if (cfg.scopes) {
    const out: Record<string, string[]> = {};
    let hasAny = false;
    for (const scope of Object.values(cfg.scopes)) {
      if (scope.kind !== 'relational' || !scope.selectedTables) continue;
      for (const [table, cols] of Object.entries(scope.selectedTables)) {
        out[table] = cols;
        hasAny = true;
      }
    }
    if (hasAny) return out;
  }
  return cfg.selectedTables ?? {};
}

/** Same shape as the legacy `cfg.tableOptions`. */
export function getConfigurationTableOptions(
  cfg: ConfigScopeShape,
): Record<string, TableToolOptions> | undefined {
  if (cfg.scopes) {
    const out: Record<string, TableToolOptions> = {};
    let hasAny = false;
    for (const scope of Object.values(cfg.scopes)) {
      if (scope.kind !== 'relational' || !scope.tableOptions) continue;
      for (const [table, opts] of Object.entries(scope.tableOptions)) {
        out[table] = opts;
        hasAny = true;
      }
    }
    if (hasAny) return out;
  }
  return cfg.tableOptions;
}

/** Same shape as the legacy `cfg.columnMasking`. */
export function getConfigurationColumnMasking(
  cfg: ConfigScopeShape,
): Record<string, Record<string, ColumnMasking>> | undefined {
  if (cfg.scopes) {
    const out: Record<string, Record<string, ColumnMasking>> = {};
    let hasAny = false;
    for (const scope of Object.values(cfg.scopes)) {
      if (scope.kind !== 'relational' || !scope.columnMasking) continue;
      for (const [table, masking] of Object.entries(scope.columnMasking)) {
        out[table] = masking;
        hasAny = true;
      }
    }
    if (hasAny) return out;
  }
  return cfg.columnMasking;
}

/**
 * The active source ids of `kind: 'relational'` from the unified shape, or
 * the legacy `cfg.connections` array as fallback. Returns an empty array when
 * neither shape carries data.
 */
export function getConfigurationRelationalSources(cfg: ConfigScopeShape): string[] {
  if (cfg.sources && cfg.scopes) {
    const out: string[] = [];
    for (const sourceId of cfg.sources) {
      const scope = cfg.scopes[sourceId];
      if (scope?.kind === 'relational') out.push(sourceId);
    }
    if (out.length > 0) return out;
  }
  return cfg.connections ?? [];
}

/** Document scope, narrowed from the discriminated `ScopeSelection` union. */
type DocumentScope = Extract<ScopeSelection, { kind: 'document' }>;

/**
 * Document scopes (kind='document') indexed by their sourceId, extracted from
 * the unified `cfg.scopes` shape. Returns an empty object when the configuration
 * carries no document scopes — the legacy flat fields are DB-only and have no
 * document equivalent, so there is no fallback path.
 *
 * Used by `mergeConfigurations` (`packages/cli/src/routes/serve.ts`) to fold
 * the RAG scopes of every Configuration referenced by a Profile into a single
 * effective set at serve time. Mirrors `getConfigurationRelationalSources` /
 * `getConfigurationSelectedTables` for the document side of `ScopeSelection`.
 */
export function getConfigurationDocumentScopes(
  cfg: ConfigScopeShape,
): Record<string, DocumentScope> {
  if (!cfg.scopes) return {};
  const out: Record<string, DocumentScope> = {};
  for (const [sourceId, scope] of Object.entries(cfg.scopes)) {
    if (scope.kind === 'document') {
      out[sourceId] = scope;
    }
  }
  return out;
}

/**
 * The active source ids of `kind: 'document'` (RAG sources) declared by the
 * configuration. Returns an empty array when the configuration has no
 * document scopes. Symmetrical to `getConfigurationRelationalSources`.
 */
export function getConfigurationDocumentSources(cfg: ConfigScopeShape): string[] {
  return Object.keys(getConfigurationDocumentScopes(cfg));
}
