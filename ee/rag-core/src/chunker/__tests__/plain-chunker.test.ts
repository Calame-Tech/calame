// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect } from 'vitest';
import { chunkPlainText } from '../plain-chunker.js';
import { chunkText } from '../token-chunker.js';
import { countTokens } from '../tokenizer.js';

describe('chunkPlainText (plain / token-sliding chunker)', () => {
  it('returns an empty array on empty input', () => {
    expect(chunkPlainText('')).toEqual([]);
    expect(chunkPlainText('   ')).toEqual([]);
    expect(chunkPlainText('\n\n')).toEqual([]);
  });

  it('emits a single chunk when text is shorter than maxTokens', () => {
    const text = 'A short sentence.';
    const chunks = chunkPlainText(text, { maxTokens: 64, overlap: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.position).toBe(0);
    expect(chunks[0]!.text).toBe(text);
    expect(chunks[0]!.tokenCount).toBeGreaterThan(0);
    expect(chunks[0]!.tokenCount).toBeLessThanOrEqual(64);
  });

  it('slides with overlap and emits monotonically increasing positions', () => {
    // Build a long enough text. ~1000 tokens.
    const text = 'word '.repeat(2000);
    const chunks = chunkPlainText(text, { maxTokens: 100, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.position).toBe(i);
      expect(chunks[i]!.tokenCount).toBeLessThanOrEqual(100);
    }
  });

  it('throws when overlap >= maxTokens', () => {
    expect(() => chunkPlainText('x', { maxTokens: 10, overlap: 10 })).toThrow(/overlap/);
    expect(() => chunkPlainText('x', { maxTokens: 10, overlap: 11 })).toThrow(/overlap/);
  });

  it('throws when maxTokens is not a positive integer', () => {
    expect(() => chunkPlainText('x', { maxTokens: 0 })).toThrow(/maxTokens/);
    expect(() => chunkPlainText('x', { maxTokens: -1 })).toThrow(/maxTokens/);
    expect(() => chunkPlainText('x', { maxTokens: 1.5 })).toThrow(/maxTokens/);
  });

  it('matches the deprecated chunkText alias byte-for-byte', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(50);
    const viaLegacy = chunkText(text, { maxTokens: 64, overlap: 8 });
    const viaNew = chunkPlainText(text, { maxTokens: 64, overlap: 8 });
    expect(viaNew).toEqual(viaLegacy);
  });

  it('accurately reports tokenCount using o200k_base', () => {
    const text = 'tokens tokens tokens';
    const chunks = chunkPlainText(text, { maxTokens: 100 });
    expect(chunks[0]!.tokenCount).toBe(countTokens(text));
  });
});
