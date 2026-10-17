// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseDocx } from '../docx.js';

describe('parseDocx', () => {
  // Regression: a `pnpm.overrides` bump of @xmldom/xmldom to 0.9.x (whose
  // parseFromString requires a mimeType that mammoth 1.x does not pass)
  // made EVERY valid DOCX fail with "DOMParser.parseFromString: the provided
  // mimeType "undefined" is not valid". Found by the sync benchmark corpus.
  it('extracts the text of a valid DOCX', async () => {
    const buffer = readFileSync(new URL('./fixtures/valid.docx', import.meta.url));
    const parsed = await parseDocx(buffer);
    expect(parsed.text).toContain('Compte rendu de réunion');
    expect(parsed.text).toContain('Le budget du projet est validé');
  });
});
