// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { Readable } from 'node:stream';
import mime from 'mime-types';
import { minimatch } from 'minimatch';

import type { RagDocument, RagFolder, RagSourceType } from '@calame-ee/rag-core';

import type { DocumentSourceConfig, DocumentSourceConnector } from './types.js';
import { deterministicId } from './utils.js';

/**
 * Configuration for `HttpConnector`. Stored encrypted by the host.
 *
 * Two mutually-supported modes:
 *  - Static URL list (`urls`): the connector indexes exactly the URLs supplied.
 *  - Sitemap (`sitemapUrl`): the connector fetches the XML sitemap and expands
 *    the `<loc>` entries into URLs.
 *
 * If both are provided, both contribute to the document set (deduped by URL).
 */
export interface HttpConfig {
  /** Mode 1 — fixed list of URLs to index. */
  urls?: string[];
  /** Mode 2 — sitemap XML URL whose `<loc>` entries are expanded into URLs. */
  sitemapUrl?: string;
  /** User-Agent header sent with every request (default: `CalameRAG/1.0`). */
  userAgent?: string;
  /** Per-request timeout in milliseconds (default: 10_000). */
  timeoutMs?: number;
  /** Optional host allowlist. URLs whose host is absent are skipped. */
  allowedHosts?: string[];
  /** Glob filters applied to URL pathname (e.g. `['/blog/**']`). */
  includeGlobs?: string[];
  excludeGlobs?: string[];
}

/** Default User-Agent used when `config.userAgent` is unset. */
const DEFAULT_USER_AGENT = 'CalameRAG/1.0';

/** Default per-request timeout (ms). */
const DEFAULT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Raised when a transport-level failure (network unreachable, DNS, TLS,
 * timeout, 5xx) occurs. The `cause` is preserved when available.
 */
export class HttpFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HttpFetchError';
  }
}

/**
 * Raised when an HTTP request returns a 4xx response. We treat 4xx as
 * configuration errors (the URL itself is the problem) and surface them
 * separately from `HttpFetchError` so the UI can hint differently.
 */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.url = url;
  }
}

/**
 * Raised by `fetchDocument` when the supplied `docId` cannot be resolved (404
 * or decode failure).
 */
export class HttpDocumentNotFoundError extends Error {
  constructor(docId: string) {
    super(`Document "${docId}" not found in HTTP source`);
    this.name = 'HttpDocumentNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Doc id encoding
// ---------------------------------------------------------------------------

const DOC_ID_PREFIX = 'http:';

/**
 * Encode a full URL into a stable opaque-looking document id. The URL is kept
 * inside the id so `fetchDocument` is stateless across processes.
 */
function encodeDocId(url: string): string {
  return `${DOC_ID_PREFIX}${Buffer.from(url, 'utf8').toString('base64url')}`;
}

function decodeDocId(docId: string): string {
  if (!docId.startsWith(DOC_ID_PREFIX)) {
    throw new HttpDocumentNotFoundError(docId);
  }
  const encoded = docId.slice(DOC_ID_PREFIX.length);
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    throw new HttpDocumentNotFoundError(docId);
  }
}

// ---------------------------------------------------------------------------
// Config narrowing
// ---------------------------------------------------------------------------

/**
 * Narrow the opaque `DocumentSourceConfig` to the shape this connector
 * understands. Throws a clear error if the config is malformed.
 */
function narrowConfig(config: DocumentSourceConfig): HttpConfig {
  const rawUrls = config.urls;
  const sitemapUrl = config.sitemapUrl;

  if (rawUrls !== undefined && !Array.isArray(rawUrls)) {
    throw new Error('HttpConnector: `urls` must be an array of strings when provided');
  }
  if (sitemapUrl !== undefined && typeof sitemapUrl !== 'string') {
    throw new Error('HttpConnector: `sitemapUrl` must be a string when provided');
  }

  const urls = rawUrls as string[] | undefined;
  const hasUrls = Array.isArray(urls) && urls.length > 0;
  const hasSitemap = typeof sitemapUrl === 'string' && sitemapUrl.length > 0;

  if (!hasUrls && !hasSitemap) {
    throw new Error(
      'HttpConnector requires at least one of `urls` (non-empty) or `sitemapUrl` in config',
    );
  }

  if (hasUrls) {
    for (const u of urls!) {
      if (typeof u !== 'string' || u.length === 0) {
        throw new Error('HttpConnector: every entry in `urls` must be a non-empty string');
      }
      assertHttpUrl(u, '`urls`');
    }
  }
  if (hasSitemap) {
    assertHttpUrl(sitemapUrl as string, '`sitemapUrl`');
  }

  const allowedHosts = config.allowedHosts;
  if (allowedHosts !== undefined) {
    if (!Array.isArray(allowedHosts) || !allowedHosts.every((h) => typeof h === 'string')) {
      throw new Error('HttpConnector: `allowedHosts` must be an array of strings when provided');
    }
  }

  const includeGlobs = config.includeGlobs;
  const excludeGlobs = config.excludeGlobs;
  if (includeGlobs !== undefined && !Array.isArray(includeGlobs)) {
    throw new Error('HttpConnector: `includeGlobs` must be an array of strings');
  }
  if (excludeGlobs !== undefined && !Array.isArray(excludeGlobs)) {
    throw new Error('HttpConnector: `excludeGlobs` must be an array of strings');
  }

  const userAgent = config.userAgent;
  if (userAgent !== undefined && typeof userAgent !== 'string') {
    throw new Error('HttpConnector: `userAgent` must be a string when provided');
  }
  const timeoutMs = config.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || timeoutMs <= 0)) {
    throw new Error('HttpConnector: `timeoutMs` must be a positive number when provided');
  }

  return {
    urls: hasUrls ? (urls as string[]) : undefined,
    sitemapUrl: hasSitemap ? (sitemapUrl as string) : undefined,
    userAgent: typeof userAgent === 'string' ? userAgent : undefined,
    timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : undefined,
    allowedHosts: allowedHosts as string[] | undefined,
    includeGlobs: includeGlobs as string[] | undefined,
    excludeGlobs: excludeGlobs as string[] | undefined,
  };
}

/** Assert that `value` is a valid http(s) URL. Throws a clear error otherwise. */
function assertHttpUrl(value: string, fieldLabel: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`HttpConnector: ${fieldLabel} contains an invalid URL: "${value}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `HttpConnector: ${fieldLabel} URL "${value}" must use http: or https: (got ${parsed.protocol})`,
    );
  }
}

// ---------------------------------------------------------------------------
// fetch wrapper with timeout + UA
// ---------------------------------------------------------------------------

interface FetchOptions {
  method: 'HEAD' | 'GET';
  userAgent: string;
  timeoutMs: number;
  /** Should HEAD/GET follow redirects? Standard `fetch` does so by default ('follow'). */
  redirect?: 'follow' | 'manual';
}

/**
 * Issue a fetch with a timeout via `AbortController`. Maps the native errors
 * into `HttpFetchError` so callers don't have to inspect node-specific
 * properties.
 */
async function timedFetch(url: string, opts: FetchOptions): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const response = await globalThis.fetch(url, {
      method: opts.method,
      headers: { 'user-agent': opts.userAgent },
      signal: controller.signal,
      redirect: opts.redirect ?? 'follow',
    });
    return response;
  } catch (err: unknown) {
    if (isAbortError(err)) {
      throw new HttpFetchError(`Request to ${url} timed out after ${opts.timeoutMs}ms`, {
        cause: err,
      });
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new HttpFetchError(`Network error for ${url}: ${reason}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'name' in err &&
    (err as { name: unknown }).name === 'AbortError'
  );
}

/** Throw `HttpFetchError` for 5xx, `HttpStatusError` for 4xx. No-op on 2xx/3xx. */
function assertOkOrSurface(response: Response, url: string): void {
  if (response.status >= 200 && response.status < 400) return;
  if (response.status >= 500) {
    throw new HttpFetchError(`Server error ${response.status} for ${url}`);
  }
  // 4xx
  throw new HttpStatusError(response.status, url);
}

// ---------------------------------------------------------------------------
// Sitemap parsing
// ---------------------------------------------------------------------------

/**
 * Extract `<loc>` entries from a sitemap XML payload using a deliberately
 * simple regex.
 *
 * Limitations (tracked as TODOs for the next pass):
 *  - No XML namespace awareness (treats `<loc>` and `<ns:loc>` differently).
 *  - No support for nested sitemaps (`<sitemapindex>` → child `<sitemap>` URLs).
 *  - No XML entity decoding beyond the four standard ones (&amp; &lt; &gt; &quot;).
 *
 * The regex is good enough for the common `/sitemap.xml` shape produced by
 * most CMSes (WordPress, Hugo, Next.js). Full XML parsing is deferred to a
 * later pass — see `docs/rag-integration-plan.md` Phase 3.
 */
// TODO(http-connector): replace with a real XML parser when we add support for
// nested sitemap indexes (`<sitemapindex>`) and namespaced `<loc>` tags.
function parseSitemapLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>([^<]+)<\/loc>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    out.push(decodeBasicXmlEntities(raw));
  }
  return out;
}

/** Decode the four mandatory XML entities. */
function decodeBasicXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// Filtering helpers
// ---------------------------------------------------------------------------

/**
 * Return true if `url` is allowed by the optional `allowedHosts` allowlist.
 * Hosts compare case-insensitively. An empty / undefined list means "any host".
 */
function isHostAllowed(url: URL, allowedHosts: string[] | undefined): boolean {
  if (!allowedHosts || allowedHosts.length === 0) return true;
  const host = url.host.toLowerCase();
  return allowedHosts.some((h) => h.toLowerCase() === host);
}

/**
 * Apply include/exclude globs to a URL pathname (excluding query/hash).
 * Globs use `minimatch` semantics with `dot:true` for parity with the other
 * connectors.
 */
function matchPathGlobs(
  pathname: string,
  includes: string[] | undefined,
  excludes: string[] | undefined,
): boolean {
  const opts = { dot: true } as const;
  if (excludes && excludes.length > 0) {
    for (const pattern of excludes) {
      if (minimatch(pathname, pattern, opts)) return false;
    }
  }
  if (!includes || includes.length === 0) return true;
  for (const pattern of includes) {
    if (minimatch(pathname, pattern, opts)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

function cleanHeaderEtag(etag: string | null): string | null {
  if (!etag) return null;
  // Strip surrounding quotes (HTTP servers commonly wrap ETags) and an optional
  // weak validator prefix `W/`.
  const trimmed = etag.replace(/^W\//, '').trim();
  return trimmed.replace(/^"+|"+$/g, '') || null;
}

function parseContentLength(value: string | null): number {
  if (!value) return 0;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Resolve a mimeType from a Content-Type response header. The header may
 * include a `; charset=...` suffix that we keep intact (parity with how
 * `S3Connector.fetchDocument` returns the upstream Content-Type verbatim).
 */
function mimeFromContentType(value: string | null, urlPath: string): string {
  if (value && value.length > 0) return value;
  const lookup = mime.lookup(urlPath);
  return typeof lookup === 'string' ? lookup : 'application/octet-stream';
}

/** Strip parameters from a Content-Type header to keep only the type/subtype. */
function stripContentTypeParams(value: string): string {
  const idx = value.indexOf(';');
  return (idx >= 0 ? value.slice(0, idx) : value).trim();
}

/** Derive a friendly document name from a URL — last path segment, fallback host. */
function deriveName(url: URL): string {
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (last && last.length > 0) return last;
  return url.host;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

/**
 * Connector for arbitrary HTTP(S) URLs. The admin supplies either a static
 * `urls` list, a `sitemapUrl`, or both, and the connector materializes the
 * union as `RagDocument` records. There is no real folder hierarchy on the
 * web — `listFolders` returns a single synthetic root.
 *
 * Phase 3 capabilities:
 *  - `testConnection` validates that the configured URL list / sitemap is
 *    reachable (HEAD on the first URL, GET on the sitemap).
 *  - `listFolders` returns a single synthetic root folder (no nested folders).
 *  - `listDocuments` HEADs each candidate URL to populate Content-Type,
 *    Content-Length, ETag and Last-Modified. URLs that return 4xx/5xx are
 *    skipped silently (they're not fatal, but the doc is excluded).
 *  - `fetchDocument` GETs the URL, validates the host against `allowedHosts`
 *    a second time (defense-in-depth against a forged docId), and returns the
 *    body as a Node `Readable`.
 *
 * Hash strategy: `RagDocument.hash` is left empty. The pipeline re-streams
 * via `fetchDocument` to compute SHA-256 when it actually indexes the
 * document. Same trade-off as the S3 connector. Change-detection relies on
 * `ETag`, falling back to `Last-Modified`.
 *
 * Deferred to later phases:
 *  - Crawling / link following → not in scope for Phase 3.
 *  - Polling / incremental sync → Phase 4.
 *  - Robust XML parsing (nested sitemaps, namespaces) → next pass on Phase 3.
 */
export class HttpConnector implements DocumentSourceConnector {
  readonly type: RagSourceType = 'http';

  async testConnection(rawConfig: DocumentSourceConfig): Promise<void> {
    const config = narrowConfig(rawConfig);
    const userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (config.urls && config.urls.length > 0) {
      const first = config.urls[0]!;
      const response = await timedFetch(first, { method: 'HEAD', userAgent, timeoutMs });
      assertOkOrSurface(response, first);
      return;
    }

    // sitemapUrl path
    const sitemap = config.sitemapUrl!;
    const response = await timedFetch(sitemap, { method: 'GET', userAgent, timeoutMs });
    assertOkOrSurface(response, sitemap);
    const text = await response.text();
    const locs = parseSitemapLocs(text);
    if (locs.length === 0) {
      throw new HttpFetchError(
        `Sitemap at ${sitemap} did not contain any <loc> entries — cannot index.`,
      );
    }
  }

  async listFolders(
    rawConfig: DocumentSourceConfig,
    sourceId: string,
    parent?: RagFolder,
  ): Promise<RagFolder[]> {
    // Defensive: still narrow the config so callers get a clear error if it
    // is malformed before we silently return [].
    narrowConfig(rawConfig);
    if (parent) return [];
    return [
      {
        id: deterministicId(sourceId, '/'),
        sourceId,
        parentId: null,
        path: '/',
        name: 'root',
        createdAt: new Date().toISOString(),
      },
    ];
  }

  async listDocuments(
    rawConfig: DocumentSourceConfig,
    sourceId: string,
    folder?: RagFolder,
  ): Promise<RagDocument[]> {
    const config = narrowConfig(rawConfig);
    const userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // 1. Build the candidate URL set (static list + sitemap). Dedupe on the
    //    string form so a URL listed in both modes is fetched once.
    const candidates = new Set<string>();
    if (config.urls) {
      for (const u of config.urls) candidates.add(u);
    }
    if (config.sitemapUrl) {
      // A failing sitemap is propagated rather than swallowed: silently
      // returning an empty list would mask a misconfigured source from the
      // admin (especially when the admin only supplied `sitemapUrl` and no
      // static `urls`).
      const response = await timedFetch(config.sitemapUrl, {
        method: 'GET',
        userAgent,
        timeoutMs,
      });
      assertOkOrSurface(response, config.sitemapUrl);
      const xml = await response.text();
      for (const u of parseSitemapLocs(xml)) candidates.add(u);
    }

    // 2. Apply allowedHosts + path globs as a cheap pre-filter before HEADing.
    const filtered: { url: string; parsed: URL }[] = [];
    for (const raw of candidates) {
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        // Sitemap may contain garbage — skip silently.
        continue;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      if (!isHostAllowed(parsed, config.allowedHosts)) continue;
      if (!matchPathGlobs(parsed.pathname, config.includeGlobs, config.excludeGlobs)) continue;
      filtered.push({ url: raw, parsed });
    }

    // 3. HEAD each candidate to get headers. Skip 4xx/5xx silently — a single
    //    bad URL must not abort the whole listing.
    const documents: RagDocument[] = [];
    for (const { url, parsed } of filtered) {
      let response: Response;
      try {
        response = await timedFetch(url, { method: 'HEAD', userAgent, timeoutMs });
      } catch {
        // Network / timeout — skip this URL.
        continue;
      }
      if (response.status >= 400) continue;

      const contentType = response.headers.get('content-type');
      const mimeType = mimeFromContentType(contentType, parsed.pathname);
      const size = parseContentLength(response.headers.get('content-length'));
      const etag = cleanHeaderEtag(response.headers.get('etag'));
      const lastModified = response.headers.get('last-modified');
      // Prefer ETag for change detection. Fall back to Last-Modified verbatim.
      const versionTag = etag ?? (lastModified && lastModified.length > 0 ? lastModified : null);

      const path = parsed.pathname.length > 0 ? parsed.pathname : '/';
      documents.push({
        id: encodeDocId(url),
        sourceId,
        folderId: folder?.id ?? null,
        path,
        name: deriveName(parsed),
        mimeType,
        size,
        // See class jsdoc — pipeline re-streams to compute SHA-256.
        hash: '',
        etag: versionTag,
        lastIndexedAt: '',
        deletedAt: null,
      });
    }
    return documents;
  }

  async fetchDocument(
    rawConfig: DocumentSourceConfig,
    _sourceId: string,
    docId: string,
  ): Promise<{ stream: Readable; mimeType: string }> {
    const config = narrowConfig(rawConfig);
    const userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const url = decodeDocId(docId);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HttpDocumentNotFoundError(docId);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new HttpDocumentNotFoundError(docId);
    }

    // Defense-in-depth: a malicious docId could encode a host outside the
    // configured allowlist. Validate before issuing the GET.
    if (!isHostAllowed(parsed, config.allowedHosts)) {
      throw new Error(
        `HttpConnector: host "${parsed.host}" decoded from docId is not in the configured allowedHosts.`,
      );
    }

    const response = await timedFetch(url, { method: 'GET', userAgent, timeoutMs });
    if (response.status === 404) {
      throw new HttpDocumentNotFoundError(docId);
    }
    if (response.status >= 400 && response.status < 500) {
      throw new HttpStatusError(response.status, url);
    }
    if (response.status >= 500) {
      throw new HttpFetchError(`Server error ${response.status} for ${url}`);
    }

    const contentType = response.headers.get('content-type');
    const mimeType = mimeFromContentType(contentType, parsed.pathname);

    if (!response.body) {
      // Non-Node fetch implementations may produce a null body on 204; the host
      // pipeline expects a stream. Synthesize an empty one.
      return { stream: Readable.from([]), mimeType };
    }

    // Node 18+ exposes a WebStream `ReadableStream` on Response.body. The
    // host pipeline expects a Node `Readable` (parity with S3/local). Convert.
    const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    return { stream, mimeType };
  }
}

// ---------------------------------------------------------------------------
// Test-only exports (mirror the `__testing` shape used by other connectors).
// ---------------------------------------------------------------------------

export const __testing = {
  encodeDocId,
  decodeDocId,
  parseSitemapLocs,
  decodeBasicXmlEntities,
  isHostAllowed,
  matchPathGlobs,
  cleanHeaderEtag,
  parseContentLength,
  mimeFromContentType,
  stripContentTypeParams,
  deriveName,
  narrowConfig,
  DEFAULT_USER_AGENT,
  DEFAULT_TIMEOUT_MS,
};
