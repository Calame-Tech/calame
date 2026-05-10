// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import mime from 'mime-types';

import {
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';

import type { RagDocument, RagFolder, RagSourceType } from '@calame-ee/rag-core';

import type { DocumentSourceConfig, DocumentSourceConnector } from './types.js';
import { deterministicId, matchGlobs } from './utils.js';

/**
 * Configuration for `S3Connector`. Stored encrypted by the host.
 *
 * Compatible with AWS S3, Cloudflare R2 and MinIO:
 *  - AWS S3: leave `endpoint` undefined, set `region` to the bucket region.
 *  - Cloudflare R2: set `endpoint = 'https://<account>.r2.cloudflarestorage.com'`
 *    and `region = 'auto'`.
 *  - MinIO: set `endpoint = 'http://localhost:9000'`, `forcePathStyle = true`,
 *    `region = 'us-east-1'` (often ignored by MinIO).
 */
export interface S3Config {
  /** Bucket name. Required. */
  bucket: string;
  /** AWS region (or `'auto'` for R2). */
  region: string;
  /**
   * Logical root prefix under the bucket. Empty string ("") = bucket root.
   * Always normalized to end with a single trailing `/` when non-empty so it
   * can be safely concatenated with relative paths.
   */
  prefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Custom endpoint (R2, MinIO). Omit for AWS S3. */
  endpoint?: string;
  /** Path-style addressing (required for MinIO). Default: false (AWS/R2 use virtual-hosted style). */
  forcePathStyle?: boolean;
  includeGlobs?: string[];
  excludeGlobs?: string[];
}

/**
 * Narrow the opaque `DocumentSourceConfig` to the shape this connector
 * understands. Throws a clear error if the config is malformed.
 */
function narrowConfig(config: DocumentSourceConfig): S3Config {
  const bucket = config.bucket;
  if (typeof bucket !== 'string' || bucket.length === 0) {
    throw new Error('S3Connector requires a non-empty `bucket` string in config');
  }
  const region = config.region;
  if (typeof region !== 'string' || region.length === 0) {
    throw new Error('S3Connector requires a non-empty `region` string in config');
  }
  const accessKeyId = config.accessKeyId;
  if (typeof accessKeyId !== 'string' || accessKeyId.length === 0) {
    throw new Error('S3Connector requires a non-empty `accessKeyId` string in config');
  }
  const secretAccessKey = config.secretAccessKey;
  if (typeof secretAccessKey !== 'string' || secretAccessKey.length === 0) {
    throw new Error('S3Connector requires a non-empty `secretAccessKey` string in config');
  }
  const prefix = config.prefix;
  if (prefix !== undefined && typeof prefix !== 'string') {
    throw new Error('S3Connector: `prefix` must be a string when provided');
  }
  const endpoint = config.endpoint;
  if (endpoint !== undefined && typeof endpoint !== 'string') {
    throw new Error('S3Connector: `endpoint` must be a string when provided');
  }
  const includeGlobs = config.includeGlobs;
  const excludeGlobs = config.excludeGlobs;
  if (includeGlobs !== undefined && !Array.isArray(includeGlobs)) {
    throw new Error('S3Connector: `includeGlobs` must be an array of strings');
  }
  if (excludeGlobs !== undefined && !Array.isArray(excludeGlobs)) {
    throw new Error('S3Connector: `excludeGlobs` must be an array of strings');
  }
  return {
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    prefix: normalizePrefix(prefix),
    endpoint,
    forcePathStyle: config.forcePathStyle === true,
    includeGlobs: includeGlobs as string[] | undefined,
    excludeGlobs: excludeGlobs as string[] | undefined,
  };
}

/**
 * Normalize a prefix: empty/undefined → "" (bucket root); otherwise strip
 * leading `/` and ensure exactly one trailing `/`.
 */
function normalizePrefix(prefix: string | undefined): string {
  if (!prefix) return '';
  let p = prefix;
  while (p.startsWith('/')) p = p.slice(1);
  if (p.length === 0) return '';
  if (!p.endsWith('/')) p = p + '/';
  return p;
}

/**
 * Raised by `fetchDocument` when the supplied `docId` cannot be resolved to a
 * real S3 object (404 / NoSuchKey).
 */
export class S3DocumentNotFoundError extends Error {
  constructor(docId: string) {
    super(`Document "${docId}" not found in S3 source`);
    this.name = 'S3DocumentNotFoundError';
  }
}

const DOC_ID_PREFIX = 's3:';

/**
 * Encode an S3 key (full key including any source-prefix) into a stable,
 * opaque-looking document id. Uses a different prefix than the local connector
 * (`path:`) to avoid collisions if the host ever cross-checks ids.
 */
function encodeDocId(key: string): string {
  return `${DOC_ID_PREFIX}${Buffer.from(key, 'utf8').toString('base64url')}`;
}

function decodeDocId(docId: string): string {
  if (!docId.startsWith(DOC_ID_PREFIX)) {
    throw new S3DocumentNotFoundError(docId);
  }
  const encoded = docId.slice(DOC_ID_PREFIX.length);
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    throw new S3DocumentNotFoundError(docId);
  }
}

/**
 * Validate that a key reconstructed from a doc id (or an explicit
 * relative-prefix concatenation) does not escape the configured `prefix`
 * root via `..` segments or absolute-path tricks. S3 keys themselves do not
 * support `..` resolution, but a malicious caller could still encode
 * `../../etc/passwd` in a docId — we strip it defensively.
 *
 * @throws Error when the key escapes the configured prefix.
 */
function assertKeyUnderPrefix(key: string, prefix: string): void {
  // Reject any segment that is exactly `..` — S3 itself treats keys as opaque
  // strings, but the host might join them with filesystem paths downstream.
  const segments = key.split('/');
  for (const segment of segments) {
    if (segment === '..') {
      throw new Error(`Invalid S3 key "${key}": contains ".." segment`);
    }
  }
  if (prefix !== '' && !key.startsWith(prefix)) {
    throw new Error(
      `Invalid S3 key "${key}": does not start with configured prefix "${prefix}"`,
    );
  }
}

/**
 * Strip surrounding quotes from an S3 ETag header value.
 * S3 returns ETags wrapped in double quotes, e.g. `"d41d8cd98f00b204e9800998ecf8427e"`.
 */
function cleanEtag(etag: string | undefined): string | null {
  if (!etag) return null;
  return etag.replace(/^"+|"+$/g, '') || null;
}

/**
 * For single-part uploads, S3's ETag is the MD5 of the object content (hex).
 * Multipart uploads have ETags of the form `"<hex>-<partCount>"`. We use the
 * presence of the dash as the multipart marker.
 */
function isSinglePartEtag(cleaned: string | null): boolean {
  return cleaned !== null && !cleaned.includes('-');
}

/**
 * Drain a Node `Readable` into a Buffer. Used by `listDocuments` only when
 * the caller asks for a content hash; not used by the streaming `fetchDocument`
 * path.
 */
async function drainToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Shape of an SDK error we need to inspect (`name`, `$metadata.httpStatusCode`). */
interface SdkError {
  name?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
  Code?: string;
}

function asSdkError(err: unknown): SdkError {
  if (err && typeof err === 'object') return err as SdkError;
  return {};
}

/**
 * Connector for AWS S3-compatible object stores (AWS S3, Cloudflare R2, MinIO).
 *
 * Phase 3 capabilities:
 *  - `testConnection` validates bucket access via `HeadBucket`. 403 / 404 / 301
 *    are mapped to clear admin-facing error messages.
 *  - `listFolders` / `listDocuments` use `ListObjectsV2` with `Delimiter='/'` so
 *    only direct children of the requested folder are returned. Pagination is
 *    handled internally via `ContinuationToken`.
 *  - `fetchDocument` opens a `GetObject` body stream (Node `Readable`).
 *  - Document ids are `s3:<base64url(key)>` so `fetchDocument` is stateless.
 *
 * Hash strategy:
 *  - For single-part uploads (ETag without a dash), the ETag IS the MD5 hex
 *    digest. We cannot expose it as `RagDocument.hash` because the host
 *    pipeline expects SHA-256 there — instead we leave `hash = ''` and let
 *    `RagDocument.etag` carry the S3 ETag verbatim. The pipeline can re-stream
 *    via `fetchDocument` to compute SHA-256 when it actually indexes the
 *    document. This keeps `listDocuments` cheap (one `ListObjectsV2` call) at
 *    the cost of one extra `GetObject` per doc at index time. See
 *    `docs/rag-integration-plan.md` §4.1.
 *
 * Deferred to later phases:
 *  - `watch()` / S3 Event Notifications → Phase 4.
 *  - Cross-account / IAM-role-assume credentials → Phase 4.
 *  - Server-side encryption headers (KMS) → Phase 4.
 */
export class S3Connector implements DocumentSourceConnector {
  readonly type: RagSourceType = 's3';

  /**
   * Cached S3 clients keyed by serialized config to avoid recreating an
   * `S3Client` (and its underlying HTTPS agent) on every method call. The
   * cache is process-local; tests re-instantiate the connector each time.
   *
   * LRU policy: capped at {@link S3Connector.MAX_CACHED_CLIENTS} entries
   * (16). When the cap is reached, the least-recently-used client is
   * evicted and its underlying socket pool is released via
   * `S3Client.destroy()` to prevent a memory leak in multi-tenant hosts
   * that may instantiate many distinct configs over time.
   *
   * Implementation note: the `Map` keeps insertion order, so re-`set`-ting
   * a key on every read (see {@link S3Connector.#getClient}) effectively
   * sorts entries from least- to most-recently used; `keys().next().value`
   * is therefore always the LRU entry.
   */
  #clientCache = new Map<string, S3Client>();

  /** Maximum number of distinct S3 client configs cached in-process. */
  static readonly MAX_CACHED_CLIENTS = 16;

  /**
   * Test-only accessor that exposes the current size of the LRU client
   * cache. Not part of the public API — guarded by an `__` prefix.
   * @internal
   */
  __cacheSizeForTests(): number {
    return this.#clientCache.size;
  }

  async testConnection(rawConfig: DocumentSourceConfig): Promise<void> {
    const config = narrowConfig(rawConfig);
    const client = this.#getClient(config);
    try {
      await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    } catch (err: unknown) {
      throw mapS3Error(err, config.bucket);
    }
  }

  async listFolders(
    rawConfig: DocumentSourceConfig,
    sourceId: string,
    parent?: RagFolder,
  ): Promise<RagFolder[]> {
    const config = narrowConfig(rawConfig);
    const client = this.#getClient(config);
    const queryPrefix = buildQueryPrefix(config.prefix, parent);

    const folders: RagFolder[] = [];
    let continuationToken: string | undefined;
    do {
      const out = await client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: queryPrefix,
          Delimiter: '/',
          ContinuationToken: continuationToken,
        }),
      );

      for (const cp of out.CommonPrefixes ?? []) {
        const fullPrefix = cp.Prefix;
        if (typeof fullPrefix !== 'string') continue;
        // CommonPrefixes always end with the delimiter — strip it for `path`.
        const trimmed = fullPrefix.endsWith('/') ? fullPrefix.slice(0, -1) : fullPrefix;
        // `path` is RELATIVE to the configured prefix root (mirrors local-folder).
        const relPath = relativeToPrefix(trimmed, config.prefix);
        if (relPath.length === 0) continue;

        if (!matchGlobs(relPath, undefined, config.excludeGlobs)) continue;

        const name = relPath.split('/').pop() ?? relPath;
        folders.push({
          id: deterministicId(sourceId, relPath),
          sourceId,
          parentId: parent?.id ?? null,
          path: relPath,
          name,
          // S3 has no inherent folder mtime — use empty string; the host will
          // overwrite with `now` at persist time, mirroring local-folder when
          // stat fails.
          createdAt: '',
        });
      }

      continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (continuationToken);

    return folders;
  }

  async listDocuments(
    rawConfig: DocumentSourceConfig,
    sourceId: string,
    folder?: RagFolder,
  ): Promise<RagDocument[]> {
    const config = narrowConfig(rawConfig);
    const client = this.#getClient(config);
    const queryPrefix = buildQueryPrefix(config.prefix, folder);

    const documents: RagDocument[] = [];
    let continuationToken: string | undefined;
    do {
      const out = await client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: queryPrefix,
          Delimiter: '/',
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of out.Contents ?? []) {
        const key = obj.Key;
        if (typeof key !== 'string' || key.length === 0) continue;
        // Skip pseudo-directory markers (zero-byte objects whose key ends with `/`).
        if (key.endsWith('/')) continue;

        const relPath = relativeToPrefix(key, config.prefix);
        if (relPath.length === 0) continue;

        if (!matchGlobs(relPath, config.includeGlobs, config.excludeGlobs)) continue;

        const cleanedEtag = cleanEtag(obj.ETag);
        const lookup = mime.lookup(key);
        const mimeType = typeof lookup === 'string' ? lookup : 'application/octet-stream';

        // Hash strategy: see class jsdoc. The pipeline re-streams when needed.
        // For single-part objects we can opportunistically expose the MD5 hex
        // (cleanedEtag) as a stable change-detection fingerprint via `etag`.
        // We do NOT put MD5 into `hash` because the host pipeline assumes
        // SHA-256 there.
        const hash = '';

        const name = relPath.split('/').pop() ?? relPath;
        documents.push({
          id: encodeDocId(key),
          sourceId,
          folderId: folder?.id ?? null,
          path: relPath,
          name,
          mimeType,
          size: typeof obj.Size === 'number' ? obj.Size : 0,
          hash,
          etag: cleanedEtag,
          lastIndexedAt: '',
          deletedAt: null,
        });
      }

      continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (continuationToken);

    return documents;
  }

  async fetchDocument(
    rawConfig: DocumentSourceConfig,
    _sourceId: string,
    docId: string,
  ): Promise<{ stream: Readable; mimeType: string }> {
    const config = narrowConfig(rawConfig);
    const key = decodeDocId(docId);
    assertKeyUnderPrefix(key, config.prefix ?? '');

    const client = this.#getClient(config);
    let response;
    try {
      response = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
      );
    } catch (err: unknown) {
      const sdkErr = asSdkError(err);
      if (
        sdkErr.name === 'NoSuchKey' ||
        sdkErr.Code === 'NoSuchKey' ||
        sdkErr.$metadata?.httpStatusCode === 404
      ) {
        throw new S3DocumentNotFoundError(docId);
      }
      throw err;
    }

    const body = response.Body;
    if (!body || !isReadable(body)) {
      throw new Error(
        `S3 GetObject for key "${key}" returned an empty or non-Readable body. ` +
          `This is unusual outside of browser environments.`,
      );
    }

    const lookup = mime.lookup(key);
    const fallbackMime = typeof lookup === 'string' ? lookup : 'application/octet-stream';
    const mimeType = response.ContentType && response.ContentType.length > 0
      ? response.ContentType
      : fallbackMime;

    return { stream: body, mimeType };
  }

  // -- helpers --------------------------------------------------------------

  #getClient(config: S3Config): S3Client {
    const cacheKey = clientCacheKey(config);
    const cached = this.#clientCache.get(cacheKey);
    if (cached) {
      // Bump to most-recently-used (Map preserves insertion order).
      this.#clientCache.delete(cacheKey);
      this.#clientCache.set(cacheKey, cached);
      return cached;
    }

    // Evict the LRU entry if we're at capacity.
    if (this.#clientCache.size >= S3Connector.MAX_CACHED_CLIENTS) {
      const oldestKey = this.#clientCache.keys().next().value;
      if (oldestKey !== undefined) {
        const evicted = this.#clientCache.get(oldestKey);
        this.#clientCache.delete(oldestKey);
        if (evicted && typeof evicted.destroy === 'function') {
          evicted.destroy();
        }
      }
    }

    const clientConfig: S3ClientConfig = {
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle === true,
    };
    if (config.endpoint) {
      clientConfig.endpoint = config.endpoint;
    }
    const client = new S3Client(clientConfig);
    this.#clientCache.set(cacheKey, client);
    return client;
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers (kept outside the class so they're easy to unit-test
// and don't leak `this` semantics).
// ---------------------------------------------------------------------------

function clientCacheKey(config: S3Config): string {
  // Hash the credential triple so we don't keep plaintext in memory longer
  // than needed AND so two configs that differ only by include/exclude globs
  // share the same client instance.
  return createHash('sha256')
    .update(
      [
        config.bucket,
        config.region,
        config.accessKeyId,
        config.secretAccessKey,
        config.endpoint ?? '',
        config.forcePathStyle ? '1' : '0',
      ].join(' '),
    )
    .digest('hex');
}

/**
 * Build the S3 query prefix for ListObjectsV2 given the configured root prefix
 * and the requested parent folder (if any). Both inputs are joined with no
 * extra separator (root prefix is already normalized to end with `/`).
 */
function buildQueryPrefix(rootPrefix: string | undefined, parent?: RagFolder): string {
  const root = rootPrefix ?? '';
  if (!parent) return root;
  // parent.path is relative to root. Append it + trailing '/' to scope the query.
  const sep = parent.path.endsWith('/') ? '' : '/';
  return `${root}${parent.path}${sep}`;
}

/**
 * Compute the path of `key` (or a folder full prefix) relative to the
 * configured root prefix. Returns `''` if the key is exactly the root prefix.
 */
function relativeToPrefix(key: string, rootPrefix: string | undefined): string {
  const root = rootPrefix ?? '';
  if (root === '') return key;
  if (!key.startsWith(root)) return key;
  return key.slice(root.length);
}

/** Type guard — narrows the SDK Body union to a Node Readable. */
function isReadable(body: unknown): body is Readable {
  return (
    body !== null &&
    typeof body === 'object' &&
    typeof (body as { pipe?: unknown }).pipe === 'function' &&
    typeof (body as { on?: unknown }).on === 'function'
  );
}

/**
 * Map an SDK error into an admin-facing message. Distinguishes the most
 * common HeadBucket failure modes so the UI can surface actionable hints.
 */
function mapS3Error(err: unknown, bucket: string): Error {
  const sdkErr = asSdkError(err);
  const status = sdkErr.$metadata?.httpStatusCode;
  const name = sdkErr.name ?? '';

  if (status === 403 || name === 'AccessDenied' || name === 'Forbidden') {
    return new Error(
      `S3: access denied to bucket "${bucket}" (HTTP 403). Check that the access key / secret have ` +
        `s3:ListBucket and s3:GetObject permissions on this bucket.`,
    );
  }
  if (status === 404 || name === 'NoSuchBucket' || name === 'NotFound') {
    return new Error(
      `S3: bucket "${bucket}" does not exist (HTTP 404). Verify the bucket name and region.`,
    );
  }
  if (status === 301 || name === 'PermanentRedirect') {
    return new Error(
      `S3: bucket "${bucket}" is in a different region than configured (HTTP 301). ` +
        `Update the region setting (or use 'auto' for Cloudflare R2).`,
    );
  }
  const reason = sdkErr.message ?? name ?? 'unknown error';
  return new Error(`S3: failed to reach bucket "${bucket}": ${reason}`);
}

// Exported for tests — kept top-level (not on the class) to mirror the
// local-folder.ts convention.
export const __testing = {
  encodeDocId,
  decodeDocId,
  normalizePrefix,
  assertKeyUnderPrefix,
  cleanEtag,
  isSinglePartEtag,
  drainToBuffer,
  buildQueryPrefix,
  relativeToPrefix,
  mapS3Error,
  /** Test-only: inspect the size of the LRU client cache. */
  getClientCacheSize(connector: S3Connector): number {
    return connector.__cacheSizeForTests();
  },
};
