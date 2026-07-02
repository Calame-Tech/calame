import { describe, it, expect } from 'vitest';
import { resolveUserScope, getTableScopeStatus } from '../scope-resolver.js';
import type { DataScopeRule, UserIdentity, ResolvedScopeFilter } from '../types.js';

// ---------------------------------------------------------------------------
// resolveUserScope
// ---------------------------------------------------------------------------

describe('resolveUserScope', () => {
  const baseIdentity: UserIdentity = {
    email: 'dupont@gmail.com',
    userId: 'usr_001',
    externalId: 'ext_42',
    customAttributes: { client_id: 'CLT-00042', region: 'EU' },
  };

  it('returns empty array when no rules', () => {
    expect(resolveUserScope(undefined, baseIdentity)).toEqual([]);
    expect(resolveUserScope([], baseIdentity)).toEqual([]);
  });

  it('resolves email identity field', () => {
    const rules: DataScopeRule[] = [
      { tableName: 'colis', column: 'client_email', identityField: 'email' },
    ];
    const filters = resolveUserScope(rules, baseIdentity);
    expect(filters).toEqual([
      { tableName: 'colis', column: 'client_email', value: 'dupont@gmail.com' },
    ]);
  });

  it('resolves externalId identity field', () => {
    const rules: DataScopeRule[] = [
      { tableName: 'orders', column: 'ext_ref', identityField: 'externalId' },
    ];
    const filters = resolveUserScope(rules, baseIdentity);
    expect(filters).toEqual([{ tableName: 'orders', column: 'ext_ref', value: 'ext_42' }]);
  });

  it('resolves custom identity field via customKey', () => {
    const rules: DataScopeRule[] = [
      {
        tableName: 'colis',
        column: 'numero_client',
        identityField: 'custom',
        customKey: 'client_id',
      },
    ];
    const filters = resolveUserScope(rules, baseIdentity);
    expect(filters).toEqual([{ tableName: 'colis', column: 'numero_client', value: 'CLT-00042' }]);
  });

  it('resolves multiple rules for different tables', () => {
    const rules: DataScopeRule[] = [
      { tableName: 'colis', column: 'client_email', identityField: 'email' },
      {
        tableName: 'factures',
        column: 'numero_client',
        identityField: 'custom',
        customKey: 'client_id',
      },
    ];
    const filters = resolveUserScope(rules, baseIdentity);
    expect(filters).toHaveLength(2);
    expect(filters[0].value).toBe('dupont@gmail.com');
    expect(filters[1].value).toBe('CLT-00042');
  });

  // Fail-closed tests
  describe('fail-closed behavior', () => {
    it('uses sentinel when email is empty', () => {
      const identity: UserIdentity = { email: '', userId: 'usr_001' };
      const rules: DataScopeRule[] = [
        { tableName: 'colis', column: 'client_email', identityField: 'email' },
      ];
      const filters = resolveUserScope(rules, identity);
      expect(filters[0].value).toBe('__calame_scope_blocked__');
    });

    it('uses sentinel when externalId is missing', () => {
      const identity: UserIdentity = { email: 'a@b.com', userId: 'usr_001' };
      const rules: DataScopeRule[] = [
        { tableName: 'orders', column: 'ext_ref', identityField: 'externalId' },
      ];
      const filters = resolveUserScope(rules, identity);
      expect(filters[0].value).toBe('__calame_scope_blocked__');
    });

    it('uses sentinel when customKey is not in customAttributes', () => {
      const identity: UserIdentity = {
        email: 'a@b.com',
        userId: 'usr_001',
        customAttributes: { region: 'EU' },
      };
      const rules: DataScopeRule[] = [
        {
          tableName: 'colis',
          column: 'numero_client',
          identityField: 'custom',
          customKey: 'client_id',
        },
      ];
      const filters = resolveUserScope(rules, identity);
      expect(filters[0].value).toBe('__calame_scope_blocked__');
    });

    it('uses sentinel when customAttributes is undefined', () => {
      const identity: UserIdentity = { email: 'a@b.com', userId: 'usr_001' };
      const rules: DataScopeRule[] = [
        {
          tableName: 'colis',
          column: 'numero_client',
          identityField: 'custom',
          customKey: 'client_id',
        },
      ];
      const filters = resolveUserScope(rules, identity);
      expect(filters[0].value).toBe('__calame_scope_blocked__');
    });

    it('uses sentinel when customKey is missing from rule', () => {
      const rules: DataScopeRule[] = [
        { tableName: 'colis', column: 'numero_client', identityField: 'custom' },
      ];
      const filters = resolveUserScope(rules, baseIdentity);
      expect(filters[0].value).toBe('__calame_scope_blocked__');
    });
  });
});

// ---------------------------------------------------------------------------
// getTableScopeStatus
// ---------------------------------------------------------------------------

describe('getTableScopeStatus', () => {
  const scopeFilters: ResolvedScopeFilter[] = [
    { tableName: 'colis', column: 'client_email', value: 'dupont@gmail.com' },
    { tableName: 'factures', column: 'numero_client', value: 'CLT-00042' },
  ];
  const sharedTables = ['produits', 'categories'];

  it('returns "scoped" for tables with a scope filter', () => {
    expect(getTableScopeStatus('colis', scopeFilters, sharedTables)).toBe('scoped');
    expect(getTableScopeStatus('factures', scopeFilters, sharedTables)).toBe('scoped');
  });

  it('returns "shared" for tables in sharedTables', () => {
    expect(getTableScopeStatus('produits', scopeFilters, sharedTables)).toBe('shared');
    expect(getTableScopeStatus('categories', scopeFilters, sharedTables)).toBe('shared');
  });

  it('returns "blocked" for tables in neither list (fail-closed)', () => {
    expect(getTableScopeStatus('secrets', scopeFilters, sharedTables)).toBe('blocked');
    expect(getTableScopeStatus('internal_logs', scopeFilters, sharedTables)).toBe('blocked');
  });

  it('returns "blocked" when sharedTables is undefined', () => {
    expect(getTableScopeStatus('produits', scopeFilters, undefined)).toBe('blocked');
  });

  it('returns "blocked" when sharedTables is empty', () => {
    expect(getTableScopeStatus('produits', scopeFilters, [])).toBe('blocked');
  });
});
