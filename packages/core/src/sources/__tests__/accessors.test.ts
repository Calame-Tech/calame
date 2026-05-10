import { describe, it, expect } from 'vitest';
import {
  getProfileTableNames,
  getProfileSelectedTables,
  getProfileTableOptions,
  getProfileColumnMasking,
  getProfileRelationalSources,
  type ProfileScopeShape,
} from '../accessors.js';

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
