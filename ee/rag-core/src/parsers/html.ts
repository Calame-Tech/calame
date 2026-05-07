// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { parse as parseHtml } from 'node-html-parser';
import type { ParsedDocument } from './types.js';

/** Tags whose content is non-textual or chrome and should be removed entirely. */
const STRIP_TAGS = ['script', 'style', 'nav', 'footer', 'noscript', 'svg', 'iframe'];

/** Heading tags — emit a leading newline so structure survives chunking. */
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/**
 * Parse an HTML buffer into plain text. Removes scripts/styles/nav/footer,
 * preserves heading boundaries with line breaks, and collapses excessive
 * whitespace.
 */
export async function parse(buffer: Buffer): Promise<ParsedDocument> {
	const root = parseHtml(buffer.toString('utf8'), {
		blockTextElements: { script: false, noscript: false, style: false },
	});

	for (const tag of STRIP_TAGS) {
		for (const node of root.querySelectorAll(tag)) {
			node.remove();
		}
	}

	// Insert blank lines around block-ish elements to keep structure readable.
	for (const heading of root.querySelectorAll(HEADING_TAGS_SELECTOR)) {
		heading.set_content(`\n\n${heading.text}\n`);
	}

	const text = root.text
		.replace(/ /g, ' ')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

	return { text };
}

const HEADING_TAGS_SELECTOR = Array.from(HEADING_TAGS).join(', ');
