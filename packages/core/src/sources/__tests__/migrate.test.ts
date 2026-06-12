import { describe, it, expect } from 'vitest';
import { upgradeProfileShape, upgradeConfigurationShape } from '../migrate.js';
import type { ServeProfile, ServeConfiguration } from '../../serve/types.js';
import type { ScopeSelection } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fully legacy profile: no sources, no scopes. */
const legacyProfile: Record<string, unknown> = {
  name: 'prod',
  label: 'Production',
  connections: ['pg-main'],
  selectedTables: {
    users: ['id', 'email', 'created_at'],
    orders: ['id', 'user_id', 'total'],
  },
  tableOptions: {
    users: { enabledTools: ['query', 'describe'], maxLimit: 100, filterableColumns: ['email'], groupableColumns: [] },
  },
  columnMasking: {
    users: { email: { maskingMode: 'hash' } },
  },
};

/** A fully new profile: sources + scopes, no legacy fields. */
const newProfile: Record<string, unknown> = {
  name: 'staging',
  label: 'Staging',
  sources: ['pg-staging'],
  scopes: {
    'pg-staging': {
      kind: 'relational',
      selectedTables: { products: ['id', 'name'] },
    },
  },
};

/** A half-migrated profile: has both legacy and new fields. */
const halfMigratedProfile: Record<string, unknown> = {
  name: 'hybrid',
  label: 'Hybrid',
  connections: ['pg-old'],
  selectedTables: { legacy_table: ['col1'] },
  sources: ['pg-new'],
  scopes: {
    'pg-new': {
      kind: 'relational',
      selectedTables: { new_table: ['colA', 'colB'] },
    },
  },
};

/** An empty profile: no relevant fields at all. */
const emptyProfile: Record<string, unknown> = {
  name: 'empty',
  label: 'Empty',
  selectedTables: {},
};

// ---------------------------------------------------------------------------
// upgradeProfileShape
// ---------------------------------------------------------------------------

describe('upgradeProfileShape', () => {
  it('throws on null input', () => {
    expect(() => upgradeProfileShape(null)).toThrow(TypeError);
    expect(() => upgradeProfileShape(null)).toThrow(/expected a plain object/);
  });

  it('throws on undefined input', () => {
    expect(() => upgradeProfileShape(undefined)).toThrow(TypeError);
  });

  it('throws on primitive inputs', () => {
    expect(() => upgradeProfileShape(42)).toThrow(TypeError);
    expect(() => upgradeProfileShape('string')).toThrow(TypeError);
    expect(() => upgradeProfileShape(true)).toThrow(TypeError);
  });

  it('throws on array input', () => {
    expect(() => upgradeProfileShape([])).toThrow(TypeError);
    expect(() => upgradeProfileShape([{ name: 'x' }])).toThrow(TypeError);
  });

  describe('fully legacy profile', () => {
    it('synthesises sources from connections', () => {
      const result = upgradeProfileShape(legacyProfile);
      expect(result.sources).toEqual(['pg-main']);
    });

    it('synthesises scopes with kind relational', () => {
      const result = upgradeProfileShape(legacyProfile);
      expect(result.scopes).toBeDefined();
      const scope = result.scopes!['pg-main'];
      expect(scope).toBeDefined();
      expect(scope.kind).toBe('relational');
    });

    it('scope carries the full selectedTables', () => {
      const result = upgradeProfileShape(legacyProfile);
      const scope = result.scopes!['pg-main'] as Extract<ScopeSelection, { kind: 'relational' }>;
      expect(scope.selectedTables).toEqual({
        users: ['id', 'email', 'created_at'],
        orders: ['id', 'user_id', 'total'],
      });
    });

    it('scope carries tableOptions', () => {
      const result = upgradeProfileShape(legacyProfile);
      const scope = result.scopes!['pg-main'] as Extract<ScopeSelection, { kind: 'relational' }>;
      expect(scope.tableOptions).toBeDefined();
      expect(scope.tableOptions!['users']).toMatchObject({ maxLimit: 100 });
    });

    it('scope carries columnMasking', () => {
      const result = upgradeProfileShape(legacyProfile);
      const scope = result.scopes!['pg-main'] as Extract<ScopeSelection, { kind: 'relational' }>;
      expect(scope.columnMasking).toBeDefined();
      expect(scope.columnMasking!['users']!['email']).toEqual({ maskingMode: 'hash' });
    });

    it('drops legacy root fields after folding into sources/scopes (Phase 5)', () => {
      const result = upgradeProfileShape(legacyProfile) as unknown as Record<string, unknown>;
      expect(result['connections']).toBeUndefined();
      expect(result['selectedTables']).toBeUndefined();
      expect(result['tableOptions']).toBeUndefined();
      expect(result['columnMasking']).toBeUndefined();
    });

    it('does not mutate the input', () => {
      const input = JSON.parse(JSON.stringify(legacyProfile)) as Record<string, unknown>;
      upgradeProfileShape(input);
      expect(input['sources']).toBeUndefined();
      expect(input['scopes']).toBeUndefined();
    });
  });

  describe('already-new profile', () => {
    it('returns a profile with the same sources', () => {
      const result = upgradeProfileShape(newProfile);
      expect(result.sources).toEqual(['pg-staging']);
    });

    it('does not re-derive scopes when scopes is already populated', () => {
      const result = upgradeProfileShape(newProfile);
      // scopes should be identical to what was passed in
      expect(result.scopes).toEqual(newProfile['scopes']);
    });

    it('has no legacy fields when none were provided', () => {
      const result = upgradeProfileShape(newProfile) as unknown as Record<string, unknown>;
      expect(result['connections']).toBeUndefined();
      expect(result['selectedTables']).toBeUndefined();
    });
  });

  describe('half-migrated profile (both legacy and new fields)', () => {
    it('keeps the new scopes untouched', () => {
      const result = upgradeProfileShape(halfMigratedProfile);
      expect(result.scopes).toEqual(halfMigratedProfile['scopes']);
    });

    it('uses the new sources when both sources and connections are present', () => {
      const result = upgradeProfileShape(halfMigratedProfile);
      // sources was already set → no synthesis from connections
      expect(result.sources).toEqual(['pg-new']);
    });

    it('drops legacy fields even when both shapes are present (Phase 5)', () => {
      const result = upgradeProfileShape(halfMigratedProfile) as unknown as Record<string, unknown>;
      expect(result['connections']).toBeUndefined();
    });
  });

  describe('empty profile (no relevant fields)', () => {
    it('returns sources as undefined when connections is absent', () => {
      const result = upgradeProfileShape(emptyProfile);
      expect(result.sources).toBeUndefined();
    });

    it('returns scopes as undefined when no legacy data', () => {
      const result = upgradeProfileShape(emptyProfile);
      const asRecord = result as unknown as Record<string, unknown>;
      expect(asRecord['scopes']).toBeUndefined();
    });
  });

  describe('idempotency', () => {
    it('upgradeProfileShape(upgradeProfileShape(x)) deep-equals upgradeProfileShape(x) for legacy profile', () => {
      const once = upgradeProfileShape(legacyProfile);
      const twice = upgradeProfileShape(once as unknown as Record<string, unknown>);
      expect(twice).toEqual(once);
    });

    it('upgradeProfileShape(upgradeProfileShape(x)) deep-equals upgradeProfileShape(x) for new profile', () => {
      const once = upgradeProfileShape(newProfile);
      const twice = upgradeProfileShape(once as unknown as Record<string, unknown>);
      expect(twice).toEqual(once);
    });
  });

  describe('single-connection legacy: selectedTables keys are table names', () => {
    it('attributes the whole block to the single source id', () => {
      const profile: Record<string, unknown> = {
        name: 'single',
        label: 'Single',
        connections: ['my-db'],
        selectedTables: { orders: ['id', 'amount'], users: ['id'] },
      };
      const result = upgradeProfileShape(profile);
      expect(result.sources).toEqual(['my-db']);
      const scope = result.scopes!['my-db'] as Extract<ScopeSelection, { kind: 'relational' }>;
      expect(scope.selectedTables).toHaveProperty('orders');
      expect(scope.selectedTables).toHaveProperty('users');
    });
  });

  describe('multi-connection legacy: same block distributed to each connection', () => {
    it('creates one scope entry per connection, all containing the same data', () => {
      const profile: Record<string, unknown> = {
        name: 'multi',
        label: 'Multi',
        connections: ['conn-a', 'conn-b'],
        selectedTables: { users: ['id', 'email'] },
        tableOptions: {
          users: { enabledTools: ['query'], maxLimit: 50, filterableColumns: [], groupableColumns: [] },
        },
      };
      const result = upgradeProfileShape(profile);
      expect(result.sources).toEqual(['conn-a', 'conn-b']);
      expect(result.scopes).toHaveProperty('conn-a');
      expect(result.scopes).toHaveProperty('conn-b');

      const scopeA = result.scopes!['conn-a'] as Extract<ScopeSelection, { kind: 'relational' }>;
      const scopeB = result.scopes!['conn-b'] as Extract<ScopeSelection, { kind: 'relational' }>;
      expect(scopeA.selectedTables).toEqual(scopeB.selectedTables);
      expect(scopeA.tableOptions).toEqual(scopeB.tableOptions);
    });

    it('scope instances are independent objects (not shared references)', () => {
      const profile: Record<string, unknown> = {
        name: 'multi-independent',
        label: 'Multi',
        connections: ['conn-a', 'conn-b'],
        selectedTables: { users: ['id'] },
      };
      const result = upgradeProfileShape(profile);
      const scopeA = result.scopes!['conn-a'];
      const scopeB = result.scopes!['conn-b'];
      // Mutating scopeA should not affect scopeB
      (scopeA as Extract<ScopeSelection, { kind: 'relational' }>).selectedTables['injected'] = ['x'];
      expect(
        (scopeB as Extract<ScopeSelection, { kind: 'relational' }>).selectedTables['injected'],
      ).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// upgradeConfigurationShape
// ---------------------------------------------------------------------------

const legacyConfig: Record<string, unknown> = {
  name: 'main-config',
  label: 'Main',
  connections: ['pg-prod'],
  selectedTables: {
    invoices: ['id', 'amount', 'status'],
  },
  tableOptions: {
    invoices: { enabledTools: ['describe', 'aggregate'], maxLimit: 500, filterableColumns: ['status'], groupableColumns: ['status'] },
  },
  columnMasking: {
    invoices: { amount: { maskingMode: 'none' } },
  },
};

const newConfig: Record<string, unknown> = {
  name: 'new-config',
  label: 'New',
  connections: ['pg-staging'],
  sources: ['pg-staging'],
  selectedTables: {},
  scopes: {
    'pg-staging': {
      kind: 'relational',
      selectedTables: { products: ['id', 'name', 'price'] },
    },
  },
};

describe('upgradeConfigurationShape', () => {
  it('throws on null input', () => {
    expect(() => upgradeConfigurationShape(null)).toThrow(TypeError);
  });

  it('throws on undefined input', () => {
    expect(() => upgradeConfigurationShape(undefined)).toThrow(TypeError);
  });

  it('throws on primitive input', () => {
    expect(() => upgradeConfigurationShape('oops')).toThrow(TypeError);
  });

  it('throws on array input', () => {
    expect(() => upgradeConfigurationShape([{ name: 'x' }])).toThrow(TypeError);
  });

  describe('fully legacy configuration', () => {
    it('synthesises sources from connections', () => {
      const result = upgradeConfigurationShape(legacyConfig);
      expect(result.sources).toEqual(['pg-prod']);
    });

    it('synthesises scopes with kind relational', () => {
      const result = upgradeConfigurationShape(legacyConfig);
      const scope = result.scopes!['pg-prod'];
      expect(scope).toBeDefined();
      expect(scope.kind).toBe('relational');
    });

    it('scope carries selectedTables', () => {
      const result = upgradeConfigurationShape(legacyConfig);
      const scope = result.scopes!['pg-prod'] as Extract<ScopeSelection, { kind: 'relational' }>;
      expect(scope.selectedTables).toEqual({ invoices: ['id', 'amount', 'status'] });
    });

    it('scope carries tableOptions', () => {
      const result = upgradeConfigurationShape(legacyConfig);
      const scope = result.scopes!['pg-prod'] as Extract<ScopeSelection, { kind: 'relational' }>;
      expect(scope.tableOptions!['invoices']).toMatchObject({ maxLimit: 500 });
    });

    it('scope carries columnMasking', () => {
      const result = upgradeConfigurationShape(legacyConfig);
      const scope = result.scopes!['pg-prod'] as Extract<ScopeSelection, { kind: 'relational' }>;
      expect(scope.columnMasking!['invoices']!['amount']).toEqual({ maskingMode: 'none' });
    });

    it('drops legacy root fields after folding into sources/scopes (Phase 5)', () => {
      const result = upgradeConfigurationShape(legacyConfig) as unknown as Record<string, unknown>;
      expect(result['connections']).toBeUndefined();
      expect(result['selectedTables']).toBeUndefined();
      expect(result['tableOptions']).toBeUndefined();
      expect(result['columnMasking']).toBeUndefined();
    });
  });

  describe('already-new configuration', () => {
    it('does not re-derive scopes when already populated', () => {
      const result = upgradeConfigurationShape(newConfig);
      expect(result.scopes).toEqual(newConfig['scopes']);
    });

    it('keeps existing sources', () => {
      const result = upgradeConfigurationShape(newConfig);
      expect(result.sources).toEqual(['pg-staging']);
    });
  });

  describe('idempotency', () => {
    it('upgradeConfigurationShape(upgradeConfigurationShape(x)) deep-equals upgradeConfigurationShape(x)', () => {
      const once = upgradeConfigurationShape(legacyConfig);
      const twice = upgradeConfigurationShape(once as unknown as Record<string, unknown>);
      expect(twice).toEqual(once);
    });
  });

  describe('empty configuration (no table data)', () => {
    it('leaves scopes undefined', () => {
      const config: Record<string, unknown> = {
        name: 'bare',
        label: 'Bare',
        connections: ['pg-x'],
        selectedTables: {},
      };
      const result = upgradeConfigurationShape(config);
      const asRecord = result as unknown as Record<string, unknown>;
      expect(asRecord['scopes']).toBeUndefined();
    });

    it('still synthesises sources from connections', () => {
      const config: Record<string, unknown> = {
        name: 'bare',
        label: 'Bare',
        connections: ['pg-x'],
        selectedTables: {},
      };
      const result = upgradeConfigurationShape(config);
      expect(result.sources).toEqual(['pg-x']);
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-function: type-level sanity checks
// ---------------------------------------------------------------------------

describe('type contract: return types satisfy the declared interfaces', () => {
  it('upgradeProfileShape returns a ServeProfile', () => {
    const result: ServeProfile = upgradeProfileShape(legacyProfile);
    expect(result.name).toBe('prod');
  });

  it('upgradeConfigurationShape returns a ServeConfiguration', () => {
    const result: ServeConfiguration = upgradeConfigurationShape(legacyConfig);
    expect(result.name).toBe('main-config');
  });
});

// ---------------------------------------------------------------------------
// Third-kind extensibility: 'api' scopes must be preserved by the migrator
// (Phase 9 of the RAG plan — proof that the abstraction holds beyond
//  document-style sources).
// ---------------------------------------------------------------------------

describe('upgradeProfileShape — api scopes preserved end-to-end', () => {
  it('keeps an existing api scope untouched', () => {
    const profile: Record<string, unknown> = {
      name: 'with-api',
      label: 'With API',
      sources: ['api1'],
      scopes: {
        api1: {
          kind: 'api',
          allowedOperations: ['http_get'],
          allowedPathPrefixes: ['/v1/public/'],
        },
      },
    };
    const result = upgradeProfileShape(profile);
    expect(result.sources).toEqual(['api1']);
    expect(result.scopes!['api1']).toEqual({
      kind: 'api',
      allowedOperations: ['http_get'],
      allowedPathPrefixes: ['/v1/public/'],
    });
  });

  it('preserves an api scope when mixed with a relational legacy block', () => {
    // Half-migrated profile: scopes is already populated with an 'api' entry,
    // so the migrator must skip the legacy synthesis path entirely.
    const profile: Record<string, unknown> = {
      name: 'hybrid-api',
      label: 'Hybrid API',
      // Legacy fields that should NOT be folded in because scopes is non-empty.
      connections: ['legacy-pg'],
      selectedTables: { users: ['id'] },
      sources: ['api1'],
      scopes: {
        api1: { kind: 'api', allowedOperations: ['http_get'] },
      },
    };
    const result = upgradeProfileShape(profile);
    expect(result.scopes).toEqual({
      api1: { kind: 'api', allowedOperations: ['http_get'] },
    });
    // Legacy fields are stripped by Phase-5 cleanup
    const asRecord = result as unknown as Record<string, unknown>;
    expect(asRecord['connections']).toBeUndefined();
    expect(asRecord['selectedTables']).toBeUndefined();
  });

  it('is idempotent for api-only profiles', () => {
    const profile: Record<string, unknown> = {
      name: 'api-only',
      label: 'API only',
      sources: ['api1'],
      scopes: {
        api1: { kind: 'api', allowedOperations: ['http_get'] },
      },
    };
    const once = upgradeProfileShape(profile);
    const twice = upgradeProfileShape(once as unknown as Record<string, unknown>);
    expect(twice).toEqual(once);
  });
});

describe('upgradeConfigurationShape — api scopes preserved end-to-end', () => {
  it('keeps an existing api scope untouched', () => {
    const cfg: Record<string, unknown> = {
      name: 'cfg-api',
      label: 'Cfg API',
      sources: ['api1'],
      scopes: {
        api1: { kind: 'api', allowedOperations: ['http_get'] },
      },
    };
    const result = upgradeConfigurationShape(cfg);
    expect(result.scopes!['api1']).toEqual({
      kind: 'api',
      allowedOperations: ['http_get'],
    });
  });
});
