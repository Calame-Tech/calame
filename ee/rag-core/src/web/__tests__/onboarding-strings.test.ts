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
    expect(RAG_STRINGS.help.globsExclude).toBe(
      'One pattern per line, e.g. **/drafts/** to skip a folder.',
    );
    expect(RAG_STRINGS.uploadFiles).toBe('Upload files');
    expect(RAG_STRINGS.polling.daily).toBe('Every day');
  });

  it('pluralizes the running sync progress on the total', () => {
    localStorage.setItem('calame-locale', 'fr');
    expect(RAG_STRINGS.syncProgress(1, 1)).toBe(' (1 / 1 document)');
    expect(RAG_STRINGS.syncProgress(0, 1)).toBe(' (0 / 1 document)');
    expect(RAG_STRINGS.syncProgress(3, 21)).toBe(' (3 / 21 documents)');
    localStorage.setItem('calame-locale', 'en');
    expect(RAG_STRINGS.syncProgress(1, 1)).toBe(' (1 / 1 document)');
    expect(RAG_STRINGS.syncProgress(3, 21)).toBe(' (3 / 21 documents)');
  });

  it('translates the known sync-job errors and keeps unknown ones verbatim', () => {
    localStorage.setItem('calame-locale', 'fr');
    expect(translateJobError('2/5 failed; last: ENOENT')).toBe(
      '2 documents sur 5 en échec ; dernière erreur : ENOENT',
    );
    expect(translateJobError('3 doc(s) skipped — unsupported format. Convert …')).toMatch(
      /^3 documents ignorés — format non pris en charge/,
    );
    expect(
      translateJobError(
        '2 doc(s) skipped; last: Dossier\\Rapport.docx: The file could not be parsed',
      ),
    ).toBe(
      '2 fichiers ignorés (illisible, corrompu, trop gros ou verrouillé) ; dernier : Dossier\\Rapport.docx: The file could not be parsed',
    );
    expect(translateJobError('1 doc(s) skipped so far; last: a.docx: locked')).toMatch(
      /^1 fichier ignoré \(/,
    );
    expect(translateJobError('connector exploded')).toBe('connector exploded');
  });

  it('agrees job-error counts with their number instead of printing "(s)"', () => {
    localStorage.setItem('calame-locale', 'fr');
    expect(translateJobError('1 doc(s) skipped — unsupported format. Convert …')).toMatch(
      /^1 document ignoré — format non pris en charge/,
    );
    expect(translateJobError('0 doc(s) skipped; last: a.docx: locked')).toMatch(
      /^0 fichier ignoré \(/,
    );
    expect(translateJobError('1/1 failed; last: ENOENT')).toBe(
      '1 document sur 1 en échec ; dernière erreur : ENOENT',
    );
    localStorage.setItem('calame-locale', 'en');
    expect(translateJobError('1 doc(s) skipped — unsupported format. Convert …')).toMatch(
      /^1 document skipped — unsupported format/,
    );
    expect(translateJobError('3 doc(s) skipped — unsupported format. Convert …')).toMatch(
      /^3 documents skipped/,
    );
    expect(translateJobError('0 doc(s) skipped; last: a.docx: locked')).toMatch(/^0 files skipped/);
    expect(translateJobError('1 doc(s) skipped; last: a.docx: locked')).toMatch(/^1 file skipped/);
    expect(translateJobError('1/3 failed; last: x')).toBe('1 of 3 documents failed; last error: x');
    for (const lang of ['fr', 'en']) {
      localStorage.setItem('calame-locale', lang);
      expect(translateJobError('5 doc(s) skipped; last: x')).not.toContain('(s)');
    }
  });
});

describe('local-folder root errors', () => {
  beforeEach(() => vi.stubGlobal('localStorage', localStorage));
  afterEach(() => {
    store.clear();
    vi.unstubAllGlobals();
  });

  it('translates missing / not-a-folder / unreadable, Windows paths included', () => {
    localStorage.setItem('calame-locale', 'fr');
    expect(
      translateJobError('Local folder "C:\\docs\\inexistant-smeagol" does not exist.'),
    ).toMatch(/^Le dossier « C:\\docs\\inexistant-smeagol » est introuvable\./);
    expect(
      translateJobError(
        'Connector validation failed: Local folder "\\\\nas\\partage\\docs" is not readable (EPERM).',
      ),
    ).toMatch(
      /^La vérification de la source a échoué : Le dossier « \\\\nas\\partage\\docs » n'est pas lisible par Calame \(EPERM\)/,
    );
    localStorage.setItem('calame-locale', 'en');
    expect(translateJobError('Local folder "D:\\notes.md" is not a folder.')).toBe(
      '"D:\\notes.md" is not a folder. Enter the folder that contains the documents.',
    );
  });
});
