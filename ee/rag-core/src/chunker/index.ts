// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { chunkPlainText } from './plain-chunker.js';
import { chunkMarkdown } from './markdown-chunker.js';
import { chunkCsv } from './csv-chunker.js';
import { chunkCode } from './code-chunker.js';
import type { Chunker } from './types.js';
import type { CodeLanguage, ParsedDocumentFormat } from '../parsers/types.js';

/**
 * Optional, format-specific hints passed alongside the format string. Each
 * field is consumed by exactly one chunker:
 *   - `language` / `filename` → code chunker.
 */
export interface PickChunkerHints {
	language?: CodeLanguage;
	filename?: string;
}

/**
 * Map a parser-declared format to the chunker that knows how to honor its
 * structure. Unknown / unrecognized formats fall back to the plain chunker so
 * the pipeline never crashes on a new format.
 *
 * For `format === 'code'`, optional `hints.language` and `hints.filename` are
 * curried into the returned chunker so the caller can keep using the standard
 * {@link Chunker} signature `(text, opts) => Chunk[]`.
 */
export function pickChunker(
	format: ParsedDocumentFormat | string | undefined,
	hints: PickChunkerHints = {},
): Chunker {
	switch (format) {
		case 'markdown':
			return chunkMarkdown;
		case 'csv':
			return chunkCsv;
		case 'code':
			return (text, opts) =>
				chunkCode(text, {
					...opts,
					language: hints.language,
					filename: hints.filename,
				});
		case 'plain':
			return chunkPlainText;
		default:
			return chunkPlainText;
	}
}

export { chunkPlainText } from './plain-chunker.js';
export { chunkMarkdown } from './markdown-chunker.js';
export { chunkCsv } from './csv-chunker.js';
export { chunkCode } from './code-chunker.js';
export type { CodeChunkOptions, CodeChunkExtraOptions } from './code-chunker.js';
export { countTokens } from './tokenizer.js';
export type { Chunk, ChunkOptions, Chunker } from './types.js';
