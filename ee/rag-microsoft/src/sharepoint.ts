// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  Client,
  ResponseType,
  type AuthenticationProvider,
} from '@microsoft/microsoft-graph-client';
import { ClientSecretCredential } from '@azure/identity';
import mime from 'mime-types';

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
 * Configuration for `SharePointConnector`. Stored encrypted by the host.
 *
 * The connector authenticates as an Azure AD app via the **client credentials
 * flow** (app-only — no end-user OAuth dance). The admin must:
 *   1. Register an app in Azure AD (portal.azure.com → App registrations).
 *   2. Under "API permissions", grant **Application** permission
 *      `Sites.Read.All` (broad) or `Sites.Selected` (narrow, per-site grant).
 *   3. Click "Grant admin consent" so the tenant-wide permission takes effect.
 *   4. Create a client secret under "Certificates & secrets" and copy it
 *      (it's only displayed once).
 *   5. Provide tenantId, clientId, and the secret here.
 *
 * This is the Microsoft equivalent of the GDrive service-account flow.
 */
export interface SharePointConfig {
  /** Azure AD tenant ID (GUID). */
  tenantId: string;
  /** App registration client ID (GUID). */
  clientId: string;
  /** App registration client secret. */
  clientSecret: string;
  /**
   * SharePoint site to index. Format flexible:
   *   - Full URL: 'https://contoso.sharepoint.com/sites/intranet'
   *   - Hostname-relative: 'contoso.sharepoint.com:/sites/intranet'
   *   - Graph site id: '<host>,<spId>,<webId>'
   * `narrowConfig` does NOT resolve to the Graph site id — that happens at
   * connection time inside `testConnection` and is cached per-client.
   */
  siteUrl: string;
  /**
   * Optional drive (Document Library) name. If omitted, uses the site's
   * default drive (typically "Documents").
   */
  driveName?: string;
  /**
   * Optional path inside the drive to use as root. Default '/' (the drive's
   * root folder). Example: '/Shared Documents/Projects/2026'.
   */
  rootFolderPath?: string;
  /** Recurse into subfolders. Default true. */
  recursive?: boolean;
  /** Optional include/exclude mime types (same pattern as GDrive). */
  includeMimeTypes?: string[];
  excludeMimeTypes?: string[];
}

/**
 * Narrow the opaque `DocumentSourceConfig` to the shape this connector
 * understands. Throws a clear error if the config is malformed. The
 * `siteUrl` is normalised to Graph's hostname-relative form
 * (`<host>:/<path>`) when given as a full URL — Graph also accepts site IDs
 * verbatim, so we leave non-URL inputs alone.
 */
export function narrowConfig(config: DocumentSourceConfig): SharePointConfig {
  const tenantId = config.tenantId;
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new Error('SharePointConnector requires a non-empty `tenantId` string in config');
  }
  const clientId = config.clientId;
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new Error('SharePointConnector requires a non-empty `clientId` string in config');
  }
  const clientSecret = config.clientSecret;
  if (typeof clientSecret !== 'string' || clientSecret.length === 0) {
    throw new Error('SharePointConnector requires a non-empty `clientSecret` string in config');
  }
  const siteUrl = config.siteUrl;
  if (typeof siteUrl !== 'string' || siteUrl.length === 0) {
    throw new Error('SharePointConnector requires a non-empty `siteUrl` string in config');
  }

  const driveName = config.driveName;
  if (driveName !== undefined && typeof driveName !== 'string') {
    throw new Error('SharePointConnector: `driveName` must be a string when provided');
  }

  const rootFolderPath = config.rootFolderPath;
  if (rootFolderPath !== undefined && typeof rootFolderPath !== 'string') {
    throw new Error('SharePointConnector: `rootFolderPath` must be a string when provided');
  }

  const recursive = config.recursive;
  if (recursive !== undefined && typeof recursive !== 'boolean') {
    throw new Error('SharePointConnector: `recursive` must be a boolean when provided');
  }

  const includeMimeTypes = config.includeMimeTypes;
  if (includeMimeTypes !== undefined) {
    if (
      !Array.isArray(includeMimeTypes) ||
      !includeMimeTypes.every((m) => typeof m === 'string')
    ) {
      throw new Error('SharePointConnector: `includeMimeTypes` must be an array of strings');
    }
  }
  const excludeMimeTypes = config.excludeMimeTypes;
  if (excludeMimeTypes !== undefined) {
    if (
      !Array.isArray(excludeMimeTypes) ||
      !excludeMimeTypes.every((m) => typeof m === 'string')
    ) {
      throw new Error('SharePointConnector: `excludeMimeTypes` must be an array of strings');
    }
  }

  return {
    tenantId,
    clientId,
    clientSecret,
    siteUrl: normaliseSiteUrl(siteUrl),
    driveName:
      typeof driveName === 'string' && driveName.length > 0 ? driveName : undefined,
    rootFolderPath: normaliseRootPath(rootFolderPath),
    recursive: recursive === undefined ? true : recursive,
    includeMimeTypes: includeMimeTypes as string[] | undefined,
    excludeMimeTypes: excludeMimeTypes as string[] | undefined,
  };
}

/**
 * Convert a SharePoint site URL into Graph's hostname-relative format.
 *
 * Accepted inputs:
 *   - `https://contoso.sharepoint.com/sites/intranet`
 *       → `contoso.sharepoint.com:/sites/intranet`
 *   - `contoso.sharepoint.com:/sites/intranet`  (already Graph-shaped)
 *       → returned unchanged.
 *   - `<host>,<spGuid>,<webGuid>`               (raw Graph site id)
 *       → returned unchanged.
 *
 * The result is used as the `{site-id}` segment for `/sites/{site-id}`
 * Graph requests. Graph accepts all three forms verbatim — see
 * https://learn.microsoft.com/graph/api/site-get.
 */
export function normaliseSiteUrl(siteUrl: string): string {
  const trimmed = siteUrl.trim();
  if (trimmed.length === 0) return trimmed;
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      // Malformed URL — leave it alone; Graph will return 400 with a useful
      // message that surfaces through testConnection's error mapping.
      return trimmed;
    }
    const host = parsed.host;
    // Strip the trailing slash off the pathname so we don't end up with
    // `host:/`. Empty path → site root (rare, but valid).
    const path = parsed.pathname.replace(/\/+$/, '');
    if (path.length === 0 || path === '/') return host;
    return `${host}:${path}`;
  }
  return trimmed;
}

/**
 * Normalise the optional rootFolderPath. Strips trailing slashes and ensures
 * a leading slash. Returns `undefined` for an empty/missing path (= "drive
 * root").
 */
function normaliseRootPath(p: string | undefined): string | undefined {
  if (typeof p !== 'string') return undefined;
  const trimmed = p.trim();
  if (trimmed.length === 0 || trimmed === '/') return undefined;
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeading.replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised by `fetchDocument` when the supplied `docId` cannot be resolved. */
export class SharePointDocumentNotFoundError extends Error {
  constructor(docId: string) {
    super(`Document "${docId}" not found in SharePoint source`);
    this.name = 'SharePointDocumentNotFoundError';
  }
}

/** Raised on HTTP 401 (invalid credentials / expired token). */
export class SharePointAuthError extends Error {
  constructor(message = 'Invalid SharePoint credentials') {
    super(message);
    this.name = 'SharePointAuthError';
  }
}

/** Raised on HTTP 403 (app has no permission to access the site). */
export class SharePointPermissionError extends Error {
  constructor(message = 'SharePoint app lacks required permissions') {
    super(message);
    this.name = 'SharePointPermissionError';
  }
}

// ---------------------------------------------------------------------------
// Doc id encoding
//
// Graph driveItem IDs are opaque base64-ish strings, stable across renames
// and moves. We just prefix them with `sharepoint:` for source-type
// disambiguation. No base64 needed (they're already URL-safe).
// ---------------------------------------------------------------------------

const DOC_ID_PREFIX = 'sharepoint:';

export function encodeDocId(itemId: string): string {
  return `${DOC_ID_PREFIX}${itemId}`;
}

export function decodeDocId(docId: string): string {
  if (!docId.startsWith(DOC_ID_PREFIX)) {
    throw new SharePointDocumentNotFoundError(docId);
  }
  const id = docId.slice(DOC_ID_PREFIX.length);
  if (id.length === 0) {
    throw new SharePointDocumentNotFoundError(docId);
  }
  return id;
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
// ETag stripping
//
// Graph eTags arrive double-quoted, e.g. `"{01XYZ...},1"`. Strip outer quotes
// so what we store is a plain identifier suitable for direct comparison.
// ---------------------------------------------------------------------------

export function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Cache key
//
// We key the client cache on tenant + clientId + a hash of the secret (16
// hex chars of sha256). The siteUrl / driveName are NOT part of the key —
// the same credentials may reach multiple sites, and Graph's `Client` is
// agnostic to the path. Resolved (siteId, driveId) for the current config
// is stored alongside the client.
// ---------------------------------------------------------------------------

export function clientCacheKey(config: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}): string {
  const secretSig = createHash('sha256')
    .update(config.clientSecret)
    .digest('hex')
    .slice(0, 16);
  return createHash('sha256')
    .update([config.tenantId, config.clientId, secretSig].join('|'))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Auth provider — wraps @azure/identity ClientSecretCredential
// ---------------------------------------------------------------------------

/**
 * Adapter that exposes a {@link ClientSecretCredential} as an
 * `AuthenticationProvider` consumable by the Graph SDK. The credential
 * caches access tokens internally (5-minute renewal window before expiry),
 * so calling `getAccessToken` on every request is cheap.
 */
export class AzureCredentialAuthProvider implements AuthenticationProvider {
  constructor(private readonly credential: ClientSecretCredential) {}

  async getAccessToken(): Promise<string> {
    const token = await this.credential.getToken('https://graph.microsoft.com/.default');
    if (!token) {
      throw new Error('Failed to get access token from Azure AD');
    }
    return token.token;
  }
}

// ---------------------------------------------------------------------------
// Graph response shapes (subsets we use)
// ---------------------------------------------------------------------------

/** Subset of the `site` resource we read. */
interface GraphSite {
  id: string; // `<host>,<spGuid>,<webGuid>`
  displayName?: string;
  webUrl?: string;
}

/** Subset of the `drive` resource we read. */
interface GraphDrive {
  id: string;
  name?: string;
  displayName?: string;
  driveType?: string;
}

/** Subset of the `driveItem` resource we read. */
interface GraphDriveItem {
  id: string;
  name?: string;
  size?: number;
  eTag?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  webUrl?: string;
  folder?: { childCount?: number };
  file?: {
    mimeType?: string;
    hashes?: {
      sha256Hash?: string;
      quickXorHash?: string;
      crc32Hash?: string;
    };
  };
  parentReference?: {
    driveId?: string;
    id?: string;
    /** Graph path: `/drives/<driveId>/root:/<path>` */
    path?: string;
  };
}

/** Generic OData collection envelope. */
interface GraphCollection<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

// ---------------------------------------------------------------------------
// Error shape & mapping
// ---------------------------------------------------------------------------

interface GraphErrorLike {
  statusCode?: number;
  status?: number;
  code?: string | number;
  message?: string;
  body?: unknown;
  response?: { status?: number };
}

function asGraphError(err: unknown): GraphErrorLike {
  if (err && typeof err === 'object') return err as GraphErrorLike;
  return {};
}

function readErrorStatus(err: GraphErrorLike): number | undefined {
  if (typeof err.statusCode === 'number') return err.statusCode;
  if (typeof err.status === 'number') return err.status;
  if (typeof err.code === 'number') return err.code;
  if (err.response && typeof err.response.status === 'number') return err.response.status;
  return undefined;
}

function readErrorCode(err: GraphErrorLike): string | undefined {
  if (typeof err.code === 'string') return err.code;
  // Graph SDK sometimes carries the typed code on `body.error.code`. Best-effort.
  if (err.body && typeof err.body === 'object') {
    const b = err.body as { error?: { code?: unknown } };
    if (b.error && typeof b.error.code === 'string') return b.error.code;
  }
  return undefined;
}

/**
 * Translate a Graph SDK error encountered during `testConnection` into an
 * admin-facing message. The site URL is included on 404 so the operator
 * knows what to fix; the typed `code` (e.g. `Authorization_RequestDenied`)
 * drives the 403 messaging because Graph returns the same HTTP code for
 * "no permission on this site" and "permission not granted at all".
 */
export function mapTestConnectionError(err: unknown, siteUrl: string): Error {
  const e = asGraphError(err);
  const status = readErrorStatus(e);
  const code = readErrorCode(e);

  if (status === 401 || code === 'InvalidAuthenticationToken') {
    return new SharePointAuthError(
      'SharePoint: invalid credentials (HTTP 401). ' +
        'Check tenantId, clientId, and clientSecret — make sure the secret has not expired.',
    );
  }
  if (status === 403 || code === 'Authorization_RequestDenied') {
    return new SharePointPermissionError(
      'SharePoint: app has no permission to access the site (HTTP 403). ' +
        "Grant Application permission 'Sites.Read.All' (or 'Sites.Selected' for this site) " +
        "in Azure AD → API permissions, then click 'Grant admin consent'.",
    );
  }
  if (status === 404) {
    return new Error(`SharePoint: site not found at URL: ${siteUrl} (HTTP 404).`);
  }
  // Network / DNS / TLS failure — surface as a generic reachability error so
  // admins see "cannot reach" instead of a raw fetch stack trace.
  if (status === undefined) {
    const reason = e.message ?? 'unknown error';
    return new Error(`SharePoint: cannot reach Microsoft Graph: ${reason}`);
  }
  const reason = e.message ?? `HTTP ${status}`;
  return new Error(`SharePoint: API error: ${reason}`);
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Extract a human-readable folder path from a Graph `parentReference.path`.
 * Graph's path looks like `/drives/<driveId>/root:/Shared Documents/Projects`
 * (URL-encoded). We slice off the `/drives/<driveId>/root:` prefix so the
 * returned path is what a human typed in the SharePoint UI.
 *
 * Returns `''` when the path can't be parsed (root folder, malformed input).
 */
export function parseGraphPath(rawPath: string | undefined): string {
  if (typeof rawPath !== 'string') return '';
  const idx = rawPath.indexOf('root:');
  if (idx < 0) return '';
  const after = rawPath.slice(idx + 'root:'.length);
  try {
    return decodeURIComponent(after);
  } catch {
    return after;
  }
}

/**
 * Build the human-readable path of a driveItem from its name + parentReference.
 * Used for `RagDocument.path` and `RagFolder.path` so the tree view is
 * meaningful to the admin.
 */
function buildItemPath(item: GraphDriveItem): string {
  const parentPath = parseGraphPath(item.parentReference?.path);
  const name = item.name ?? '';
  if (!name) return parentPath;
  if (!parentPath || parentPath === '/') return name;
  // parentPath may or may not have a leading slash depending on whether the
  // parent was the drive root. Strip any leading slash so we always emit a
  // relative path like `Shared Documents/Projects/file.pdf`.
  const stripped = parentPath.replace(/^\/+/, '');
  return stripped.length > 0 ? `${stripped}/${name}` : name;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

/**
 * Cached state for a credential triple: the Graph `Client` plus the
 * resolved (siteId, driveId, rootItemId) tuple for the current
 * (siteUrl, driveName, rootFolderPath) combo. We re-resolve when any of the
 * three changes — caching is best-effort and a miss costs at most two extra
 * Graph round-trips.
 */
interface CachedClient {
  client: Client;
  resolution: Map<string, ResolvedDrive>;
}

interface ResolvedDrive {
  siteId: string;
  driveId: string;
  /** Item id of the configured rootFolderPath (or the drive root). */
  rootItemId: string;
  /** Path the root is rooted at, kept for tree-view display. */
  rootPath: string;
}

/**
 * Connector for SharePoint Document Libraries (app-only / client credentials).
 *
 * Mapping:
 *   - SharePoint **Document Library**  → addressed via Graph `drive`
 *   - SharePoint **folder** (driveItem with `folder !== undefined`) → `RagFolder`
 *   - SharePoint **file**   (driveItem with `file   !== undefined`) → `RagDocument`
 *
 * Phase 3+ capabilities:
 *   - `testConnection` resolves the site and lists drives so the admin gets a
 *     clear error if Sites.Read.All is missing or the site URL is wrong.
 *   - `listFolders` returns subfolders of `parent.id` (or the configured
 *     rootFolderPath when no parent is supplied). Pagination via
 *     `@odata.nextLink` is handled internally.
 *   - `listDocuments` lists files under `folder.id` (or the configured root).
 *     Mime-type include/exclude filters are applied. Documents are addressed
 *     by their stable Graph driveItem id, prefixed with `sharepoint:`.
 *   - `fetchDocument` streams the file body via Graph's `/content` endpoint.
 *     Graph responds with a 302 to Azure Blob storage; the SDK follows the
 *     redirect transparently when responseType is STREAM.
 *
 * Hash strategy: Graph exposes `sha256Hash` for files stored directly in
 * SharePoint, but NOT for Office documents (Word/Excel/PowerPoint), which
 * only carry `quickXorHash`. We expose whichever is available as the
 * canonical hash; `etag` (with surrounding quotes stripped) is the primary
 * change-detection signal. When neither hash is present, `hash` is left
 * empty and the host pipeline re-streams to compute SHA-256 at index time
 * (parity with S3 / GDrive).
 *
 * Deferred:
 *   - Microsoft Graph push notifications (/subscriptions webhooks) → Phase 4+.
 *   - OAuth on-behalf-of flow (delegated permissions) — app-only suffices for MVP.
 *   - Multi-site indexing per source — out of scope; one source = one site.
 *   - SharePoint Lists (vs Document Libraries) — out of scope for MVP.
 *   - Teams files (technically SharePoint but via a different graph path).
 */
export class SharePointConnector implements DocumentSourceConnector {
  readonly type: RagSourceType = 'sharepoint';

  #clientCache = new Map<string, CachedClient>();

  static readonly MAX_CACHED_CLIENTS = 16;

  /**
   * Optional rate limiter wired by the host at runtime. Microsoft Graph's
   * documented limit is 10 000 requests / 10 min / app / tenant — we throttle
   * to 15 req/sec by default (with a 50-token burst) via `DEFAULT_LIMITS.sharepoint`.
   * Each Graph call (`/sites`, `/drives`, `/items`, `/content`) acquires one
   * token from the `('sharepoint', clientCacheKey)` bucket before the SDK
   * sends the request.
   */
  #rateLimiter: RateLimiterLike | undefined;

  setRateLimiter(limiter: RateLimiterLike | undefined): void {
    this.#rateLimiter = limiter;
  }

  /**
   * Acquire one token scoped to the credential triple. Token key matches the
   * client cache key so two sources sharing creds also share a bucket
   * (matches Graph's per-app-per-tenant quota model).
   */
  async #acquireToken(config: SharePointConfig): Promise<void> {
    if (!this.#rateLimiter) return;
    await this.#rateLimiter.acquire('sharepoint', clientCacheKey(config));
  }

  /** Test-only accessor that exposes the current LRU cache size. */
  __cacheSizeForTests(): number {
    return this.#clientCache.size;
  }

  async testConnection(rawConfig: DocumentSourceConfig): Promise<void> {
    const config = narrowConfig(rawConfig);
    const client = this.#getClient(config).client;

    let site: GraphSite;
    try {
      await this.#acquireToken(config);
      site = (await client.api(`/sites/${config.siteUrl}`).get()) as GraphSite;
    } catch (err: unknown) {
      throw mapTestConnectionError(err, config.siteUrl);
    }
    if (!site || typeof site.id !== 'string') {
      throw new Error(`SharePoint: site lookup returned no id for "${config.siteUrl}"`);
    }

    let drives: GraphCollection<GraphDrive>;
    try {
      await this.#acquireToken(config);
      drives = (await client.api(`/sites/${site.id}/drives`).get()) as GraphCollection<GraphDrive>;
    } catch (err: unknown) {
      throw mapTestConnectionError(err, config.siteUrl);
    }
    const driveList = Array.isArray(drives?.value) ? drives.value : [];
    if (driveList.length === 0) {
      throw new Error(`SharePoint: site "${config.siteUrl}" has no document libraries.`);
    }

    if (config.driveName) {
      const matched = driveList.find(
        (d) => d.name === config.driveName || d.displayName === config.driveName,
      );
      if (!matched) {
        const available = driveList
          .map((d) => d.displayName ?? d.name)
          .filter((n): n is string => typeof n === 'string')
          .join(', ');
        throw new Error(
          `SharePoint: document library "${config.driveName}" not found. Available: ${available}`,
        );
      }
    }

    // Stash the resolution so listFolders / listDocuments don't re-resolve.
    await this.#resolveDrive(client, config, site, driveList);
  }

  async listFolders(
    rawConfig: DocumentSourceConfig,
    sourceId: string,
    parent?: RagFolder,
  ): Promise<RagFolder[]> {
    const config = narrowConfig(rawConfig);
    const client = this.#getClient(config).client;

    if (!config.recursive && parent) {
      // Mirror GDrive: when recursion is disabled, never list sub-folders of
      // a non-root parent. The host's traversal never reaches this code in
      // practice (it only descends into folders we return), but we mirror
      // the semantics defensively.
      return [];
    }

    const resolved = await this.#resolveDrive(client, config);
    const parentItemId = parent ? parent.id : resolved.rootItemId;

    const items = await this.#listChildren(client, resolved, parentItemId, config);

    const folders: RagFolder[] = [];
    for (const item of items) {
      if (!item.folder || typeof item.id !== 'string' || typeof item.name !== 'string') continue;
      folders.push({
        id: item.id,
        sourceId,
        parentId: parent?.id ?? null,
        path: buildItemPath(item),
        name: item.name,
        createdAt: typeof item.createdDateTime === 'string' ? item.createdDateTime : '',
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
    const client = this.#getClient(config).client;

    const resolved = await this.#resolveDrive(client, config);
    const parentItemId = folder ? folder.id : resolved.rootItemId;

    const items = await this.#listChildren(client, resolved, parentItemId, config);

    const docs: RagDocument[] = [];
    for (const item of items) {
      if (!item.file || typeof item.id !== 'string' || typeof item.name !== 'string') continue;
      const declaredMime = item.file.mimeType;
      const mimeType =
        typeof declaredMime === 'string' && declaredMime.length > 0
          ? declaredMime
          : mime.lookup(item.name) || 'application/octet-stream';
      if (!matchMimeTypes(mimeType, config.includeMimeTypes, config.excludeMimeTypes)) {
        continue;
      }

      const size = typeof item.size === 'number' ? item.size : 0;
      const hash =
        item.file.hashes?.sha256Hash ??
        item.file.hashes?.quickXorHash ??
        '';
      const rawETag = typeof item.eTag === 'string' ? stripQuotes(item.eTag) : null;

      docs.push({
        id: encodeDocId(item.id),
        sourceId,
        folderId: folder?.id ?? null,
        path: buildItemPath(item),
        name: item.name,
        mimeType,
        size,
        hash,
        etag: rawETag,
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
    const client = this.#getClient(config).client;
    const itemId = decodeDocId(docId);

    const resolved = await this.#resolveDrive(client, config);

    // 1. metadata fetch to get the mime type (Graph doesn't always echo it
    //    on the /content response — depends on the underlying CDN headers).
    let meta: GraphDriveItem;
    try {
      await this.#acquireToken(config);
      meta = (await client
        .api(`/sites/${resolved.siteId}/drives/${resolved.driveId}/items/${itemId}`)
        .get()) as GraphDriveItem;
    } catch (err: unknown) {
      const e = asGraphError(err);
      if (readErrorStatus(e) === 404) {
        throw new SharePointDocumentNotFoundError(docId);
      }
      if (readErrorStatus(e) === 401) throw new SharePointAuthError();
      if (readErrorStatus(e) === 403) throw new SharePointPermissionError();
      throw err;
    }

    const mimeType =
      (meta.file?.mimeType && meta.file.mimeType.length > 0
        ? meta.file.mimeType
        : meta.name
          ? mime.lookup(meta.name) || 'application/octet-stream'
          : 'application/octet-stream');

    // 2. stream the body. Graph returns a 302 to Azure Blob; the SDK follows
    //    the redirect transparently. We request a STREAM responseType so the
    //    body arrives as a Node Readable (no full-buffer materialization).
    let stream: Readable;
    try {
      await this.#acquireToken(config);
      const body = await client
        .api(`/sites/${resolved.siteId}/drives/${resolved.driveId}/items/${itemId}/content`)
        .responseType(ResponseType.STREAM)
        .get();
      stream = ensureReadable(body);
    } catch (err: unknown) {
      const e = asGraphError(err);
      if (readErrorStatus(e) === 404) {
        throw new SharePointDocumentNotFoundError(docId);
      }
      if (readErrorStatus(e) === 401) throw new SharePointAuthError();
      if (readErrorStatus(e) === 403) throw new SharePointPermissionError();
      throw err;
    }

    return { stream, mimeType };
  }

  // -- helpers --------------------------------------------------------------

  /**
   * Cached `(client, resolved-drive)` lookup. The resolution is keyed on
   * `siteUrl|driveName|rootFolderPath` so each distinct config produces
   * exactly one set of Graph round-trips per process.
   */
  #getClient(config: SharePointConfig): CachedClient {
    const cacheKey = clientCacheKey(config);
    const cached = this.#clientCache.get(cacheKey);
    if (cached) {
      // Refresh LRU order so the hot client doesn't get evicted under load.
      this.#clientCache.delete(cacheKey);
      this.#clientCache.set(cacheKey, cached);
      return cached;
    }

    if (this.#clientCache.size >= SharePointConnector.MAX_CACHED_CLIENTS) {
      const oldestKey = this.#clientCache.keys().next().value;
      if (oldestKey !== undefined) this.#clientCache.delete(oldestKey);
    }

    const credential = new ClientSecretCredential(
      config.tenantId,
      config.clientId,
      config.clientSecret,
    );
    const client = Client.initWithMiddleware({
      authProvider: new AzureCredentialAuthProvider(credential),
    });
    const entry: CachedClient = { client, resolution: new Map() };
    this.#clientCache.set(cacheKey, entry);
    return entry;
  }

  /**
   * Resolve `(siteId, driveId, rootItemId)` for the given config. Result is
   * cached on the credential entry so subsequent calls within the same
   * process (and against the same site/drive/root) skip the Graph round-trips.
   *
   * When `siteOverride` / `drivesOverride` are passed (testConnection),
   * we reuse them instead of refetching.
   */
  async #resolveDrive(
    client: Client,
    config: SharePointConfig,
    siteOverride?: GraphSite,
    drivesOverride?: GraphDrive[],
  ): Promise<ResolvedDrive> {
    const credKey = clientCacheKey(config);
    const cached = this.#clientCache.get(credKey);
    const resolutionKey = `${config.siteUrl}|${config.driveName ?? ''}|${config.rootFolderPath ?? ''}`;
    if (cached) {
      const hit = cached.resolution.get(resolutionKey);
      if (hit) return hit;
    }

    // 1. site
    let site: GraphSite;
    if (siteOverride) {
      site = siteOverride;
    } else {
      try {
        await this.#acquireToken(config);
        site = (await client.api(`/sites/${config.siteUrl}`).get()) as GraphSite;
      } catch (err: unknown) {
        throw mapTestConnectionError(err, config.siteUrl);
      }
    }
    if (!site.id) {
      throw new Error(`SharePoint: site lookup returned no id for "${config.siteUrl}"`);
    }

    // 2. drives
    let driveList: GraphDrive[];
    if (drivesOverride) {
      driveList = drivesOverride;
    } else {
      try {
        await this.#acquireToken(config);
        const drives = (await client
          .api(`/sites/${site.id}/drives`)
          .get()) as GraphCollection<GraphDrive>;
        driveList = Array.isArray(drives?.value) ? drives.value : [];
      } catch (err: unknown) {
        throw mapTestConnectionError(err, config.siteUrl);
      }
    }
    if (driveList.length === 0) {
      throw new Error(`SharePoint: site "${config.siteUrl}" has no document libraries.`);
    }
    const drive = config.driveName
      ? driveList.find(
          (d) => d.name === config.driveName || d.displayName === config.driveName,
        )
      : driveList[0];
    if (!drive) {
      const available = driveList
        .map((d) => d.displayName ?? d.name)
        .filter((n): n is string => typeof n === 'string')
        .join(', ');
      throw new Error(
        `SharePoint: document library "${config.driveName ?? '(default)'}" not found. Available: ${available}`,
      );
    }

    // 3. root item — either drive root or the configured path.
    let rootItemId: string;
    let rootPath: string;
    if (config.rootFolderPath) {
      // Graph supports path-based addressing on the drive: GET
      // /sites/{site}/drives/{drive}/root:/{path}  → driveItem
      try {
        await this.#acquireToken(config);
        const item = (await client
          .api(`/sites/${site.id}/drives/${drive.id}/root:${config.rootFolderPath}`)
          .get()) as GraphDriveItem;
        if (typeof item.id !== 'string') {
          throw new Error(
            `SharePoint: rootFolderPath "${config.rootFolderPath}" resolved without an id`,
          );
        }
        rootItemId = item.id;
        rootPath = config.rootFolderPath;
      } catch (err: unknown) {
        const e = asGraphError(err);
        if (readErrorStatus(e) === 404) {
          throw new Error(
            `SharePoint: rootFolderPath "${config.rootFolderPath}" not found in drive "${drive.displayName ?? drive.name}".`,
          );
        }
        throw mapTestConnectionError(err, config.siteUrl);
      }
    } else {
      // Drive root — fetch once to get its id.
      try {
        await this.#acquireToken(config);
        const item = (await client
          .api(`/sites/${site.id}/drives/${drive.id}/root`)
          .get()) as GraphDriveItem;
        if (typeof item.id !== 'string') {
          throw new Error('SharePoint: drive root resolved without an id');
        }
        rootItemId = item.id;
        rootPath = '';
      } catch (err: unknown) {
        throw mapTestConnectionError(err, config.siteUrl);
      }
    }

    const resolved: ResolvedDrive = {
      siteId: site.id,
      driveId: drive.id,
      rootItemId,
      rootPath,
    };
    if (cached) cached.resolution.set(resolutionKey, resolved);
    return resolved;
  }

  /**
   * Drain a `/items/{id}/children` listing across pages, returning every
   * child (folders + files). Caller filters on `folder` vs `file`. The
   * `config` is threaded purely so we can acquire a rate-limit token per
   * page request — the listing itself is config-agnostic.
   */
  async #listChildren(
    client: Client,
    resolved: ResolvedDrive,
    parentItemId: string,
    config: SharePointConfig,
  ): Promise<GraphDriveItem[]> {
    const items: GraphDriveItem[] = [];
    let nextLink: string | undefined;
    let firstCall = true;
    // Graph paginates at $top up to 200 per page; we explicitly request that
    // ceiling to minimise round-trips.
    const initialPath = `/sites/${resolved.siteId}/drives/${resolved.driveId}/items/${parentItemId}/children?$top=200`;

    do {
      const path = firstCall ? initialPath : (nextLink as string);
      firstCall = false;
      let resp: GraphCollection<GraphDriveItem>;
      try {
        await this.#acquireToken(config);
        resp = (await client.api(path).get()) as GraphCollection<GraphDriveItem>;
      } catch (err: unknown) {
        const e = asGraphError(err);
        if (readErrorStatus(e) === 401) throw new SharePointAuthError();
        if (readErrorStatus(e) === 403) throw new SharePointPermissionError();
        throw err;
      }
      if (Array.isArray(resp?.value)) {
        for (const v of resp.value) items.push(v);
      }
      nextLink =
        typeof resp?.['@odata.nextLink'] === 'string' ? resp['@odata.nextLink'] : undefined;
    } while (nextLink);

    return items;
  }
}

// ---------------------------------------------------------------------------
// Stream conversion
//
// The Graph SDK returns various shapes depending on the underlying HTTP
// driver (fetch vs node-fetch vs cross-fetch). For STREAM responses we get
// either a Node Readable or a web ReadableStream. Normalise to a Node
// Readable so the host pipeline doesn't need to branch.
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
  // Web ReadableStream — supported on Node 18+. Adapt to a Node Readable.
  if (
    body !== null &&
    typeof body === 'object' &&
    typeof (body as { getReader?: unknown }).getReader === 'function'
  ) {
    // Node's Readable.fromWeb expects a global ReadableStream; cast through
    // unknown to keep the function tree-shakeable for test runners that
    // don't materialise the Web Streams polyfill.
    return Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0]);
  }
  // Test mocks may return a string. Wrap it.
  if (typeof body === 'string') {
    return Readable.from([Buffer.from(body, 'utf8')]);
  }
  // Buffer / Uint8Array — wrap.
  if (body instanceof Uint8Array) {
    return Readable.from([Buffer.from(body)]);
  }
  throw new Error('SharePointConnector: Graph API returned a non-Readable body');
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __testing = {
  encodeDocId,
  decodeDocId,
  narrowConfig,
  normaliseSiteUrl,
  matchMimeTypes,
  clientCacheKey,
  stripQuotes,
  parseGraphPath,
  mapTestConnectionError,
  ensureReadable,
  getClientCacheSize(connector: SharePointConnector): number {
    return connector.__cacheSizeForTests();
  },
};
