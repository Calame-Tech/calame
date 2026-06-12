// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Shared options accepted by every chunker. Not every option is honored by
 * every implementation: e.g. `csv-chunker` ignores `overlap` because rows are
 * atomic.
 */
export interface ChunkOptions {
	/** Maximum tokens per chunk. Default 512. */
	maxTokens?: number;
	/** Overlap (in tokens) between consecutive chunks. Default 64. */
	overlap?: number;
	/**
	 * Minimum tokens per chunk before merging with the next one. Default 50.
	 * Honored by structure-aware chunkers (markdown). Ignored by plain.
	 */
	minTokens?: number;
}

/**
 * One unit of indexable text. All chunkers — regardless of strategy — emit
 * objects of this shape so that downstream consumers (embedding, storage) do
 * not care which strategy produced them.
 */
export interface Chunk {
	/** 0-based ordinal of the chunk within the source text. */
	position: number;
	/** Decoded text for this chunk. */
	text: string;
	/** Number of tokens in this chunk (always <= maxTokens). */
	tokenCount: number;
}

/** Signature implemented by every chunker. */
export type Chunker = (text: string, opts?: ChunkOptions) => Chunk[];

/** Defaults applied when a chunker option is omitted. */
export const DEFAULT_MAX_TOKENS = 512;
export const DEFAULT_OVERLAP = 64;
export const DEFAULT_MIN_TOKENS = 50;

/**
 * Soft cap on the number of tokens spent on the hierarchy "preamble" emitted
 * by the markdown chunker. If the heading path is longer than this, the
 * chunker keeps only the most-specific levels.
 */
export const MAX_PREAMBLE_TOKENS = 100;
