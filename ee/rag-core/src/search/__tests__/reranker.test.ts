// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CohereReranker, RerankerError } from '../reranker.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const DOCS = [
  { id: 'a', text: 'Apple introduces a new chip for the next iPhone.' },
  { id: 'b', text: 'Bananas are rich in potassium.' },
  { id: 'c', text: 'Container orchestration with Kubernetes.' },
];

interface MockFetchOptions {
  status?: number;
  statusText?: string;
  body?: unknown;
  rawBody?: string;
  delayMs?: number;
}

function mockFetchResponse(opts: MockFetchOptions = {}): typeof fetch {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    // Simulate honoring an AbortSignal so timeout tests work without a real network.
    if (opts.delayMs !== undefined) {
      const signal = init?.signal;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, opts.delayMs);
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    }
    const status = opts.status ?? 200;
    const statusText = opts.statusText ?? (status === 200 ? 'OK' : 'Error');
    const ok = status >= 200 && status < 300;
    const bodyText = opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : '');
    return {
      ok,
      status,
      statusText,
      async json() {
        if (opts.rawBody !== undefined) {
          // Mimic the real Response.json() which throws on malformed JSON
          return JSON.parse(opts.rawBody) as unknown;
        }
        return opts.body as unknown;
      },
      async text() {
        return bodyText;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CohereReranker', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Each test installs its own mock; clear any leftover from a prior test.
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('rerank: success — maps Cohere result indices back to caller ids', async () => {
    // Cohere returns the docs reordered (1, 0, 2) with descending scores.
    globalThis.fetch = mockFetchResponse({
      body: {
        results: [
          { index: 1, relevance_score: 0.95 },
          { index: 0, relevance_score: 0.7 },
          { index: 2, relevance_score: 0.3 },
        ],
      },
    });

    const reranker = new CohereReranker({ apiKey: 'sk-test', model: 'rerank-multilingual-v3.0' });
    const result = await reranker.rerank({
      query: 'fruit and tech',
      documents: DOCS,
      topN: 3,
    });

    expect(result.results).toEqual([
      { id: 'b', score: 0.95 },
      { id: 'a', score: 0.7 },
      { id: 'c', score: 0.3 },
    ]);
  });

  it('rerank: empty input list short-circuits without an API call', async () => {
    const fetchSpy = mockFetchResponse({ body: { results: [] } });
    globalThis.fetch = fetchSpy;
    const reranker = new CohereReranker({ apiKey: 'sk-test', model: 'rerank-multilingual-v3.0' });
    const result = await reranker.rerank({ query: 'q', documents: [], topN: 5 });
    expect(result.results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rerank: 401 → RerankerError "Invalid API key"', async () => {
    globalThis.fetch = mockFetchResponse({
      status: 401,
      statusText: 'Unauthorized',
      rawBody: '{"message":"invalid api token"}',
    });
    const reranker = new CohereReranker({ apiKey: 'bad-key', model: 'rerank-multilingual-v3.0' });
    await expect(reranker.rerank({ query: 'q', documents: DOCS, topN: 3 })).rejects.toThrow(
      RerankerError,
    );
    await expect(reranker.rerank({ query: 'q', documents: DOCS, topN: 3 })).rejects.toThrow(
      /Invalid API key/,
    );
  });

  it('rerank: 429 → RerankerError "Rate limit exceeded"', async () => {
    globalThis.fetch = mockFetchResponse({
      status: 429,
      statusText: 'Too Many Requests',
      rawBody: '{"message":"rate limit"}',
    });
    const reranker = new CohereReranker({ apiKey: 'sk-test', model: 'rerank-multilingual-v3.0' });
    await expect(reranker.rerank({ query: 'q', documents: DOCS, topN: 3 })).rejects.toThrow(
      /Rate limit exceeded/,
    );
  });

  it('rerank: 503 → RerankerError "Cohere API error"', async () => {
    globalThis.fetch = mockFetchResponse({
      status: 503,
      statusText: 'Service Unavailable',
      rawBody: '<html>down</html>',
    });
    const reranker = new CohereReranker({ apiKey: 'sk-test', model: 'rerank-multilingual-v3.0' });
    await expect(reranker.rerank({ query: 'q', documents: DOCS, topN: 3 })).rejects.toThrow(
      /Cohere API error/,
    );
  });

  it('rerank: AbortError (timeout) → RerankerError "Rerank timed out"', async () => {
    // Set the fetch to delay 5s while timeoutMs=50, so the AbortController fires.
    globalThis.fetch = mockFetchResponse({ delayMs: 5000, body: { results: [] } });
    const reranker = new CohereReranker({
      apiKey: 'sk-test',
      model: 'rerank-multilingual-v3.0',
      timeoutMs: 50,
    });
    await expect(reranker.rerank({ query: 'q', documents: DOCS, topN: 3 })).rejects.toThrow(
      /Rerank timed out after 50ms/,
    );
  });

  it('rerank: posts {model, query, documents (text array), top_n, return_documents: false}', async () => {
    const fetchSpy = vi.fn(async (_url: unknown, _init?: RequestInit): Promise<Response> => {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async json() {
          return { results: [] };
        },
        async text() {
          return '';
        },
      } as unknown as Response;
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const reranker = new CohereReranker({
      apiKey: 'sk-test-key',
      model: 'rerank-multilingual-v3.0',
    });
    await reranker.rerank({ query: 'mango', documents: DOCS, topN: 2 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0]!;
    const url = call[0];
    const init = call[1] as RequestInit;
    expect(url).toBe('https://api.cohere.com/v2/rerank');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test-key');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      model: 'rerank-multilingual-v3.0',
      query: 'mango',
      documents: [
        'Apple introduces a new chip for the next iPhone.',
        'Bananas are rich in potassium.',
        'Container orchestration with Kubernetes.',
      ],
      top_n: 2,
      return_documents: false,
    });
  });

  it('rerank: custom baseUrl overrides the default endpoint', async () => {
    const fetchSpy = vi.fn(async (_url: unknown, _init?: RequestInit): Promise<Response> => {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async json() {
          return { results: [] };
        },
        async text() {
          return '';
        },
      } as unknown as Response;
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const reranker = new CohereReranker({
      apiKey: 'sk-test',
      model: 'rerank-multilingual-v3.0',
      baseUrl: 'http://localhost:9999/rerank',
    });
    await reranker.rerank({ query: 'q', documents: DOCS, topN: 1 });

    expect(fetchSpy.mock.calls[0]![0]).toBe('http://localhost:9999/rerank');
  });

  it('rerank: returns fewer items than asked when Cohere returns top_n < documents.length', async () => {
    // Cohere caps top_n at the requested value or its own internal limit;
    // the caller may also pass topN=2 against 5 documents. Mapping must work
    // when result size < input size.
    globalThis.fetch = mockFetchResponse({
      body: {
        results: [
          { index: 2, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.5 },
        ],
      },
    });
    const reranker = new CohereReranker({ apiKey: 'sk-test', model: 'rerank-multilingual-v3.0' });
    const result = await reranker.rerank({ query: 'q', documents: DOCS, topN: 2 });
    expect(result.results).toEqual([
      { id: 'c', score: 0.9 },
      { id: 'a', score: 0.5 },
    ]);
  });

  it('rerank: malformed response — missing results array → RerankerError', async () => {
    globalThis.fetch = mockFetchResponse({ body: { wrong: 'shape' } });
    const reranker = new CohereReranker({ apiKey: 'sk-test', model: 'rerank-multilingual-v3.0' });
    await expect(reranker.rerank({ query: 'q', documents: DOCS, topN: 1 })).rejects.toThrow(
      /missing "results" array/,
    );
  });

  it('rerank: skips malformed result entries and out-of-range indices', async () => {
    globalThis.fetch = mockFetchResponse({
      body: {
        results: [
          { index: 0, relevance_score: 0.9 },
          { index: 99, relevance_score: 0.5 }, // out of range
          { index: 1, relevance_score: 'oops' }, // malformed
          { index: 2, relevance_score: 0.1 },
        ],
      },
    });
    const reranker = new CohereReranker({ apiKey: 'sk-test', model: 'rerank-multilingual-v3.0' });
    const result = await reranker.rerank({ query: 'q', documents: DOCS, topN: 4 });
    expect(result.results).toEqual([
      { id: 'a', score: 0.9 },
      { id: 'c', score: 0.1 },
    ]);
  });

  it('constructor: throws when apiKey is missing', () => {
    expect(() => new CohereReranker({ apiKey: '', model: 'rerank-multilingual-v3.0' })).toThrow(
      /apiKey is required/,
    );
  });

  it('constructor: throws when model is missing', () => {
    expect(() => new CohereReranker({ apiKey: 'sk-test', model: '' })).toThrow(/model is required/);
  });
});
