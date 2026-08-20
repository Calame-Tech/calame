// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * registerMergedDocumentRagTools — registers a single set of 5 RAG MCP tools
 * (rag_search, rag_list_sources, rag_list_folders, rag_list_documents,
 * rag_get_document) that span multiple document sources.
 *
 * Design rationale:
 *   Previously each document source registered its own namespaced copy of the
 *   5 tools (e.g. kb1_rag_search, kb2_rag_search). In Phase 4 we collapse this
 *   into a single global set: the LLM sees one rag_search tool with an optional
 *   `source` parameter rather than N tool variants. The old per-source
 *   `registerMcpTools` method delegates here with a single-element `sources`
 *   array to preserve backward compatibility.
 *
 * Security invariants:
 *   - rag_search is ALWAYS bounded to the explicit `opts.sources` list — never
 *     a global scan of all indexed content.
 *   - The optional `source` parameter is resolved ONLY among `opts.sources`
 *     (case-insensitive name match). Unknown values return a clear error, not a
 *     fallback to all sources.
 *   - tenantId is ALWAYS passed to `deps.searchIndex.search()` for defense-in-
 *     depth isolation at the SQL layer.
 *   - Scope (allowedFolders / allowedDocuments / piiMaskingMode) is applied PER
 *     SOURCE after results are retrieved.
 *   - rag_get_document is only registered when at least one source has
 *     directFetchDisabled !== true; at call time, it refuses if the resolved
 *     source has directFetchDisabled === true.
 */

import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ScopeSelection, AuditLogEntry, PiiCategory, Source } from '@calame/core';
import type { RagFolder, RagDocument, RagSearchResult } from './types.js';
import type { DocumentAdapterDeps } from './source-adapter.js';
import { maskSearchResult } from './pii-masking.js';

// ---------------------------------------------------------------------------
// Re-exported type (the single entry point callers use)
// ---------------------------------------------------------------------------

/** One entry in the merged tool's source list. */
export interface MergedSourceEntry {
  /** The source being served. */
  source: Source;
  /** Must be kind: 'document'. Scope applied per-source after results. */
  selection: Extract<ScopeSelection, { kind: 'document' }>;
  /** Connector-specific config (opaque — not used by the tool layer). */
  config: unknown;
}

/** Options for registerMergedDocumentRagTools. */
export interface RegisterMergedDocumentRagToolsOpts {
  server: McpServer;
  deps: DocumentAdapterDeps;
  tenantId: string;
  sources: ReadonlyArray<MergedSourceEntry>;
  profileName: string;
  responseMode: 'friendly' | 'raw';
  onAuditLog: (entry: AuditLogEntry) => void;
}

// ---------------------------------------------------------------------------
// Allowlist helpers (mirrors source-adapter.ts)
// ---------------------------------------------------------------------------

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
  for (const ancestor of folderChain) {
    for (const allowed of scope.allowedFolders) {
      if (ancestor.path === allowed || ancestor.path.startsWith(allowed + '/')) return true;
    }
  }
  return false;
}

/**
 * Mirrors packages/cli/src/rag/folder-helpers.ts's `normaliseFolderArg` —
 * kept as a small independent copy since ee/rag-core cannot import from the
 * host package. Recognizes `""`, `"/"`, and a bare `"."` as root; everything
 * else is trimmed and slash-stripped but otherwise passed through for the
 * caller to resolve or reject.
 */
function normalizeFolderToken(folder: string): string {
  const trimmed = folder.trim();
  if (trimmed === '.') return '';
  return trimmed.replace(/^\/+|\/+$/g, '');
}

// ---------------------------------------------------------------------------
// Token-budget caps (mirrors source-adapter.ts)
// ---------------------------------------------------------------------------

const APPROX_CHARS_PER_TOKEN = 4;
const MAX_CHUNK_TOKENS = 1000;
const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * APPROX_CHARS_PER_TOKEN;
const MAX_DOC_BYTES = 50 * 1024;

function capChunkText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_CHUNK_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_CHUNK_CHARS), truncated: true };
}

function capDocText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_DOC_BYTES) return { text, truncated: false };
  return { text: text.slice(0, MAX_DOC_BYTES), truncated: true };
}

function readDirectFetchCap(): number {
  const raw = process.env['CALAME_RAG_MAX_DIRECT_FETCH_PER_TURN'];
  if (raw === undefined) return 5;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return 5;
  return parsed;
}

// ---------------------------------------------------------------------------
// Source resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a source by name (case-insensitive) among the registered entries.
 * Returns null when the name is not found.
 */
function resolveSourceByName(
  name: string,
  entries: ReadonlyArray<MergedSourceEntry>,
): MergedSourceEntry | null {
  const lower = name.toLowerCase();
  return entries.find((e) => e.source.name.toLowerCase() === lower) ?? null;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Register a single set of 5 RAG MCP tools (without namespace prefix) that
 * serve multiple document sources.
 *
 * Call this once per MCP server session. The old per-adapter `registerMcpTools`
 * delegates here with `sources` set to a single element.
 */
export function registerMergedDocumentRagTools(opts: RegisterMergedDocumentRagToolsOpts): void {
  const { server, deps, tenantId, sources, profileName, onAuditLog } = opts;

  if (sources.length === 0) {
    // Nothing to register — callers should not reach here but be defensive.
    return;
  }

  const directFetchCap = readDirectFetchCap();
  let directFetchCount = 0;

  // ---------------------------------------------------------------------------
  // Audit helper
  // ---------------------------------------------------------------------------
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
      profileName,
      toolName: tool,
      toolArgs: hasRedactions ? { ...args, piiRedacted } : args,
      result,
      resultSummary,
      durationMs: Date.now() - startTime,
    };
    onAuditLog(entry);
  };

  // Collect all source IDs for cross-source queries.
  const allSourceIds = sources.map((e) => e.source.id);

  // ---------------------------------------------------------------------------
  // rag_search
  // ---------------------------------------------------------------------------
  server.tool(
    'rag_search',
    `Semantic vector search over the knowledge base(s) available in this profile — user-uploaded documents such as notes, work logs, manuals, reports, contracts, meeting minutes, or any free-form text content. ` +
      `Returns the most relevant text chunks. Prefer this tool over relational database queries whenever the user asks about textual content, what was written in a document, what was logged on a date, or anything that naturally lives in a file rather than a structured table. ` +
      `Call it even when the question mentions names, dates, or events — those may appear in documents just as easily as in tables. ` +
      `Use rag_list_sources first to discover available source names, then pass the source name to restrict the search. ` +
      `\n\nEach returned chunk has TWO different numbers, and only one of them tells you whether the match is any good: ` +
      `"similarity" is a cosine similarity in [-1, 1] between your query and the chunk (or null for a chunk that only matched by exact keyword, not semantically) — treat a low similarity (roughly under 0.3) as a weak match, and if every returned chunk is low, say the knowledge base doesn't seem to cover this rather than answering from the best chunk available anyway. ` +
      `"score" is an internal ranking value (rank-based, blends keyword and semantic signal) that always exists and is only meaningful for ordering these results against each other — a query with no real match in the knowledge base still returns chunks with a "score", so never use "score" to judge whether the results actually answer the question.`,
    {
      query: z.string().min(1).describe('The natural language search query.'),
      source: z
        .string()
        .optional()
        .describe(
          'Optional source name to restrict the search to (case-insensitive). Omit to search all sources. Use rag_list_sources to discover valid names.',
        ),
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
        .describe(
          'Restrict search to specific folder paths (further filtered by profile allowlist).',
        ),
      fileTypes: z
        .array(z.string())
        .optional()
        .describe('Restrict search to specific MIME types, e.g. ["application/pdf"].'),
      minSimilarity: z
        .number()
        .min(-1)
        .max(1)
        .optional()
        .describe(
          'Hard cutoff on the "similarity" field (see above) — chunks below this are dropped ' +
            'before being returned, instead of relying on the caller to notice a low value. ' +
            'A keyword-only chunk (similarity: null) is never dropped by this filter — it has no ' +
            'vector score to compare, not a low one. Omit for no filtering (the default).',
        ),
    },
    async (args) => {
      const t0 = Date.now();
      const topK = Math.min(args.topK ?? 5, 10);

      // Resolve target sources. The invariant: results are ALWAYS bounded to
      // the explicit `sources` list — never a global scan.
      let targetEntries: ReadonlyArray<MergedSourceEntry>;
      if (args.source !== undefined) {
        const resolved = resolveSourceByName(args.source, sources);
        if (!resolved) {
          const validNames = sources.map((e) => `"${e.source.name}"`).join(', ');
          audit(
            'rag_search',
            { query: args.query, source: args.source, topK },
            `unknown source: ${args.source}`,
            'error',
            t0,
          );
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Unknown source "${args.source}". Valid sources: ${validNames}. Use rag_list_sources to list them.`,
                }),
              },
            ],
          };
        }
        targetEntries = [resolved];
      } else {
        targetEntries = sources;
      }

      const targetSourceIds = targetEntries.map((e) => e.source.id);

      // Perform the search. Use sourceIds for multi-source fan-out (single DB
      // round-trip via HybridSearchIndex#searchMultipleSources).
      let searchResult: RagSearchResult;
      try {
        if (targetSourceIds.length === 1) {
          searchResult = await deps.searchIndex.search(targetSourceIds[0]!, args.query, {
            topK,
            folders: args.folders,
            fileTypes: args.fileTypes,
            tenantId,
          });
        } else {
          // Multi-source: pass sourceIds so the index fans out in one call.
          searchResult = await deps.searchIndex.search(targetSourceIds[0]!, args.query, {
            topK,
            folders: args.folders,
            fileTypes: args.fileTypes,
            tenantId,
            sourceIds: targetSourceIds,
          });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        audit(
          'rag_search',
          { query: args.query, source: args.source, topK },
          `error: ${message}`,
          'error',
          t0,
        );
        return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
      }

      // Post-search: apply per-source scope allowlist and PII masking.
      // Build a map from sourceId → entry for O(1) lookup.
      const entryBySourceId = new Map(targetEntries.map((e) => [e.source.id, e]));

      const filtered: Array<
        RagSearchResult['chunks'][number] & { truncated: boolean; sourceName: string }
      > = [];

      for (const chunk of searchResult.chunks) {
        const entry = entryBySourceId.get(chunk.sourceId);
        if (!entry) continue; // chunk from a source not in our target list (shouldn't happen)

        const scope = entry.selection;
        const chain = await deps.storage.getDocumentFolderChain(chunk.documentId);
        const effectiveChain = chain.length > 0 ? chain : [{ id: '', path: chunk.folder }];

        if (!isDocumentAllowedByChain(chunk.documentId, chunk.fileName, effectiveChain, scope)) {
          continue;
        }

        // Hard cutoff, when requested — a keyword-only chunk (similarity:
        // null) has no vector score to compare against the threshold, so it
        // is never dropped here (see the parameter's own description).
        if (
          args.minSimilarity !== undefined &&
          chunk.similarity !== null &&
          chunk.similarity < args.minSimilarity
        ) {
          continue;
        }

        const { text, truncated } = capChunkText(chunk.text);
        filtered.push({
          text,
          truncated,
          score: chunk.score,
          similarity: chunk.similarity,
          sourceId: chunk.sourceId,
          sourceName: entry.source.name,
          folder: chunk.folder,
          fileName: chunk.fileName,
          position: chunk.position,
          documentId: chunk.documentId,
        });
      }

      // Apply PII masking per-source (scope.piiMaskingMode can be 'off' per source).
      let piiRedacted: Partial<Record<PiiCategory, number>> | undefined;
      let outChunks = filtered;

      if (deps.piiMasking?.enabled) {
        const toMask = filtered.filter((c) => {
          const entry = entryBySourceId.get(c.sourceId);
          return entry?.selection.piiMaskingMode !== 'off';
        });
        const skipMask = filtered.filter((c) => {
          const entry = entryBySourceId.get(c.sourceId);
          return entry?.selection.piiMaskingMode === 'off';
        });

        if (toMask.length > 0) {
          const masked = maskSearchResult(
            { chunks: toMask as unknown as RagSearchResult['chunks'] },
            deps.piiMasking,
          );
          piiRedacted = masked.redactionCounts;
          // Merge back — preserve relative order using original index.
          const maskedChunks = masked.result.chunks as unknown as typeof filtered;
          outChunks = [...maskedChunks, ...skipMask];
          // Re-sort by score descending (mask preserves scores).
          outChunks.sort((a, b) => b.score - a.score);
        }
      }

      const response = { chunks: outChunks };
      audit(
        'rag_search',
        { query: args.query, source: args.source, topK },
        `${outChunks.length} chunks returned`,
        'success',
        t0,
        piiRedacted,
      );

      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    },
  );

  // ---------------------------------------------------------------------------
  // rag_list_sources
  // ---------------------------------------------------------------------------
  server.tool(
    'rag_list_sources',
    `List the document source(s) of the user's knowledge base accessible through this profile. ` +
      `Use when the user asks "what knowledge bases / document sources do I have?" or to discover ` +
      `what's available before calling rag_search. ` +
      `"documentCount" is every file discovered by the last sync; "indexedDocumentCount" is how many of ` +
      `those actually have searchable content (some file types, e.g. images with no OCR/captioning ` +
      `support, are discovered but never produce any chunks). If they differ, rag_search/rag_list_documents ` +
      `will legitimately miss some files — that's expected, not a permissions problem.`,
    {},
    async (_args) => {
      const t0 = Date.now();
      let allSources: Array<{
        id: string;
        name: string;
        type: string;
        folderCount: number;
        documentCount: number;
        indexedDocumentCount: number;
      }>;
      try {
        const stored = await deps.storage.listSources();
        // Filter to the sources configured for this profile.
        const profileSourceIds = new Set(allSourceIds);
        allSources = stored.filter((s) => profileSourceIds.has(s.id));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        audit('rag_list_sources', {}, `error: ${message}`, 'error', t0);
        return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
      }

      audit('rag_list_sources', {}, `${allSources.length} source(s) returned`, 'success', t0);
      return { content: [{ type: 'text', text: JSON.stringify({ sources: allSources }) }] };
    },
  );

  // ---------------------------------------------------------------------------
  // rag_list_folders
  // ---------------------------------------------------------------------------
  server.tool(
    'rag_list_folders',
    `List folders in the knowledge base — useful to discover the structure of the user's documents ` +
      `before drilling down with rag_list_documents or rag_search.`,
    {
      source: z
        .string()
        .optional()
        .describe('Source name to restrict to. Omit to list across all sources.'),
      parent: z.string().optional().describe('Parent folder path. Omit to list root folders.'),
    },
    async (args) => {
      const t0 = Date.now();

      let targetEntries: ReadonlyArray<MergedSourceEntry>;
      if (args.source !== undefined) {
        const resolved = resolveSourceByName(args.source, sources);
        if (!resolved) {
          const validNames = sources.map((e) => `"${e.source.name}"`).join(', ');
          audit(
            'rag_list_folders',
            { source: args.source, parent: args.parent },
            `unknown source: ${args.source}`,
            'error',
            t0,
          );
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Unknown source "${args.source}". Valid sources: ${validNames}.`,
                }),
              },
            ],
          };
        }
        targetEntries = [resolved];
      } else {
        targetEntries = sources;
      }

      const allFolders: Array<{
        id: string;
        sourceId: string;
        sourceName: string;
        path: string;
        parent: string | null;
        name: string;
      }> = [];

      for (const entry of targetEntries) {
        let folders: RagFolder[];
        try {
          folders = await deps.storage.listFolders(entry.source.id, args.parent);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          audit(
            'rag_list_folders',
            { source: args.source, parent: args.parent },
            `error: ${message}`,
            'error',
            t0,
          );
          return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
        }

        const scope = entry.selection;
        const filtered =
          scope.mode === 'allowAll'
            ? folders
            : folders.filter((f) => {
                for (const allowed of scope.allowedFolders) {
                  if (f.path === allowed || f.path.startsWith(allowed + '/')) return true;
                }
                return false;
              });

        for (const f of filtered) {
          allFolders.push({
            id: f.id,
            sourceId: f.sourceId,
            sourceName: entry.source.name,
            path: f.path,
            parent: f.parentId,
            name: f.name,
          });
        }
      }

      audit(
        'rag_list_folders',
        { source: args.source, parent: args.parent },
        `${allFolders.length} folders returned`,
        'success',
        t0,
      );
      return { content: [{ type: 'text', text: JSON.stringify({ folders: allFolders }) }] };
    },
  );

  // ---------------------------------------------------------------------------
  // rag_list_documents
  // ---------------------------------------------------------------------------
  server.tool(
    'rag_list_documents',
    `List documents in a specific folder. Use when the user asks "what files do I have in <folder>?" ` +
      `or to enumerate documents before fetching them.`,
    {
      folder: z
        .string()
        .describe(
          'The folder path to list documents from. Use "" (empty string) for the root — "/" and ' +
            '"." also work. Use rag_list_folders to discover real folder paths; an unrecognized ' +
            'value returns an explicit "Unknown folder" error rather than an empty list.',
        ),
      source: z
        .string()
        .optional()
        .describe('Source name to restrict to. Omit to list across all sources.'),
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

      let targetEntries: ReadonlyArray<MergedSourceEntry>;
      if (args.source !== undefined) {
        const resolved = resolveSourceByName(args.source, sources);
        if (!resolved) {
          const validNames = sources.map((e) => `"${e.source.name}"`).join(', ');
          audit(
            'rag_list_documents',
            { folder: args.folder, source: args.source, limit },
            `unknown source: ${args.source}`,
            'error',
            t0,
          );
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Unknown source "${args.source}". Valid sources: ${validNames}.`,
                }),
              },
            ],
          };
        }
        targetEntries = [resolved];
      } else {
        targetEntries = sources;
      }

      const allDocuments: Array<{
        id: string;
        name: string;
        sourceName: string;
        mimeType: string;
        size: number;
        modifiedAt: string;
      }> = [];

      // We check plain folder EXISTENCE (not the allowlist) up front, across
      // every targeted source, before deciding between an error and an empty
      // result. Without this, an unresolvable folder token — a typo, "root",
      // "../" — silently resolves to zero documents (storage.listDocuments
      // just finds no folder id to match) and is indistinguishable from
      // "this folder is real but genuinely empty". Real-world testing showed
      // an agent trying "." (a very natural root guess once ""/"/" are ruled
      // out) concluding the whole knowledge base was empty.
      //
      // The check has to span the WHOLE fan-out, not just single-source
      // calls: an earlier version only errored when `source` narrowed to
      // exactly one entry, and silently returned `[]` whenever a folder
      // matched zero of several fanned-out sources — recreating the exact
      // ambiguity this check exists to remove, just one level up. So we
      // record whether the folder matched ANY targeted source, and only
      // error if it matched none — same outcome for the single-source case,
      // now also correct for the multi-source one.
      const normalizedFolder = normalizeFolderToken(args.folder);
      const folderCheckNeeded = normalizedFolder !== '';
      let folderMatchedAnywhere = false;

      for (const entry of targetEntries) {
        const scope = entry.selection;

        // No pre-fetch folder-level ALLOWLIST gate here — deliberately.
        // `scope.allowedFolders` only covers WHOLE-folder auto-include
        // grants; documents can ALSO be individually allowlisted by path in
        // `scope.allowedDocuments` (e.g. every root-level document, per
        // buildDocumentScope in rag-access-state.ts, or any strict-mode
        // folder where docs were cherry-picked rather than the folder
        // itself). A folder can therefore be legitimately "accessible" with
        // zero entries in `allowedFolders` — checking only that list here
        // used to hard-reject requests rag_search allowed just fine, because
        // rag_search never pre-checks the folder at all: it filters each
        // resulting chunk's own document through isDocumentAllowedByChain
        // below, which correctly consults both lists. Deferring to the same
        // per-document check here (instead of a separate, narrower
        // pre-check) keeps the two tools in lockstep by construction.
        //
        // This is deliberately just an existence check, not a security
        // boundary — the error text is the same generic "unknown folder"
        // regardless of WHY it doesn't resolve anywhere, so it can't be used
        // to distinguish "doesn't exist" from "exists but you can't see it".
        if (folderCheckNeeded) {
          const knownFolders = await deps.storage.listFolders(entry.source.id);
          const folderExists = knownFolders.some(
            (f) => f.id === normalizedFolder || f.path === normalizedFolder,
          );
          if (!folderExists) {
            // Doesn't apply to this particular source — try the rest of the
            // fan-out before concluding the token is unknown everywhere.
            continue;
          }
          folderMatchedAnywhere = true;
        }

        let docs: RagDocument[];
        try {
          docs = await deps.storage.listDocuments(entry.source.id, args.folder);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          audit(
            'rag_list_documents',
            { folder: args.folder, source: args.source, limit },
            `error: ${message}`,
            'error',
            t0,
          );
          return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
        }

        // Post-fetch per-document allowlist filter with folder chain walk.
        for (const d of docs) {
          if (allDocuments.length >= limit) break;
          const chain = await deps.storage.getDocumentFolderChain(d.id);
          // Mirrors rag_search's synthesis exactly (see above): a document
          // with no real folder chain (root-level) still gets a single
          // synthetic ancestor entry rather than an empty chain, so both
          // tools evaluate root documents identically.
          const effectiveChain = chain.length > 0 ? chain : [{ id: d.folderId ?? '', path: args.folder }];
          if (!isDocumentAllowedByChain(d.id, d.path, effectiveChain, scope)) continue;
          allDocuments.push({
            id: d.id,
            name: d.name,
            sourceName: entry.source.name,
            mimeType: d.mimeType,
            size: d.size,
            modifiedAt: d.lastIndexedAt,
          });
        }
      }

      if (folderCheckNeeded && !folderMatchedAnywhere) {
        audit(
          'rag_list_documents',
          { folder: args.folder, source: args.source, limit },
          'unknown folder',
          'error',
          t0,
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: `Unknown folder "${args.folder}". Use rag_list_folders to discover valid folder paths, or omit "folder" / pass "" for the root.`,
              }),
            },
          ],
        };
      }

      const result = { documents: allDocuments.slice(0, limit) };
      audit(
        'rag_list_documents',
        { folder: args.folder, source: args.source, limit },
        `${result.documents.length} documents returned`,
        'success',
        t0,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ---------------------------------------------------------------------------
  // rag_get_document
  // Only registered when at least one source has directFetchDisabled !== true.
  // ---------------------------------------------------------------------------
  const fetchEnabled = sources.some((e) => e.selection.directFetchDisabled !== true);
  if (fetchEnabled) {
    server.tool(
      'rag_get_document',
      `Retrieve the full text content of a single document from the knowledge base. Use when the user names a document explicitly, or to expand on a chunk that rag_search returned but truncated. Content is capped at 50 KB — large documents are flagged truncated.`,
      {
        documentId: z.string().describe('The document id to retrieve.'),
      },
      async (args) => {
        const t0 = Date.now();

        // Per-session cap: prevent the LLM from bulk-reading all documents.
        if (directFetchCap > 0 && directFetchCount >= directFetchCap) {
          audit(
            'rag_get_document',
            { documentId: args.documentId },
            `cap exceeded (${directFetchCap})`,
            'error',
            t0,
          );
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Direct-fetch cap reached for this session (max ${directFetchCap} per turn). Use rag_search to find specific content instead.`,
                }),
              },
            ],
          };
        }
        directFetchCount++;

        let fetchResult: { doc: RagDocument; text: string } | null;
        try {
          fetchResult = await deps.storage.getDocument(args.documentId);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          audit(
            'rag_get_document',
            { documentId: args.documentId },
            `error: ${message}`,
            'error',
            t0,
          );
          return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
        }

        if (!fetchResult) {
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

        const { doc, text } = fetchResult;

        // Defense-in-depth tenant isolation: `documentId` is a GLOBAL identifier and
        // `storage.getDocument` fetches across all tenants without a tenant filter.
        // Reject any document that does not belong to the request tenant — and surface
        // it as a generic "not found" so the existence of cross-tenant documents is
        // never leaked.
        if (doc.tenantId !== tenantId) {
          audit(
            'rag_get_document',
            { documentId: args.documentId },
            'cross-tenant document blocked',
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

        // Resolve which source owns this document.
        const ownerEntry = sources.find((e) => e.source.id === doc.sourceId);

        // If the document's source is not in this profile, treat it as not found
        // (don't leak the existence of documents in other profiles).
        if (!ownerEntry) {
          audit(
            'rag_get_document',
            { documentId: args.documentId },
            'document not in profile',
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

        // Refuse if THIS source has directFetchDisabled.
        if (ownerEntry.selection.directFetchDisabled === true) {
          audit(
            'rag_get_document',
            { documentId: args.documentId },
            'direct fetch disabled for source',
            'error',
            t0,
          );
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Direct document fetch is disabled for the source "${ownerEntry.source.name}". Use rag_search instead.`,
                }),
              },
            ],
          };
        }

        const scope = ownerEntry.selection;

        // Allowlist enforcement — walk full ancestor chain.
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

        // Apply PII masking if enabled for this source.
        let finalText = capped;
        let piiRedacted: Partial<Record<PiiCategory, number>> | undefined;
        if (deps.piiMasking?.enabled && scope.piiMaskingMode !== 'off') {
          const masked = maskSearchResult(
            {
              chunks: [
                {
                  text: capped,
                  score: 0,
                  // Not a real search hit — this is a synthetic wrapper
                  // reusing maskSearchResult's masking logic on the whole
                  // fetched document, so there's no vector distance to
                  // derive a similarity from.
                  similarity: null,
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
          sourceName: ownerEntry.source.name,
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
        return { content: [{ type: 'text', text: JSON.stringify(response) }] };
      },
    );
  }
}
