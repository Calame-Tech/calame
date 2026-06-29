// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Embedding-model price table, expressed in USD per 1,000,000 input tokens.
 *
 * Prices snapshot — May 2026. Sources (public pricing pages):
 *  - OpenAI:  https://openai.com/api/pricing (text-embedding-3-small/large, ada-002)
 *  - Cohere:  https://cohere.com/pricing (embed-* v3 family)
 *  - Voyage:  https://www.voyageai.com/pricing (voyage-3, voyage-3-lite)
 *
 * Keep keys aligned with the `embeddingModel` string the host stores on
 * `rag_sources.embedding_model_version` (which is itself sourced from the
 * AI setting at source-create time). When a model is not listed here the
 * usage endpoint reports `costUsd: 0` for that bucket but still counts
 * the tokens — graceful degradation rather than a 500.
 *
 * NOTE: prices are display-only estimates. The authoritative bill is the
 * provider's invoice; this table exists so operators see ballpark cost in
 * the UI without round-tripping to the provider's dashboard.
 */
export const EMBEDDING_PRICES_PER_1M_TOKENS: Record<string, number> = {
  // OpenAI
  'text-embedding-3-small': 0.02,
  'text-embedding-3-large': 0.13,
  'text-embedding-ada-002': 0.1,
  // Cohere — v3 family
  'embed-multilingual-v3.0': 0.1,
  'embed-english-v3.0': 0.1,
  'embed-multilingual-light-v3.0': 0.02,
  'embed-english-light-v3.0': 0.02,
  // Voyage AI
  'voyage-3': 0.06,
  'voyage-3-lite': 0.02,
  'voyage-3-large': 0.18,
};

/**
 * Estimate USD cost for an embedding job given a model identifier and the
 * total token count. Unknown models return 0 (graceful — the caller still
 * surfaces the token count, just without a dollar figure).
 */
export function estimateCostUsd(model: string, tokens: number): number {
  const pricePer1M = EMBEDDING_PRICES_PER_1M_TOKENS[model];
  if (pricePer1M === undefined) return 0;
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return (tokens / 1_000_000) * pricePer1M;
}

/**
 * Returns `true` when the embedding model identifier appears in the price
 * table. Useful for the UI to decide whether to render a "Tarif inconnu"
 * tooltip next to the cost figure.
 */
export function isKnownEmbeddingModel(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(EMBEDDING_PRICES_PER_1M_TOKENS, model);
}
