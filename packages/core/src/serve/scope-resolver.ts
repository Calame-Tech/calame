import type { DataScopeRule, UserIdentity, ResolvedScopeFilter } from './types.js';

/**
 * Sentinel value used for fail-closed: produces a WHERE condition that can never match,
 * ensuring zero rows are returned when the user's identity field is missing.
 */
const FAIL_CLOSED_VALUE = '__calame_scope_blocked__';

/**
 * Resolve the identity value for a given scope rule.
 * Returns the concrete value from the user's identity, or null if missing.
 */
function resolveIdentityValue(rule: DataScopeRule, identity: UserIdentity): string | null {
  switch (rule.identityField) {
    case 'email':
      // Explicit null/empty check — do NOT use || which treats "0" as falsy
      return identity.email != null && identity.email !== '' ? identity.email : null;
    case 'externalId':
      return identity.externalId != null && identity.externalId !== '' ? identity.externalId : null;
    case 'custom': {
      if (!rule.customKey) return null;
      const v = identity.customAttributes?.[rule.customKey];
      return v != null && v !== '' ? v : null;
    }
    default:
      return null;
  }
}

/**
 * Resolve profile-level scope rules + authenticated user identity into concrete
 * WHERE filters ready for injection.
 *
 * Fail-closed: if a rule references an identity field the user doesn't have,
 * the filter uses a sentinel value that will never match any real data.
 */
export function resolveUserScope(
  rules: DataScopeRule[] | undefined,
  identity: UserIdentity,
): ResolvedScopeFilter[] {
  if (!rules || rules.length === 0) return [];

  return rules.map((rule) => {
    const value = resolveIdentityValue(rule, identity);
    return {
      tableName: rule.tableName,
      column: rule.column,
      // Fail-closed: if value is null/empty, use sentinel that matches nothing
      value: value || FAIL_CLOSED_VALUE,
    };
  });
}

/**
 * Determine the scope status of a table given the profile's scope rules and shared tables.
 * Only meaningful when dataScopeRules is non-empty (strict mode).
 */
export type TableScopeStatus = 'scoped' | 'shared' | 'blocked';

export function getTableScopeStatus(
  tableName: string,
  scopeFilters: ResolvedScopeFilter[],
  sharedTables: string[] | undefined,
): TableScopeStatus {
  // Check if this table has a scope filter
  if (scopeFilters.some((f) => f.tableName === tableName)) {
    return 'scoped';
  }
  // Check if explicitly shared
  if (sharedTables && sharedTables.includes(tableName)) {
    return 'shared';
  }
  // Neither scoped nor shared → blocked (fail-closed)
  return 'blocked';
}
