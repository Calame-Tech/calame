// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import mammoth from 'mammoth';
import type { ParsedDocument } from './types.js';

/**
 * `mammoth.convertToMarkdown` exists at runtime (since mammoth ^1.6) but is
 * not part of the published type definitions. We declare a narrow shape here
 * so the rest of the file stays type-safe.
 */
interface MammothMarkdown {
  convertToMarkdown: (
    input: { buffer: Buffer },
    options?: Record<string, unknown>,
  ) => Promise<{ value: string; messages: unknown[] }>;
}

/**
 * Parse a DOCX buffer to Markdown using `mammoth.convertToMarkdown`. This
 * preserves Word's heading hierarchy, lists, and emphasis — exactly the
 * signals the structure-aware chunker needs to split sensibly.
 *
 * If conversion fails for any reason we fall back to `extractRawText` so the
 * pipeline still produces *something* indexable rather than 500ing on the
 * upload. The fallback returns `format: 'plain'` so the plain chunker is
 * picked.
 */
export async function parse(buffer: Buffer): Promise<ParsedDocument> {
  const mm = mammoth as unknown as MammothMarkdown & typeof mammoth;

  try {
    const result = await mm.convertToMarkdown({ buffer });
    const text = (result.value ?? '').trim();
    if (text.length === 0) {
      const raw = await mammoth.extractRawText({ buffer });
      return { text: raw.value ?? '', format: 'plain' };
    }
    return { text, format: 'markdown' };
  } catch {
    const raw = await mammoth.extractRawText({ buffer });
    return { text: raw.value ?? '', format: 'plain' };
  }
}
