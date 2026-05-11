// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { google, type sheets_v4, type drive_v3 } from 'googleapis';
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
 * Configuration for `GSheetsConnector`. Stored encrypted by the host.
 *
 * The connector authenticates as a Google Cloud service account (same flow
 * as `@calame-ee/rag-gdrive` — admins can re-use the same service account
 * key as long as both the Sheets API and the Drive API are enabled on the
 * GCP project and each spreadsheet (or the enumeration folder) is shared
 * with the service account's `client_email`).
 *
 * Either `spreadsheetIds` OR `driveFolderId` (or both) MUST be set. The
 * connector treats them as complementary: spreadsheets listed explicitly are
 * always indexed; spreadsheets discovered under `driveFolderId` are added to
 * that set at list time.
 */
export interface GSheetsConfig {
  /**
   * Service account JSON key (downloaded from GCP Console). Same shape as
   * `@calame-ee/rag-gdrive` — accepted as either a parsed object or a raw
   * JSON string. Must contain at minimum `client_email`, `private_key`, and
   * `token_uri`.
   */
  serviceAccountKey: Record<string, unknown> | string;
  /**
   * Explicit spreadsheet IDs to index. Each ID surfaces as one `RagFolder`
   * (the spreadsheet) containing one `RagDocument` per tab/sheet.
   */
  spreadsheetIds?: string[];
  /**
   * Drive folder ID to enumerate spreadsheets from. The connector lists
   * every file under the folder whose mime type is
   * `application/vnd.google-apps.spreadsheet`. No recursion — sub-folders
   * are ignored (DocumentSource semantics: a spreadsheet is the unit).
   */
  driveFolderId?: string;
  /**
   * Optional impersonation: use domain-wide delegation to act as a specific
   * Workspace user. Most setups don't need this — leave undefined.
   */
  impersonateAs?: string;
  /**
   * Default range to read per sheet (A1 notation, e.g. `'A:Z'` or
   * `'A1:D100'`). When omitted the connector reads the whole used range of
   * each tab (`<sheetTitle>!A:ZZ` — wide enough for any sane workbook).
   */
  defaultRange?: string;
  /**
   * Whether to include sheets whose title starts with `archive_` or `_old`
   * (case-insensitive). Default false — operators typically don't want
   * historical tabs indexed alongside live data.
   */
  includeArchived?: boolean;
}

/** Pattern used to detect "archive-like" sheet titles. */
const ARCHIVE_TITLE_RE = /^(archive_|_old)/i;

/**
 * Narrow the opaque `DocumentSourceConfig` to the shape this connector
 * understands. Accepts the service account key as either a parsed object or
 * a raw JSON string. Throws a clear error if the config is malformed.
 */
export function narrowConfig(config: DocumentSourceConfig): GSheetsConfig {
  const rawKey = config.serviceAccountKey;
  if (rawKey === undefined || rawKey === null) {
    throw new Error(
      'GSheetsConnector requires a `serviceAccountKey` (object or JSON string) in config',
    );
  }
  let key: Record<string, unknown>;
  if (typeof rawKey === 'string') {
    if (rawKey.length === 0) {
      throw new Error('GSheetsConnector: `serviceAccountKey` string is empty');
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
        `GSheetsConnector: \`serviceAccountKey\` is not valid JSON (${reason})`,
      );
    }
  } else if (typeof rawKey === 'object' && !Array.isArray(rawKey)) {
    key = rawKey as Record<string, unknown>;
  } else {
    throw new Error(
      'GSheetsConnector: `serviceAccountKey` must be an object or a JSON string',
    );
  }

  for (const field of ['client_email', 'private_key', 'token_uri'] as const) {
    const v = key[field];
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(
        `GSheetsConnector: serviceAccountKey is missing required field "${field}"`,
      );
    }
  }

  const rawIds = config.spreadsheetIds;
  let spreadsheetIds: string[] | undefined;
  if (rawIds !== undefined) {
    if (!Array.isArray(rawIds) || !rawIds.every((id) => typeof id === 'string')) {
      throw new Error('GSheetsConnector: `spreadsheetIds` must be an array of strings');
    }
    const cleaned = (rawIds as string[]).map((s) => s.trim()).filter((s) => s.length > 0);
    spreadsheetIds = cleaned.length > 0 ? cleaned : undefined;
  }

  const rawFolderId = config.driveFolderId;
  let driveFolderId: string | undefined;
  if (rawFolderId !== undefined) {
    if (typeof rawFolderId !== 'string') {
      throw new Error('GSheetsConnector: `driveFolderId` must be a string when provided');
    }
    const trimmed = rawFolderId.trim();
    driveFolderId = trimmed.length > 0 ? trimmed : undefined;
  }

  if (!spreadsheetIds && !driveFolderId) {
    throw new Error(
      'GSheetsConnector: at least one of `spreadsheetIds` or `driveFolderId` must be set',
    );
  }

  const impersonateAs = config.impersonateAs;
  if (impersonateAs !== undefined && typeof impersonateAs !== 'string') {
    throw new Error('GSheetsConnector: `impersonateAs` must be a string when provided');
  }

  const defaultRange = config.defaultRange;
  if (defaultRange !== undefined && typeof defaultRange !== 'string') {
    throw new Error('GSheetsConnector: `defaultRange` must be a string when provided');
  }

  const includeArchived = config.includeArchived;
  if (includeArchived !== undefined && typeof includeArchived !== 'boolean') {
    throw new Error('GSheetsConnector: `includeArchived` must be a boolean when provided');
  }

  return {
    serviceAccountKey: key,
    spreadsheetIds,
    driveFolderId,
    impersonateAs:
      typeof impersonateAs === 'string' && impersonateAs.length > 0 ? impersonateAs : undefined,
    defaultRange:
      typeof defaultRange === 'string' && defaultRange.length > 0 ? defaultRange : undefined,
    includeArchived: includeArchived === true,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Raised by `fetchDocument` when the supplied `docId` cannot be resolved
 * (wrong prefix, missing spreadsheet, or sheetId not found in the workbook).
 */
export class GSheetsDocumentNotFoundError extends Error {
  constructor(docId: string) {
    super(`Document "${docId}" not found in Google Sheets source`);
    this.name = 'GSheetsDocumentNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Doc / folder id encoding
//
// Doc ids carry both the spreadsheet id and the numeric sheet id so the
// runtime can resolve a document back to a `(spreadsheetId, sheetId)` tuple
// without needing to re-list the workbook. Spreadsheet ids are URL-safe
// Drive ids, sheet ids are 32-bit integers (Sheets returns them as numbers).
//
// Folder ids identify a spreadsheet (one synthetic folder per workbook) —
// distinct prefix avoids any collision with the document namespace.
// ---------------------------------------------------------------------------

const DOC_ID_PREFIX = 'gsheets:tab:';
const FOLDER_ID_PREFIX = 'gsheets:ss:';

export function encodeDocId(spreadsheetId: string, sheetId: number): string {
  return `${DOC_ID_PREFIX}${spreadsheetId}:${sheetId}`;
}

export function decodeDocId(docId: string): { spreadsheetId: string; sheetId: number } {
  if (!docId.startsWith(DOC_ID_PREFIX)) {
    throw new GSheetsDocumentNotFoundError(docId);
  }
  const rest = docId.slice(DOC_ID_PREFIX.length);
  // The sheetId is the last `:`-delimited segment (spreadsheet ids never
  // contain a colon — they are URL-safe base64 — so the split is unambiguous).
  const lastColon = rest.lastIndexOf(':');
  if (lastColon <= 0 || lastColon === rest.length - 1) {
    throw new GSheetsDocumentNotFoundError(docId);
  }
  const spreadsheetId = rest.slice(0, lastColon);
  const sheetIdStr = rest.slice(lastColon + 1);
  const sheetId = Number.parseInt(sheetIdStr, 10);
  if (!Number.isFinite(sheetId) || sheetId < 0 || String(sheetId) !== sheetIdStr) {
    throw new GSheetsDocumentNotFoundError(docId);
  }
  return { spreadsheetId, sheetId };
}

export function encodeFolderId(spreadsheetId: string): string {
  return `${FOLDER_ID_PREFIX}${spreadsheetId}`;
}

export function decodeFolderId(folderId: string): string {
  if (!folderId.startsWith(FOLDER_ID_PREFIX)) {
    throw new Error(`GSheetsConnector: invalid folder id "${folderId}"`);
  }
  const id = folderId.slice(FOLDER_ID_PREFIX.length);
  if (id.length === 0) {
    throw new Error(`GSheetsConnector: empty spreadsheet id in folder id "${folderId}"`);
  }
  return id;
}

// ---------------------------------------------------------------------------
// CSV serialization (RFC 4180)
//
// We always quote every field — keeps the implementation tiny and is what
// every spreadsheet importer expects. Embedded `"` chars are doubled.
// ---------------------------------------------------------------------------

/** True if a sheet title looks like an archive tab (per `ARCHIVE_TITLE_RE`). */
export function isArchivedSheetTitle(title: string): boolean {
  return ARCHIVE_TITLE_RE.test(title);
}

/**
 * Serialize a 2D values array (as returned by `spreadsheets.values.get`)
 * into RFC 4180 CSV text. `undefined` / `null` cells become empty strings;
 * everything else is `String()`-coerced and quoted.
 */
export function valuesToCsv(values: unknown[][]): string {
  if (!Array.isArray(values) || values.length === 0) return '';
  const lines: string[] = [];
  for (const row of values) {
    if (!Array.isArray(row)) {
      lines.push('');
      continue;
    }
    const cells = row.map((cell) => {
      if (cell === undefined || cell === null) return '""';
      const s = typeof cell === 'string' ? cell : String(cell);
      // RFC 4180: double every embedded quote and wrap in quotes.
      return `"${s.replace(/"/g, '""')}"`;
    });
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}

/**
 * Sheets API quotes a sheet title in A1 notation when it contains anything
 * other than `[a-zA-Z0-9_]`. We always quote, doubling any embedded `'`,
 * so a tab named `Q1 'Forecast'` survives round-tripping.
 */
export function quoteSheetTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

function clientCacheKey(config: GSheetsConfig): string {
  const key = config.serviceAccountKey as Record<string, unknown>;
  const email = typeof key.client_email === 'string' ? key.client_email : '';
  const pkSig =
    typeof key.private_key === 'string'
      ? createHash('sha256').update(key.private_key).digest('hex').slice(0, 16)
      : '';
  return createHash('sha256')
    .update([email, pkSig, config.impersonateAs ?? ''].join('|'))
    .digest('hex');
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
 * Translate a Sheets / Drive SDK error encountered during `testConnection`
 * into an admin-facing message. The service-account email is included on 403
 * so the operator immediately knows whom to share the resource with.
 */
function mapTestConnectionError(
  err: unknown,
  serviceAccountEmail: string,
  resourceId: string,
  resourceLabel: 'spreadsheet' | 'folder',
): Error {
  const sdkErr = asSdkError(err);
  const status = readErrorStatus(sdkErr);
  if (status === 401) {
    return new Error(
      'GSheets: service account authentication failed (HTTP 401). ' +
        'Check that the JSON key is valid and that the Sheets API + Drive API are enabled on the project.',
    );
  }
  if (status === 403) {
    return new Error(
      `GSheets: service account has no access to ${resourceLabel} "${resourceId}" (HTTP 403). ` +
        `Share it with: ${serviceAccountEmail}`,
    );
  }
  if (status === 404) {
    return new Error(`GSheets: ${resourceLabel} ID "${resourceId}" not found (HTTP 404).`);
  }
  const reason = sdkErr.message ?? 'unknown error';
  return new Error(`GSheets: API error reaching ${resourceLabel} "${resourceId}": ${reason}`);
}

// ---------------------------------------------------------------------------
// Drive folder enumeration
// ---------------------------------------------------------------------------

async function listSpreadsheetsInFolder(
  drive: drive_v3.Drive,
  folderId: string,
  beforeCall?: () => Promise<void>,
): Promise<drive_v3.Schema$File[]> {
  const all: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;
  const q =
    `'${folderId}' in parents and ` +
    `mimeType = 'application/vnd.google-apps.spreadsheet' and ` +
    `trashed = false`;
  do {
    if (beforeCall) await beforeCall();
    const resp = await drive.files.list({
      q,
      fields: 'nextPageToken, files(id, name, modifiedTime, createdTime)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const data = resp.data ?? {};
    if (Array.isArray(data.files)) {
      for (const f of data.files) all.push(f);
    }
    pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : undefined;
  } while (pageToken);
  return all;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

/**
 * Per-spreadsheet metadata kept in a tiny LRU so `listDocuments` and
 * `fetchDocument` don't re-fetch the workbook on every call. Capped at
 * `MAX_SPREADSHEET_META` entries — well under the working set of any
 * single sync job.
 */
interface SpreadsheetMeta {
  title: string;
  /** Drive-side `modifiedTime` — used as the document etag. */
  modifiedTime: string | null;
  /** Sheet title indexed by sheetId. */
  sheetTitles: Map<number, string>;
}

/**
 * Connector for Google Sheets (service-account flow). Distinct from
 * `@calame-ee/rag-gdrive` because:
 *
 *  - Each tab inside a workbook surfaces as its own `RagDocument` (one Drive
 *    Sheet with 5 tabs → 5 documents), keeping the RAG search granularity
 *    aligned with how users actually structure data inside Sheets.
 *  - `fetchDocument` exports the requested tab to RFC 4180 CSV with the
 *    header row preserved, so the host CSV chunker can repeat it on every
 *    chunk (schema-aware retrieval).
 *  - The configuration accepts either explicit `spreadsheetIds` or a
 *    `driveFolderId` to enumerate spreadsheets from — most teams pick the
 *    folder mode so newly-shared workbooks are picked up automatically.
 *
 * Hash strategy: empty string for `RagDocument.hash`; the host pipeline
 * re-streams via `fetchDocument` to compute SHA-256 at index time (parity
 * with the gdrive / s3 / http connectors). `etag` is the spreadsheet's
 * Drive-side `modifiedTime` — coarse-grained (an edit to any tab updates
 * all tabs' etags) but correct, since editing a workbook is the only way
 * to change the CSV that a tab exports.
 *
 * Hors scope (MVP):
 *  - Per-cell range scoping (only the global `defaultRange` is honored).
 *  - Watch via Drive push notifications (Phase 4+).
 *  - Write-back to Sheets (read-only RAG).
 *  - Charts / images / conditional formatting metadata.
 *  - Merged cells: the API returns merged values only in the top-left cell
 *    (other merged cells come back as empty / undefined). We don't
 *    re-expand the merge — the CSV faithfully reflects the API response,
 *    which matches what `gdrive`'s CSV export does too.
 */
export class GSheetsConnector implements DocumentSourceConnector {
  readonly type: RagSourceType = 'gsheets';

  /** LRU of `clientCacheKey → { jwt, sheets, drive }`. Same shape as gdrive. */
  #clientCache = new Map<string, { jwt: JWT; sheets: sheets_v4.Sheets; drive: drive_v3.Drive }>();

  static readonly MAX_CACHED_CLIENTS = 16;

  /** LRU of `spreadsheetId → SpreadsheetMeta`. Keeps title + tab list hot. */
  #metaCache = new Map<string, SpreadsheetMeta>();

  static readonly MAX_SPREADSHEET_META = 32;

  /**
   * Optional rate limiter wired by the host. Sheets and Drive share the
   * `gsheets` bucket since one sync job hits both APIs in tandem — keeping
   * them in one bucket avoids double-throttling against the same upstream
   * quota (Google's per-project request cap is global, not per-API).
   */
  #rateLimiter: RateLimiterLike | undefined;

  setRateLimiter(limiter: RateLimiterLike | undefined): void {
    this.#rateLimiter = limiter;
  }

  async #acquireToken(config: GSheetsConfig): Promise<void> {
    if (!this.#rateLimiter) return;
    await this.#rateLimiter.acquire('gsheets', clientCacheKey(config));
  }

  /** Test-only accessor exposing the current client-cache size. */
  __cacheSizeForTests(): number {
    return this.#clientCache.size;
  }

  /** Test-only accessor exposing the current meta-cache size. */
  __metaCacheSizeForTests(): number {
    return this.#metaCache.size;
  }

  async testConnection(rawConfig: DocumentSourceConfig): Promise<void> {
    const config = narrowConfig(rawConfig);
    const { sheets, drive } = this.#getClient(config);
    const serviceEmail =
      ((config.serviceAccountKey as Record<string, unknown>).client_email as string) ?? '';

    // Prefer the IDs mode when both are set — it's cheaper (one Sheets call)
    // than enumerating a folder. Fall back to verifying the folder exists.
    const probeId = config.spreadsheetIds?.[0];
    if (probeId) {
      try {
        await this.#acquireToken(config);
        await sheets.spreadsheets.get({
          spreadsheetId: probeId,
          fields: 'spreadsheetId,properties.title',
        });
        return;
      } catch (err: unknown) {
        throw mapTestConnectionError(err, serviceEmail, probeId, 'spreadsheet');
      }
    }

    const folderId = config.driveFolderId;
    if (!folderId) {
      // narrowConfig already enforces at-least-one, so this is defensive.
      throw new Error(
        'GSheetsConnector: neither `spreadsheetIds` nor `driveFolderId` is set',
      );
    }
    let resp: { data?: drive_v3.Schema$File };
    try {
      await this.#acquireToken(config);
      resp = (await drive.files.get({
        fileId: folderId,
        fields: 'id, name, mimeType',
        supportsAllDrives: true,
      })) as { data?: drive_v3.Schema$File };
    } catch (err: unknown) {
      throw mapTestConnectionError(err, serviceEmail, folderId, 'folder');
    }
    const file = resp.data ?? {};
    if (file.mimeType !== 'application/vnd.google-apps.folder') {
      throw new Error(
        `GSheets: id "${folderId}" is not a folder ` +
          `(mimeType: ${file.mimeType ?? 'unknown'}). Configure a folder id, not a file id.`,
      );
    }
  }

  async listFolders(
    rawConfig: DocumentSourceConfig,
    sourceId: string,
    parent?: RagFolder,
  ): Promise<RagFolder[]> {
    // Spreadsheets surface as the leaf "folders" of this source. There is no
    // sub-folder concept inside a spreadsheet (the next level down is tabs,
    // which are documents). So when a parent is supplied we always return
    // an empty list.
    if (parent) return [];

    const config = narrowConfig(rawConfig);
    const { sheets, drive } = this.#getClient(config);

    const seen = new Set<string>();
    const folders: RagFolder[] = [];

    // 1) Explicit spreadsheet IDs.
    if (config.spreadsheetIds && config.spreadsheetIds.length > 0) {
      for (const ssid of config.spreadsheetIds) {
        if (seen.has(ssid)) continue;
        seen.add(ssid);
        // Fetch title + tab metadata once and cache it — listDocuments will
        // re-use the entry to avoid a second roundtrip per spreadsheet.
        let title = ssid;
        let modifiedTime: string | null = null;
        try {
          await this.#acquireToken(config);
          const ssResp = await sheets.spreadsheets.get({
            spreadsheetId: ssid,
            fields: 'spreadsheetId,properties.title,sheets.properties',
          });
          const data = (ssResp as { data?: sheets_v4.Schema$Spreadsheet }).data ?? {};
          if (typeof data.properties?.title === 'string') {
            title = data.properties.title;
          }
          const sheetTitles = new Map<number, string>();
          for (const s of data.sheets ?? []) {
            const sp = s.properties ?? {};
            if (typeof sp.sheetId === 'number' && typeof sp.title === 'string') {
              sheetTitles.set(sp.sheetId, sp.title);
            }
          }
          // Drive `modifiedTime` is on the Drive file, not the spreadsheet
          // resource. Fetch it lazily; tolerate 403 (admin restricted Drive
          // scope) by leaving etag null.
          try {
            await this.#acquireToken(config);
            const fileResp = await drive.files.get({
              fileId: ssid,
              fields: 'modifiedTime',
              supportsAllDrives: true,
            });
            const md = (fileResp as { data?: drive_v3.Schema$File }).data ?? {};
            if (typeof md.modifiedTime === 'string') modifiedTime = md.modifiedTime;
          } catch {
            // Best-effort — surface the spreadsheet without an etag.
          }
          this.#rememberMeta(ssid, { title, modifiedTime, sheetTitles });
        } catch (err: unknown) {
          // A single missing / forbidden id shouldn't sink the whole listing.
          // Skip it — the next sync pass will retry. The host's audit log
          // captures the error via the surrounding job machinery.
          const sdkErr = asSdkError(err);
          if (readErrorStatus(sdkErr) === 404) continue;
          throw err;
        }
        folders.push({
          id: encodeFolderId(ssid),
          sourceId,
          parentId: null,
          path: title,
          name: title,
          createdAt: '',
        });
      }
    }

    // 2) Drive folder enumeration.
    if (config.driveFolderId) {
      let files: drive_v3.Schema$File[];
      try {
        files = await listSpreadsheetsInFolder(drive, config.driveFolderId, () =>
          this.#acquireToken(config),
        );
      } catch (err: unknown) {
        const serviceEmail =
          ((config.serviceAccountKey as Record<string, unknown>).client_email as string) ?? '';
        throw mapTestConnectionError(
          err,
          serviceEmail,
          config.driveFolderId,
          'folder',
        );
      }
      for (const f of files) {
        if (typeof f.id !== 'string' || typeof f.name !== 'string') continue;
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        const modifiedTime = typeof f.modifiedTime === 'string' ? f.modifiedTime : null;
        // Don't prefetch tab metadata here — it would cost one extra round-
        // trip per spreadsheet at list time. Defer to listDocuments.
        this.#rememberMeta(f.id, {
          title: f.name,
          modifiedTime,
          sheetTitles: new Map(),
        });
        folders.push({
          id: encodeFolderId(f.id),
          sourceId,
          parentId: null,
          path: f.name,
          name: f.name,
          createdAt: typeof f.createdTime === 'string' ? f.createdTime : '',
        });
      }
    }

    return folders;
  }

  async listDocuments(
    rawConfig: DocumentSourceConfig,
    sourceId: string,
    folder?: RagFolder,
  ): Promise<RagDocument[]> {
    if (!folder) {
      // Root-level documents are not supported — every spreadsheet is its
      // own folder. The host iterates per folder, so this branch only
      // matters for tests that call listDocuments without a parent.
      return [];
    }
    const config = narrowConfig(rawConfig);
    const spreadsheetId = decodeFolderId(folder.id);
    const { sheets, drive } = this.#getClient(config);

    // Cache hit? Use the stored tabs. Otherwise, fetch + cache.
    let meta = this.#metaCache.get(spreadsheetId);
    if (!meta || meta.sheetTitles.size === 0) {
      try {
        await this.#acquireToken(config);
        const resp = await sheets.spreadsheets.get({
          spreadsheetId,
          fields: 'spreadsheetId,properties.title,sheets.properties',
        });
        const data = (resp as { data?: sheets_v4.Schema$Spreadsheet }).data ?? {};
        const title =
          typeof data.properties?.title === 'string'
            ? data.properties.title
            : (meta?.title ?? spreadsheetId);
        const sheetTitles = new Map<number, string>();
        for (const s of data.sheets ?? []) {
          const sp = s.properties ?? {};
          if (typeof sp.sheetId === 'number' && typeof sp.title === 'string') {
            sheetTitles.set(sp.sheetId, sp.title);
          }
        }
        let modifiedTime = meta?.modifiedTime ?? null;
        if (modifiedTime === null) {
          try {
            await this.#acquireToken(config);
            const fileResp = await drive.files.get({
              fileId: spreadsheetId,
              fields: 'modifiedTime',
              supportsAllDrives: true,
            });
            const md = (fileResp as { data?: drive_v3.Schema$File }).data ?? {};
            if (typeof md.modifiedTime === 'string') modifiedTime = md.modifiedTime;
          } catch {
            // Best-effort.
          }
        }
        meta = { title, modifiedTime, sheetTitles };
        this.#rememberMeta(spreadsheetId, meta);
      } catch (err: unknown) {
        const sdkErr = asSdkError(err);
        if (readErrorStatus(sdkErr) === 404) {
          throw new GSheetsDocumentNotFoundError(folder.id);
        }
        throw err;
      }
    }

    const docs: RagDocument[] = [];
    for (const [sheetId, sheetTitle] of meta.sheetTitles) {
      if (!config.includeArchived && isArchivedSheetTitle(sheetTitle)) continue;
      const docPath = `${meta.title}/${sheetTitle}`;
      docs.push({
        id: encodeDocId(spreadsheetId, sheetId),
        sourceId,
        folderId: folder.id,
        path: docPath,
        name: sheetTitle,
        mimeType: 'text/csv',
        // Size is unknown without fetching the tab's contents. 0 signals
        // "indeterminate" — the pipeline still streams the document and
        // computes the real size at ingest time.
        size: 0,
        hash: '',
        etag: meta.modifiedTime,
        lastIndexedAt: '',
        deletedAt: null,
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
    const { spreadsheetId, sheetId } = decodeDocId(docId);
    const { sheets, drive } = this.#getClient(config);

    // Resolve the sheet title (and refresh meta on cache miss).
    let meta = this.#metaCache.get(spreadsheetId);
    if (!meta || !meta.sheetTitles.has(sheetId)) {
      try {
        await this.#acquireToken(config);
        const resp = await sheets.spreadsheets.get({
          spreadsheetId,
          fields: 'spreadsheetId,properties.title,sheets.properties',
        });
        const data = (resp as { data?: sheets_v4.Schema$Spreadsheet }).data ?? {};
        const title =
          typeof data.properties?.title === 'string'
            ? data.properties.title
            : (meta?.title ?? spreadsheetId);
        const sheetTitles = new Map<number, string>();
        for (const s of data.sheets ?? []) {
          const sp = s.properties ?? {};
          if (typeof sp.sheetId === 'number' && typeof sp.title === 'string') {
            sheetTitles.set(sp.sheetId, sp.title);
          }
        }
        let modifiedTime = meta?.modifiedTime ?? null;
        if (modifiedTime === null) {
          try {
            await this.#acquireToken(config);
            const fileResp = await drive.files.get({
              fileId: spreadsheetId,
              fields: 'modifiedTime',
              supportsAllDrives: true,
            });
            const md = (fileResp as { data?: drive_v3.Schema$File }).data ?? {};
            if (typeof md.modifiedTime === 'string') modifiedTime = md.modifiedTime;
          } catch {
            // Best-effort.
          }
        }
        meta = { title, modifiedTime, sheetTitles };
        this.#rememberMeta(spreadsheetId, meta);
      } catch (err: unknown) {
        const sdkErr = asSdkError(err);
        if (readErrorStatus(sdkErr) === 404) {
          throw new GSheetsDocumentNotFoundError(docId);
        }
        throw err;
      }
    }
    const sheetTitle = meta.sheetTitles.get(sheetId);
    if (typeof sheetTitle !== 'string') {
      throw new GSheetsDocumentNotFoundError(docId);
    }

    // Build the A1 range. `defaultRange` is range-only (`'A1:D100'`); we
    // prefix the (quoted) sheet title. When absent, default to `A:ZZ` —
    // wide enough for any sane workbook and only fetches the used range.
    const rangeBody =
      typeof config.defaultRange === 'string' && config.defaultRange.length > 0
        ? config.defaultRange
        : 'A:ZZ';
    const range = `${quoteSheetTitle(sheetTitle)}!${rangeBody}`;

    let values: unknown[][];
    try {
      await this.#acquireToken(config);
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
        // 'FORMATTED_VALUE' keeps what the user sees (formula → result).
        valueRenderOption: 'FORMATTED_VALUE',
        dateTimeRenderOption: 'FORMATTED_STRING',
      });
      const data = (resp as { data?: sheets_v4.Schema$ValueRange }).data ?? {};
      values = Array.isArray(data.values) ? (data.values as unknown[][]) : [];
    } catch (err: unknown) {
      const sdkErr = asSdkError(err);
      if (readErrorStatus(sdkErr) === 404) {
        throw new GSheetsDocumentNotFoundError(docId);
      }
      throw err;
    }

    const csv = valuesToCsv(values);
    return {
      stream: Readable.from([Buffer.from(csv, 'utf8')]),
      mimeType: 'text/csv',
    };
  }

  // -- helpers --------------------------------------------------------------

  #rememberMeta(spreadsheetId: string, meta: SpreadsheetMeta): void {
    // Refresh LRU position.
    if (this.#metaCache.has(spreadsheetId)) {
      this.#metaCache.delete(spreadsheetId);
    } else if (this.#metaCache.size >= GSheetsConnector.MAX_SPREADSHEET_META) {
      const oldest = this.#metaCache.keys().next().value;
      if (oldest !== undefined) this.#metaCache.delete(oldest);
    }
    this.#metaCache.set(spreadsheetId, meta);
  }

  #getClient(config: GSheetsConfig): {
    jwt: JWT;
    sheets: sheets_v4.Sheets;
    drive: drive_v3.Drive;
  } {
    const cacheKey = clientCacheKey(config);
    const cached = this.#clientCache.get(cacheKey);
    if (cached) {
      this.#clientCache.delete(cacheKey);
      this.#clientCache.set(cacheKey, cached);
      return cached;
    }

    if (this.#clientCache.size >= GSheetsConnector.MAX_CACHED_CLIENTS) {
      const oldestKey = this.#clientCache.keys().next().value;
      if (oldestKey !== undefined) {
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
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets.readonly',
        'https://www.googleapis.com/auth/drive.readonly',
      ],
      subject: config.impersonateAs,
    });
    const sheetsApi = google.sheets({ version: 'v4', auth: jwt });
    const driveApi = google.drive({ version: 'v3', auth: jwt });
    const entry = { jwt, sheets: sheetsApi, drive: driveApi };
    this.#clientCache.set(cacheKey, entry);
    return entry;
  }
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __testing = {
  encodeDocId,
  decodeDocId,
  encodeFolderId,
  decodeFolderId,
  narrowConfig,
  clientCacheKey,
  mapTestConnectionError,
  valuesToCsv,
  quoteSheetTitle,
  isArchivedSheetTitle,
  getClientCacheSize(connector: GSheetsConnector): number {
    return connector.__cacheSizeForTests();
  },
  getMetaCacheSize(connector: GSheetsConnector): number {
    return connector.__metaCacheSizeForTests();
  },
};
