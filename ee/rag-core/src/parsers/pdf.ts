// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { extractText, getDocumentProxy } from 'unpdf';
import type { ParsedDocument } from './types.js';

/**
 * Parse a PDF buffer into Markdown using `unpdf` (a modern, dependency-light
 * fork of pdf.js with no native bindings).
 *
 * `unpdf` does not expose heading / paragraph structure within a page — but
 * it DOES give us the page boundaries (`mergePages: false`), which are the
 * one piece of real structure every PDF has. We mark each page as a `## Page
 * N` heading and tag the result `'markdown'` so the structure-aware markdown
 * chunker splits on page boundaries instead of raw token windows. Without
 * this, a PDF whose total extracted text fits under one token window (a
 * short slide deck with sparse text, say) comes back as a single chunk
 * regardless of how many pages/slides it actually has — while the same
 * content as HTML gets one chunk per heading via the markdown chunker. This
 * keeps both formats on equal footing.
 *
 * Page numbers reflect the ORIGINAL PDF page index (1-based), not the index
 * after dropping empty pages — so "## Page 3" always means page 3 of the
 * PDF, even if pages 1-2 had no extractable text (e.g. image-only slides).
 */
export async function parse(buffer: Buffer): Promise<ParsedDocument> {
  // unpdf expects a Uint8Array, not a Node Buffer slice.
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pdf = await getDocumentProxy(bytes);
  const result = await extractText(pdf, { mergePages: false });

  // `text` is string[] when mergePages is false.
  const pages: string[] = Array.isArray(result.text) ? result.text : [result.text];
  const normalized = pages
    .map((p, i) => ({ pageNumber: i + 1, text: typeof p === 'string' ? p.trim() : '' }))
    .filter((p) => p.text.length > 0)
    .map((p) => `## Page ${p.pageNumber}\n\n${p.text}`)
    .join('\n\n');

  return {
    text: normalized,
    format: 'markdown',
    metadata: { pageCount: pages.length },
  };
}
