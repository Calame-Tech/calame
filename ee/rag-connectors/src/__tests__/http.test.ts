// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

import {
  HttpConnector,
  HttpDocumentNotFoundError,
  HttpFetchError,
  HttpStatusError,
  __testing,
} from '../http.js';

// ---------------------------------------------------------------------------
// Helpers — minimal Response factory for fetch mocks
// ---------------------------------------------------------------------------

interface FakeResponseInit {
  status?: number;
  headers?: Record<string, string>;
  /** Body to return for `.text()` (sitemaps) or `.body` (GETs). */
  body?: string;
}

/**
 * Minimal `Response`-shaped object good enough for the connector. The
 * connector touches: `.status`, `.headers.get(...)`, `.text()`, `.body` and
 * the body is converted via `Readable.fromWeb`. Returning a real Web
 * `ReadableStream` keeps `Readable.fromWeb` happy.
 */
function fakeResponse(init: FakeResponseInit = {}): Response {
  const status = init.status ?? 200;
  const headers = new Headers(init.headers ?? {});
  const bodyText = init.body ?? '';

  // Build a Web ReadableStream from the body string (Node 18+ has it global).
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(bodyText));
      controller.close();
    },
  });

  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    body,
    async text() {
      return bodyText;
    },
  } as unknown as Response;
}

/** Build a fake AbortError for timeout testing. */
function abortError(): Error {
  const err = new Error('aborted') as Error & { name: string };
  err.name = 'AbortError';
  return err;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// testConnection
// ---------------------------------------------------------------------------

describe('HttpConnector.testConnection', () => {
  it('resolves silently when HEAD on the first URL returns 200', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ status: 200 }));
    const connector = new HttpConnector();
    await expect(
      connector.testConnection({ urls: ['https://example.com/a'] }),
    ).resolves.toBeUndefined();
    // One HEAD on the first URL.
    const call = fetchMock.mock.calls[0]!;
    expect(call[1]?.method).toBe('HEAD');
    expect(call[0]).toBe('https://example.com/a');
  });

  it('throws HttpStatusError when HEAD on the first URL returns 404', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ status: 404 }));
    const connector = new HttpConnector();
    await expect(
      connector.testConnection({ urls: ['https://example.com/missing'] }),
    ).rejects.toBeInstanceOf(HttpStatusError);
  });

  it('parses sitemap and validates at least one <loc>', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        status: 200,
        body: '<urlset><url><loc>https://x.test/a</loc></url><url><loc>https://x.test/b</loc></url></urlset>',
      }),
    );
    const connector = new HttpConnector();
    await expect(
      connector.testConnection({ sitemapUrl: 'https://x.test/sitemap.xml' }),
    ).resolves.toBeUndefined();
  });

  it('throws when sitemap parses to zero <loc> entries', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ status: 200, body: '<urlset></urlset>' }),
    );
    const connector = new HttpConnector();
    await expect(
      connector.testConnection({ sitemapUrl: 'https://x.test/sitemap.xml' }),
    ).rejects.toThrow(/did not contain any <loc>/);
  });

  it('throws HttpFetchError when sitemap returns 503', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ status: 503 }));
    const connector = new HttpConnector();
    await expect(
      connector.testConnection({ sitemapUrl: 'https://x.test/sitemap.xml' }),
    ).rejects.toBeInstanceOf(HttpFetchError);
  });

  it('maps AbortError into HttpFetchError (timeout)', async () => {
    fetchMock.mockRejectedValue(abortError());
    const connector = new HttpConnector();
    await expect(
      connector.testConnection({ urls: ['https://slow.test/'], timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(HttpFetchError);
  });

  it('rejects malformed configs (no urls, no sitemap)', async () => {
    const connector = new HttpConnector();
    await expect(connector.testConnection({})).rejects.toThrow(
      /at least one of `urls` .* or `sitemapUrl`/,
    );
    await expect(connector.testConnection({ urls: [] })).rejects.toThrow(
      /at least one of `urls`/,
    );
    await expect(
      connector.testConnection({ urls: ['ftp://nope.test/'] }),
    ).rejects.toThrow(/must use http: or https:/);
    await expect(
      connector.testConnection({ urls: ['not-a-url'] }),
    ).rejects.toThrow(/invalid URL/);
  });
});

// ---------------------------------------------------------------------------
// listFolders
// ---------------------------------------------------------------------------

describe('HttpConnector.listFolders', () => {
  it('returns a single synthetic root folder when parent is omitted', async () => {
    const connector = new HttpConnector();
    const folders = await connector.listFolders(
      { urls: ['https://example.com/'] },
      'src-1',
    );
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({
      sourceId: 'src-1',
      parentId: null,
      path: '/',
      name: 'root',
    });
    expect(folders[0]!.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns [] when parent is provided (HTTP has no nested folders)', async () => {
    const connector = new HttpConnector();
    const folders = await connector.listFolders(
      { urls: ['https://example.com/'] },
      'src-1',
      {
        id: 'fake-parent',
        sourceId: 'src-1',
        parentId: null,
        path: '/',
        name: 'root',
        createdAt: '',
      },
    );
    expect(folders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listDocuments
// ---------------------------------------------------------------------------

describe('HttpConnector.listDocuments', () => {
  it('lists documents from a static `urls` array via HEAD requests', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://example.com/a') {
        return fakeResponse({
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-length': '123',
            etag: '"abc"',
          },
        });
      }
      if (url === 'https://example.com/b.pdf') {
        return fakeResponse({
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'content-length': '4567',
            'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
          },
        });
      }
      return fakeResponse({ status: 500 });
    });

    const connector = new HttpConnector();
    const docs = await connector.listDocuments(
      { urls: ['https://example.com/a', 'https://example.com/b.pdf'] },
      'src-1',
    );
    expect(docs).toHaveLength(2);

    const a = docs.find((d) => d.path === '/a')!;
    expect(a.mimeType).toBe('text/html; charset=utf-8');
    expect(a.size).toBe(123);
    expect(a.etag).toBe('abc');
    expect(a.hash).toBe('');
    expect(a.id.startsWith('http:')).toBe(true);

    const b = docs.find((d) => d.path === '/b.pdf')!;
    expect(b.mimeType).toBe('application/pdf');
    expect(b.size).toBe(4567);
    // No ETag → fall back to Last-Modified verbatim.
    expect(b.etag).toBe('Wed, 21 Oct 2026 07:28:00 GMT');
    expect(b.name).toBe('b.pdf');
  });

  it('expands a sitemap into URLs and HEADs each one', async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit | undefined) => {
      if (init?.method === 'GET' && url === 'https://x.test/sitemap.xml') {
        return fakeResponse({
          status: 200,
          body: '<urlset><url><loc>https://x.test/p1</loc></url><url><loc>https://x.test/p2</loc></url></urlset>',
        });
      }
      return fakeResponse({
        status: 200,
        headers: { 'content-type': 'text/html', 'content-length': '10' },
      });
    });

    const connector = new HttpConnector();
    const docs = await connector.listDocuments(
      { sitemapUrl: 'https://x.test/sitemap.xml' },
      'src-1',
    );
    expect(docs.map((d) => d.path).sort()).toEqual(['/p1', '/p2']);
    // Sitemap GET + 2 HEADs = 3 fetch calls.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('filters via allowedHosts and includeGlobs/excludeGlobs', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ status: 200, headers: { 'content-type': 'text/html' } }),
    );

    const connector = new HttpConnector();
    const docs = await connector.listDocuments(
      {
        urls: [
          'https://allowed.test/blog/a',
          'https://allowed.test/about',
          'https://other.test/blog/b',
          'https://allowed.test/blog/_draft',
        ],
        allowedHosts: ['allowed.test'],
        includeGlobs: ['/blog/**'],
        excludeGlobs: ['**/_*'],
      },
      'src-1',
    );

    // Only allowed host + matches /blog/** + does not start with `_`.
    expect(docs.map((d) => d.path).sort()).toEqual(['/blog/a']);
    // Filtered URLs should NOT have triggered HEAD requests.
    const headedUrls = fetchMock.mock.calls.map((c) => c[0]);
    expect(headedUrls).toEqual(['https://allowed.test/blog/a']);
  });

  it('skips URLs that respond with 4xx/5xx during HEAD without aborting the listing', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://example.com/ok') {
        return fakeResponse({
          status: 200,
          headers: { 'content-type': 'text/html', 'content-length': '5' },
        });
      }
      if (url === 'https://example.com/forbidden') {
        return fakeResponse({ status: 403 });
      }
      if (url === 'https://example.com/down') {
        return fakeResponse({ status: 503 });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const connector = new HttpConnector();
    const docs = await connector.listDocuments(
      {
        urls: [
          'https://example.com/ok',
          'https://example.com/forbidden',
          'https://example.com/down',
        ],
      },
      'src-1',
    );
    expect(docs.map((d) => d.path)).toEqual(['/ok']);
  });

  it('prefers ETag when present, falls back to Last-Modified, else null', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://e.test/etag') {
        return fakeResponse({
          status: 200,
          headers: {
            'content-type': 'text/html',
            etag: 'W/"weak-tag"',
            'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
          },
        });
      }
      if (url === 'https://e.test/lm-only') {
        return fakeResponse({
          status: 200,
          headers: {
            'content-type': 'text/html',
            'last-modified': 'Tue, 20 Oct 2026 07:28:00 GMT',
          },
        });
      }
      // No etag, no last-modified
      return fakeResponse({ status: 200, headers: { 'content-type': 'text/html' } });
    });

    const connector = new HttpConnector();
    const docs = await connector.listDocuments(
      {
        urls: [
          'https://e.test/etag',
          'https://e.test/lm-only',
          'https://e.test/no-version',
        ],
      },
      'src-1',
    );
    const byPath = new Map(docs.map((d) => [d.path, d.etag]));
    // Weak ETag stripped of W/ prefix and quotes.
    expect(byPath.get('/etag')).toBe('weak-tag');
    expect(byPath.get('/lm-only')).toBe('Tue, 20 Oct 2026 07:28:00 GMT');
    expect(byPath.get('/no-version')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchDocument
// ---------------------------------------------------------------------------

describe('HttpConnector.fetchDocument', () => {
  it('streams the body and returns the response Content-Type', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: '{"hello":"world"}',
      }),
    );
    const connector = new HttpConnector();
    const docId = __testing.encodeDocId('https://example.com/data.json');
    const out = await connector.fetchDocument(
      { urls: ['https://example.com/data.json'] },
      'src-1',
      docId,
    );
    expect(out.mimeType).toBe('application/json; charset=utf-8');
    const buf = await drainReadable(out.stream);
    expect(buf.toString('utf8')).toBe('{"hello":"world"}');
  });

  it('throws HttpDocumentNotFoundError on 404', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ status: 404 }));
    const connector = new HttpConnector();
    const docId = __testing.encodeDocId('https://example.com/missing');
    await expect(
      connector.fetchDocument(
        { urls: ['https://example.com/missing'] },
        'src-1',
        docId,
      ),
    ).rejects.toBeInstanceOf(HttpDocumentNotFoundError);
  });

  it('rejects fetchDocument when the docId host is outside allowedHosts', async () => {
    const connector = new HttpConnector();
    // forge a docId pointing at a host that is NOT in allowedHosts
    const docId = __testing.encodeDocId('https://evil.test/exfil');
    await expect(
      connector.fetchDocument(
        {
          urls: ['https://allowed.test/a'],
          allowedHosts: ['allowed.test'],
        },
        'src-1',
        docId,
      ),
    ).rejects.toThrow(/not in the configured allowedHosts/);
    // Crucially, fetch was NEVER called — defense-in-depth blocked the egress.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Doc id round-trip + helpers
// ---------------------------------------------------------------------------

describe('doc id encode/decode', () => {
  it('round-trips URLs with query strings, ports, fragments and unicode', () => {
    const cases = [
      'https://example.com/',
      'https://example.com:8443/path?x=1&y=2',
      'https://example.com/blog/post#section',
      'http://localhost:3000/api/v1/items?limit=10',
      'https://例え.test/ファイル.pdf',
      'https://example.com/space%20encoded/and+plus',
    ];
    for (const url of cases) {
      const id = __testing.encodeDocId(url);
      expect(id.startsWith('http:')).toBe(true);
      expect(__testing.decodeDocId(id)).toBe(url);
    }
  });

  it('decodeDocId throws HttpDocumentNotFoundError for non-http-prefixed ids', () => {
    expect(() => __testing.decodeDocId('s3:abc')).toThrow(HttpDocumentNotFoundError);
    expect(() => __testing.decodeDocId('garbage')).toThrow(HttpDocumentNotFoundError);
  });
});

describe('helpers', () => {
  it('parseSitemapLocs extracts <loc> entries and decodes basic XML entities', () => {
    const xml =
      '<?xml version="1.0"?><urlset>' +
      '<url><loc>https://x.test/a</loc><lastmod>2026-01-01</lastmod></url>' +
      '<url><loc>https://x.test/b?id=1&amp;x=2</loc></url>' +
      '<url><loc></loc></url>' +
      '</urlset>';
    const locs = __testing.parseSitemapLocs(xml);
    expect(locs).toEqual(['https://x.test/a', 'https://x.test/b?id=1&x=2']);
  });

  it('cleanHeaderEtag strips weak prefix + surrounding quotes', () => {
    expect(__testing.cleanHeaderEtag(null)).toBeNull();
    expect(__testing.cleanHeaderEtag('')).toBeNull();
    expect(__testing.cleanHeaderEtag('"abc"')).toBe('abc');
    expect(__testing.cleanHeaderEtag('W/"abc"')).toBe('abc');
    expect(__testing.cleanHeaderEtag('abc')).toBe('abc');
  });

  it('parseContentLength returns 0 for invalid / missing values', () => {
    expect(__testing.parseContentLength(null)).toBe(0);
    expect(__testing.parseContentLength('')).toBe(0);
    expect(__testing.parseContentLength('-5')).toBe(0);
    expect(__testing.parseContentLength('not-a-number')).toBe(0);
    expect(__testing.parseContentLength('42')).toBe(42);
  });

  it('isHostAllowed compares hosts case-insensitively', () => {
    const url = new URL('https://Example.COM:443/x');
    expect(__testing.isHostAllowed(url, undefined)).toBe(true);
    expect(__testing.isHostAllowed(url, [])).toBe(true);
    expect(__testing.isHostAllowed(url, ['example.com'])).toBe(true);
    expect(__testing.isHostAllowed(url, ['other.test'])).toBe(false);
  });

  it('deriveName returns the last path segment, falling back to host', () => {
    expect(__testing.deriveName(new URL('https://example.com/'))).toBe('example.com');
    expect(__testing.deriveName(new URL('https://example.com/a/b/c.pdf'))).toBe('c.pdf');
    expect(__testing.deriveName(new URL('https://example.com/folder/'))).toBe('folder');
  });
});

describe('HttpConnector type discriminator', () => {
  it("exposes type === 'http' so the registry can dispatch on it", () => {
    expect(new HttpConnector().type).toBe('http');
  });
});

// ---------------------------------------------------------------------------
// Internal: drain a Readable into a Buffer for assertions.
// ---------------------------------------------------------------------------

async function drainReadable(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
