import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { SourceAdapterRegistry } from '../registry.js';
import type { SourceAdapter, ScopeSelection } from '../types.js';

// ---------------------------------------------------------------------------
// Minimal mock adapters
// ---------------------------------------------------------------------------

const scopeSelectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('relational'),
    selectedTables: z.record(z.string(), z.array(z.string())),
  }),
  z.object({
    kind: z.literal('document'),
    mode: z.enum(['allowAll', 'allowList']),
    allowedFolders: z.array(z.string()),
    allowedDocuments: z.array(z.string()),
  }),
]) as z.ZodType<ScopeSelection>;

function makeAdapter(type: string, caps: SourceAdapter['capabilities'] = []): SourceAdapter {
  return {
    type,
    displayName: `${type} adapter`,
    capabilities: caps,
    configSchema: z.object({}),
    scopeSelectionSchema,
    testConnection: async () => {
      // no-op
    },
  };
}

const adapterA = makeAdapter('postgresql', ['introspect', 'query', 'sample']);
const adapterB = makeAdapter('local', ['introspect', 'enumerate', 'fetch', 'search']);
const adapterC = makeAdapter('http', ['fetch']);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SourceAdapterRegistry', () => {
  let registry: SourceAdapterRegistry;

  beforeEach(() => {
    registry = new SourceAdapterRegistry();
  });

  it('register adds an adapter', () => {
    registry.register(adapterA);
    expect(registry.has('postgresql')).toBe(true);
  });

  it('register throws on duplicate type', () => {
    registry.register(adapterA);
    expect(() => registry.register(makeAdapter('postgresql'))).toThrow(
      "adapter 'postgresql' is already registered",
    );
  });

  it('get returns the adapter', () => {
    registry.register(adapterA);
    expect(registry.get('postgresql')).toBe(adapterA);
  });

  it('get returns undefined for unknown type', () => {
    expect(registry.get('unknown')).toBeUndefined();
  });

  it('has returns true when registered', () => {
    registry.register(adapterA);
    expect(registry.has('postgresql')).toBe(true);
  });

  it('has returns false when not registered', () => {
    expect(registry.has('postgresql')).toBe(false);
  });

  it('list returns adapters in insertion order', () => {
    registry.register(adapterA);
    registry.register(adapterB);
    registry.register(adapterC);
    expect(registry.list()).toEqual([adapterA, adapterB, adapterC]);
  });

  it('listByCapability filters correctly', () => {
    registry.register(adapterA);
    registry.register(adapterB);
    registry.register(adapterC);

    expect(registry.listByCapability('introspect')).toEqual([adapterA, adapterB]);
    expect(registry.listByCapability('search')).toEqual([adapterB]);
    expect(registry.listByCapability('query')).toEqual([adapterA]);
    expect(registry.listByCapability('fetch')).toEqual([adapterB, adapterC]);
    expect(registry.listByCapability('write')).toEqual([]);
  });

  it('requireWithCapability returns the adapter when capability matches', () => {
    registry.register(adapterA);
    expect(registry.requireWithCapability('postgresql', 'query')).toBe(adapterA);
  });

  it('requireWithCapability throws when adapter is missing', () => {
    expect(() => registry.requireWithCapability('missing', 'query')).toThrow(
      "adapter 'missing' is not registered",
    );
  });

  it('requireWithCapability throws when adapter exists but capability is not declared', () => {
    registry.register(adapterA);
    expect(() => registry.requireWithCapability('postgresql', 'search')).toThrow(
      "adapter 'postgresql' does not declare capability 'search'",
    );
  });

  it('clear empties the registry', () => {
    registry.register(adapterA);
    registry.register(adapterB);
    registry.clear();
    expect(registry.list()).toEqual([]);
    expect(registry.has('postgresql')).toBe(false);
  });

  it('unregister removes by type and returns true', () => {
    registry.register(adapterA);
    expect(registry.unregister('postgresql')).toBe(true);
    expect(registry.has('postgresql')).toBe(false);
  });

  it('unregister returns false when not found', () => {
    expect(registry.unregister('nonexistent')).toBe(false);
  });
});
