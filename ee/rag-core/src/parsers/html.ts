// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { parse as parseHtml } from 'node-html-parser';
import TurndownService from 'turndown';
import type { ParsedDocument } from './types.js';

/** Tags whose content is non-textual or chrome and should be removed entirely. */
const STRIP_TAGS = ['script', 'style', 'nav', 'footer', 'noscript', 'svg', 'iframe'];

/**
 * Parse an HTML buffer into Markdown. We strip the obvious non-content chrome
 * (scripts, navigation, footers), then hand the cleaned HTML to
 * [turndown](https://github.com/mixmark-io/turndown) which converts headings,
 * lists, code blocks, and emphasis to their Markdown equivalents.
 *
 * The structured Markdown output is consumed downstream by the markdown
 * chunker, which can then split on section boundaries instead of arbitrary
 * token windows.
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

  const cleaned = root.toString();

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
    strongDelimiter: '**',
  });

  const markdown = turndown
    .turndown(cleaned)
    // Collapse runs of more than 2 blank lines that turndown sometimes
    // emits around block elements.
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text: markdown, format: 'markdown' };
}
