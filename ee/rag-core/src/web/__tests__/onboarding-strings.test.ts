// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RAG_STRINGS, translateJobError } from '../onboarding-strings.js';

// rag-core tests run under node: stub the storage the host app writes the locale to.
const store = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};

describe('rag-core strings', () => {
  beforeEach(() => vi.stubGlobal('localStorage', localStorage));
  afterEach(() => {
    store.clear();
    vi.unstubAllGlobals();
  });

  it('follows the saved app locale', () => {
    localStorage.setItem('calame-locale', 'fr');
    expect(RAG_STRINGS.kbTitle).toBe('Bases de connaissances');
    localStorage.setItem('calame-locale', 'en');
    expect(RAG_STRINGS.kbTitle).toBe('Knowledge bases');
    expect(RAG_STRINGS.help.globsExclude).toBe('One glob per line.');
    expect(RAG_STRINGS.uploadFiles).toBe('Upload files');
    expect(RAG_STRINGS.polling.daily).toBe('Every day');
  });

  it('translates the known sync-job errors and keeps unknown ones verbatim', () => {
    localStorage.setItem('calame-locale', 'fr');
    expect(translateJobError('2/5 failed; last: ENOENT')).toBe(
      '2 document(s) sur 5 en échec ; dernière erreur : ENOENT',
    );
    expect(translateJobError('3 doc(s) skipped — unsupported format. Convert …')).toMatch(
      /^3 document\(s\) ignoré\(s\) — format non pris en charge/,
    );
    expect(translateJobError('connector exploded')).toBe('connector exploded');
  });
});
