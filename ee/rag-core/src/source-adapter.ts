// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * DocumentSourceAdapter — wraps the RAG runtime (vector store, storage, connector)
 * behind the `SourceAdapter<TConfig, TSchema, TCaps>` contract from @calame/core.
 *
 * Design decisions:
 *
 * ONE adapter per RagSourceType (vs. one for all):
 *   Mirrors DatabaseSourceAdapter's per-DB-type pattern. Each call to
 *   `buildDocumentSourceAdapter('local', ...)` produces a dedicated adapter for
 *   that source type. Phase 4+ can call the factory again for 's3', 'http', etc.
 *   A single "any-type" adapter would couple the configSchema to ALL connector
 *   types at once and make capability testing brittle.
 *
 * rag_list_sources placement:
 *   All 5 RAG tools are registered per-adapter (option c from the plan
 *   deferred to a comment below). The adapter only knows its own source; the
 *   `rag_list_sources` tool it registers returns a single-element list for the
 *   source it was wired to. A host-level aggregation tool can be added in
 *   Phase 4 by iterating all document-kind adapters and merging their outputs.
 *   See "Phase 4 note" comments below.
 *
 * Allowlist filtering invariant (rag-integration-plan.md §6.3):
 *   Filtering never happens at the embedding / vector-store layer. Every tool
 *   applies the profile ScopeSelection AFTER receiving results from the search
 *   index or storage, ensuring that connector-side changes (new documents in an
 *   allowed folder) are reflected immediately without profile rewrites.
 */

import { z } from 'zod';
import { nanoid } from 'nanoid';
import type {
  SourceAdapter,
  ScopeSelection,
  McpRegistrationContext,
  DocumentFolderInfo,
  DocumentItemInfo,
  AuditLogEntry,
  PiiCategory,
} from '@calame/core';
import type { RagFolder, RagDocument, RagSearchResult } from './types.js';
import { maskSearchResult, type RagPiiMaskingConfig } from './pii-masking.js';

// ---------------------------------------------------------------------------
// Public config type
// ---------------------------------------------------------------------------

/**
 * Config shape for a 'local' document source adapter.
 * Mirrors the `config` object accepted by `POST /api/rag/sources` when `type === 'local'`.
 */
export interface LocalDocumentAdapterConfig {
  root: string;
  includeGlobs?: string[];
  excludeGlobs?: string[];
}

// ---------------------------------------------------------------------------
// Capability and schema type aliases
// ---------------------------------------------------------------------------

type DocumentCaps = 'enumerate' | 'fetch' | 'search' | 'introspect';

type DocumentSchema = Extract<
  import('@calame/core').SourceSchema,
  { kind: 'document' }
>;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Minimal duck-typed connector shape. Avoids importing @calame-ee/rag-connectors
 * directly (rag-connectors → rag-core, not back) while still allowing type-safe
 * delegation. Matches ConnectorLike from routes/types.ts.
 */
export interface ConnectorLike {
  type: string;
  testConnection(config: Record<string, unknown>): Promise<void>;
}

/**
 * Search index abstraction. The adapter does not reach into the vector store
 * directly — it goes through this interface which the host builds and injects.
 */
export interface DocumentSearchIndex {
  search(
    sourceId: string,
    query: string,
    opts: {
      topK: number;
      folders?: readonly string[];
      fileTypes?: readonly string[];
    },
  ): Promise<RagSearchResult>;
}

/**
 * Read-side storage accessors. All sync-to-DB writes go through IngestionPipeline;
 * the adapter only reads. The host builds an implementation over the shared
 * BetterSqlite3Database instance.
 */
export interface DocumentStorage {
  listFolders(sourceId: string, parent?: string): Promise<RagFolder[]>;
  listDocuments(sourceId: string, folder?: string): Promise<RagDocument[]>;
  getDocument(
    documentId: string,
  ): Promise<{ doc: RagDocument; text: string } | null>;
  listSources(): Promise<
    Array<{
      id: string;
      name: string;
      type: string;
      folderCount: number;
      documentCount: number;
    }>
  >;
  /**
   * Returns the folder ancestor chain of a document — its immediate folder
   * first, then that folder's parent, and so on up to the root. Each entry
   * carries both `id` and `path` so the scope allowlist check can match by
   * either (the gdrive connector stores flat `path = name` while other
   * connectors may store hierarchical paths — both must work).
   *
   * Returns an empty array when the document is at the source root, when the
   * document does not exist, or when the chain has already been fully walked
   * and no ancestor folder is recorded.
   */
  getDocumentFolderChain(
    documentId: string,
  ): Promise<Array<{ id: string; path: string }>>;
}

/**
 * Constructor-time dependencies injected by the host. Keeps the adapter
 * decoupled from packages/cli and the BetterSqlite3 database.
 */
export interface DocumentAdapterDeps {
  /**
   * Resolves a DocumentSourceConnector for a given source type. The adapter
   * calls this once per `testConnection` invocation.
   */
  resolveConnector(type: string): ConnectorLike | null;
  /** Abstracted search layer over the vector store + embedding query. */
  searchIndex: DocumentSearchIndex;
  /** Read-side accessors over the SQLite-backed RAG tables. */
  storage: DocumentStorage;
  /**
   * Optional PII-masking config applied to chunk text and full-document text
   * before they are returned to the LLM. When `undefined`, masking is
   * skipped entirely (no scan, no audit counts). Hosts that DO build a
   * config should pass {@link parseRagPiiConfig} (or equivalent) — that
   * helper already enforces the "safe-by-default" behaviour expected for
   * regulated industries.
   */
  piiMasking?: RagPiiMaskingConfig;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const configSchema = z.object({
  root: z.string().min(1),
  includeGlobs: z.array(z.string()).optional(),
  excludeGlobs: z.array(z.string()).optional(),
});

// Accepts both document and relational ScopeSelection so the registry can store
// a single adapter instance without type errors; the adapter validates at
// runtime that it received a 'document' kind selection.
const scopeSelectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('document'),
    mode: z.enum(['allowAll', 'allowList']),
    allowedFolders: z.array(z.string()),
    allowedDocuments: z.array(z.string()),
    piiMaskingMode: z.enum(['inherit', 'off']).optional(),
    directFetchDisabled: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('relational'),
    selectedTables: z.record(z.string(), z.array(z.string())),
    tableOptions: z.record(z.string(), z.unknown()).optional(),
    columnMasking: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  }),
]) as z.ZodType<ScopeSelection>;

// ---------------------------------------------------------------------------
// Allowlist helpers
// ---------------------------------------------------------------------------

/** Returns true when the document passes the scope selection allowlist. */
function isDocumentAllowed(
  documentId: string,
  documentPath: string,
  folderPath: string | null,
  scope: Extract<ScopeSelection, { kind: 'document' }>,
): boolean {
  if (scope.mode === 'allowAll') return true;
  // `allowedDocuments` accepts EITHER stable nanoids OR human-readable paths/names —
  // the frontend writes paths, but the contract was originally id-based, so we honour both.
  if (scope.allowedDocuments.includes(documentId)) return true;
  if (scope.allowedDocuments.includes(documentPath)) return true;
  if (folderPath !== null) {
    for (const allowed of scope.allowedFolders) {
      if (folderPath === allowed || folderPath.startsWith(allowed + '/')) return true;
    }
  }
  return false;
}

/**
 * Returns true when the document passes the allowlist using its full folder
 * ancestor chain. Use this in preference to {@link isDocumentAllowed} when
 * the storage layer can supply the chain — it covers cases where the doc's
 * immediate folder doesn't match an entry but a higher ancestor does
 * (typical when the user ticks a top-level folder expecting recursive
 * coverage). Falls back to the path-prefix behaviour for connectors whose
 * folder paths already encode the hierarchy.
 *
 * The chain MUST list folders from immediate parent outward — root last —
 * but the function does not depend on the order; it scans all entries.
 */
function isDocumentAllowedByChain(
  documentId: string,
  documentPath: string,
  folderChain: ReadonlyArray<{ id: string; path: string }>,
  scope: Extract<ScopeSelection, { kind: 'document' }>,
): boolean {
  if (scope.mode === 'allowAll') return true;
  if (scope.allowedDocuments.includes(documentId)) return true;
  if (scope.allowedDocuments.includes(documentPath)) return true;
  for (const ancestor of folderChain) {
    if (scope.allowedFolders.includes(ancestor.id)) return true;
    if (scope.allowedFolders.includes(ancestor.path)) return true;
  }
  // Keep prefix matching as a defensive fallback for hierarchical connectors
  // (the chain check above covers flat-path connectors like gdrive).
  for (const ancestor of folderChain) {
    for (const allowed of scope.allowedFolders) {
      if (ancestor.path === allowed || ancestor.path.startsWith(allowed + '/')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Computes the effective folder filter passed to the search index.
 *
 * Scope enforcement is handled by the post-search filter (which walks each
 * chunk's folder ancestor chain — see `isDocumentAllowedByChain`). We
 * therefore only forward the **caller-requested** folders here; pre-filtering
 * by `scope.allowedFolders` at the SQL layer would mis-fire on connectors
 * that store flat folder paths (gdrive's `path = name`), excluding deeply
 * nested matches before the chain-walk even runs.
 *
 * The reranking layer over-fetches `candidatesPerSearch` (50 by default) so
 * the post-filter has enough headroom to keep top-K populated even when most
 * of the source falls outside the profile scope.
 */
function effectiveFolders(
  argFolders: readonly string[] | undefined,
  _scope: Extract<ScopeSelection, { kind: 'document' }>,
): readonly string[] | undefined {
  return argFolders;
}

// ---------------------------------------------------------------------------
// Token-budget cap for chunk text
// ---------------------------------------------------------------------------

const APPROX_CHARS_PER_TOKEN = 4;
const MAX_CHUNK_TOKENS = 1000;
const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * APPROX_CHARS_PER_TOKEN;

function capChunkText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_CHUNK_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_CHUNK_CHARS), truncated: true };
}

// Document full-text cap (50 KB, matching the plan §rag_get_document)
const MAX_DOC_BYTES = 50 * 1024;

/**
 * Per-MCP-session cap on `rag_get_document` invocations. Read from
 * CALAME_RAG_MAX_DIRECT_FETCH_PER_TURN. Default 5. Negative / zero values
 * disable the cap entirely. NaN falls back to the default.
 */
function readDirectFetchCap(): number {
  const raw = process.env['CALAME_RAG_MAX_DIRECT_FETCH_PER_TURN'];
  if (raw === undefined) return 5;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return 5;
  return parsed;
}

function capDocText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_DOC_BYTES) return { text, truncated: false };
  return { text: text.slice(0, MAX_DOC_BYTES), truncated: true };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Builds a SourceAdapter for a specific document source type.
 *
 * For Phase 3, only `'local'` is fully wired (the host provides a real
 * LocalFolderConnector via `deps.resolveConnector`). Additional types ('s3',
 * 'http', …) can be supported by calling the factory again with the
 * corresponding type string once their connectors land in Phase 3+.
 *
 * @param deps   - Host-provided runtime dependencies (search index, storage).
 * @param type   - Adapter type key (e.g. `'local'`). Registered under this key
 *                 in the SourceAdapterRegistry.
 * @param displayName - Human-readable name shown in the UI.
 */
export function buildDocumentSourceAdapter(
  deps: DocumentAdapterDeps,
  type: 'local',
  displayName: 'Local folder',
): SourceAdapter<LocalDocumentAdapterConfig, DocumentSchema, DocumentCaps>;
export function buildDocumentSourceAdapter(
  deps: DocumentAdapterDeps,
  type: string,
  displayName: string,
): SourceAdapter<LocalDocumentAdapterConfig, DocumentSchema, DocumentCaps>;
export function buildDocumentSourceAdapter(
  deps: DocumentAdapterDeps,
  type: string,
  displayName: string,
): SourceAdapter<LocalDocumentAdapterConfig, DocumentSchema, DocumentCaps> {
  return {
    type,
    displayName,
    capabilities: ['enumerate', 'fetch', 'search', 'introspect'] as const,
    configSchema,
    scopeSelectionSchema,

    // -----------------------------------------------------------------------
    // testConnection — delegates to the connector
    // -----------------------------------------------------------------------
    async testConnection(config: LocalDocumentAdapterConfig): Promise<void> {
      const connector = deps.resolveConnector(type);
      if (!connector) {
        throw new Error(
          `DocumentSourceAdapter(${type}): no connector registered for type '${type}'.`,
        );
      }
      await connector.testConnection(config as unknown as Record<string, unknown>);
    },

    // -----------------------------------------------------------------------
    // introspect — produces a DocumentSchema from storage
    // -----------------------------------------------------------------------
    async introspect(
      _config: LocalDocumentAdapterConfig,
      sourceId: string,
    ): Promise<DocumentSchema> {
      const [ragFolders, ragDocuments] = await Promise.all([
        deps.storage.listFolders(sourceId),
        deps.storage.listDocuments(sourceId),
      ]);

      const folders: DocumentFolderInfo[] = ragFolders.map((f) => ({
        id: f.id,
        name: f.name,
        path: f.path,
        parentId: f.parentId,
      }));

      const documents: DocumentItemInfo[] = ragDocuments.map((d) => ({
        id: d.id,
        name: d.name,
        path: d.path,
        parentId: d.folderId,
        mimeType: d.mimeType,
        size: d.size,
      }));

      return { kind: 'document', folders, documents };
    },

    // -----------------------------------------------------------------------
    // listScopes — returns folders (from storage, simpler than live connector)
    // Choice: storage-backed (cached). This avoids an extra live FS scan and
    // is consistent with what the MCP tools actually expose. Phase 4 can swap
    // to a live connector call when incremental sync lands.
    // -----------------------------------------------------------------------
    async listScopes(
      _config: LocalDocumentAdapterConfig,
      sourceId: string,
      parent?: string,
    ): Promise<ReadonlyArray<{ id: string; name: string; path: string }>> {
      const folders = await deps.storage.listFolders(sourceId, parent);
      return folders.map((f) => ({ id: f.id, name: f.name, path: f.path }));
    },

    // -----------------------------------------------------------------------
    // listItems — returns documents in a folder
    // -----------------------------------------------------------------------
    async listItems(
      _config: LocalDocumentAdapterConfig,
      sourceId: string,
      scope?: string,
    ): Promise<ReadonlyArray<{ id: string; name: string; mimeType: string; size: number }>> {
      const docs = await deps.storage.listDocuments(sourceId, scope);
      return docs.map((d) => ({ id: d.id, name: d.name, mimeType: d.mimeType, size: d.size }));
    },

    // -----------------------------------------------------------------------
    // fetchItem — returns full document content
    // -----------------------------------------------------------------------
    async fetchItem(
      _config: LocalDocumentAdapterConfig,
      _sourceId: string,
      itemId: string,
    ): Promise<{ id: string; name: string; mimeType: string; size: number; text: string } | null> {
      const result = await deps.storage.getDocument(itemId);
      if (!result) return null;
      const { doc, text } = result;
      return { id: doc.id, name: doc.name, mimeType: doc.mimeType, size: doc.size, text };
    },

    // -----------------------------------------------------------------------
    // search — delegates to the search index
    // -----------------------------------------------------------------------
    async search(
      _config: LocalDocumentAdapterConfig,
      query: string,
      options?: { sourceId?: string; topK?: number; folders?: string[]; fileTypes?: string[] },
    ): Promise<RagSearchResult> {
      const sourceId = options?.sourceId ?? '';
      const topK = Math.min(options?.topK ?? 5, 10);
      return deps.searchIndex.search(sourceId, query, {
        topK,
        folders: options?.folders,
        fileTypes: options?.fileTypes,
      });
    },

    // -----------------------------------------------------------------------
    // registerMcpTools — the 5 RAG MCP tools
    // -----------------------------------------------------------------------
    registerMcpTools(
      ctx: McpRegistrationContext<LocalDocumentAdapterConfig, DocumentSchema>,
    ): void {
      if (ctx.selection.kind !== 'document') {
        throw new Error(
          `DocumentSourceAdapter(${type}): expected document selection, got '${ctx.selection.kind}'`,
        );
      }

      const directFetchCap = readDirectFetchCap();
      let directFetchCount = 0;

      const scope = ctx.selection;
      const ns = ctx.toolNamespace; // e.g. '' or 'kb1_'
      const sourceId = ctx.source.id;

      // Shorthand for audit logging. durationMs is measured from the provided
      // startTime (Date.now() at handler entry) so the entry reflects actual
      // async execution time rather than a hard-coded 0.
      //
      // `piiRedacted`, when present, is the aggregate count map produced by
      // {@link maskSearchResult} / {@link applyPiiMasking}. We log COUNTS only
      // — never the redacted values — so audit logs stay safe to ship to any
      // SIEM. Pass `undefined` (or an empty map) to omit the field.
      const audit = (
        tool: string,
        args: Record<string, unknown>,
        resultSummary: string,
        result: 'success' | 'error' = 'success',
        startTime: number = Date.now(),
        piiRedacted?: Partial<Record<PiiCategory, number>>,
      ): void => {
        const hasRedactions = piiRedacted && Object.keys(piiRedacted).length > 0;
        const entry: AuditLogEntry = {
          id: nanoid(),
          timestamp: new Date().toISOString(),
          profileName: ctx.profileName,
          toolName: `${ns}${tool}`,
          toolArgs: hasRedactions ? { ...args, piiRedacted } : args,
          result,
          resultSummary,
          durationMs: Date.now() - startTime,
        };
        ctx.onAuditLog(entry);
      };

      // -------------------------------------------------------------------
      // rag_search
      // -------------------------------------------------------------------
      ctx.server.tool(
        `${ns}rag_search`,
        `Semantic vector search over the "${ctx.source.name}" knowledge base — user-uploaded documents such as notes, work logs, manuals, reports, contracts, meeting minutes, or any free-form text content. ` +
          `Returns the most relevant text chunks. Prefer this tool over relational database queries whenever the user asks about textual content, what was written in a document, what was logged on a date, or anything that naturally lives in a file rather than a structured table. ` +
          `Call it even when the question mentions names, dates, or events — those may appear in documents just as easily as in tables.`,
        {
          query: z.string().min(1).describe('The natural language search query.'),
          topK: z
            .number()
            .int()
            .min(1)
            .max(10)
            .optional()
            .describe('Number of chunks to return (default 5, max 10).'),
          folders: z
            .array(z.string())
            .optional()
            .describe('Restrict search to specific folder paths (further filtered by profile allowlist).'),
          fileTypes: z
            .array(z.string())
            .optional()
            .describe('Restrict search to specific MIME types, e.g. ["application/pdf"].'),
        },
        async (args) => {
          const t0 = Date.now();
          const topK = Math.min(args.topK ?? 5, 10);
          const folders = effectiveFolders(args.folders, scope);

          let searchResult: RagSearchResult;
          try {
            searchResult = await deps.searchIndex.search(sourceId, args.query, {
              topK,
              folders,
              fileTypes: args.fileTypes,
            });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            audit('rag_search', { query: args.query, topK }, `error: ${message}`, 'error', t0);
            return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
          }

          // Post-search allowlist filter (§6.3 invariant).
          //
          // The check walks each chunk's document folder ancestor chain so a
          // ticked top-level folder transitively covers everything underneath
          // — required because connectors like gdrive store flat folder paths
          // (`path = name`), so prefix-only matching on the immediate folder
          // misses deeply-nested matches. When the chain is empty (legacy
          // tests, orphaned folder rows) we fall back to the chunk.folder
          // path so the old single-level behaviour stays intact.
          const filtered: typeof searchResult.chunks = [];
          for (const chunk of searchResult.chunks) {
            const chain = await deps.storage.getDocumentFolderChain(chunk.documentId);
            const effectiveChain =
              chain.length > 0 ? chain : [{ id: '', path: chunk.folder }];
            if (
              isDocumentAllowedByChain(chunk.documentId, chunk.fileName, effectiveChain, scope)
            ) {
              filtered.push(chunk);
            }
          }

          const cappedChunks = filtered.map((chunk) => {
            const { text, truncated } = capChunkText(chunk.text);
            return {
              text,
              truncated,
              score: chunk.score,
              sourceId: chunk.sourceId,
              folder: chunk.folder,
              fileName: chunk.fileName,
              position: chunk.position,
              documentId: chunk.documentId,
            };
          });

          // Apply PII masking BEFORE shipping the chunks to the LLM. Order
          // matters: we cap THEN mask so the mask's placeholder labels are
          // not themselves truncated mid-token. Masking is a structural
          // no-op when piiMasking is undefined or `enabled: false`.
          let piiRedacted: Partial<Record<PiiCategory, number>> | undefined;
          let outChunks = cappedChunks;
          if (deps.piiMasking?.enabled && scope.piiMaskingMode !== 'off') {
            // `maskSearchResult` accepts a RagSearchResult-shaped object;
            // our `cappedChunks` carries an extra `truncated` field, which
            // the function preserves via spread. Cast at the boundary.
            const masked = maskSearchResult(
              { chunks: cappedChunks as unknown as RagSearchResult['chunks'] },
              deps.piiMasking,
            );
            outChunks = masked.result.chunks as unknown as typeof cappedChunks;
            piiRedacted = masked.redactionCounts;
          }

          const response = { chunks: outChunks };
          audit(
            'rag_search',
            { query: args.query, topK },
            `${outChunks.length} chunks returned`,
            'success',
            t0,
            piiRedacted,
          );

          return {
            content: [{ type: 'text', text: JSON.stringify(response) }],
          };
        },
      );

      // -------------------------------------------------------------------
      // rag_list_sources
      // Phase 4 note: this tool returns a single-element list scoped to
      // ctx.source. When multiple document-kind sources are in a profile, each
      // adapter registers its own namespaced rag_list_sources (e.g.
      // kb1_rag_list_sources, kb2_rag_list_sources). A host-level aggregation
      // tool that merges them into a single list is planned for Phase 4 — it
      // would iterate all document adapters in the active profile and collect
      // their source records. For now, per-adapter single-source output is
      // correct and sufficient.
      // -------------------------------------------------------------------
      ctx.server.tool(
        `${ns}rag_list_sources`,
        `List the document source(s) of the user's knowledge base accessible through this endpoint. Use when the user asks "what knowledge bases / document sources do I have?" or to discover what's available before calling rag_search.`,
        {},
        async (_args) => {
          const t0 = Date.now();
          let sources: Array<{
            id: string;
            name: string;
            type: string;
            folderCount: number;
            documentCount: number;
          }>;
          try {
            const all = await deps.storage.listSources();
            // Filter to only THIS source (the adapter is per-source)
            sources = all.filter((s) => s.id === sourceId);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            audit('rag_list_sources', {}, `error: ${message}`, 'error', t0);
            return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
          }

          audit('rag_list_sources', {}, `${sources.length} source(s) returned`, 'success', t0);
          return {
            content: [{ type: 'text', text: JSON.stringify({ sources }) }],
          };
        },
      );

      // -------------------------------------------------------------------
      // rag_list_folders
      // -------------------------------------------------------------------
      ctx.server.tool(
        `${ns}rag_list_folders`,
        `List folders in the "${ctx.source.name}" knowledge base — useful to discover the structure of the user's documents before drilling down with rag_list_documents or rag_search.`,
        {
          parent: z
            .string()
            .optional()
            .describe('Parent folder path. Omit to list root folders.'),
        },
        async (args) => {
          const t0 = Date.now();
          let folders: RagFolder[];
          try {
            folders = await deps.storage.listFolders(sourceId, args.parent);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            audit('rag_list_folders', { parent: args.parent }, `error: ${message}`, 'error', t0);
            return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
          }

          // Apply allowlist filter
          const filtered =
            scope.mode === 'allowAll'
              ? folders
              : folders.filter((f) => {
                  for (const allowed of scope.allowedFolders) {
                    if (f.path === allowed || f.path.startsWith(allowed + '/')) return true;
                  }
                  return false;
                });

          const result = {
            folders: filtered.map((f) => ({
              id: f.id,
              sourceId: f.sourceId,
              path: f.path,
              parent: f.parentId,
              name: f.name,
            })),
          };

          audit(
            'rag_list_folders',
            { parent: args.parent },
            `${result.folders.length} folders returned`,
            'success',
            t0,
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        },
      );

      // -------------------------------------------------------------------
      // rag_list_documents
      // -------------------------------------------------------------------
      ctx.server.tool(
        `${ns}rag_list_documents`,
        `List documents in a specific folder of the "${ctx.source.name}" knowledge base. Use when the user asks "what files do I have in <folder>?" or to enumerate documents before fetching them.`,
        {
          folder: z.string().describe('The folder path to list documents from.'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .describe('Maximum number of documents to return (default 50, max 200).'),
        },
        async (args) => {
          const t0 = Date.now();
          const limit = Math.min(args.limit ?? 50, 200);

          // Allowlist check on folder before fetching documents
          if (scope.mode === 'allowList') {
            const folderAllowed = scope.allowedFolders.some(
              (af) => args.folder === af || args.folder.startsWith(af + '/'),
            );
            if (!folderAllowed) {
              audit(
                'rag_list_documents',
                { folder: args.folder, limit },
                'folder not in allowlist',
                'error',
                t0,
              );
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      error: `Folder "${args.folder}" is not accessible in this profile.`,
                    }),
                  },
                ],
              };
            }
          }

          let docs: RagDocument[];
          try {
            docs = await deps.storage.listDocuments(sourceId, args.folder);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            audit(
              'rag_list_documents',
              { folder: args.folder, limit },
              `error: ${message}`,
              'error',
              t0,
            );
            return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
          }

          // Post-fetch per-document allowlist filter. Walk the doc's folder
          // ancestor chain so a ticked top-level folder transitively covers
          // descendants. Falls back to the immediate folder path argument
          // when the chain is unavailable (legacy mocks, orphaned rows).
          const filteredDocs: RagDocument[] = [];
          for (const d of docs) {
            const chain = await deps.storage.getDocumentFolderChain(d.id);
            const effectiveChain =
              chain.length > 0
                ? chain
                : d.folderId && args.folder
                  ? [{ id: d.folderId, path: args.folder }]
                  : [];
            if (isDocumentAllowedByChain(d.id, d.path, effectiveChain, scope)) {
              filteredDocs.push(d);
            }
          }
          const allowed = filteredDocs.slice(0, limit);

          const result = {
            documents: allowed.map((d) => ({
              id: d.id,
              name: d.name,
              mimeType: d.mimeType,
              size: d.size,
              modifiedAt: d.lastIndexedAt,
            })),
          };

          audit(
            'rag_list_documents',
            { folder: args.folder, limit },
            `${result.documents.length} documents returned`,
            'success',
            t0,
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        },
      );

      // -------------------------------------------------------------------
      // rag_get_document
      // -------------------------------------------------------------------
      if (scope.directFetchDisabled !== true) {
      ctx.server.tool(
        `${ns}rag_get_document`,
        `Retrieve the full text content of a single document from the "${ctx.source.name}" knowledge base. Use when the user names a document explicitly, or to expand on a chunk that rag_search returned but truncated. Content is capped at 50 KB — large documents are flagged truncated.`,
        {
          documentId: z.string().describe('The document id to retrieve.'),
        },
        async (args) => {
          const t0 = Date.now();

          // Per-session cap: prevent the LLM from bulk-reading all documents.
          if (directFetchCap > 0 && directFetchCount >= directFetchCap) {
            audit('rag_get_document', { documentId: args.documentId }, `cap exceeded (${directFetchCap})`, 'error', t0);
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  error: `Direct-fetch cap reached for this session (max ${directFetchCap} per turn). Use rag_search to find specific content instead.`,
                }),
              }],
            };
          }
          directFetchCount++;

          let result: { doc: RagDocument; text: string } | null;
          try {
            result = await deps.storage.getDocument(args.documentId);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            audit('rag_get_document', { documentId: args.documentId }, `error: ${message}`, 'error', t0);
            return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
          }

          if (!result) {
            audit(
              'rag_get_document',
              { documentId: args.documentId },
              'document not found',
              'error',
              t0,
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: `Document "${args.documentId}" not found.` }),
                },
              ],
            };
          }

          const { doc, text } = result;

          // Allowlist enforcement — must be in allowedDocuments OR in an
          // allowed folder (walking the full ancestor chain so a ticked
          // top-level folder covers descendants transitively).
          const chain = await deps.storage.getDocumentFolderChain(doc.id);
          if (!isDocumentAllowedByChain(doc.id, doc.path, chain, scope)) {
            audit(
              'rag_get_document',
              { documentId: args.documentId },
              'document not in allowlist',
              'error',
              t0,
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: `Document "${args.documentId}" is not accessible in this profile.`,
                  }),
                },
              ],
            };
          }

          const { text: capped, truncated } = capDocText(text);

          // Apply PII masking to the full-document text BEFORE returning it
          // to the LLM. Same fast-path as rag_search: when piiMasking is
          // undefined or `enabled: false`, this is a structural no-op.
          let finalText = capped;
          let piiRedacted: Partial<Record<PiiCategory, number>> | undefined;
          if (deps.piiMasking?.enabled && scope.piiMaskingMode !== 'off') {
            // Lazy import would be cleaner but `applyPiiMasking` is already
            // pulled in transitively via maskSearchResult; importing it at
            // the top of the file keeps the tree-shaker happy and avoids a
            // dynamic require in a hot path.
            const masked = maskSearchResult(
              {
                chunks: [
                  {
                    text: capped,
                    score: 0,
                    sourceId: doc.sourceId,
                    folder: '',
                    fileName: doc.name,
                    position: 0,
                    documentId: doc.id,
                  },
                ],
              },
              deps.piiMasking,
            );
            finalText = masked.result.chunks[0]?.text ?? capped;
            piiRedacted = masked.redactionCounts;
          }

          const response = {
            id: doc.id,
            name: doc.name,
            mimeType: doc.mimeType,
            size: doc.size,
            text: finalText,
            truncated,
          };

          audit(
            'rag_get_document',
            { documentId: args.documentId },
            `${doc.size} bytes, truncated=${truncated}`,
            'success',
            t0,
            piiRedacted,
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(response) }],
          };
        },
      );
      } // end if (scope.directFetchDisabled !== true)
    },
  };
}
