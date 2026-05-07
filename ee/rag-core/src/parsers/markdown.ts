// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { toString as mdastToString } from 'mdast-util-to-string';
import type { ParsedDocument } from './types.js';

/**
 * Strip a YAML front-matter block delimited by `---` at the top of the file.
 * Returns the markdown body unchanged when no front-matter is present.
 */
function stripFrontMatter(text: string): string {
	if (!text.startsWith('---')) return text;
	// Look for the closing `---` on its own line after the first.
	const closing = text.indexOf('\n---', 3);
	if (closing === -1) return text;
	const afterClosing = text.indexOf('\n', closing + 4);
	return afterClosing === -1 ? '' : text.slice(afterClosing + 1);
}

/**
 * Parse a Markdown buffer into plain text. We strip an optional YAML
 * front-matter block, then convert the AST to a flat string via
 * `mdast-util-to-string`, which removes all syntax noise (links, code fences,
 * emphasis markers) while preserving the textual content.
 */
export async function parse(buffer: Buffer): Promise<ParsedDocument> {
	const raw = buffer.toString('utf8');
	const body = stripFrontMatter(raw);

	const tree = unified().use(remarkParse).parse(body);
	const text = mdastToString(tree);

	return { text };
}
