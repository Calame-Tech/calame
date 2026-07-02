import type { ServeProfile, ServeConfiguration } from '../serve/types.js';
import type { ScopeSelection } from './types.js';

// ---------------------------------------------------------------------------
// upgradeProfileShape
// ---------------------------------------------------------------------------

// Why: the legacy ServeProfile shape (pre-Phase 2) stored table visibility as
// three flat root fields:
//   - connections: string[]
//       list of connection names
//   - selectedTables: Record<tableName, columnName[]>
//       keys are TABLE names, NOT connection names
//   - tableOptions: Record<tableName, TableToolOptions>
//   - columnMasking: Record<tableName, Record<columnName, ColumnMasking>>
//
// Evidence from packages/cli/src/routes/serve.ts (post-Phase 5 Tier 1):
//   const relationalSources = getProfileRelationalSources(profile);
//   const matchedSources = relationalSources.filter((id) => state.connections.has(id));
//   effectiveConnections = matchedSources.length ? [...matchedSources] : [...state.connections.keys()];
//   effectiveSelectedTables = { ...getProfileSelectedTables(profile) }  // flat table-keyed map
// Pre-Phase-5 the same logic read directly from `profile.connections` and
// `profile.selectedTables`; the accessors now absorb the legacy/unified branching.
//
// The serve.ts runtime then resolves which connection owns each table at
// request time by matching table names against each connection's introspected
// schema (serve.ts lines 448-463). The migrator cannot perform that lookup
// because no schema is available at profile-read time.
//
// Conservative strategy: attribute the entire legacy block to EVERY source id
// listed in `connections`. At Phase 3, DatabaseSourceAdapter.registerMcpTools
// filters the scope to only the tables it actually owns, so duplicating the
// block across connections is safe and idempotent.
//
// The new shape uses:
//   - sources: string[]                              replaces connections
//   - scopes: Record<sourceId, ScopeSelection>       replaces the three legacy fields
//
// Idempotency rule: if `scopes` is already a non-empty object, no synthesis is
// performed — the existing scopes are preserved as-is.

/**
 * Upgrades a legacy profile shape (with root `selectedTables`/`tableOptions`/
 * `columnMasking`/`connections`) to the new unified shape with `sources` and
 * `scopes`. Idempotent: profiles that already carry a populated `scopes` field
 * are returned as-is (deep-copied). Legacy fields are preserved in the result
 * so that code paths not yet migrated to the new shape keep working until
 * Phase 3 completes.
 *
 * @throws {TypeError} if `raw` is not a plain object.
 */
export function upgradeProfileShape(raw: unknown): ServeProfile {
  assertPlainObject(raw, 'upgradeProfileShape');

  // Deep-copy via JSON round-trip: isolates the caller's object and strips
  // non-serialisable values (functions, undefined own-properties).
  const result = deepCopy(raw);

  // --- Sources synthesis ---
  // Derive `sources` from `connections` when the new field is absent.
  if (result['sources'] === undefined || result['sources'] === null) {
    const connections = raw['connections'];
    if (Array.isArray(connections) && connections.length > 0) {
      result['sources'] = [...(connections as string[])];
    }
  }

  // --- Scopes synthesis ---
  // Only synthesise when scopes is absent or empty.
  if (!hasNonEmptyScopes(result)) {
    const scopeBlock = buildRelationalScopeBlock(raw);
    if (scopeBlock !== null) {
      const distributed = distributeScope(result['sources'], scopeBlock);
      result['scopes'] = distributed;
      // When `sources` was missing entirely, distributeScope falls back to a
      // synthetic `'default'` id — make sure it is also reflected on `sources`
      // so the unified shape is internally consistent.
      if (
        (result['sources'] === undefined || result['sources'] === null) &&
        Object.keys(distributed).length > 0
      ) {
        result['sources'] = Object.keys(distributed);
      }
    }
  }

  // Phase 5 — strip the legacy root fields after they have been folded into
  // `sources` / `scopes`. Profiles previously authored in the legacy shape
  // therefore emerge from the migrator with the unified shape only, and the
  // next storage write persists without the deprecated keys.
  delete result['connections'];
  delete result['selectedTables'];
  delete result['tableOptions'];
  delete result['columnMasking'];

  return result as unknown as ServeProfile;
}

// ---------------------------------------------------------------------------
// upgradeConfigurationShape
// ---------------------------------------------------------------------------

/**
 * Upgrades a legacy configuration row (with root `selectedTables`/
 * `tableOptions`/`columnMasking`/`connections`) to the new unified shape with
 * `sources` and `scopes`. Idempotent: configurations that already carry a
 * populated `scopes` field are returned as-is. Legacy fields are preserved so
 * that existing CLI paths remain functional until Phase 3.
 *
 * @throws {TypeError} if `raw` is not a plain object.
 */
export function upgradeConfigurationShape(raw: unknown): ServeConfiguration {
  assertPlainObject(raw, 'upgradeConfigurationShape');

  const result = deepCopy(raw);

  // --- Sources synthesis ---
  if (result['sources'] === undefined || result['sources'] === null) {
    const connections = raw['connections'];
    if (Array.isArray(connections) && connections.length > 0) {
      result['sources'] = [...(connections as string[])];
    }
  }

  // --- Scopes synthesis ---
  if (!hasNonEmptyScopes(result)) {
    const scopeBlock = buildRelationalScopeBlock(raw);
    if (scopeBlock !== null) {
      const distributed = distributeScope(result['sources'], scopeBlock);
      result['scopes'] = distributed;
      if (
        (result['sources'] === undefined || result['sources'] === null) &&
        Object.keys(distributed).length > 0
      ) {
        result['sources'] = Object.keys(distributed);
      }
    }
  }

  // Phase 5 — strip the legacy root fields (same rationale as upgradeProfileShape).
  delete result['connections'];
  delete result['selectedTables'];
  delete result['tableOptions'];
  delete result['columnMasking'];

  return result as unknown as ServeConfiguration;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Asserts that `value` is a plain (non-null, non-array) object. */
function assertPlainObject(
  value: unknown,
  fnName: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    const got = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    throw new TypeError(`${fnName}: expected a plain object, got ${got}`);
  }
}

/** Deep-copies a serialisable plain object via JSON round-trip. */
function deepCopy(obj: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
}

/** Returns true when `obj.scopes` is a non-empty plain object. */
function hasNonEmptyScopes(obj: Record<string, unknown>): boolean {
  const s = obj['scopes'];
  return (
    s !== undefined &&
    s !== null &&
    typeof s === 'object' &&
    !Array.isArray(s) &&
    Object.keys(s as Record<string, unknown>).length > 0
  );
}

/** Returns true when `value` is a non-null, non-array object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Returns true when `value` is a non-empty plain record. */
function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value) && Object.keys(value).length > 0;
}

/**
 * Builds a `relational` ScopeSelection from the three legacy flat fields on
 * `raw`. Returns null when none of the legacy fields carry any data (i.e.
 * `selectedTables` is absent or empty AND `tableOptions` and `columnMasking`
 * are also absent or empty).
 */
function buildRelationalScopeBlock(
  raw: Record<string, unknown>,
): Extract<ScopeSelection, { kind: 'relational' }> | null {
  const legacySelectedTables = raw['selectedTables'];
  const legacyTableOptions = raw['tableOptions'];
  const legacyColumnMasking = raw['columnMasking'];

  // selectedTables on a profile/configuration is always present as {} when empty,
  // so we treat both absence and empty object as "no data".
  const hasData =
    isNonEmptyRecord(legacySelectedTables) ||
    isNonEmptyRecord(legacyTableOptions) ||
    isNonEmptyRecord(legacyColumnMasking);

  if (!hasData) return null;

  const scope: Extract<ScopeSelection, { kind: 'relational' }> = {
    kind: 'relational',
    selectedTables: isPlainRecord(legacySelectedTables)
      ? (legacySelectedTables as Record<string, string[]>)
      : {},
  };

  if (isNonEmptyRecord(legacyTableOptions)) {
    scope.tableOptions = legacyTableOptions as Record<
      string,
      import('../introspect/types.js').TableToolOptions
    >;
  }

  if (isNonEmptyRecord(legacyColumnMasking)) {
    scope.columnMasking = legacyColumnMasking as Record<
      string,
      Record<string, import('../pii/types.js').ColumnMasking>
    >;
  }

  return scope;
}

/**
 * Returns a scopes map where every id in `sources` maps to a copy of
 * `scopeBlock`. When `sources` is absent or empty, the single key `'default'`
 * is used instead (conservative fallback so that at least one scope entry is
 * always present when legacy data exists).
 *
 * The first source id receives the original `scopeBlock` object; subsequent ids
 * receive deep copies so that callers cannot accidentally share state between
 * scopes.
 */
function distributeScope(
  sources: unknown,
  scopeBlock: Extract<ScopeSelection, { kind: 'relational' }>,
): Record<string, ScopeSelection> {
  const sourceIds =
    Array.isArray(sources) && (sources as unknown[]).length > 0
      ? (sources as string[])
      : ['default'];

  const scopes: Record<string, ScopeSelection> = {};
  for (let i = 0; i < sourceIds.length; i++) {
    const id = sourceIds[i];
    scopes[id] = i === 0 ? scopeBlock : (JSON.parse(JSON.stringify(scopeBlock)) as ScopeSelection);
  }
  return scopes;
}
