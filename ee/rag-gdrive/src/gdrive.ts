// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { google, type drive_v3 } from 'googleapis';
import type { JWT } from 'google-auth-library';

import type { RagDocument, RagFolder, RagSourceType } from '@calame-ee/rag-core';
import type {
  DocumentSourceConfig,
  DocumentSourceConnector,
  RateLimiterLike,
} from '@calame-ee/rag-connectors';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for `GDriveConnector`. Stored encrypted by the host.
 *
 * The connector authenticates as a Google Cloud service account (no end-user
 * OAuth flow). The admin must:
 *  1. Create a Service Account in Google Cloud Console
 *  2. Enable the Drive API on the project
 *  3. Download the JSON key
 *  4. Share the Drive folder (rootFolderId) with the service account's
 *     `client_email` (Viewer is enough; Editor isn't needed for read-only).
 */
export interface GDriveConfig {
  /**
   * Service account JSON key (downloaded from GCP Console). Either the full
   * parsed object or the raw JSON string — narrowConfig accepts both.
   *
   * Must contain at minimum `client_email`, `private_key` and `token_uri`.
   */
  serviceAccountKey: Record<string, unknown> | string;
  /**
   * Drive folder ID to use as root. The service account must have at least
   * Viewer access to this folder (admin shares it with the service account
   * email from the JSON key). Required — listing My Drive isn't supported
   * for service accounts without domain-wide delegation.
   */
  rootFolderId: string;
  /**
   * Optional impersonation: use domain-wide delegation to act as a specific
   * Workspace user. Most setups don't need this — leave undefined.
   */
  impersonateAs?: string;
  /** Optional include/exclude on file mimeTypes. */
  includeMimeTypes?: string[];
  excludeMimeTypes?: string[];
  /**
   * Whether to recurse into subfolders. Default true. When false, only the
   * direct children of `rootFolderId` are indexed.
   */
  recursive?: boolean;
}

/**
 * Narrow the opaque `DocumentSourceConfig` to the shape this connector
 * understands. Accepts the service account key as either a parsed object or
 * a raw JSON string. Throws a clear error if the config is malformed.
 */
export function narrowConfig(config: DocumentSourceConfig): GDriveConfig {
  const rawKey = config.serviceAccountKey;
  if (rawKey === undefined || rawKey === null) {
    throw new Error(
      'GDriveConnector requires a `serviceAccountKey` (object or JSON string) in config',
    );
  }
  let key: Record<string, unknown>;
  if (typeof rawKey === 'string') {
    if (rawKey.length === 0) {
      throw new Error('GDriveConnector: `serviceAccountKey` string is empty');
    }
    try {
      const parsed = JSON.parse(rawKey) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      key = parsed as Record<string, unknown>;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `GDriveConnector: \`serviceAccountKey\` is not valid JSON (${reason})`,
      );
    }
  } else if (typeof rawKey === 'object' && !Array.isArray(rawKey)) {
    key = rawKey as Record<string, unknown>;
  } else {
    throw new Error(
      'GDriveConnector: `serviceAccountKey` must be an object or a JSON string',
    );
  }

  for (const field of ['client_email', 'private_key', 'token_uri'] as const) {
    const v = key[field];
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(
        `GDriveConnector: serviceAccountKey is missing required field "${field}"`,
      );
    }
  }

  const rootFolderId = config.rootFolderId;
  if (typeof rootFolderId !== 'string' || rootFolderId.length === 0) {
    throw new Error('GDriveConnector requires a non-empty `rootFolderId` string in config');
  }

  const impersonateAs = config.impersonateAs;
  if (impersonateAs !== undefined && typeof impersonateAs !== 'string') {
    throw new Error('GDriveConnector: `impersonateAs` must be a string when provided');
  }

  const includeMimeTypes = config.includeMimeTypes;
  if (includeMimeTypes !== undefined) {
    if (
      !Array.isArray(includeMimeTypes) ||
      !includeMimeTypes.every((m) => typeof m === 'string')
    ) {
      throw new Error('GDriveConnector: `includeMimeTypes` must be an array of strings');
    }
  }
  const excludeMimeTypes = config.excludeMimeTypes;
  if (excludeMimeTypes !== undefined) {
    if (
      !Array.isArray(excludeMimeTypes) ||
      !excludeMimeTypes.every((m) => typeof m === 'string')
    ) {
      throw new Error('GDriveConnector: `excludeMimeTypes` must be an array of strings');
    }
  }

  const recursive = config.recursive;
  if (recursive !== undefined && typeof recursive !== 'boolean') {
    throw new Error('GDriveConnector: `recursive` must be a boolean when provided');
  }

  return {
    serviceAccountKey: key,
    rootFolderId,
    impersonateAs: typeof impersonateAs === 'string' && impersonateAs.length > 0
      ? impersonateAs
      : undefined,
    includeMimeTypes: includeMimeTypes as string[] | undefined,
    excludeMimeTypes: excludeMimeTypes as string[] | undefined,
    recursive: recursive === undefined ? true : recursive,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Raised by `fetchDocument` when the supplied `docId` cannot be resolved.
 */
export class GDriveDocumentNotFoundError extends Error {
  constructor(docId: string) {
    super(`Document "${docId}" not found in Google Drive source`);
    this.name = 'GDriveDocumentNotFoundError';
  }
}

/**
 * Raised by `fetchDocument` for Google-Workspace mime types we have no
 * export target for. Currently we map Docs, Sheets and Slides — anything
 * else (Drawings, Forms, …) is unsupported.
 */
export class UnsupportedGDriveMimeTypeError extends Error {
  readonly mimeType: string;
  constructor(mimeType: string) {
    super(`GDriveConnector: unsupported Google Workspace mime type "${mimeType}"`);
    this.name = 'UnsupportedGDriveMimeTypeError';
    this.mimeType = mimeType;
  }
}

// ---------------------------------------------------------------------------
// Doc id encoding
//
// Drive file ids are already opaque URL-safe strings, so we just prefix them
// with `gdrive:` for source-type disambiguation. No base64 needed.
// ---------------------------------------------------------------------------

const DOC_ID_PREFIX = 'gdrive:';

export function encodeDocId(fileId: string): string {
  return `${DOC_ID_PREFIX}${fileId}`;
}

export function decodeDocId(docId: string): string {
  if (!docId.startsWith(DOC_ID_PREFIX)) {
    throw new GDriveDocumentNotFoundError(docId);
  }
  const id = docId.slice(DOC_ID_PREFIX.length);
  if (id.length === 0) {
    throw new GDriveDocumentNotFoundError(docId);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Google Workspace export targets
//
// Google Docs / Sheets / Slides have no native binary representation — they
// must be exported to a concrete mime type before download. We pick PDF for
// Docs and Slides (preserves layout and feeds the existing PDF parser) and
// CSV for Sheets (cheapest text representation; first sheet only).
// ---------------------------------------------------------------------------

const GOOGLE_DOCS_PREFIX = 'application/vnd.google-apps.';

/**
 * Map a Google Workspace mime type to the export mime we want to download.
 * Returns null when the type is not exportable (e.g. folder) or unsupported.
 */
export function pickExportMime(googleMime: string): string | null {
  switch (googleMime) {
    case 'application/vnd.google-apps.document':
      return 'application/pdf';
    case 'application/vnd.google-apps.spreadsheet':
      return 'text/csv';
    case 'application/vnd.google-apps.presentation':
      return 'application/pdf';
    default:
      return null;
  }
}

/** True if the supplied mime type is a Google Workspace virtual type. */
export function isGoogleWorkspaceMime(mimeType: string): boolean {
  return mimeType.startsWith(GOOGLE_DOCS_PREFIX);
}

// ---------------------------------------------------------------------------
// MimeType filtering
// ---------------------------------------------------------------------------

/**
 * Decide whether a mime type passes the include/exclude filters. Empty /
 * undefined include list means "include everything"; exclude list always wins.
 */
export function matchMimeTypes(
  mimeType: string,
  includes: string[] | undefined,
  excludes: string[] | undefined,
): boolean {
  if (excludes && excludes.length > 0) {
    if (excludes.includes(mimeType)) return false;
  }
  if (!includes || includes.length === 0) return true;
  return includes.includes(mimeType);
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

function clientCacheKey(config: GDriveConfig): string {
  const key = config.serviceAccountKey as Record<string, unknown>;
  const email = typeof key.client_email === 'string' ? key.client_email : '';
  // Private key is opaque; hash just the prefix to avoid keeping plaintext.
  const pkSig =
    typeof key.private_key === 'string'
      ? createHash('sha256').update(key.private_key).digest('hex').slice(0, 16)
      : '';
  return createHash('sha256')
    .update([email, pkSig, config.impersonateAs ?? ''].join('|'))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Drive helpers — pagination
// ---------------------------------------------------------------------------

/**
 * Drain a `files.list` query across pages and return all matching files.
 * Each page is fetched serially with the previous `nextPageToken`. The
 * optional `beforeCall` hook is awaited before every page fetch — used by
 * the connector to acquire a rate-limit token per page request.
 */
async function listAllFiles(
  drive: drive_v3.Drive,
  params: drive_v3.Params$Resource$Files$List,
  beforeCall?: () => Promise<void>,
): Promise<drive_v3.Schema$File[]> {
  const all: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;
  do {
    if (beforeCall) await beforeCall();
    const resp = await drive.files.list({ ...params, pageToken });
    const data = resp.data ?? {};
    if (Array.isArray(data.files)) {
      for (const f of data.files) all.push(f);
    }
    pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : undefined;
  } while (pageToken);
  return all;
}

// ---------------------------------------------------------------------------
// Stream conversion
//
// `googleapis` returns a Node Readable for `media`-typed responses, but the
// SDK's TypeScript types expose it as `unknown`. We normalize defensively so
// callers always get a Node `Readable`.
// ---------------------------------------------------------------------------

function ensureReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (
    body !== null &&
    typeof body === 'object' &&
    typeof (body as { pipe?: unknown }).pipe === 'function' &&
    typeof (body as { on?: unknown }).on === 'function'
  ) {
    return body as Readable;
  }
  // Some test mocks return a string. Wrap it.
  if (typeof body === 'string') {
    return Readable.from([Buffer.from(body, 'utf8')]);
  }
  throw new Error('GDriveConnector: Drive API returned a non-Readable body');
}

// ---------------------------------------------------------------------------
// SDK error shape
// ---------------------------------------------------------------------------

interface GoogleSdkError {
  code?: number;
  message?: string;
  response?: { status?: number; data?: unknown };
  errors?: Array<{ reason?: string; message?: string }>;
}

function asSdkError(err: unknown): GoogleSdkError {
  if (err && typeof err === 'object') return err as GoogleSdkError;
  return {};
}

function readErrorStatus(err: GoogleSdkError): number | undefined {
  if (typeof err.code === 'number') return err.code;
  if (err.response && typeof err.response.status === 'number') return err.response.status;
  return undefined;
}

/**
 * Translate a Drive SDK error encountered during `testConnection` into an
 * admin-facing message. The service-account email is included on 403 so the
 * operator immediately knows whom to share the folder with.
 */
function mapTestConnectionError(
  err: unknown,
  serviceAccountEmail: string,
  folderId: string,
): Error {
  const sdkErr = asSdkError(err);
  const status = readErrorStatus(sdkErr);
  if (status === 401) {
    return new Error(
      'GDrive: service account authentication failed (HTTP 401). ' +
        'Check that the JSON key is valid and that the Drive API is enabled on the project.',
    );
  }
  if (status === 403) {
    return new Error(
      `GDrive: service account has no access to folder "${folderId}" (HTTP 403). ` +
        `Share it with: ${serviceAccountEmail}`,
    );
  }
  if (status === 404) {
    return new Error(`GDrive: folder ID "${folderId}" not found (HTTP 404).`);
  }
  const reason = sdkErr.message ?? 'unknown error';
  return new Error(`GDrive: API error reaching folder "${folderId}": ${reason}`);
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

/**
 * Connector for Google Drive (service-account flow).
 *
 * Phase 3+ capabilities:
 *  - `testConnection` opens a JWT and calls `files.get` on the root folder.
 *    401 / 403 / 404 are mapped to admin-friendly messages that mention the
 *    service account email so the operator knows whom to share the folder
 *    with.
 *  - `listFolders` returns the direct subfolders of the root (or of `parent`
 *    when supplied). Pagination is handled internally.
 *  - `listDocuments` lists non-folder, non-trashed files under the requested
 *    folder. Mime-type include / exclude filters are applied. Documents are
 *    addressed by their stable Drive file id, prefixed with `gdrive:`.
 *  - `fetchDocument` opens a binary stream:
 *      - Google Docs   → exported to PDF
 *      - Google Sheets → exported to CSV
 *      - Google Slides → exported to PDF
 *      - Anything else → `alt=media` byte-stream of the original file
 *    Unsupported Google Workspace types (Drawings, Forms, …) throw
 *    {@link UnsupportedGDriveMimeTypeError}.
 *
 * Shared Drives (Team Drives) are transparently supported via
 * `supportsAllDrives=true` and `includeItemsFromAllDrives=true` on every
 * Drive API call. The admin just supplies a Shared Drive folder id and shares
 * it with the service account (or makes the SA a member of the drive).
 *
 * Hash strategy: Drive only exposes `md5Checksum` on binary files (not on
 * Google Docs). We expose it as `etag` (the host's primary change-detection
 * signal), falling back to `modifiedTime` when md5 is absent. `RagDocument.hash`
 * is left empty — the host pipeline re-streams via `fetchDocument` to compute
 * SHA-256 at index time (parity with S3 / HTTP).
 *
 * Folder paths: Drive folders can technically have multiple parents, and
 * reconstructing the full path requires one API call per ancestor. For MVP
 * we use `path = folder.name` (just the leaf). This is enough for the UI
 * tree view; reconstructing absolute paths is a small follow-up.
 *
 * Deferred:
 *  - Drive Push Notifications (`watch()` via channel webhooks) → Phase 4+.
 *  - OAuth user flow (delegated, browser-based consent) → not planned for MVP.
 *  - Full path reconstruction for nested folders → small follow-up.
 */
export class GDriveConnector implements DocumentSourceConnector {
  readonly type: RagSourceType = 'gdrive';

  /**
   * Cached `drive_v3.Drive` instances (with their underlying JWT) keyed by
   * service-account-email + impersonateAs. The cache is process-local and
   * capped via a small LRU policy — same shape as `S3Connector`.
   */
  #clientCache = new Map<string, { jwt: JWT; drive: drive_v3.Drive }>();

  static readonly MAX_CACHED_CLIENTS = 16;

  /**
   * Optional rate limiter wired by the host at runtime. Drive's published
   * cap is 1000 queries per 100s per user (= 10/sec) — we throttle to a
   * conservative 8/sec by default (see `DEFAULT_LIMITS.gdrive`). Each
   * `drive.files.*` round-trip acquires one token from the
   * `('gdrive', clientCacheKey)` bucket before invoking the SDK.
   */
  #rateLimiter: RateLimiterLike | undefined;

  setRateLimiter(limiter: RateLimiterLike | undefined): void {
    this.#rateLimiter = limiter;
  }

  /**
   * Acquire one token from the gdrive bucket scoped to the credential
   * triple. No-op when `#rateLimiter` is undefined (preserves the prior
   * behavior for callers that build the connector directly).
   */
  async #acquireToken(config: GDriveConfig): Promise<void> {
    if (!this.#rateLimiter) return;
    await this.#rateLimiter.acquire('gdrive', clientCacheKey(config));
  }

  /** Test-only accessor that exposes the current LRU cache size. */
  __cacheSizeForTests(): number {
    return this.#clientCache.size;
  }

  async testConnection(rawConfig: DocumentSourceConfig): Promise<void> {
    const config = narrowConfig(rawConfig);
    const { drive } = this.#getClient(config);
    const serviceEmail =
      ((config.serviceAccountKey as Record<string, unknown>).client_email as string) ?? '';

    let resp: { data?: drive_v3.Schema$File };
    try {
      await this.#acquireToken(config);
      resp = (await drive.files.get({
        fileId: config.rootFolderId,
        fields: 'id, name, mimeType',
        supportsAllDrives: true,
      })) as { data?: drive_v3.Schema$File };
    } catch (err: unknown) {
      throw mapTestConnectionError(err, serviceEmail, config.rootFolderId);
    }

    const file = resp.data ?? {};
    if (file.mimeType !== 'application/vnd.google-apps.folder') {
      throw new Error(
        `GDrive: id "${config.rootFolderId}" is not a folder ` +
          `(mimeType: ${file.mimeType ?? 'unknown'}). Configure a folder id, not a file id.`,
      );
    }
  }

  async listFolders(
    rawConfig: DocumentSourceConfig,
    sourceId: string,
    parent?: RagFolder,
  ): Promise<RagFolder[]> {
    const config = narrowConfig(rawConfig);
    const { drive } = this.#getClient(config);

    // Use the parent folder id when supplied; otherwise the configured root.
    const parentId = this.#resolveParentDriveId(config, parent);
    // When recursive=false and a parent was supplied, we'd never reach it from
    // the host's traversal (the host only descends into folders returned by a
    // prior call). The flag really only matters for `listDocuments`, but we
    // mirror the semantics here defensively: don't return sub-folders of a
    // non-root parent when recursion is disabled.
    if (!config.recursive && parent) {
      return [];
    }

    const q =
      `'${parentId}' in parents and ` +
      `mimeType = 'application/vnd.google-apps.folder' and ` +
      `trashed = false`;

    const files = await listAllFiles(
      drive,
      {
        q,
        fields: 'nextPageToken, files(id, name, parents, modifiedTime, createdTime)',
        pageSize: 1000,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      },
      () => this.#acquireToken(config),
    );

    const folders: RagFolder[] = [];
    for (const f of files) {
      if (typeof f.id !== 'string' || typeof f.name !== 'string') continue;
      folders.push({
        id: f.id,
        sourceId,
        parentId: parent?.id ?? null,
        // MVP: path == name. Full absolute path reconstruction is a small
        // follow-up — see class jsdoc.
        path: f.name,
        name: f.name,
        createdAt: typeof f.createdTime === 'string' ? f.createdTime : '',
      });
    }
    return folders;
  }

  async listDocuments(
    rawConfig: DocumentSourceConfig,
    sourceId: string,
    folder?: RagFolder,
  ): Promise<RagDocument[]> {
    const config = narrowConfig(rawConfig);
    const { drive } = this.#getClient(config);

    const parentId = this.#resolveParentDriveId(config, folder);
    const q =
      `'${parentId}' in parents and ` +
      `mimeType != 'application/vnd.google-apps.folder' and ` +
      `trashed = false`;

    const files = await listAllFiles(
      drive,
      {
        q,
        fields:
          'nextPageToken, files(id, name, mimeType, size, md5Checksum, modifiedTime, parents)',
        pageSize: 1000,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      },
      () => this.#acquireToken(config),
    );

    const docs: RagDocument[] = [];
    for (const f of files) {
      if (typeof f.id !== 'string' || typeof f.name !== 'string') continue;
      const mimeType = typeof f.mimeType === 'string' ? f.mimeType : 'application/octet-stream';
      if (!matchMimeTypes(mimeType, config.includeMimeTypes, config.excludeMimeTypes)) {
        continue;
      }

      const folderPath = folder?.path;
      const path =
        typeof folderPath === 'string' && folderPath.length > 0
          ? `${folderPath}/${f.name}`
          : f.name;

      // Drive returns `size` as a string ("9874"). Coerce defensively;
      // Google Docs have no size at all.
      let size = 0;
      if (typeof f.size === 'string') {
        const n = Number.parseInt(f.size, 10);
        if (Number.isFinite(n) && n >= 0) size = n;
      } else if (typeof f.size === 'number') {
        size = f.size;
      }

      // Prefer md5Checksum (stable across renames), fallback to modifiedTime.
      const etag =
        typeof f.md5Checksum === 'string' && f.md5Checksum.length > 0
          ? f.md5Checksum
          : typeof f.modifiedTime === 'string' && f.modifiedTime.length > 0
            ? f.modifiedTime
            : null;

      docs.push({
        id: encodeDocId(f.id),
        sourceId,
        folderId: folder?.id ?? null,
        path,
        name: f.name,
        mimeType,
        size,
        hash: '',
        etag,
        lastIndexedAt: '',
        deletedAt: null,
        ingestError: null,
      });
    }
    return docs;
  }

  async fetchDocument(
    rawConfig: DocumentSourceConfig,
    _sourceId: string,
    docId: string,
  ): Promise<{ stream: Readable; mimeType: string }> {
    const config = narrowConfig(rawConfig);
    const { drive } = this.#getClient(config);
    const fileId = decodeDocId(docId);

    // Look up the mimeType first so we know whether to use export or media.
    let meta: drive_v3.Schema$File;
    try {
      await this.#acquireToken(config);
      const resp = (await drive.files.get({
        fileId,
        fields: 'id, name, mimeType',
        supportsAllDrives: true,
      })) as { data?: drive_v3.Schema$File };
      meta = resp.data ?? {};
    } catch (err: unknown) {
      const sdkErr = asSdkError(err);
      if (readErrorStatus(sdkErr) === 404) {
        throw new GDriveDocumentNotFoundError(docId);
      }
      throw err;
    }

    const originalMime =
      typeof meta.mimeType === 'string' ? meta.mimeType : 'application/octet-stream';

    if (isGoogleWorkspaceMime(originalMime)) {
      const exportMime = pickExportMime(originalMime);
      if (!exportMime) {
        throw new UnsupportedGDriveMimeTypeError(originalMime);
      }
      await this.#acquireToken(config);
      const exportResp = await drive.files.export(
        { fileId, mimeType: exportMime },
        { responseType: 'stream' },
      );
      const body = (exportResp as { data?: unknown }).data;
      return { stream: ensureReadable(body), mimeType: exportMime };
    }

    // Binary file — stream via alt=media.
    try {
      await this.#acquireToken(config);
      const mediaResp = await drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' },
      );
      const body = (mediaResp as { data?: unknown }).data;
      return { stream: ensureReadable(body), mimeType: originalMime };
    } catch (err: unknown) {
      const sdkErr = asSdkError(err);
      if (readErrorStatus(sdkErr) === 404) {
        throw new GDriveDocumentNotFoundError(docId);
      }
      throw err;
    }
  }

  // -- helpers --------------------------------------------------------------

  #resolveParentDriveId(config: GDriveConfig, parent?: RagFolder): string {
    if (parent) {
      // `RagFolder.id` round-trips with Drive file id — listFolders sets it
      // to the file id directly (no hashing).
      return parent.id;
    }
    return config.rootFolderId;
  }

  #getClient(config: GDriveConfig): { jwt: JWT; drive: drive_v3.Drive } {
    const cacheKey = clientCacheKey(config);
    const cached = this.#clientCache.get(cacheKey);
    if (cached) {
      this.#clientCache.delete(cacheKey);
      this.#clientCache.set(cacheKey, cached);
      return cached;
    }

    if (this.#clientCache.size >= GDriveConnector.MAX_CACHED_CLIENTS) {
      const oldestKey = this.#clientCache.keys().next().value;
      if (oldestKey !== undefined) {
        // Best effort: revoke the JWT to flush any cached access token. The
        // JWT class exposes `revokeCredentials()` in recent google-auth-library
        // versions — guard it so we don't crash on older builds.
        const evicted = this.#clientCache.get(oldestKey);
        this.#clientCache.delete(oldestKey);
        if (evicted) {
          const maybeRevoke = (evicted.jwt as unknown as { revokeCredentials?: () => unknown })
            .revokeCredentials;
          if (typeof maybeRevoke === 'function') {
            try {
              const r = maybeRevoke.call(evicted.jwt);
              if (r && typeof (r as Promise<unknown>).then === 'function') {
                (r as Promise<unknown>).catch(() => undefined);
              }
            } catch {
              // Swallow — eviction is best-effort.
            }
          }
        }
      }
    }

    const key = config.serviceAccountKey as Record<string, unknown>;
    const jwt = new google.auth.JWT({
      email: key.client_email as string,
      key: key.private_key as string,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      // Workspace domain-wide delegation. When set, the JWT acts as the named
      // user instead of the service account.
      subject: config.impersonateAs,
    });
    const drive = google.drive({ version: 'v3', auth: jwt });
    const entry = { jwt, drive };
    this.#clientCache.set(cacheKey, entry);
    return entry;
  }
}

// ---------------------------------------------------------------------------
// Test-only exports (mirror the `__testing` shape used by the other connectors).
// ---------------------------------------------------------------------------

export const __testing = {
  encodeDocId,
  decodeDocId,
  narrowConfig,
  pickExportMime,
  isGoogleWorkspaceMime,
  matchMimeTypes,
  clientCacheKey,
  ensureReadable,
  mapTestConnectionError,
  getClientCacheSize(connector: GDriveConnector): number {
    return connector.__cacheSizeForTests();
  },
};
