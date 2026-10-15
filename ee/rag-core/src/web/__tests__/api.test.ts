// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiGet, apiPatch, apiPost, ApiTimeoutError } from '../api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiGet timeout', () => {
  it('rejects with ApiTimeoutError when the server never answers', async () => {
    // Never resolves on its own — only the abort signal settles it.
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiGet('/api/rag/sources', { timeoutMs: 10 })).rejects.toBeInstanceOf(
      ApiTimeoutError,
    );
  });

  it('returns the body when the server answers in time', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ sources: [] }), { status: 200 }))),
    );

    await expect(apiGet('/api/rag/sources', { timeoutMs: 1000 })).resolves.toEqual({
      sources: [],
    });
  });

  it('propagates network errors unchanged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    await expect(apiGet('/api/rag/sources', { timeoutMs: 1000 })).rejects.toThrow(
      'Failed to fetch',
    );
  });
});

describe('apiPost / apiPatch timeout', () => {
  function stubHangingFetch() {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );
  }

  it('rejects a hung POST with ApiTimeoutError', async () => {
    stubHangingFetch();
    await expect(
      apiPost('/api/rag/sources', { name: 'Docs' }, { timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(ApiTimeoutError);
  });

  it('rejects a hung PATCH with ApiTimeoutError', async () => {
    stubHangingFetch();
    await expect(
      apiPatch('/api/rag/sources/src_1', { name: 'Docs' }, { timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(ApiTimeoutError);
  });

  it('keeps sending the JSON body and method', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiPost('/x', { a: 1 }, { timeoutMs: 1000 })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      '/x',
      expect.objectContaining({ method: 'POST', body: '{"a":1}' }),
    );
  });
});
