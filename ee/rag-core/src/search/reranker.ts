// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Reranker abstraction — second-stage cross-encoder ranking applied AFTER the
 * first-stage hybrid retrieval. The hybrid index (FTS5 + vector via RRF)
 * returns the top-N candidates. The reranker re-orders them using a
 * cross-encoder model that scores (query, document) pairs jointly, which
 * captures lexical AND semantic signals the dual-encoder vector branch and
 * the keyword branch each miss in isolation.
 *
 * Phase 5 / Tranche 2 ships a single concrete implementation: the
 * managed-API {@link CohereReranker} that hits `POST /v2/rerank`. Other
 * providers (Voyage AI, local cross-encoders, ...) plug in by implementing
 * the {@link Reranker} interface.
 *
 * Fail-open contract: the reranker is wrapped by {@link RerankingSearchIndex}
 * which catches reranker errors and falls back to the base index results.
 * That wrapper — not this module — owns the resilience policy. This module
 * propagates failures via {@link RerankerError} so the wrapper can log them.
 */

/** Input to {@link Reranker.rerank}. */
export interface RerankerInput {
  /** Natural-language search query. */
  query: string;
  /** Candidate documents to rerank. */
  documents: Array<{
    /** Stable id the caller maps back to a chunk after reranking. */
    id: string;
    /** Document text passed to the reranker model. */
    text: string;
  }>;
  /** How many results to keep after rerank. */
  topN: number;
}

/** Output of {@link Reranker.rerank}. */
export interface RerankerResult {
  results: Array<{
    /** Echo of the input `documents[i].id` selected by the model. */
    id: string;
    /** Model-specific relevance score. Higher = more relevant. Typically [0, 1]. */
    score: number;
  }>;
}

/** Common shape implemented by every reranker. */
export interface Reranker {
  /** Human-readable model identifier — propagated to audit logs. */
  readonly model: string;
  rerank(input: RerankerInput): Promise<RerankerResult>;
}

/**
 * Error thrown by reranker implementations. The {@link RerankingSearchIndex}
 * wrapper catches these and falls back to the base index — callers of the
 * wrapper rarely see RerankerError directly.
 */
export class RerankerError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'RerankerError';
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

// ---------------------------------------------------------------------------
// Cohere reranker
// ---------------------------------------------------------------------------

/** Configuration for {@link CohereReranker}. */
export interface CohereRerankerConfig {
  /** Cohere API key. Sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /**
   * Cohere model identifier. Sensible defaults:
   *  - `rerank-multilingual-v3.0` — recommended default for mixed-language KBs.
   *  - `rerank-english-v3.0` — slightly higher quality on English-only corpora.
   */
  model: string;
  /**
   * Override the Cohere API base URL. Default `https://api.cohere.com/v2/rerank`.
   * Useful for testing (mock servers) and for self-hosted Cohere proxies.
   */
  baseUrl?: string;
  /** Request timeout in milliseconds. Default 10000 (10s). */
  timeoutMs?: number;
}

const DEFAULT_COHERE_BASE_URL = 'https://api.cohere.com/v2/rerank';
const DEFAULT_TIMEOUT_MS = 10_000;

interface CohereRerankApiResult {
  index: number;
  relevance_score: number;
}

interface CohereRerankApiResponse {
  results: CohereRerankApiResult[];
}

/**
 * Cohere-managed reranker. Talks to `POST /v2/rerank` on the configured base
 * URL with the standard payload `{ model, query, documents, top_n, return_documents }`.
 *
 * Cohere docs (https://docs.cohere.com/reference/rerank) cap the request at
 * 1000 documents and 100 top_n — the hybrid index returns ~50 candidates so
 * both limits hold by construction. The wrapper passes `return_documents: false`
 * to keep the response payload small; we map indices back to the original
 * documents on this side.
 */
export class CohereReranker implements Reranker {
  readonly model: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(config: CohereRerankerConfig) {
    if (!config.apiKey) {
      throw new Error('CohereReranker: apiKey is required');
    }
    if (!config.model) {
      throw new Error('CohereReranker: model is required');
    }
    this.model = config.model;
    this.#apiKey = config.apiKey;
    this.#baseUrl = config.baseUrl ?? DEFAULT_COHERE_BASE_URL;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async rerank(input: RerankerInput): Promise<RerankerResult> {
    // Defensive: an empty document list is a no-op — return empty without
    // burning an API call. The wrapper already short-circuits this case but
    // we double-check so callers can use the reranker standalone.
    if (input.documents.length === 0) {
      return { results: [] };
    }

    const body = JSON.stringify({
      model: this.model,
      query: input.query,
      documents: input.documents.map((d) => d.text),
      top_n: input.topN,
      return_documents: false,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await fetch(this.#baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${this.#apiKey}`,
        },
        body,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      // AbortError → timeout. Anything else → network error (DNS, ECONNREFUSED…).
      if (err instanceof Error && err.name === 'AbortError') {
        throw new RerankerError(`Rerank timed out after ${this.#timeoutMs}ms`, { cause: err });
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new RerankerError(`Cohere rerank network error: ${msg}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '<no body>');
      const status = response.status;
      if (status === 401 || status === 403) {
        throw new RerankerError(`Invalid API key (${status}): ${errText}`);
      }
      if (status === 429) {
        throw new RerankerError(`Rate limit exceeded (${status}): ${errText}`);
      }
      if (status >= 500) {
        throw new RerankerError(`Cohere API error (${status} ${response.statusText}): ${errText}`);
      }
      throw new RerankerError(
        `Cohere rerank failed (${status} ${response.statusText}): ${errText}`,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err: unknown) {
      throw new RerankerError('Cohere rerank: malformed JSON response', { cause: err });
    }
    if (typeof json !== 'object' || json === null || !Array.isArray((json as { results?: unknown }).results)) {
      throw new RerankerError('Cohere rerank: missing "results" array in response');
    }

    const apiResults = (json as CohereRerankApiResponse).results;
    const out: RerankerResult['results'] = [];
    for (const entry of apiResults) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof entry.index !== 'number' ||
        typeof entry.relevance_score !== 'number'
      ) {
        // Skip malformed entries — defensive against future API drift.
        continue;
      }
      const doc = input.documents[entry.index];
      if (!doc) continue; // index out of range — also defensive
      out.push({ id: doc.id, score: entry.relevance_score });
    }

    return { results: out };
  }
}
