// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { extractText, getDocumentProxy } from 'unpdf';
import type { ParsedDocument } from './types.js';

/**
 * Parse a PDF buffer into plain text using `unpdf` (a modern, dependency-light
 * fork of pdf.js with no native bindings).
 *
 * `unpdf` does not expose heading / paragraph structure — only page-level
 * text. We therefore return the result tagged as `'plain'` so the token
 * chunker is selected. Pages are joined with a double newline so the
 * downstream paragraph splitter (used by the plain chunker's fallback paths,
 * and by the markdown chunker when run on heading-less input) still has a
 * usable section signal.
 */
export async function parse(buffer: Buffer): Promise<ParsedDocument> {
	// unpdf expects a Uint8Array, not a Node Buffer slice.
	const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	const pdf = await getDocumentProxy(bytes);
	const result = await extractText(pdf, { mergePages: false });

	// `text` is string[] when mergePages is false.
	const pages: string[] = Array.isArray(result.text) ? result.text : [result.text];
	const normalized = pages
		.map((p) => (typeof p === 'string' ? p.trim() : ''))
		.filter((p) => p.length > 0)
		.join('\n\n');

	return {
		text: normalized,
		format: 'plain',
		metadata: { pageCount: pages.length },
	};
}
