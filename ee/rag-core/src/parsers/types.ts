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
 *   - `plain`    → unstructured text; consumed by the plain (token-sliding)
 *     chunker. This is the safe default for unknown content.
 */
export type ParsedDocumentFormat = 'markdown' | 'csv' | 'plain';

/** Common return shape for every parser. */
export interface ParsedDocument {
	text: string;
	/**
	 * Format hint. Optional for backwards compatibility: omitted is treated
	 * as `'plain'` by the chunker selector.
	 */
	format?: ParsedDocumentFormat;
	metadata?: Record<string, unknown>;
}

/** A parser converts a binary buffer into a {@link ParsedDocument}. */
export type DocumentParser = (buffer: Buffer) => Promise<ParsedDocument>;
