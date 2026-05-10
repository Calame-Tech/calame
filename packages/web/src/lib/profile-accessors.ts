/**
 * Frontend mirror of `@calame/core/sources/accessors`. Reads from the unified
 * `scopes` shape with fallback to the legacy flat fields, so a single profile
 * can be displayed regardless of which shape it was authored in.
 *
 * Lives in `packages/web/` rather than re-exporting from `@calame/core` because
 * the web bundle uses its own structurally-equivalent mirror of `Profile` /
 * `ScopeSelection` (cf. `types/schema.ts`); pulling the core type would force
 * the web package to depend on the full TS definitions of the introspection /
 * PII modules, which it does not need.
 */
import type { Profile } from '../types/schema.js';

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
  if (names.size === 0 && profile.selectedTables) {
    for (const table of Object.keys(profile.selectedTables)) {
      names.add(table);
    }
  }
  return Array.from(names);
}

/**
 * Source ids of `kind: 'relational'`. Falls back to the legacy
 * `profile.connections` array when the unified shape carries no relational
 * scope.
 */
export function getProfileRelationalSources(profile: Profile): string[] {
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

/**
 * Pick a target sourceId to write into when populating profile-wide settings
 * (e.g. global masking rules) from the frontend. Strategy:
 *
 *   1. First relational source from the unified shape.
 *   2. First legacy connection.
 *   3. `'default'` placeholder — the backend migrator reconciles this against
 *      live connections when the profile is loaded into the runtime, so it is
 *      a safe sentinel even when no source is configured yet.
 */
export function pickMaskingTargetSourceId(profile: Profile): string {
  const relational = getProfileRelationalSources(profile);
  if (relational.length > 0) return relational[0];
  if (profile.connections && profile.connections.length > 0) return profile.connections[0];
  return 'default';
}
