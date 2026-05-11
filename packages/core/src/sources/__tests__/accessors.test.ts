import { describe, it, expect } from 'vitest';
import {
  getProfileTableNames,
  getProfileSelectedTables,
  getProfileTableOptions,
  getProfileColumnMasking,
  getProfileRelationalSources,
  getConfigurationTableNames,
  getConfigurationSelectedTables,
  getConfigurationTableOptions,
  getConfigurationColumnMasking,
  getConfigurationRelationalSources,
  type ProfileScopeShape,
} from '../accessors.js';
import type { ServeConfiguration } from '../../serve/types.js';

/**
 * The accessors operate on `ProfileScopeShape` — a structural sub-type that
 * carries both the unified (`sources`/`scopes`) and the legacy
 * (`selectedTables`/...) fields. Tests use it directly so they can exercise
 * the legacy fallback branches without depending on the full `ServeProfile`
 * type (whose legacy keys were dropped in Phase 5).
 */
function makeProfile(overrides: ProfileScopeShape = {}): ProfileScopeShape {
  return { ...overrides };
}

describe('profile accessors — unified shape preferred', () => {
  it('getProfileTableNames returns table names from every relational scope', () => {
    const profile = makeProfile({
      sources: ['db1', 'db2'],
      scopes: {
        db1: { kind: 'relational', selectedTables: { users: ['id'], orders: ['id'] } },
        db2: { kind: 'relational', selectedTables: { products: ['id'] } },
      },
    });
    expect(getProfileTableNames(profile).sort()).toEqual(['orders', 'products', 'users']);
  });

  it('getProfileTableNames falls back to legacy selectedTables when scopes is empty', () => {
    const profile = makeProfile({
      selectedTables: { legacy_table: ['col1', 'col2'] },
    });
    expect(getProfileTableNames(profile)).toEqual(['legacy_table']);
  });

  it('getProfileTableNames ignores document scopes', () => {
    const profile = makeProfile({
      sources: ['kb', 'db'],
      scopes: {
        kb: {
          kind: 'document',
          mode: 'allowAll',
          allowedFolders: [],
          allowedDocuments: [],
        },
        db: { kind: 'relational', selectedTables: { customers: ['id'] } },
      },
    });
    expect(getProfileTableNames(profile)).toEqual(['customers']);
  });

  it('getProfileSelectedTables merges across multiple relational scopes', () => {
    const profile = makeProfile({
      sources: ['db1', 'db2'],
      scopes: {
        db1: { kind: 'relational', selectedTables: { users: ['id'] } },
        db2: { kind: 'relational', selectedTables: { orders: ['total'] } },
      },
    });
    expect(getProfileSelectedTables(profile)).toEqual({
      users: ['id'],
      orders: ['total'],
    });
  });

  it('getProfileSelectedTables returns the legacy field when scopes is empty', () => {
    const profile = makeProfile({ selectedTables: { x: ['y'] } });
    expect(getProfileSelectedTables(profile)).toEqual({ x: ['y'] });
  });

  it('getProfileSelectedTables returns empty object when nothing is set', () => {
    const profile = makeProfile({ scopes: {} });
    expect(getProfileSelectedTables(profile)).toEqual({});
  });

  it('getProfileTableOptions reads from the unified scope', () => {
    const profile = makeProfile({
      sources: ['db1'],
      scopes: {
        db1: {
          kind: 'relational',
          selectedTables: { users: ['id'] },
          tableOptions: {
            users: {
              enabledTools: ['describe'],
              maxLimit: 100,
              filterableColumns: [],
              groupableColumns: [],
            },
          },
        },
      },
    });
    expect(getProfileTableOptions(profile)).toEqual({
      users: {
        enabledTools: ['describe'],
        maxLimit: 100,
        filterableColumns: [],
        groupableColumns: [],
      },
    });
  });

  it('getProfileTableOptions falls back to legacy field when scopes has none', () => {
    const profile = makeProfile({
      tableOptions: {
        x: {
          enabledTools: ['describe', 'query'],
          maxLimit: 50,
          filterableColumns: [],
          groupableColumns: [],
        },
      },
    });
    expect(getProfileTableOptions(profile)).toEqual({
      x: {
        enabledTools: ['describe', 'query'],
        maxLimit: 50,
        filterableColumns: [],
        groupableColumns: [],
      },
    });
  });

  it('getProfileColumnMasking reads from the unified scope', () => {
    const profile = makeProfile({
      sources: ['db1'],
      scopes: {
        db1: {
          kind: 'relational',
          selectedTables: { users: ['email'] },
          columnMasking: { users: { email: { maskingMode: 'hash' } } },
        },
      },
    });
    expect(getProfileColumnMasking(profile)).toEqual({
      users: { email: { maskingMode: 'hash' } },
    });
  });

  it('getProfileColumnMasking returns undefined when neither shape carries masking', () => {
    const profile = makeProfile({
      sources: ['db1'],
      scopes: {
        db1: { kind: 'relational', selectedTables: { users: ['id'] } },
      },
    });
    expect(getProfileColumnMasking(profile)).toBeUndefined();
  });

  it('getProfileRelationalSources lists only relational kinds from sources[]', () => {
    const profile = makeProfile({
      sources: ['db1', 'kb1', 'db2'],
      scopes: {
        db1: { kind: 'relational', selectedTables: {} },
        kb1: {
          kind: 'document',
          mode: 'allowAll',
          allowedFolders: [],
          allowedDocuments: [],
        },
        db2: { kind: 'relational', selectedTables: {} },
      },
    });
    expect(getProfileRelationalSources(profile)).toEqual(['db1', 'db2']);
  });

  it('getProfileRelationalSources falls back to legacy connections when no relational scope', () => {
    const profile = makeProfile({ connections: ['legacy1', 'legacy2'] });
    expect(getProfileRelationalSources(profile)).toEqual(['legacy1', 'legacy2']);
  });

  it('getProfileRelationalSources returns [] when nothing is set', () => {
    const profile = makeProfile();
    expect(getProfileRelationalSources(profile)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// API scope kind — extensibility check (Phase 9 of the RAG plan)
//
// These tests pin the contract that tabular-relational accessors gracefully
// ignore 'api' scopes (and never throw). Adding a third kind to the union
// should not break call sites that only care about relational data.
// ---------------------------------------------------------------------------

describe("profile accessors — third 'api' kind ignored by tabular helpers", () => {
  it('getProfileTableNames ignores api scopes', () => {
    const profile = makeProfile({
      sources: ['api1', 'db1'],
      scopes: {
        api1: { kind: 'api', allowedOperations: ['http_get'] },
        db1: { kind: 'relational', selectedTables: { customers: ['id'] } },
      },
    });
    expect(getProfileTableNames(profile)).toEqual(['customers']);
  });

  it('getProfileTableNames returns [] when every scope is api-only', () => {
    const profile = makeProfile({
      sources: ['api1'],
      scopes: {
        api1: { kind: 'api', allowedOperations: ['http_get'] },
      },
    });
    expect(getProfileTableNames(profile)).toEqual([]);
  });

  it('getProfileSelectedTables returns {} when only api scopes exist', () => {
    const profile = makeProfile({
      sources: ['api1'],
      scopes: {
        api1: { kind: 'api', allowedOperations: ['http_get'] },
      },
    });
    expect(getProfileSelectedTables(profile)).toEqual({});
  });

  it('getProfileTableOptions returns undefined for api-only profile', () => {
    const profile = makeProfile({
      sources: ['api1'],
      scopes: {
        api1: { kind: 'api', allowedOperations: ['http_get'] },
      },
    });
    expect(getProfileTableOptions(profile)).toBeUndefined();
  });

  it('getProfileColumnMasking returns undefined for api-only profile', () => {
    const profile = makeProfile({
      sources: ['api1'],
      scopes: {
        api1: { kind: 'api', allowedOperations: ['http_get'] },
      },
    });
    expect(getProfileColumnMasking(profile)).toBeUndefined();
  });

  it('getProfileRelationalSources excludes api scopes', () => {
    const profile = makeProfile({
      sources: ['db1', 'api1', 'db2'],
      scopes: {
        db1: { kind: 'relational', selectedTables: {} },
        api1: { kind: 'api', allowedOperations: ['http_get'] },
        db2: { kind: 'relational', selectedTables: {} },
      },
    });
    expect(getProfileRelationalSources(profile)).toEqual(['db1', 'db2']);
  });
});

// ---------------------------------------------------------------------------
// Configuration accessors
// ---------------------------------------------------------------------------

/**
 * Build a minimal ServeConfiguration for tests.
 * Partial to allow constructing both unified (scopes) and legacy shapes without
 * TypeScript complaining about missing required fields.
 */
function makeCfg(overrides: Partial<ServeConfiguration>): ServeConfiguration {
  return {
    name: 'test',
    label: 'Test',
    ...overrides,
  } as ServeConfiguration;
}

describe('configuration accessors — unified shape preferred', () => {
  it('getConfigurationTableNames returns table names from every relational scope', () => {
    const cfg = makeCfg({
      sources: ['db1', 'db2'],
      scopes: {
        db1: { kind: 'relational', selectedTables: { users: ['id'], orders: ['id'] } },
        db2: { kind: 'relational', selectedTables: { products: ['sku'] } },
      },
    });
    expect(getConfigurationTableNames(cfg).sort()).toEqual(['orders', 'products', 'users']);
  });

  it('getConfigurationTableNames falls back to legacy selectedTables when scopes is absent', () => {
    const cfg = makeCfg({ selectedTables: { legacy_table: ['col1'] } });
    expect(getConfigurationTableNames(cfg)).toEqual(['legacy_table']);
  });

  it('getConfigurationTableNames ignores document scopes', () => {
    const cfg = makeCfg({
      sources: ['kb', 'db'],
      scopes: {
        kb: { kind: 'document', mode: 'allowAll', allowedFolders: [], allowedDocuments: [] },
        db: { kind: 'relational', selectedTables: { invoices: ['id'] } },
      },
    });
    expect(getConfigurationTableNames(cfg)).toEqual(['invoices']);
  });

  it('getConfigurationSelectedTables merges across multiple relational scopes', () => {
    const cfg = makeCfg({
      sources: ['db1', 'db2'],
      scopes: {
        db1: { kind: 'relational', selectedTables: { users: ['id'] } },
        db2: { kind: 'relational', selectedTables: { orders: ['total'] } },
      },
    });
    expect(getConfigurationSelectedTables(cfg)).toEqual({
      users: ['id'],
      orders: ['total'],
    });
  });

  it('getConfigurationSelectedTables returns the legacy field when scopes is absent', () => {
    const cfg = makeCfg({ selectedTables: { x: ['y'] } });
    expect(getConfigurationSelectedTables(cfg)).toEqual({ x: ['y'] });
  });

  it('getConfigurationSelectedTables returns empty object when neither shape carries data', () => {
    const cfg = makeCfg({ scopes: {} });
    expect(getConfigurationSelectedTables(cfg)).toEqual({});
  });

  it('getConfigurationTableOptions reads from the unified scope', () => {
    const cfg = makeCfg({
      sources: ['db1'],
      scopes: {
        db1: {
          kind: 'relational',
          selectedTables: { users: ['id'] },
          tableOptions: {
            users: { enabledTools: ['describe'], maxLimit: 50, filterableColumns: [], groupableColumns: [] },
          },
        },
      },
    });
    expect(getConfigurationTableOptions(cfg)).toEqual({
      users: { enabledTools: ['describe'], maxLimit: 50, filterableColumns: [], groupableColumns: [] },
    });
  });

  it('getConfigurationTableOptions falls back to legacy field when scopes has none', () => {
    const cfg = makeCfg({
      tableOptions: {
        orders: { enabledTools: ['query'], maxLimit: 200, filterableColumns: [], groupableColumns: [] },
      },
    });
    expect(getConfigurationTableOptions(cfg)).toEqual({
      orders: { enabledTools: ['query'], maxLimit: 200, filterableColumns: [], groupableColumns: [] },
    });
  });

  it('getConfigurationColumnMasking reads from the unified scope', () => {
    const cfg = makeCfg({
      sources: ['db1'],
      scopes: {
        db1: {
          kind: 'relational',
          selectedTables: { users: ['email'] },
          columnMasking: { users: { email: { maskingMode: 'hash' } } },
        },
      },
    });
    expect(getConfigurationColumnMasking(cfg)).toEqual({
      users: { email: { maskingMode: 'hash' } },
    });
  });

  it('getConfigurationColumnMasking returns undefined when neither shape carries masking', () => {
    const cfg = makeCfg({
      sources: ['db1'],
      scopes: { db1: { kind: 'relational', selectedTables: { users: ['id'] } } },
    });
    expect(getConfigurationColumnMasking(cfg)).toBeUndefined();
  });

  it('getConfigurationRelationalSources lists only relational kinds from sources[]', () => {
    const cfg = makeCfg({
      sources: ['db1', 'kb1', 'db2'],
      scopes: {
        db1: { kind: 'relational', selectedTables: {} },
        kb1: { kind: 'document', mode: 'allowAll', allowedFolders: [], allowedDocuments: [] },
        db2: { kind: 'relational', selectedTables: {} },
      },
    });
    expect(getConfigurationRelationalSources(cfg)).toEqual(['db1', 'db2']);
  });

  it('getConfigurationRelationalSources falls back to legacy connections when no relational scope', () => {
    const cfg = makeCfg({ connections: ['conn1', 'conn2'] });
    expect(getConfigurationRelationalSources(cfg)).toEqual(['conn1', 'conn2']);
  });

  it('getConfigurationRelationalSources returns [] when nothing is set', () => {
    const cfg = makeCfg({});
    expect(getConfigurationRelationalSources(cfg)).toEqual([]);
  });
});

describe("configuration accessors — third 'api' kind ignored by tabular helpers", () => {
  it('getConfigurationTableNames ignores api scopes', () => {
    const cfg = makeCfg({
      sources: ['api1', 'db1'],
      scopes: {
        api1: { kind: 'api', allowedOperations: ['http_get'] },
        db1: { kind: 'relational', selectedTables: { invoices: ['id'] } },
      },
    });
    expect(getConfigurationTableNames(cfg)).toEqual(['invoices']);
  });

  it('getConfigurationSelectedTables returns {} for api-only configuration', () => {
    const cfg = makeCfg({
      sources: ['api1'],
      scopes: {
        api1: { kind: 'api', allowedOperations: ['http_get'] },
      },
    });
    expect(getConfigurationSelectedTables(cfg)).toEqual({});
  });

  it('getConfigurationRelationalSources excludes api scopes', () => {
    const cfg = makeCfg({
      sources: ['db1', 'api1'],
      scopes: {
        db1: { kind: 'relational', selectedTables: {} },
        api1: { kind: 'api', allowedOperations: ['http_get'] },
      },
    });
    expect(getConfigurationRelationalSources(cfg)).toEqual(['db1']);
  });
});
