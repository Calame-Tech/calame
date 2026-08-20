// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect } from 'vitest';
import {
  estimateCostUsd,
  isKnownEmbeddingModel,
  isLocalEmbeddingModel,
  EMBEDDING_PRICES_PER_1M_TOKENS,
  LOCAL_EMBEDDING_MODELS,
} from '../pricing.js';

describe('pricing — estimateCostUsd', () => {
  it('estimates correctly for a known model', () => {
    // 1,000,000 tokens of text-embedding-3-small @ $0.02 / 1M = exactly $0.02.
    expect(estimateCostUsd('text-embedding-3-small', 1_000_000)).toBeCloseTo(0.02, 6);
    // 500,000 tokens → half-rate.
    expect(estimateCostUsd('text-embedding-3-small', 500_000)).toBeCloseTo(0.01, 6);
  });

  it('returns 0 for an unknown model (graceful — counted tokens, no cost)', () => {
    expect(estimateCostUsd('unknown-embedding-model-vX', 1_000_000)).toBe(0);
  });

  it('returns 0 for zero or negative token counts', () => {
    expect(estimateCostUsd('text-embedding-3-small', 0)).toBe(0);
    expect(estimateCostUsd('text-embedding-3-small', -100)).toBe(0);
  });

  it('returns 0 for a non-finite token count rather than NaN', () => {
    expect(estimateCostUsd('text-embedding-3-small', Number.NaN)).toBe(0);
    expect(estimateCostUsd('text-embedding-3-small', Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('pricing — isKnownEmbeddingModel', () => {
  it('returns true for every model present in the price table', () => {
    for (const model of Object.keys(EMBEDDING_PRICES_PER_1M_TOKENS)) {
      expect(isKnownEmbeddingModel(model)).toBe(true);
    }
  });

  it('returns false for a model not in the table', () => {
    expect(isKnownEmbeddingModel('does-not-exist')).toBe(false);
    expect(isKnownEmbeddingModel('')).toBe(false);
  });
});

describe('pricing — local embedding model', () => {
  it('the bundled local model is listed at $0, not simply absent from the table', () => {
    // Distinguishes "free" (in the table, price 0) from "unpriced" (absent,
    // renders a "?" in the UI) — see the comment on EMBEDDING_PRICES_PER_1M_TOKENS.
    expect(isKnownEmbeddingModel('embeddinggemma-300m-q4')).toBe(true);
    expect(EMBEDDING_PRICES_PER_1M_TOKENS['embeddinggemma-300m-q4']).toBe(0);
    expect(estimateCostUsd('embeddinggemma-300m-q4', 10_000_000)).toBe(0);
  });

  it('isLocalEmbeddingModel identifies the bundled model and rejects everything else', () => {
    expect(isLocalEmbeddingModel('embeddinggemma-300m-q4')).toBe(true);
    for (const model of Object.keys(EMBEDDING_PRICES_PER_1M_TOKENS)) {
      if (model === 'embeddinggemma-300m-q4') continue;
      expect(isLocalEmbeddingModel(model)).toBe(false);
    }
    expect(isLocalEmbeddingModel('')).toBe(false);
  });

  it('every entry in LOCAL_EMBEDDING_MODELS is also a known (priced) model', () => {
    for (const model of LOCAL_EMBEDDING_MODELS) {
      expect(isKnownEmbeddingModel(model)).toBe(true);
    }
  });
});
