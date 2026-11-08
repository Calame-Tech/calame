import { describe, it, expect } from 'vitest';
import {
  getConfigurationDocumentSelection,
  isConfigurationEmpty,
  omitTables,
} from './configuration-save.js';
import type { Configuration } from '../types/schema.js';

const docScope = {
  kind: 'document',
  mode: 'allowList',
  allowedFolders: ['docs'],
  allowedDocuments: [],
} as const;

describe('configuration-save helpers', () => {
  it('extracts only the knowledge-base (document) part of a configuration', () => {
    const config = {
      name: 'c',
      label: 'C',
      sources: ['pg', 'kb1', 'kb2'],
      scopes: {
        pg: { kind: 'relational', selectedTables: {} },
        kb1: docScope,
      },
    } as unknown as Configuration;
    const { sources, scopes } = getConfigurationDocumentSelection(config);
    expect(sources).toEqual(['kb1']);
    expect(Object.keys(scopes)).toEqual(['kb1']);
    expect(getConfigurationDocumentSelection(undefined)).toEqual({ sources: [], scopes: {} });
  });

  it('flags a configuration with no source and no scope as empty', () => {
    expect(isConfigurationEmpty({ name: 'c', label: 'C', sources: [], scopes: {} })).toBe(true);
    expect(isConfigurationEmpty({ name: 'c', label: 'C' })).toBe(true);
    expect(
      isConfigurationEmpty({
        name: 'c',
        label: 'C',
        sources: ['kb1'],
        scopes: { kb1: docScope },
      } as unknown as Configuration),
    ).toBe(false);
  });

  it("drops a removed connection's tables", () => {
    expect(omitTables({ a: 1, b: 2, c: 3 }, new Set(['a', 'c']))).toEqual({ b: 2 });
  });
});
