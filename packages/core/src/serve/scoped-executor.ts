import type { ResolvedScopeFilter } from './types.js';
import { getTableScopeStatus } from './scope-resolver.js';
import type { FilterValue, Dialect } from './filter-builder.js';
import { buildWhereConditions } from './filter-builder.js';

// Re-export the shared filter types so existing importers
// (e.g. `import type { Dialect } from './scoped-executor.js'`) keep working.
export type { FilterValue, Dialect } from './filter-builder.js';

export type ExecuteQuery = (
  sql: string,
  params: unknown[],
) => Promise<{ rows: Record<string, unknown>[]; fields: { name: string }[] }>;

interface WhereResult {
  clause: string;
  values: unknown[];
  nextParamIndex: number;
}

// ---------------------------------------------------------------------------
// Scope Guard — central point for row-level data isolation
// ---------------------------------------------------------------------------

export interface ScopeGuard {
  /** Whether scoping is active on this request. */
  readonly active: boolean;

  /**
   * Check if a table is accessible. Returns 'scoped' or 'shared'.
   * Throws `ScopeBlockedError` for tables that are neither scoped nor shared.
   */
  checkTableAccess(tableName: string): 'scoped' | 'shared';

  /**
   * Build a WHERE clause merging scope filters with user-provided filters.
   * Scope filters are always prepended and cannot be overridden.
   */
  buildWhereClause(
    tableName: string,
    userFilters: Record<string, FilterValue | undefined> | undefined,
    allowedColumns: string[],
    dialect: Dialect,
    startParamIndex?: number,
  ): WhereResult;

  /**
   * Build a scope-only WHERE clause (no user filters).
   * Used by describe tools for COUNT, DISTINCT, MIN/MAX queries.
   */
  buildScopeOnlyWhereClause(
    tableName: string,
    dialect: Dialect,
    startParamIndex?: number,
  ): WhereResult;

  /** Get scope info for audit logging. */
  getScopeInfo(): { active: boolean; filters: ResolvedScopeFilter[] };
}

/** Thrown when a query targets a table that is blocked by scope rules. */
export class ScopeBlockedError extends Error {
  constructor(tableName: string) {
    super(`Table "${tableName}" is blocked by data scope rules (not scoped and not shared).`);
    this.name = 'ScopeBlockedError';
  }
}

// ---------------------------------------------------------------------------
// ScopedScopeGuard — active scoping
// ---------------------------------------------------------------------------

class ScopedScopeGuard implements ScopeGuard {
  readonly active = true;

  constructor(
    private scopeFilters: ResolvedScopeFilter[],
    private sharedTables: string[],
  ) {}

  checkTableAccess(tableName: string): 'scoped' | 'shared' {
    const status = getTableScopeStatus(tableName, this.scopeFilters, this.sharedTables);
    if (status === 'blocked') {
      throw new ScopeBlockedError(tableName);
    }
    return status;
  }

  buildWhereClause(
    tableName: string,
    userFilters: Record<string, FilterValue | undefined> | undefined,
    allowedColumns: string[],
    dialect: Dialect,
    startParamIndex = 1,
  ): WhereResult {
    const allConditions: string[] = [];
    const allValues: unknown[] = [];
    let paramIndex = startParamIndex;

    // 1. Scope filters first (mandatory, cannot be overridden)
    // Multiple rules per table are supported — all are ANDed together
    const scopeFiltersForTable = this.scopeFilters.filter((f) => f.tableName === tableName);
    for (const scopeFilter of scopeFiltersForTable) {
      const qi = dialect.quoteIdent(scopeFilter.column);
      allConditions.push(`${qi} = ${dialect.param(paramIndex++)}`);
      allValues.push(scopeFilter.value);
    }

    // 2. User filters (ANDed with scope)
    if (userFilters) {
      const { conditions, values, nextParamIndex } = buildWhereConditions(
        userFilters,
        allowedColumns,
        dialect,
        paramIndex,
      );
      allConditions.push(...conditions);
      allValues.push(...values);
      paramIndex = nextParamIndex;
    }

    return {
      clause: allConditions.length > 0 ? `WHERE ${allConditions.join(' AND ')}` : '',
      values: allValues,
      nextParamIndex: paramIndex,
    };
  }

  buildScopeOnlyWhereClause(
    tableName: string,
    dialect: Dialect,
    startParamIndex = 1,
  ): WhereResult {
    return this.buildWhereClause(tableName, undefined, [], dialect, startParamIndex);
  }

  getScopeInfo(): { active: boolean; filters: ResolvedScopeFilter[] } {
    return { active: true, filters: this.scopeFilters };
  }
}

// ---------------------------------------------------------------------------
// UnscopedScopeGuard — no scoping (admin, or profile without scope rules)
// ---------------------------------------------------------------------------

class UnscopedScopeGuard implements ScopeGuard {
  readonly active = false;

  checkTableAccess(_tableName: string): 'scoped' | 'shared' {
    return 'shared'; // all tables accessible
  }

  buildWhereClause(
    _tableName: string,
    userFilters: Record<string, FilterValue | undefined> | undefined,
    allowedColumns: string[],
    dialect: Dialect,
    startParamIndex = 1,
  ): WhereResult {
    if (!userFilters) {
      return { clause: '', values: [], nextParamIndex: startParamIndex };
    }
    const { conditions, values, nextParamIndex } = buildWhereConditions(
      userFilters,
      allowedColumns,
      dialect,
      startParamIndex,
    );
    return {
      clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
      values,
      nextParamIndex,
    };
  }

  buildScopeOnlyWhereClause(
    _tableName: string,
    _dialect: Dialect,
    startParamIndex = 1,
  ): WhereResult {
    return { clause: '', values: [], nextParamIndex: startParamIndex };
  }

  getScopeInfo(): { active: boolean; filters: ResolvedScopeFilter[] } {
    return { active: false, filters: [] };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ScopeGuard for the current request.
 * - If scopeFilters is non-empty → ScopedScopeGuard (enforces row-level isolation)
 * - Otherwise → UnscopedScopeGuard (no filtering, admin/legacy behavior)
 */
export function createScopeGuard(
  scopeFilters: ResolvedScopeFilter[],
  sharedTables?: string[],
): ScopeGuard {
  if (scopeFilters.length > 0) {
    return new ScopedScopeGuard(scopeFilters, sharedTables ?? []);
  }
  return new UnscopedScopeGuard();
}
