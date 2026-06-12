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
import type {
  SourceAdapter,
  ScopeSelection,
  McpRegistrationContext,
  DocumentFolderInfo,
  DocumentItemInfo,
} from '@calame/core';
import type { RagFolder, RagDocument, RagSearchResult } from './types.js';
import type { RagPiiMaskingConfig } from './pii-masking.js';
import { registerMergedDocumentRagTools } from './merged-rag-tools.js';

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
      /**
       * When provided, restricts results to rows whose `tenant_id` column
       * matches this value (defense-in-depth on top of source-level isolation).
       * Optional so callers that have not yet migrated to the tenant-aware path
       * continue to compile and behave as before.
       */
      tenantId?: string;
      /**
       * When provided, restricts results to the listed source ids in a single
       * query (used by `rag_search` without a `source` parameter to fan out
       * across all sources in one call). Optional for backward compatibility.
       */
      sourceIds?: readonly string[];
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
    // registerMcpTools — delegates to registerMergedDocumentRagTools with a
    // single-element sources array. This preserves full backward compatibility
    // (the host loop in serve.ts continues to call registerMcpTools once per
    // source) while ensuring there is only ONE implementation of the 5 tool
    // handlers in the codebase.
    //
    // The toolNamespace prefix (ctx.toolNamespace, e.g. 'kb1_') is applied by
    // wrapping the server with a namespacing proxy so the merged function's
    // output still carries the per-source prefix when invoked via this path.
    // -----------------------------------------------------------------------
    registerMcpTools(
      ctx: McpRegistrationContext<LocalDocumentAdapterConfig, DocumentSchema>,
    ): void {
      if (ctx.selection.kind !== 'document') {
        throw new Error(
          `DocumentSourceAdapter(${type}): expected document selection, got '${ctx.selection.kind}'`,
        );
      }

      const ns = ctx.toolNamespace; // e.g. '' or 'kb1_'
      const scope = ctx.selection;

      // When a namespace prefix is requested, wrap ctx.server so every
      // server.tool(name, ...) call receives the prefixed name.  This keeps
      // registerMergedDocumentRagTools unaware of namespacing.
      const wrappedServer =
        ns === ''
          ? ctx.server
          : new Proxy(ctx.server, {
              get(target, prop, receiver) {
                if (prop === 'tool') {
                  return (
                    name: string,
                    description: string,
                    schema: unknown,
                    handler: unknown,
                  ) => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    return (target.tool as (...args: any[]) => unknown)(
                      `${ns}${name}`,
                      description,
                      schema,
                      handler,
                    );
                  };
                }
                return Reflect.get(target, prop, receiver);
              },
            });

      registerMergedDocumentRagTools({
        server: wrappedServer,
        deps,
        tenantId: 'default', // legacy single-source path: always the default tenant
        sources: [{ source: ctx.source, selection: scope, config: ctx.config }],
        profileName: ctx.profileName,
        responseMode: ctx.responseMode,
        onAuditLog: ctx.onAuditLog,
      });
    },
  };
}
