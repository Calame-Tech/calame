// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

// Tester feedback #04 / #06: labels of the Sources → knowledge base → MCP flow
// written for a non-specialist, with plurals agreeing with the real count and
// one consistent name for knowledge bases.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApiError, ApiTimeoutError, userFacingApiError } from '../api.js';
import { RAG_STRING_TABLES } from '../onboarding-strings.js';
import { KB_MANAGER_STRING_TABLES } from '../strings/kb-manager.js';
import { RAG_ACCESS_STRING_TABLES } from '../strings/rag-access.js';
import { SOURCE_FORM_STRING_TABLES } from '../strings/source-form.js';
import { SYNC_PANELS_STRING_TABLES, SYNC_PANELS_STRINGS } from '../strings/sync-panels.js';

const store = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};

/** Every rendered text of a table: plain strings, and functions called with 1 and 2. */
function texts(table: object): string[] {
  return Object.values(table).flatMap((value): string[] => {
    if (typeof value === 'string') return [value];
    if (typeof value === 'function') {
      const fn = value as (...args: unknown[]) => unknown;
      return [1, 2].map((n) => String(fn(...Array.from({ length: fn.length }, () => n))));
    }
    return value !== null && typeof value === 'object' ? texts(value as object) : [];
  });
}

const TABLES = {
  onboarding: RAG_STRING_TABLES,
  kbManager: KB_MANAGER_STRING_TABLES,
  ragAccess: RAG_ACCESS_STRING_TABLES,
  sourceForm: SOURCE_FORM_STRING_TABLES,
  syncPanels: SYNC_PANELS_STRING_TABLES,
};

describe('knowledge-base flow labels', () => {
  beforeEach(() => vi.stubGlobal('localStorage', localStorage));
  afterEach(() => {
    store.clear();
    vi.unstubAllGlobals();
  });

  it('never shows an environment variable name', () => {
    for (const { fr, en } of Object.values(TABLES)) {
      for (const text of [...texts(fr), ...texts(en)]) {
        expect(text).not.toMatch(/CALAME_[A-Z_]+/);
      }
    }
  });

  it('names knowledge bases the same way everywhere', () => {
    for (const { fr, en } of Object.values(TABLES)) {
      for (const text of texts(fr)) {
        // "base(s) de connaissances" — never "connaissance" alone.
        expect(text).not.toMatch(/bases? de connaissance(?!s)/i);
      }
      for (const text of texts(en)) expect(text).not.toMatch(/RAG (scopes|access)/);
    }
  });

  it('drops the "Globs" jargon from the visible field names', () => {
    for (const { fr, en } of [RAG_STRING_TABLES]) {
      for (const key of ['includeGlobs', 'excludeGlobs'] as const) {
        expect(fr[key]).not.toMatch(/^Globs/);
        expect(en[key]).not.toMatch(/globs$/);
        // The technical term stays available for those who know it.
        expect(fr[key]).toMatch(/glob/);
        expect(en[key]).toMatch(/glob/);
      }
    }
    expect(RAG_STRING_TABLES.fr.embeddingLabel).toBe("Modèle d'analyse des documents (embeddings)");
    expect(RAG_STRING_TABLES.en.embeddingLabel).toBe('Document analysis model (embeddings)');
  });

  it('agrees token units and source counts with the number', () => {
    const { fr, en } = SYNC_PANELS_STRING_TABLES;
    expect([0, 1, 2].map(fr.tokens)).toEqual(['jeton', 'jeton', 'jetons']);
    expect([0, 1, 2].map(en.tokens)).toEqual(['tokens', 'token', 'tokens']);
    expect(fr.reindexProgress(1, 1)).toBe('1 / 1 source purgée et reconfigurée.');
    expect(en.reindexProgress(0, 3)).toBe('0 / 3 sources purged and reconfigured.');
    expect(KB_MANAGER_STRING_TABLES.en.trashButtonTitle(1, 30)).toMatch(/^1 source in the trash/);
    expect(KB_MANAGER_STRING_TABLES.fr.trashButtonTitle(2, 30)).toMatch(
      /^2 sources dans la corbeille — restaurables/,
    );
    for (const { fr: f, en: e } of Object.values(TABLES)) {
      for (const text of [...texts(f), ...texts(e)]) expect(text).not.toMatch(/\w\(s\)(?!:\/\/)/);
    }
  });

  it('explains a request without HTTP answer instead of showing "Failed to fetch"', () => {
    localStorage.setItem('calame-locale', 'fr');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const message = userFacingApiError(new TypeError('Failed to fetch'), 'fallback');
    expect(message).toBe('le serveur Calame ne répond pas');
    expect(`${SYNC_PANELS_STRINGS.usageLoadFailed} ${message}`).toBe(
      'Impossible de charger la consommation : le serveur Calame ne répond pas',
    );
    // The technical detail is kept for the console.
    expect(consoleError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: 'Failed to fetch' }),
    );
    // Server answers and timeouts keep their own message.
    expect(userFacingApiError(new ApiError(500, 'Boom'), 'fallback')).toBe('Boom');
    expect(userFacingApiError(new ApiTimeoutError(15_000), 'x')).toMatch(/15 s/);
    expect(userFacingApiError('weird', 'fallback')).toBe('fallback');
    consoleError.mockRestore();
  });
});
