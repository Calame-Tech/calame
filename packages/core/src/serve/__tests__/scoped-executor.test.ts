import { describe, it, expect } from 'vitest';
import { createScopeGuard, ScopeBlockedError } from '../scoped-executor.js';
import type { Dialect } from '../scoped-executor.js';
import type { ResolvedScopeFilter } from '../types.js';

// PostgreSQL dialect for testing
const pgDialect: Dialect = {
  isPostgres: true,
  quoteIdent: (n) => `"${n}"`,
  quoteTable: (s, t) => `"${s}"."${t}"`,
  param: (i) => `$${i}`,
  random: 'RANDOM()',
};

// SQLite dialect for testing
const sqliteDialect: Dialect = {
  isPostgres: false,
  quoteIdent: (n) => `"${n}"`,
  quoteTable: (_s, t) => `"${t}"`,
  param: () => '?',
  random: 'RANDOM()',
};

const scopeFilters: ResolvedScopeFilter[] = [
  { tableName: 'colis', column: 'client_email', value: 'dupont@gmail.com' },
  { tableName: 'factures', column: 'numero_client', value: 'CLT-00042' },
];
const sharedTables = ['produits', 'categories'];

// ---------------------------------------------------------------------------
// UnscopedScopeGuard
// ---------------------------------------------------------------------------

describe('UnscopedScopeGuard (no scoping)', () => {
  const guard = createScopeGuard([]);

  it('reports active = false', () => {
    expect(guard.active).toBe(false);
  });

  it('allows access to any table', () => {
    expect(guard.checkTableAccess('anything')).toBe('shared');
  });

  it('builds WHERE clause from user filters only', () => {
    const result = guard.buildWhereClause(
      'colis',
      { statut: { op: 'eq', value: 'en_cours' } },
      ['statut', 'client_email'],
      pgDialect,
    );
    expect(result.clause).toBe('WHERE "statut" = $1');
    expect(result.values).toEqual(['en_cours']);
    expect(result.nextParamIndex).toBe(2);
  });

  it('returns empty WHERE when no user filters', () => {
    const result = guard.buildWhereClause('colis', undefined, [], pgDialect);
    expect(result.clause).toBe('');
    expect(result.values).toEqual([]);
  });

  it('buildScopeOnlyWhereClause returns empty', () => {
    const result = guard.buildScopeOnlyWhereClause('colis', pgDialect);
    expect(result.clause).toBe('');
  });

  it('getScopeInfo returns inactive', () => {
    expect(guard.getScopeInfo()).toEqual({ active: false, filters: [] });
  });
});

// ---------------------------------------------------------------------------
// ScopedScopeGuard
// ---------------------------------------------------------------------------

describe('ScopedScopeGuard (active scoping)', () => {
  const guard = createScopeGuard(scopeFilters, sharedTables);

  it('reports active = true', () => {
    expect(guard.active).toBe(true);
  });

  // --- Table access ---

  it('allows scoped tables', () => {
    expect(guard.checkTableAccess('colis')).toBe('scoped');
    expect(guard.checkTableAccess('factures')).toBe('scoped');
  });

  it('allows shared tables', () => {
    expect(guard.checkTableAccess('produits')).toBe('shared');
    expect(guard.checkTableAccess('categories')).toBe('shared');
  });

  it('blocks tables that are neither scoped nor shared', () => {
    expect(() => guard.checkTableAccess('secrets')).toThrow(ScopeBlockedError);
    expect(() => guard.checkTableAccess('internal_logs')).toThrow(ScopeBlockedError);
  });

  // --- WHERE clause building ---

  it('injects scope filter for scoped table (PostgreSQL)', () => {
    const result = guard.buildWhereClause('colis', undefined, [], pgDialect);
    expect(result.clause).toBe('WHERE "client_email" = $1');
    expect(result.values).toEqual(['dupont@gmail.com']);
    expect(result.nextParamIndex).toBe(2);
  });

  it('injects scope filter for scoped table (SQLite)', () => {
    const result = guard.buildWhereClause('colis', undefined, [], sqliteDialect);
    expect(result.clause).toBe('WHERE "client_email" = ?');
    expect(result.values).toEqual(['dupont@gmail.com']);
  });

  it('merges scope + user filters with AND', () => {
    const result = guard.buildWhereClause(
      'colis',
      { statut: { op: 'eq', value: 'en_cours' } },
      ['statut', 'client_email'],
      pgDialect,
    );
    expect(result.clause).toBe('WHERE "client_email" = $1 AND "statut" = $2');
    expect(result.values).toEqual(['dupont@gmail.com', 'en_cours']);
  });

  it('scope always wins when user filters same column (AND produces 0 results)', () => {
    // User tries to filter client_email = 'other@test.com'
    // Scope says client_email = 'dupont@gmail.com'
    // Both conditions AND → no row matches both → 0 results
    const result = guard.buildWhereClause(
      'colis',
      { client_email: { op: 'eq', value: 'other@test.com' } },
      ['client_email', 'statut'],
      pgDialect,
    );
    expect(result.clause).toBe('WHERE "client_email" = $1 AND "client_email" = $2');
    expect(result.values).toEqual(['dupont@gmail.com', 'other@test.com']);
    // Both conditions are present — scope cannot be bypassed
  });

  it('no scope filter for shared tables', () => {
    const result = guard.buildWhereClause('produits', undefined, [], pgDialect);
    expect(result.clause).toBe('');
    expect(result.values).toEqual([]);
  });

  it('user filters still work on shared tables', () => {
    const result = guard.buildWhereClause(
      'produits',
      { categorie: { op: 'eq', value: 'electronique' } },
      ['categorie'],
      pgDialect,
    );
    expect(result.clause).toBe('WHERE "categorie" = $1');
    expect(result.values).toEqual(['electronique']);
  });

  // --- Scope-only WHERE (for describe) ---

  it('buildScopeOnlyWhereClause returns scope filter', () => {
    const result = guard.buildScopeOnlyWhereClause('colis', pgDialect);
    expect(result.clause).toBe('WHERE "client_email" = $1');
    expect(result.values).toEqual(['dupont@gmail.com']);
  });

  it('buildScopeOnlyWhereClause returns empty for shared tables', () => {
    const result = guard.buildScopeOnlyWhereClause('produits', pgDialect);
    expect(result.clause).toBe('');
  });

  // --- Scope info ---

  it('getScopeInfo returns active filters', () => {
    const info = guard.getScopeInfo();
    expect(info.active).toBe(true);
    expect(info.filters).toEqual(scopeFilters);
  });

  // --- Fail-closed with sentinel value ---

  it('sentinel value in scope filter produces valid WHERE (will match nothing in DB)', () => {
    const guardWithSentinel = createScopeGuard([
      { tableName: 'colis', column: 'client_email', value: '__calame_scope_blocked__' },
    ]);
    const result = guardWithSentinel.buildWhereClause('colis', undefined, [], pgDialect);
    expect(result.clause).toBe('WHERE "client_email" = $1');
    expect(result.values).toEqual(['__calame_scope_blocked__']);
  });
});

// ---------------------------------------------------------------------------
// Multi-operator user filters with scope
// ---------------------------------------------------------------------------

describe('ScopeGuard with complex user filters', () => {
  const guard = createScopeGuard(scopeFilters, sharedTables);

  it('handles IN operator user filter + scope', () => {
    const result = guard.buildWhereClause(
      'colis',
      { statut: { op: 'in', value: ['en_cours', 'livre'] } },
      ['statut'],
      pgDialect,
    );
    expect(result.clause).toBe('WHERE "client_email" = $1 AND "statut" = ANY($2)');
    expect(result.values).toEqual(['dupont@gmail.com', ['en_cours', 'livre']]);
  });

  it('handles BETWEEN operator user filter + scope', () => {
    const result = guard.buildWhereClause(
      'factures',
      { montant: { op: 'between', value: [100, 500] } },
      ['montant'],
      pgDialect,
    );
    expect(result.clause).toBe('WHERE "numero_client" = $1 AND "montant" >= $2 AND "montant" <= $3');
    expect(result.values).toEqual(['CLT-00042', 100, 500]);
  });

  it('handles SQLite IN expansion + scope', () => {
    const result = guard.buildWhereClause(
      'colis',
      { statut: { op: 'in', value: ['en_cours', 'livre'] } },
      ['statut'],
      sqliteDialect,
    );
    expect(result.clause).toBe('WHERE "client_email" = ? AND "statut" IN (?, ?)');
    expect(result.values).toEqual(['dupont@gmail.com', 'en_cours', 'livre']);
  });
});

// ---------------------------------------------------------------------------
// IN operator — CSV string normalization (bug fix)
// ---------------------------------------------------------------------------

describe('IN operator CSV string normalization', () => {
  const unscopedGuard = createScopeGuard([]);

  it('accepts an array directly (PostgreSQL) — baseline', () => {
    const result = unscopedGuard.buildWhereClause(
      'colis',
      { statut: { op: 'in', value: ['echec', 'en_attente'] } },
      ['statut'],
      pgDialect,
    );
    expect(result.clause).toBe('WHERE "statut" = ANY($1)');
    expect(result.values).toEqual([['echec', 'en_attente']]);
  });

  it('accepts an array directly (SQLite) — baseline', () => {
    const result = unscopedGuard.buildWhereClause(
      'colis',
      { statut: { op: 'in', value: ['echec', 'en_attente'] } },
      ['statut'],
      sqliteDialect,
    );
    expect(result.clause).toBe('WHERE "statut" IN (?, ?)');
    expect(result.values).toEqual(['echec', 'en_attente']);
  });

  it('splits a CSV string into individual values (PostgreSQL)', () => {
    const result = unscopedGuard.buildWhereClause(
      'colis',
      { statut: { op: 'in', value: 'echec,en_attente,en_cours' } },
      ['statut'],
      pgDialect,
    );
    expect(result.clause).toBe('WHERE "statut" = ANY($1)');
    expect(result.values).toEqual([['echec', 'en_attente', 'en_cours']]);
  });

  it('splits a CSV string into individual values (SQLite)', () => {
    const result = unscopedGuard.buildWhereClause(
      'colis',
      { statut: { op: 'in', value: 'echec,en_attente,en_cours' } },
      ['statut'],
      sqliteDialect,
    );
    expect(result.clause).toBe('WHERE "statut" IN (?, ?, ?)');
    expect(result.values).toEqual(['echec', 'en_attente', 'en_cours']);
  });

  it('trims whitespace around CSV values (PostgreSQL)', () => {
    const result = unscopedGuard.buildWhereClause(
      'colis',
      { statut: { op: 'in', value: 'echec, en_attente , en_cours' } },
      ['statut'],
      pgDialect,
    );
    expect(result.clause).toBe('WHERE "statut" = ANY($1)');
    expect(result.values).toEqual([['echec', 'en_attente', 'en_cours']]);
  });

  it('trims whitespace around CSV values (SQLite)', () => {
    const result = unscopedGuard.buildWhereClause(
      'colis',
      { statut: { op: 'in', value: ' a , b , c ' } },
      ['statut'],
      sqliteDialect,
    );
    expect(result.clause).toBe('WHERE "statut" IN (?, ?, ?)');
    expect(result.values).toEqual(['a', 'b', 'c']);
  });

  it('empty string produces 1=0 (match nothing, no crash) — PostgreSQL', () => {
    const result = unscopedGuard.buildWhereClause(
      'colis',
      { statut: { op: 'in', value: '' } },
      ['statut'],
      pgDialect,
    );
    expect(result.clause).toBe('WHERE 1=0');
    expect(result.values).toEqual([]);
  });

  it('empty string produces 1=0 (match nothing, no crash) — SQLite', () => {
    const result = unscopedGuard.buildWhereClause(
      'colis',
      { statut: { op: 'in', value: '' } },
      ['statut'],
      sqliteDialect,
    );
    expect(result.clause).toBe('WHERE 1=0');
    expect(result.values).toEqual([]);
  });

  it('empty array produces 1=0 (match nothing, no crash) — PostgreSQL', () => {
    const result = unscopedGuard.buildWhereClause(
      'colis',
      { statut: { op: 'in', value: [] } },
      ['statut'],
      pgDialect,
    );
    expect(result.clause).toBe('WHERE 1=0');
    expect(result.values).toEqual([]);
  });

  it('empty array produces 1=0 (match nothing, no crash) — SQLite', () => {
    const result = unscopedGuard.buildWhereClause(
      'colis',
      { statut: { op: 'in', value: [] } },
      ['statut'],
      sqliteDialect,
    );
    expect(result.clause).toBe('WHERE 1=0');
    expect(result.values).toEqual([]);
  });
});

describe('IS NULL / IS NOT NULL operators', () => {
  const unscopedGuard = createScopeGuard([]);

  it('is_null generates IS NULL without binding any value (PostgreSQL)', () => {
    const result = unscopedGuard.buildWhereClause(
      'colis',
      { id_livreur: { op: 'is_null', value: undefined } },
      ['id_livreur'],
      pgDialect,
    );
    expect(result.clause).toBe('WHERE "id_livreur" IS NULL');
    expect(result.values).toEqual([]);
    expect(result.nextParamIndex).toBe(1);
  });

  it('is_null generates IS NULL without binding any value (SQLite)', () => {
    const result = unscopedGuard.buildWhereClause(
      'colis',
      { id_livreur: { op: 'is_null', value: undefined } },
      ['id_livreur'],
      sqliteDialect,
    );
    expect(result.clause).toBe('WHERE "id_livreur" IS NULL');
    expect(result.values).toEqual([]);
  });

  it('is_not_null generates IS NOT NULL without binding any value (PostgreSQL)', () => {
    const result = unscopedGuard.buildWhereClause(
      'colis',
      { id_livreur: { op: 'is_not_null', value: undefined } },
      ['id_livreur'],
      pgDialect,
    );
    expect(result.clause).toBe('WHERE "id_livreur" IS NOT NULL');
    expect(result.values).toEqual([]);
  });

  it('is_not_null generates IS NOT NULL without binding any value (SQLite)', () => {
    const result = unscopedGuard.buildWhereClause(
      'colis',
      { id_livreur: { op: 'is_not_null', value: undefined } },
      ['id_livreur'],
      sqliteDialect,
    );
    expect(result.clause).toBe('WHERE "id_livreur" IS NOT NULL');
    expect(result.values).toEqual([]);
  });

  it('ignores value passed to is_null (LLM robustness)', () => {
    const result = unscopedGuard.buildWhereClause(
      'colis',
      { id_livreur: { op: 'is_null', value: 'anything' } },
      ['id_livreur'],
      sqliteDialect,
    );
    expect(result.clause).toBe('WHERE "id_livreur" IS NULL');
    expect(result.values).toEqual([]);
  });

  it('combines is_not_null with other filters preserving param order', () => {
    const result = unscopedGuard.buildWhereClause(
      'colis',
      {
        id_livreur: { op: 'is_not_null', value: undefined },
        statut: { op: 'eq', value: 'livre' },
      },
      ['id_livreur', 'statut'],
      sqliteDialect,
    );
    expect(result.clause).toContain('"id_livreur" IS NOT NULL');
    expect(result.clause).toContain('"statut" = ?');
    expect(result.values).toEqual(['livre']);
  });
});
