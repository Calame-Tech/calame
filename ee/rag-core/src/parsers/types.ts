// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Format hint produced by a parser. Drives the chunker selection downstream:
 *
 *   - `markdown` → headings / paragraphs / fenced code preserved verbatim;
 *     consumed by the markdown chunker which respects section boundaries.
 *   - `csv`      → first line is the header, subsequent lines are records;
 *     consumed by the CSV chunker which keeps rows atomic and repeats the
 *     header in every chunk.
 *   - `code`     → source code; consumed by the code chunker which splits on
 *     top-level declarations (function/class/struct/…) using language-aware
 *     regex heuristics.
 *   - `plain`    → unstructured text; consumed by the plain (token-sliding)
 *     chunker. This is the safe default for unknown content.
 */
export type ParsedDocumentFormat = 'markdown' | 'csv' | 'code' | 'plain';

/**
 * Supported source-code languages for the code chunker. `unknown` indicates
 * the file extension didn't map to any recognized language — in that case the
 * parser still tags the format as `'code'` but the chunker falls back to the
 * plain strategy because we have no reliable boundary signal.
 */
export type CodeLanguage =
	| 'typescript'
	| 'javascript'
	| 'python'
	| 'go'
	| 'rust'
	| 'java'
	| 'unknown';

/** Common return shape for every parser. */
export interface ParsedDocument {
	text: string;
	/**
	 * Format hint. Optional for backwards compatibility: omitted is treated
	 * as `'plain'` by the chunker selector.
	 */
	format?: ParsedDocumentFormat;
	/**
	 * Detected programming language (only set when `format === 'code'`).
	 * Propagated through to the code chunker so it can pick the right regex
	 * patterns and comment prefix.
	 */
	language?: CodeLanguage;
	/**
	 * Original filename (without path), when known. The code chunker uses it
	 * to render the `// File: …` preamble of each chunk.
	 */
	filename?: string;
	metadata?: Record<string, unknown>;
}

/**
 * A parser converts a binary buffer into a {@link ParsedDocument}.
 *
 * The optional `filename` argument lets the parser dispatch on extension when
 * the MIME type is generic (e.g. `text/plain` for a `.py` file). Parsers that
 * don't need it ignore the argument.
 */
export type DocumentParser = (buffer: Buffer, filename?: string) => Promise<ParsedDocument>;
