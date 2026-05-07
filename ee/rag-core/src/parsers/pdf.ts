// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { extractText, getDocumentProxy } from 'unpdf';
import type { ParsedDocument } from './types.js';

/**
 * Parse a PDF buffer into plain text using `unpdf` (a modern, dependency-light
 * fork of pdf.js with no native bindings). Pages are joined with a double
 * newline so chunkers can split on paragraph boundaries when desired.
 */
export async function parse(buffer: Buffer): Promise<ParsedDocument> {
	// unpdf expects a Uint8Array, not a Node Buffer slice.
	const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	const pdf = await getDocumentProxy(bytes);
	const result = await extractText(pdf, { mergePages: false });

	// `text` is string[] when mergePages is false.
	const pages: string[] = Array.isArray(result.text) ? result.text : [result.text];
	const text = pages.map((p) => (typeof p === 'string' ? p : '')).join('\n\n').trim();

	return {
		text,
		metadata: { pageCount: pages.length },
	};
}
