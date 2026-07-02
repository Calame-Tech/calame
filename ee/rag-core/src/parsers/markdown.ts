// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { ParsedDocument } from './types.js';

/**
 * Strip a YAML front-matter block delimited by `---` at the top of the file.
 * Returns the markdown body unchanged when no front-matter is present.
 */
function stripFrontMatter(text: string): string {
  if (!text.startsWith('---')) return text;
  const closing = text.indexOf('\n---', 3);
  if (closing === -1) return text;
  const afterClosing = text.indexOf('\n', closing + 4);
  return afterClosing === -1 ? '' : text.slice(afterClosing + 1);
}

/**
 * Parse a Markdown buffer. We preserve the markdown source verbatim (minus an
 * optional YAML front-matter) so the structure-aware chunker downstream can
 * see headings, lists, fenced code blocks, and emit chunks that respect those
 * boundaries.
 *
 * NOTE: This replaces the previous behavior, which flattened the AST to plain
 * text via `mdast-util-to-string`. That flattening discarded the very signals
 * the new markdown chunker relies on (heading levels, paragraph breaks), so
 * we now keep the markdown intact.
 */
export async function parse(buffer: Buffer): Promise<ParsedDocument> {
  const raw = buffer.toString('utf8');
  const body = stripFrontMatter(raw);
  return { text: body, format: 'markdown' };
}
