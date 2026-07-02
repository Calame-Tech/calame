/**
 * Integration tests for `mergeConfigurations` with Phase 5 unified-shape
 * ServeConfiguration objects (no legacy `connections`/`selectedTables`/
 * `tableOptions`/`columnMasking` root fields).
 *
 * These tests document and guard the three bugs that caused
 * `Cannot read properties of undefined (reading Symbol.iterator)` in serve.ts
 * when a profile referenced a Phase 5 configuration:
 *
 *  Bug A — `mergeConfigurations` called `config.connections` directly; for a
 *    Phase 5 config the field is `undefined`, spreading `undefined` into a
 *    `for…of` loop throws.
 *
 *  Bug B / C — `cfg.selectedTables` was read directly in the
 *    `/api/serve/start` and `/api/serve/refresh` handlers in serve-status.ts;
 *    same crash.
 *
 * The fix: all field reads go through the Configuration accessors
 * (`getConfigurationRelationalSources`, `getConfigurationSelectedTables`,
 * `getConfigurationTableOptions`, `getConfigurationColumnMasking`).
 *
 * `mergeConfigurations` is exported so it can be tested in isolation here
 * without booting the full Express app.
 */
import { describe, it, expect } from 'vitest';
import { mergeConfigurations } from '../serve.js';
import type { ServeConfiguration } from '@calame/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Phase 5 unified-shape ServeConfiguration (no legacy root fields). */
function makeUnifiedConfig(
  name: string,
  scopes: ServeConfiguration['scopes'],
  sources?: string[],
): ServeConfiguration {
  return {
    name,
    label: name,
    sources: sources ?? Object.keys(scopes ?? {}),
    scopes,
    // Intentionally absent: connections, selectedTables, tableOptions, columnMasking
  } as ServeConfiguration;
}

/** Build a legacy-shape ServeConfiguration (pre-migration v10). */
function makeLegacyConfig(
  name: string,
  connections: string[],
  selectedTables: Record<string, string[]>,
): ServeConfiguration {
  return {
    name,
    label: name,
    connections,
    selectedTables,
  } as ServeConfiguration;
}

// ---------------------------------------------------------------------------
// Tests — Phase 5 unified shape
// ---------------------------------------------------------------------------

describe('mergeConfigurations — Phase 5 unified shape (no legacy fields)', () => {
  it('does not throw when configs carry scopes instead of selectedTables/connections', () => {
    const cfg = makeUnifiedConfig('cfg1', {
      db1: { kind: 'relational', selectedTables: { users: ['id', 'email'] } },
    });
    expect(() => mergeConfigurations([cfg])).not.toThrow();
  });

  it('returns the correct selectedTables from a single Phase 5 config', () => {
    const cfg = makeUnifiedConfig('cfg1', {
      db1: { kind: 'relational', selectedTables: { users: ['id'], orders: ['total'] } },
    });
    const result = mergeConfigurations([cfg]);
    expect(result.selectedTables).toEqual({ users: ['id'], orders: ['total'] });
  });

  it('returns the correct relational sources (connections) from a Phase 5 config', () => {
    const cfg = makeUnifiedConfig(
      'cfg1',
      {
        prod: { kind: 'relational', selectedTables: { users: ['id'] } },
        staging: { kind: 'relational', selectedTables: { users: ['id'] } },
      },
      ['prod', 'staging'],
    );
    const result = mergeConfigurations([cfg]);
    expect(result.connections).toContain('prod');
    expect(result.connections).toContain('staging');
  });

  it('merges two Phase 5 configs: unions columns for shared table', () => {
    const cfg1 = makeUnifiedConfig('cfg1', {
      db1: { kind: 'relational', selectedTables: { users: ['id', 'email'] } },
    });
    const cfg2 = makeUnifiedConfig('cfg2', {
      db1: { kind: 'relational', selectedTables: { users: ['id', 'name'], orders: ['amount'] } },
    });
    const result = mergeConfigurations([cfg1, cfg2]);
    expect(result.selectedTables['users'].sort()).toEqual(['email', 'id', 'name']);
    expect(result.selectedTables['orders']).toEqual(['amount']);
  });

  it('tableOptions are merged from Phase 5 scopes', () => {
    const cfg = makeUnifiedConfig('cfg1', {
      db1: {
        kind: 'relational',
        selectedTables: { products: ['id'] },
        tableOptions: {
          products: {
            enabledTools: ['query'],
            maxLimit: 100,
            filterableColumns: [],
            groupableColumns: [],
          },
        },
      },
    });
    const result = mergeConfigurations([cfg]);
    expect(result.tableOptions['products']).toBeDefined();
    expect(result.tableOptions['products'].maxLimit).toBe(100);
  });

  it('columnMasking is merged from Phase 5 scopes', () => {
    const cfg = makeUnifiedConfig('cfg1', {
      db1: {
        kind: 'relational',
        selectedTables: { users: ['email'] },
        columnMasking: { users: { email: { maskingMode: 'hash' } } },
      },
    });
    const result = mergeConfigurations([cfg]);
    expect(result.columnMasking['users']['email'].maskingMode).toBe('hash');
  });

  it('least restrictive masking wins when two configs mask the same column differently', () => {
    const cfg1 = makeUnifiedConfig('cfg1', {
      db1: {
        kind: 'relational',
        selectedTables: { users: ['email'] },
        columnMasking: { users: { email: { maskingMode: 'exclude' } } },
      },
    });
    const cfg2 = makeUnifiedConfig('cfg2', {
      db1: {
        kind: 'relational',
        selectedTables: { users: ['email'] },
        columnMasking: { users: { email: { maskingMode: 'replace' } } },
      },
    });
    const result = mergeConfigurations([cfg1, cfg2]);
    // 'replace' is less restrictive than 'exclude' in MASKING_ORDER
    expect(result.columnMasking['users']['email'].maskingMode).toBe('replace');
  });

  it('document scopes are ignored (only relational sources contribute to connections)', () => {
    const cfg = makeUnifiedConfig(
      'cfg1',
      {
        kb1: { kind: 'document', mode: 'allowAll', allowedFolders: [], allowedDocuments: [] },
        db1: { kind: 'relational', selectedTables: { docs: ['id'] } },
      },
      ['kb1', 'db1'],
    );
    const result = mergeConfigurations([cfg]);
    expect(result.connections).toEqual(['db1']);
    expect(result.connections).not.toContain('kb1');
  });

  it('empty scopes object produces empty result without throwing', () => {
    const cfg = makeUnifiedConfig('cfg1', {});
    const result = mergeConfigurations([cfg]);
    expect(result.connections).toEqual([]);
    expect(result.selectedTables).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Tests — legacy shape (regression guard: must still work after the migration)
// ---------------------------------------------------------------------------

describe('mergeConfigurations — legacy shape (pre-migration v10 rows)', () => {
  it('still works with legacy connections + selectedTables fields', () => {
    const cfg = makeLegacyConfig('legacy', ['conn1'], { orders: ['id', 'total'] });
    const result = mergeConfigurations([cfg]);
    expect(result.connections).toEqual(['conn1']);
    expect(result.selectedTables['orders']).toEqual(['id', 'total']);
  });

  it('merges a legacy config with a Phase 5 config without throwing', () => {
    const legacy = makeLegacyConfig('old', ['conn1'], { users: ['id'] });
    const unified = makeUnifiedConfig('new', {
      conn2: { kind: 'relational', selectedTables: { users: ['email'], products: ['sku'] } },
    });
    const result = mergeConfigurations([legacy, unified]);
    expect(result.connections).toContain('conn1');
    expect(result.connections).toContain('conn2');
    expect(result.selectedTables['users'].sort()).toEqual(['email', 'id']);
    expect(result.selectedTables['products']).toEqual(['sku']);
  });
});
