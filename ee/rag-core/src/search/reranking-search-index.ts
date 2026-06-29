// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * RerankingSearchIndex — composes a base {@link DocumentSearchIndex} (typically
 * {@link HybridSearchIndex}) with a {@link Reranker} (typically {@link CohereReranker})
 * to deliver the rerank-then-cut pattern:
 *
 *   1. Over-fetch the top-N candidates from the base index (default N = 50).
 *   2. Pass the candidates' (id, text) pairs to the reranker.
 *   3. Re-order the base-index hits using the reranker's score and return the
 *      caller-requested top-K.
 *
 * Fail-open behavior:
 *   When the reranker throws (network error, invalid API key, rate limit, ...)
 *   the wrapper falls back to the base index's natural ordering, capped to
 *   the caller's `topK`. This prevents a Cohere outage from breaking the
 *   entire RAG `search` surface. The failure is logged via the optional
 *   `onAudit` hook so operators can see when rerank is silently disabled.
 *
 * Score semantics after reranking:
 *   The wrapper REPLACES the base index's RRF score with the reranker's
 *   relevance score on each hit. Consumers of `RagSearchResult.chunks[i].score`
 *   should treat the value as opaque, comparable only within a single response
 *   — different rerankers produce different score scales.
 */

import type { DocumentSearchIndex } from '../source-adapter.js';
import type { RagSearchResult } from '../types.js';
import type { Reranker } from './reranker.js';

/** Audit event emitted when the rerank wrapper falls back to the base index. */
export interface RerankAuditEntry {
  type: string;
  payload: Record<string, unknown>;
}

/** Constructor dependencies for the RerankingSearchIndex. */
export interface RerankingSearchDeps {
  /** First-stage retrieval (hybrid, vector-only, or any DocumentSearchIndex). */
  base: DocumentSearchIndex;
  /** Cross-encoder reranker applied to the base candidates. */
  reranker: Reranker;
  /**
   * How many candidates to over-fetch from the base index before reranking.
   * Larger values improve rerank quality but cost more on both branches.
   * Default 50. Clamped to at least the caller's `topK` at call time.
   */
  candidatesPerSearch?: number;
  /**
   * Optional audit hook — emitted on rerank success ('rag.rerank.applied') and
   * on rerank failure / fail-open fallback ('rag.rerank.failed'). Defaults to
   * a no-op so the wrapper has no side effects when omitted.
   */
  onAudit?: (event: RerankAuditEntry) => void;
}

const DEFAULT_CANDIDATES_PER_SEARCH = 50;

export class RerankingSearchIndex implements DocumentSearchIndex {
  readonly #base: DocumentSearchIndex;
  readonly #reranker: Reranker;
  readonly #candidatesPerSearch: number;
  readonly #onAudit: (event: RerankAuditEntry) => void;

  constructor(deps: RerankingSearchDeps) {
    this.#base = deps.base;
    this.#reranker = deps.reranker;
    this.#candidatesPerSearch = deps.candidatesPerSearch ?? DEFAULT_CANDIDATES_PER_SEARCH;
    this.#onAudit = deps.onAudit ?? (() => {});
  }

  async search(
    sourceId: string,
    query: string,
    opts: {
      topK: number;
      folders?: readonly string[];
      fileTypes?: readonly string[];
      tenantId?: string;
      sourceIds?: readonly string[];
    },
  ): Promise<RagSearchResult> {
    const topK = Math.max(1, opts.topK);
    // Always over-fetch at least as many candidates as the caller wants to
    // keep; if topK > candidatesPerSearch (unusual but possible), bump.
    const fetchK = Math.max(topK, this.#candidatesPerSearch);

    // Stage 1 — base retrieval. Errors here propagate (the base index has its
    // own internal fallbacks; if it still throws, something is genuinely broken
    // and we want the caller to see it).
    const baseResult = await this.#base.search(sourceId, query, {
      topK: fetchK,
      folders: opts.folders,
      fileTypes: opts.fileTypes,
      tenantId: opts.tenantId,
      sourceIds: opts.sourceIds,
    });

    // Short-circuit when the base index returned nothing — no point burning a
    // reranker API call. Also keeps the audit log quieter.
    if (baseResult.chunks.length === 0) {
      return { chunks: [] };
    }

    // Build the (id → original-hit) map BEFORE calling the reranker so we can
    // map the reranker's `id` reply back to the rich metadata. We use the
    // chunk's documentId+position as a synthetic id because the base index's
    // RagSearchResult does NOT expose chunkId. Cohere only sees the id we
    // hand it; it has no reason to mint new ones, so the round-trip is safe.
    const rerankerDocs = baseResult.chunks.map((c, i) => ({
      // Index-based id is the simplest mapping that doesn't require chunkId.
      // Stringified to satisfy the `id: string` contract.
      id: `${i}`,
      text: c.text,
    }));

    const t0 = Date.now();
    let rerankResult: Awaited<ReturnType<Reranker['rerank']>>;
    try {
      rerankResult = await this.#reranker.rerank({
        query,
        documents: rerankerDocs,
        topN: topK,
      });
    } catch (err: unknown) {
      // Fail-open: log and return the base index's top-K. We do NOT rethrow
      // because a transient Cohere failure should degrade the search quality,
      // not break the search entirely.
      const message = err instanceof Error ? err.message : String(err);
      this.#onAudit({
        type: 'rag.rerank.failed',
        payload: {
          sourceId,
          model: this.#reranker.model,
          error: message,
          candidates: baseResult.chunks.length,
          durationMs: Date.now() - t0,
        },
      });
      return { chunks: baseResult.chunks.slice(0, topK) };
    }

    // Stage 2 — reorder hits by the reranker's verdict.
    const reordered: RagSearchResult['chunks'] = [];
    for (const r of rerankResult.results) {
      const idx = Number(r.id);
      if (!Number.isInteger(idx) || idx < 0 || idx >= baseResult.chunks.length) continue;
      const hit = baseResult.chunks[idx];
      if (!hit) continue;
      reordered.push({
        ...hit,
        // Override the base index score with the reranker's verdict so the
        // top-K's `.score` reflects the cross-encoder ranking, not RRF.
        score: r.score,
      });
    }

    // Cap to topK (reranker should already obey, but be defensive).
    const top = reordered.slice(0, topK);

    this.#onAudit({
      type: 'rag.rerank.applied',
      payload: {
        sourceId,
        model: this.#reranker.model,
        candidates: baseResult.chunks.length,
        returned: top.length,
        durationMs: Date.now() - t0,
      },
    });

    return { chunks: top };
  }
}
