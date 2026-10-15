// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect } from 'vitest';
import { RAG_STRING_TABLES } from '../onboarding-strings.js';
import { KB_MANAGER_STRING_TABLES } from '../strings/kb-manager.js';
import { RAG_ACCESS_STRING_TABLES } from '../strings/rag-access.js';
import { SOURCE_FORM_STRING_TABLES } from '../strings/source-form.js';
import { SYNC_PANELS_STRING_TABLES } from '../strings/sync-panels.js';

/** Flattens nested tables to dotted keys, tagging functions with their arity. */
function shape(table: object, prefix = ''): string[] {
  return Object.entries(table).flatMap(([key, value]) =>
    value !== null && typeof value === 'object'
      ? shape(value as object, `${prefix}${key}.`)
      : [`${prefix}${key}:${typeof value === 'function' ? `fn${value.length}` : typeof value}`],
  );
}

describe('rag-core fr/en string tables', () => {
  const tables = {
    onboarding: RAG_STRING_TABLES,
    kbManager: KB_MANAGER_STRING_TABLES,
    ragAccess: RAG_ACCESS_STRING_TABLES,
    sourceForm: SOURCE_FORM_STRING_TABLES,
    syncPanels: SYNC_PANELS_STRING_TABLES,
  };

  for (const [name, { fr, en }] of Object.entries(tables)) {
    it(`${name}: same keys and argument counts in fr and en`, () => {
      expect(shape(en).sort()).toEqual(shape(fr).sort());
    });

    it(`${name}: no empty translation`, () => {
      const empty = (t: object): string[] =>
        shape(t)
          .filter((k) => k.endsWith(':string'))
          .filter((k) => {
            const value = k
              .split(':')[0]
              .split('.')
              .reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], t);
            return value === '';
          });
      expect(empty(fr)).toEqual([]);
      expect(empty(en)).toEqual([]);
    });
  }
});
