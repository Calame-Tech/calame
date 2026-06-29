// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { Client, APIResponseError, APIErrorCode } from '@notionhq/client';

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
 * Configuration for `NotionConnector`. Stored encrypted by the host.
 *
 * The connector authenticates as a Notion Internal Integration (no OAuth flow).
 * The admin must:
 *   1. Go to https://www.notion.so/profile/integrations → "New integration"
 *   2. Copy the secret (starts with `secret_` or `ntn_`)
 *   3. In each page or database to index, click "Share" → invite the integration
 *
 * Notion has no Drive-style "list everything I own" endpoint — the integration
 * only sees content explicitly shared with it. `rootIds` is therefore optional:
 * leave empty to index ALL shared content (returned by the `search` endpoint),
 * or provide explicit page / database IDs to restrict the scope.
 */
export interface NotionConfig {
  /** Internal integration token from notion.so/profile/integrations (`secret_…` or `ntn_…`). */
  apiKey: string;
  /**
   * Optional. List of page or database IDs to use as roots. If omitted, the
   * connector indexes ALL pages/databases shared with the integration (the
   * `search` endpoint returns them).
   *
   * Page IDs are 32 hex chars; Notion's UI shows them dash-separated
   * (8-4-4-4-12). `narrowConfig` accepts either form and re-normalizes.
   */
  rootIds?: string[];
  /** Include archived (trashed) pages? Default false. */
  includeArchived?: boolean;
  /**
   * Maximum block recursion depth when fetching a page's content. Default 5.
   * Notion can have arbitrarily deep toggle / sub-page nesting; capping
   * protects against runaway fetches.
   */
  maxBlockDepth?: number;
}

/**
 * Notion ID format. Both forms below resolve to the same page; we normalize to
 * the 32-char lowercase hex form internally and re-add hyphens when calling
 * the API (the SDK accepts both, but the dashed form is what Notion documents).
 */
const NOTION_ID_HEX_LEN = 32;

/**
 * Strip dashes / whitespace and lowercase a Notion id. Returns the empty
 * string when the input is not a valid 32-hex-char id (caller decides what
 * to do — `narrowConfig` throws; lookups treat empty as "not found").
 */
export function normalizeId(raw: string): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().toLowerCase().replace(/-/g, '');
  if (trimmed.length !== NOTION_ID_HEX_LEN) return '';
  if (!/^[0-9a-f]+$/.test(trimmed)) return '';
  return trimmed;
}

/**
 * Re-add hyphens to a normalized 32-hex-char id, producing the canonical
 * 8-4-4-4-12 dashed form that Notion's API and URLs use. Returns the input
 * unchanged when it isn't a valid normalized id (defensive).
 */
export function denormalizeId(id: string): string {
  if (id.length !== NOTION_ID_HEX_LEN || !/^[0-9a-f]+$/.test(id)) return id;
  return (
    id.slice(0, 8) +
    '-' +
    id.slice(8, 12) +
    '-' +
    id.slice(12, 16) +
    '-' +
    id.slice(16, 20) +
    '-' +
    id.slice(20)
  );
}

/**
 * Narrow the opaque `DocumentSourceConfig` to the shape this connector
 * understands. Throws a clear error if the config is malformed.
 */
export function narrowConfig(config: DocumentSourceConfig): NotionConfig {
  const apiKey = config.apiKey;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error('NotionConnector requires a non-empty `apiKey` string in config');
  }
  if (!apiKey.startsWith('secret_') && !apiKey.startsWith('ntn_')) {
    throw new Error(
      'NotionConnector: `apiKey` must start with `secret_` or `ntn_` (Notion internal integration token).',
    );
  }

  let rootIds: string[] | undefined;
  if (config.rootIds !== undefined) {
    if (!Array.isArray(config.rootIds)) {
      throw new Error('NotionConnector: `rootIds` must be an array of strings when provided');
    }
    rootIds = [];
    for (const raw of config.rootIds) {
      if (typeof raw !== 'string') {
        throw new Error('NotionConnector: `rootIds` must contain only strings');
      }
      const normalized = normalizeId(raw);
      if (!normalized) {
        throw new Error(
          `NotionConnector: invalid Notion id in rootIds: "${raw}" (expected 32 hex chars, with or without hyphens)`,
        );
      }
      rootIds.push(normalized);
    }
  }

  const includeArchived = config.includeArchived;
  if (includeArchived !== undefined && typeof includeArchived !== 'boolean') {
    throw new Error('NotionConnector: `includeArchived` must be a boolean when provided');
  }

  const maxBlockDepth = config.maxBlockDepth;
  if (maxBlockDepth !== undefined) {
    if (typeof maxBlockDepth !== 'number' || !Number.isFinite(maxBlockDepth) || maxBlockDepth < 0) {
      throw new Error('NotionConnector: `maxBlockDepth` must be a non-negative number');
    }
  }

  return {
    apiKey,
    rootIds,
    includeArchived: includeArchived === true,
    maxBlockDepth: typeof maxBlockDepth === 'number' ? maxBlockDepth : 5,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised by `fetchDocument` when the supplied `docId` cannot be resolved. */
export class NotionDocumentNotFoundError extends Error {
  constructor(docId: string) {
    super(`Document "${docId}" not found in Notion source`);
    this.name = 'NotionDocumentNotFoundError';
  }
}

/** Raised by `testConnection` (and other methods) on HTTP 401. */
export class NotionAuthError extends Error {
  constructor(message = 'Invalid Notion API key') {
    super(message);
    this.name = 'NotionAuthError';
  }
}

/** Raised when Notion returns HTTP 429. Notion's published cap is ~3 req/sec. */
export class NotionRateLimitError extends Error {
  constructor(message = 'Notion API rate limit exceeded (3 req/sec)') {
    super(message);
    this.name = 'NotionRateLimitError';
  }
}

// ---------------------------------------------------------------------------
// Doc id encoding
//
// Notion page IDs are already short, opaque hex strings, so we just prefix
// them with `notion:` for source-type disambiguation. No base64 needed.
// ---------------------------------------------------------------------------

const DOC_ID_PREFIX = 'notion:';

export function encodeDocId(pageId: string): string {
  const normalized = normalizeId(pageId);
  return `${DOC_ID_PREFIX}${normalized || pageId}`;
}

export function decodeDocId(docId: string): string {
  if (!docId.startsWith(DOC_ID_PREFIX)) {
    throw new NotionDocumentNotFoundError(docId);
  }
  const id = docId.slice(DOC_ID_PREFIX.length);
  if (id.length === 0) {
    throw new NotionDocumentNotFoundError(docId);
  }
  return id;
}

// Folder IDs (which represent Notion databases in our mapping) use a
// dedicated prefix so the host can distinguish docs from folders later.
const FOLDER_ID_PREFIX = 'notion:db:';

function encodeFolderId(dbId: string): string {
  const normalized = normalizeId(dbId);
  return `${FOLDER_ID_PREFIX}${normalized || dbId}`;
}

function decodeFolderId(folderId: string): string {
  if (!folderId.startsWith(FOLDER_ID_PREFIX)) return '';
  return folderId.slice(FOLDER_ID_PREFIX.length);
}

// ---------------------------------------------------------------------------
// Notion SDK error shape
// ---------------------------------------------------------------------------

/**
 * Read the HTTP status off a Notion SDK error. The SDK exposes `status` on
 * `APIResponseError`; we also fall back to common alternative shapes used by
 * test mocks (`code`, `response.status`).
 */
function readErrorStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const e = err as {
      status?: number;
      code?: number | string;
      response?: { status?: number };
    };
    if (typeof e.status === 'number') return e.status;
    if (typeof e.code === 'number') return e.code;
    if (e.response && typeof e.response.status === 'number') return e.response.status;
  }
  return undefined;
}

/**
 * Translate a generic Notion SDK error into one of our typed errors.
 * Returns the input unchanged when no mapping applies.
 */
function mapNotionError(err: unknown, docId?: string): Error {
  const status = readErrorStatus(err);
  if (status === 401) return new NotionAuthError();
  if (status === 429) return new NotionRateLimitError();
  if (status === 404) {
    return new NotionDocumentNotFoundError(docId ?? 'unknown');
  }
  // APIResponseError carries the error code in the body — try to surface it.
  if (err instanceof APIResponseError) {
    if (err.code === APIErrorCode.Unauthorized) return new NotionAuthError(err.message);
    if (err.code === APIErrorCode.RateLimited) return new NotionRateLimitError(err.message);
    if (err.code === APIErrorCode.ObjectNotFound) {
      return new NotionDocumentNotFoundError(docId ?? 'unknown');
    }
  }
  if (err instanceof Error) return err;
  return new Error(String(err));
}

// ---------------------------------------------------------------------------
// Rich text → markdown
// ---------------------------------------------------------------------------

/**
 * A subset of the `RichTextItemResponse` shape we care about. The SDK exports
 * a full union, but we only ever read `plain_text` and `annotations` — typing
 * defensively keeps tests easy to write without dragging the entire response
 * type along.
 */
interface RichTextLike {
  plain_text: string;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
  };
}

/**
 * Render a rich text array to markdown, preserving bold / italic / code /
 * strikethrough. Notion combines annotations on a single span; we wrap once
 * (bold > italic > code), which is the standard CommonMark precedence.
 */
function renderRichText(rt: ReadonlyArray<RichTextLike> | undefined): string {
  if (!rt || rt.length === 0) return '';
  let out = '';
  for (const span of rt) {
    let text = span.plain_text;
    if (!text) continue;
    const a = span.annotations ?? {};
    if (a.code) text = '`' + text + '`';
    if (a.bold) text = '**' + text + '**';
    if (a.italic) text = '*' + text + '*';
    if (a.strikethrough) text = '~~' + text + '~~';
    out += text;
  }
  return out;
}

/**
 * Extract a plain-string title from the `properties` map of a page. Pages in a
 * database have one `type === 'title'` property (named after the schema column);
 * standalone pages always have a property named `title`. We scan for either.
 *
 * Returns `'Untitled'` when no title text is found — Notion lets users save
 * pages with empty titles, and we don't want empty `name` fields downstream.
 */
export function pageTitle(page: unknown): string {
  if (!page || typeof page !== 'object') return 'Untitled';
  const props = (page as { properties?: Record<string, unknown> }).properties;
  if (!props || typeof props !== 'object') return 'Untitled';
  for (const value of Object.values(props)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as { type?: string; title?: unknown };
    if (v.type === 'title' && Array.isArray(v.title)) {
      const text = renderRichText(v.title as RichTextLike[]);
      const trimmed = text.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return 'Untitled';
}

/**
 * Block with children — Notion's recursive shape. We attach a synthetic
 * `_children` array during fetch so `renderBlocksToText` can render without
 * making additional API calls.
 */
export interface BlockWithChildren {
  id: string;
  type: string;
  has_children?: boolean;
  _children?: BlockWithChildren[];
  // Block-specific payload shape varies by `type` — we type loosely and
  // narrow at render time.
  [key: string]: unknown;
}

/**
 * Render a block hierarchy to markdown. The block types covered:
 *   - paragraph, heading_1/2/3
 *   - bulleted_list_item, numbered_list_item (with nesting)
 *   - code (fenced, language preserved)
 *   - toggle (renders summary + recurses into children)
 *   - quote (`> `)
 *   - divider (`---`)
 *   - image, file (as a `[Image: <caption-or-url>]` mention)
 *   - child_page, child_database (mention only — they're separate
 *     RagDocuments / RagFolders, so we don't recurse into them here).
 *
 * Any block type not listed above is silently skipped — Notion ships new
 * block types constantly and we don't want a single unknown block to break
 * a whole page render. Callers needing to debug skipped blocks should pass
 * the page to a richer renderer (out of scope for the MVP).
 */
export function renderBlocksToText(blocks: BlockWithChildren[], depth = 0): string {
  const out: string[] = [];
  const indent = '  '.repeat(depth);
  for (const block of blocks) {
    const rendered = renderOneBlock(block, depth, indent);
    if (rendered !== null) out.push(rendered);
  }
  return out.join('\n');
}

function renderOneBlock(block: BlockWithChildren, depth: number, indent: string): string | null {
  const t = block.type;
  switch (t) {
    case 'paragraph': {
      const p = (block as { paragraph?: { rich_text?: RichTextLike[] } }).paragraph;
      const txt = renderRichText(p?.rich_text);
      const childTxt = renderChildrenIfAny(block, depth);
      return childTxt ? `${indent}${txt}\n${childTxt}` : `${indent}${txt}`;
    }
    case 'heading_1': {
      const h = (block as { heading_1?: { rich_text?: RichTextLike[] } }).heading_1;
      return `${indent}# ${renderRichText(h?.rich_text)}`;
    }
    case 'heading_2': {
      const h = (block as { heading_2?: { rich_text?: RichTextLike[] } }).heading_2;
      return `${indent}## ${renderRichText(h?.rich_text)}`;
    }
    case 'heading_3': {
      const h = (block as { heading_3?: { rich_text?: RichTextLike[] } }).heading_3;
      return `${indent}### ${renderRichText(h?.rich_text)}`;
    }
    case 'bulleted_list_item': {
      const b = (block as { bulleted_list_item?: { rich_text?: RichTextLike[] } })
        .bulleted_list_item;
      const txt = `${indent}- ${renderRichText(b?.rich_text)}`;
      const childTxt = renderChildrenIfAny(block, depth);
      return childTxt ? `${txt}\n${childTxt}` : txt;
    }
    case 'numbered_list_item': {
      const n = (block as { numbered_list_item?: { rich_text?: RichTextLike[] } })
        .numbered_list_item;
      // Notion doesn't expose the index — `1.` is fine, most markdown renderers
      // auto-number sibling `1.` items.
      const txt = `${indent}1. ${renderRichText(n?.rich_text)}`;
      const childTxt = renderChildrenIfAny(block, depth);
      return childTxt ? `${txt}\n${childTxt}` : txt;
    }
    case 'code': {
      const c = (block as { code?: { rich_text?: RichTextLike[]; language?: string } }).code;
      const lang = c?.language ?? '';
      // For code blocks we want the raw plain_text without annotation markup.
      const code = (c?.rich_text ?? []).map((s) => s.plain_text).join('');
      return `${indent}\`\`\`${lang}\n${code}\n${indent}\`\`\``;
    }
    case 'toggle': {
      const tg = (block as { toggle?: { rich_text?: RichTextLike[] } }).toggle;
      const summary = renderRichText(tg?.rich_text);
      const childTxt = renderChildrenIfAny(block, depth);
      return childTxt ? `${indent}${summary}\n${childTxt}` : `${indent}${summary}`;
    }
    case 'quote': {
      const q = (block as { quote?: { rich_text?: RichTextLike[] } }).quote;
      return `${indent}> ${renderRichText(q?.rich_text)}`;
    }
    case 'divider':
      return `${indent}---`;
    case 'callout': {
      const c = (block as { callout?: { rich_text?: RichTextLike[] } }).callout;
      // Treat callouts like a quoted paragraph — they're paragraph-shaped.
      return `${indent}> ${renderRichText(c?.rich_text)}`;
    }
    case 'child_page': {
      const cp = (block as { child_page?: { title?: string } }).child_page;
      const title = cp?.title ?? 'Untitled';
      return `${indent}→ Sub-page: ${title}`;
    }
    case 'child_database': {
      const cd = (block as { child_database?: { title?: string } }).child_database;
      const title = cd?.title ?? 'Untitled';
      return `${indent}→ Database: ${title}`;
    }
    case 'image': {
      const img = (
        block as {
          image?: {
            type?: string;
            external?: { url?: string };
            file?: { url?: string };
            caption?: RichTextLike[];
          };
        }
      ).image;
      const caption = renderRichText(img?.caption).trim();
      const url =
        img?.type === 'external'
          ? img?.external?.url
          : img?.type === 'file'
            ? img?.file?.url
            : undefined;
      const label = caption || url || 'image';
      return `${indent}[Image: ${label}]`;
    }
    case 'file':
    case 'pdf':
    case 'video':
    case 'audio': {
      const m = block as {
        [key: string]: {
          type?: string;
          external?: { url?: string };
          file?: { url?: string };
          caption?: RichTextLike[];
        };
      };
      const payload = m[t];
      const caption = renderRichText(payload?.caption).trim();
      const url =
        payload?.type === 'external'
          ? payload?.external?.url
          : payload?.type === 'file'
            ? payload?.file?.url
            : undefined;
      const label = caption || url || t;
      return `${indent}[${t}: ${label}]`;
    }
    default:
      // Unknown / unsupported block type — silently skip.
      return null;
  }
}

function renderChildrenIfAny(block: BlockWithChildren, depth: number): string {
  if (!block._children || block._children.length === 0) return '';
  return renderBlocksToText(block._children, depth + 1);
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

/**
 * Connector for Notion (Internal Integration token flow).
 *
 * Mapping:
 *   - Notion **database**  → `RagFolder`
 *   - Notion **page**      → `RagDocument` (whether standalone or a database row)
 *   - A page's content     → its block hierarchy rendered to markdown
 *
 * Notion has no Drive-style "browse-everything" API: integrations only see
 * pages and databases that have been explicitly shared with them via the
 * Share button in the UI. `narrowConfig.rootIds` lets the admin restrict the
 * scope further; when empty, the connector calls `search()` to enumerate
 * everything the integration can see.
 *
 * Phase 3+ capabilities:
 *   - `testConnection` calls `users.me({})` — the only endpoint that always
 *     succeeds on an integration with no extra permissions. 401 → typed
 *     `NotionAuthError`.
 *   - `listFolders` returns Notion databases. When `rootIds` is configured we
 *     filter to those; otherwise `search({ filter: object='database' })`.
 *     `parent` is currently unused — Notion databases are flat in this MVP.
 *   - `listDocuments` returns Notion pages. If `folder` is supplied we
 *     `databases.query` (database rows); otherwise we list standalone pages.
 *   - `fetchDocument` walks the page's block hierarchy (capped at
 *     `maxBlockDepth`) and renders to markdown.
 *
 * Hash strategy: Notion has no content hash, so `RagDocument.hash` is left
 * empty (the host pipeline re-streams to compute SHA-256 at index time —
 * parity with S3 / HTTP / GDrive). `etag` is set to `page.last_edited_time`,
 * which is the canonical change signal Notion exposes.
 *
 * Deferred:
 *   - Public OAuth integration flow (Phase 4+) — internal token is sufficient
 *     for MVP single-tenant deployments.
 *   - Webhooks: Notion has no official push API for content changes; the host
 *     `PollScheduler` handles polling.
 *   - Comments and inline database property metadata.
 */
export class NotionConnector implements DocumentSourceConnector {
  readonly type: RagSourceType = 'notion';

  // No client cache yet — Notion's `Client` is cheap to construct (no JWT
  // signing, no token exchange). Adding a cache is a small follow-up if the
  // admin reports load.

  /**
   * Optional rate limiter wired by the host at runtime. Notion's published
   * cap is 3 req/sec averaged with a small burst; we throttle to that by
   * default (see `DEFAULT_LIMITS.notion`). Each SDK call (`users.me`,
   * `databases.query`, `blocks.children.list`, `search`, …) acquires one
   * token from the `('notion', hash(apiKey))` bucket before invoking.
   */
  #rateLimiter: RateLimiterLike | undefined;

  setRateLimiter(limiter: RateLimiterLike | undefined): void {
    this.#rateLimiter = limiter;
  }

  /**
   * Acquire one token scoped to the API key. We hash the key so we don't
   * keep the plaintext credential alive on the bucket map.
   */
  async #acquireToken(apiKey: string): Promise<void> {
    if (!this.#rateLimiter) return;
    const credentialKey = createHash('sha256').update(apiKey).digest('hex').slice(0, 32);
    await this.#rateLimiter.acquire('notion', credentialKey);
  }

  async testConnection(rawConfig: DocumentSourceConfig): Promise<void> {
    const config = narrowConfig(rawConfig);
    const notion = new Client({ auth: config.apiKey });
    try {
      await this.#acquireToken(config.apiKey);
      await notion.users.me({});
    } catch (err: unknown) {
      const status = readErrorStatus(err);
      if (status === 401) {
        throw new NotionAuthError(
          'Notion: invalid API key (HTTP 401). Generate a new integration token at notion.so/profile/integrations.',
        );
      }
      // Network errors aren't HTTP — they surface as plain Error / fetch
      // failures. Surface a useful message either way.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Notion: cannot reach the API: ${msg}`);
    }
  }

  async listFolders(
    rawConfig: DocumentSourceConfig,
    sourceId: string,
    parent?: RagFolder,
  ): Promise<RagFolder[]> {
    // Phase 1 — databases are flat. Future versions may surface
    // `child_database` blocks of a page as nested folders.
    if (parent) return [];

    const config = narrowConfig(rawConfig);
    const notion = new Client({ auth: config.apiKey });

    if (config.rootIds && config.rootIds.length > 0) {
      // Resolve each root id — it could be a page (skip — listed by
      // listDocuments) or a database (becomes a folder).
      const folders: RagFolder[] = [];
      for (const id of config.rootIds) {
        const dashed = denormalizeId(id);
        try {
          await this.#acquireToken(config.apiKey);
          const db = await notion.databases.retrieve({ database_id: dashed });
          if ('title' in db && Array.isArray((db as { title?: unknown }).title)) {
            folders.push(this.#dbToFolder(db, sourceId));
          }
        } catch (err: unknown) {
          // `databases.retrieve` against a page id returns 404 — that's
          // expected and not an error; the id will be picked up by
          // listDocuments instead.
          const status = readErrorStatus(err);
          if (status === 404 || status === 400) continue;
          if (status === 401) throw new NotionAuthError();
          if (status === 429) throw new NotionRateLimitError();
          throw mapNotionError(err);
        }
      }
      return folders;
    }

    // No rootIds → enumerate every database the integration can see.
    const folders: RagFolder[] = [];
    let startCursor: string | undefined;
    do {
      type SearchArgs = {
        filter: { property: 'object'; value: 'database' };
        page_size: number;
        start_cursor?: string;
      };
      const args: SearchArgs = {
        filter: { property: 'object', value: 'database' },
        page_size: 100,
      };
      if (startCursor !== undefined) args.start_cursor = startCursor;
      let resp;
      try {
        await this.#acquireToken(config.apiKey);
        resp = await notion.search(args);
      } catch (err: unknown) {
        throw mapNotionError(err);
      }
      for (const result of resp.results) {
        if ('object' in result && result.object === 'database' && 'title' in result) {
          folders.push(this.#dbToFolder(result, sourceId));
        }
      }
      startCursor = resp.has_more ? (resp.next_cursor ?? undefined) : undefined;
    } while (startCursor);

    return folders;
  }

  async listDocuments(
    rawConfig: DocumentSourceConfig,
    sourceId: string,
    folder?: RagFolder,
  ): Promise<RagDocument[]> {
    const config = narrowConfig(rawConfig);
    const notion = new Client({ auth: config.apiKey });

    // --- Branch 1: a specific folder (= database) was supplied ---
    if (folder) {
      const dbId = decodeFolderId(folder.id);
      if (!dbId) return [];
      const docs: RagDocument[] = [];
      let startCursor: string | undefined;
      do {
        type QueryArgs = {
          database_id: string;
          page_size: number;
          archived?: boolean;
          start_cursor?: string;
        };
        const args: QueryArgs = {
          database_id: denormalizeId(dbId),
          page_size: 100,
        };
        // Notion's API treats `archived: true` as "include archived rows",
        // false as "live rows only". We pass `false` to skip trashed pages.
        // The query response still surfaces `archived: true` on individual
        // rows when applicable, so we double-check below.
        if (!config.includeArchived) args.archived = false;
        if (startCursor !== undefined) args.start_cursor = startCursor;
        let resp;
        try {
          await this.#acquireToken(config.apiKey);
          resp = await notion.databases.query(args);
        } catch (err: unknown) {
          throw mapNotionError(err);
        }
        for (const row of resp.results) {
          if (!isPageResult(row)) continue;
          if (row.archived && !config.includeArchived) continue;
          docs.push(this.#pageToDocument(row, sourceId, folder));
        }
        startCursor = resp.has_more ? (resp.next_cursor ?? undefined) : undefined;
      } while (startCursor);
      return docs;
    }

    // --- Branch 2: no folder, rootIds given → list explicit pages only ---
    if (config.rootIds && config.rootIds.length > 0) {
      const docs: RagDocument[] = [];
      for (const id of config.rootIds) {
        const dashed = denormalizeId(id);
        try {
          await this.#acquireToken(config.apiKey);
          const page = await notion.pages.retrieve({ page_id: dashed });
          if (!isPageResult(page)) continue;
          if (page.archived && !config.includeArchived) continue;
          docs.push(this.#pageToDocument(page, sourceId, undefined));
        } catch (err: unknown) {
          // Database ids get caught here too (pages.retrieve on a DB id
          // throws 404 / object_not_found). They'll be picked up as folders
          // by listFolders — silent skip is correct.
          const status = readErrorStatus(err);
          if (status === 404 || status === 400) continue;
          if (status === 401) throw new NotionAuthError();
          if (status === 429) throw new NotionRateLimitError();
          throw mapNotionError(err);
        }
      }
      return docs;
    }

    // --- Branch 3: no folder, no rootIds → search all visible pages ---
    const docs: RagDocument[] = [];
    let startCursor: string | undefined;
    do {
      type SearchArgs = {
        filter: { property: 'object'; value: 'page' };
        page_size: number;
        start_cursor?: string;
      };
      const args: SearchArgs = {
        filter: { property: 'object', value: 'page' },
        page_size: 100,
      };
      if (startCursor !== undefined) args.start_cursor = startCursor;
      let resp;
      try {
        await this.#acquireToken(config.apiKey);
        resp = await notion.search(args);
      } catch (err: unknown) {
        throw mapNotionError(err);
      }
      for (const result of resp.results) {
        if (!isPageResult(result)) continue;
        if (result.archived && !config.includeArchived) continue;
        // Pages that live inside a database show up here too; we still
        // index them, but their `folderId` resolution lives with the
        // host (we don't have the database's RagFolder.id reachable
        // from search results, so we list them at the source root).
        docs.push(this.#pageToDocument(result, sourceId, undefined));
      }
      startCursor = resp.has_more ? (resp.next_cursor ?? undefined) : undefined;
    } while (startCursor);

    return docs;
  }

  async fetchDocument(
    rawConfig: DocumentSourceConfig,
    _sourceId: string,
    docId: string,
  ): Promise<{ stream: Readable; mimeType: string }> {
    const config = narrowConfig(rawConfig);
    const notion = new Client({ auth: config.apiKey });
    const rawPageId = decodeDocId(docId);
    const pageId = denormalizeId(rawPageId);

    let blocks: BlockWithChildren[];
    try {
      blocks = await this.#fetchBlockTree(
        notion,
        pageId,
        0,
        config.maxBlockDepth ?? 5,
        config.apiKey,
      );
    } catch (err: unknown) {
      throw mapNotionError(err, docId);
    }

    const markdown = renderBlocksToText(blocks);
    const buffer = Buffer.from(markdown, 'utf8');
    return { stream: Readable.from([buffer]), mimeType: 'text/markdown' };
  }

  // -- helpers --------------------------------------------------------------

  /**
   * Recursively fetch a page's block tree. `currentDepth` is the depth of the
   * node whose children we're about to fetch; we stop recursing when it
   * reaches `maxDepth`. Pagination is handled per level.
   */
  async #fetchBlockTree(
    notion: Client,
    blockId: string,
    currentDepth: number,
    maxDepth: number,
    apiKey: string,
  ): Promise<BlockWithChildren[]> {
    const collected: BlockWithChildren[] = [];
    let startCursor: string | undefined;
    do {
      type ListArgs = { block_id: string; page_size: number; start_cursor?: string };
      const args: ListArgs = { block_id: blockId, page_size: 100 };
      if (startCursor !== undefined) args.start_cursor = startCursor;
      await this.#acquireToken(apiKey);
      const resp = await notion.blocks.children.list(args);
      for (const raw of resp.results) {
        // PartialBlockObjectResponse only has `id` / `object` — skip those:
        // we have no way to render them. The full responses carry `type`.
        if (!('type' in raw)) continue;
        const block = raw as BlockWithChildren;
        // Recurse if the block has children AND we haven't capped out.
        if (block.has_children && currentDepth + 1 < maxDepth) {
          // child_page / child_database have children too (the entire page
          // tree under them), but they're separate RagDocuments / RagFolders —
          // recursing here would double-index. Skip explicitly.
          if (block.type === 'child_page' || block.type === 'child_database') {
            collected.push(block);
            continue;
          }
          block._children = await this.#fetchBlockTree(
            notion,
            block.id,
            currentDepth + 1,
            maxDepth,
            apiKey,
          );
        }
        collected.push(block);
      }
      startCursor = resp.has_more ? (resp.next_cursor ?? undefined) : undefined;
    } while (startCursor);
    return collected;
  }

  #dbToFolder(db: unknown, sourceId: string): RagFolder {
    const d = db as {
      id: string;
      title?: RichTextLike[];
      created_time?: string;
    };
    const title = renderRichText(d.title).trim() || 'Untitled';
    return {
      id: encodeFolderId(d.id),
      sourceId,
      parentId: null,
      path: title,
      name: title,
      createdAt: typeof d.created_time === 'string' ? d.created_time : '',
    };
  }

  #pageToDocument(page: unknown, sourceId: string, folder?: RagFolder): RagDocument {
    const p = page as {
      id: string;
      archived?: boolean;
      last_edited_time?: string;
    };
    const title = pageTitle(page);
    const folderPath = folder?.path;
    const path =
      typeof folderPath === 'string' && folderPath.length > 0 ? `${folderPath}/${title}` : title;
    const etag = typeof p.last_edited_time === 'string' ? p.last_edited_time : null;
    const deletedAt = p.archived === true ? etag : null;
    return {
      id: encodeDocId(p.id),
      sourceId,
      folderId: folder?.id ?? null,
      path,
      name: title,
      mimeType: 'text/markdown',
      size: 0,
      hash: '',
      etag,
      lastIndexedAt: '',
      deletedAt,
      ingestError: null,
    };
  }
}

/**
 * Type guard: is this Notion search / query result a full page (not a
 * partial response or a database row)? Full pages carry `archived` and
 * `last_edited_time`; partial responses only carry `id` / `object`.
 */
function isPageResult(
  result: unknown,
): result is { id: string; object: 'page'; archived: boolean; last_edited_time: string } {
  if (!result || typeof result !== 'object') return false;
  const r = result as { object?: string; archived?: unknown; last_edited_time?: unknown };
  return (
    r.object === 'page' && typeof r.archived === 'boolean' && typeof r.last_edited_time === 'string'
  );
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __testing = {
  encodeDocId,
  decodeDocId,
  encodeFolderId,
  decodeFolderId,
  normalizeId,
  denormalizeId,
  narrowConfig,
  renderBlocksToText,
  renderRichText,
  pageTitle,
  mapNotionError,
  readErrorStatus,
  isPageResult,
};
