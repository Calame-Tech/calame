// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { encode, decode } from 'gpt-tokenizer/encoding/o200k_base';

export interface TokenChunkOptions {
	/** Maximum tokens per chunk. Default 512. */
	maxTokens?: number;
	/** Overlap (in tokens) between consecutive chunks. Default 64. */
	overlap?: number;
}

export interface TokenChunk {
	/** 0-based ordinal of the chunk within the source text. */
	position: number;
	/** Decoded text for this chunk. */
	text: string;
	/** Number of tokens in this chunk (always <= maxTokens). */
	tokenCount: number;
}

const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_OVERLAP = 64;

/**
 * Token-based sliding-window chunker using the o200k_base encoding (the
 * tokenizer used by OpenAI text-embedding-3-* models).
 *
 * Algorithm:
 *  1. Encode the entire input text to tokens.
 *  2. Walk through tokens with a window of `maxTokens`, advancing by
 *     `maxTokens - overlap` each step (so each window overlaps the previous
 *     by `overlap` tokens).
 *  3. Decode each window back to text and emit a chunk.
 *
 * Edge cases:
 *  - Empty / whitespace-only text → empty array.
 *  - Text shorter than `maxTokens` → a single chunk.
 *
 * @throws if `overlap >= maxTokens` (would loop forever).
 */
export function chunkText(text: string, opts: TokenChunkOptions = {}): TokenChunk[] {
	const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
	const overlap = opts.overlap ?? DEFAULT_OVERLAP;

	if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
		throw new Error(`chunkText: maxTokens must be a positive integer, got ${maxTokens}`);
	}
	if (!Number.isInteger(overlap) || overlap < 0) {
		throw new Error(`chunkText: overlap must be a non-negative integer, got ${overlap}`);
	}
	if (overlap >= maxTokens) {
		throw new Error(
			`chunkText: overlap (${overlap}) must be strictly less than maxTokens (${maxTokens})`,
		);
	}

	if (!text || text.trim().length === 0) {
		return [];
	}

	const tokens = encode(text);
	if (tokens.length === 0) {
		return [];
	}

	const step = maxTokens - overlap;
	const chunks: TokenChunk[] = [];
	let position = 0;

	for (let start = 0; start < tokens.length; start += step) {
		const end = Math.min(start + maxTokens, tokens.length);
		const slice = tokens.slice(start, end);
		const chunkText = decode(slice);
		chunks.push({
			position,
			text: chunkText,
			tokenCount: slice.length,
		});
		position += 1;
		if (end === tokens.length) break;
	}

	return chunks;
}
