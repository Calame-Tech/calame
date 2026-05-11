// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { chunkPlainText } from './plain-chunker.js';
import { chunkMarkdown } from './markdown-chunker.js';
import { chunkCsv } from './csv-chunker.js';
import type { Chunker } from './types.js';
import type { ParsedDocumentFormat } from '../parsers/types.js';

/**
 * Map a parser-declared format to the chunker that knows how to honor its
 * structure. Unknown / unrecognized formats fall back to the plain chunker so
 * the pipeline never crashes on a new format.
 */
export function pickChunker(format: ParsedDocumentFormat | string | undefined): Chunker {
	switch (format) {
		case 'markdown':
			return chunkMarkdown;
		case 'csv':
			return chunkCsv;
		case 'plain':
			return chunkPlainText;
		default:
			return chunkPlainText;
	}
}

export { chunkPlainText } from './plain-chunker.js';
export { chunkMarkdown } from './markdown-chunker.js';
export { chunkCsv } from './csv-chunker.js';
export { countTokens } from './tokenizer.js';
export type { Chunk, ChunkOptions, Chunker } from './types.js';
