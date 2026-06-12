// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Tests for registerMergedDocumentRagTools — the Phase 4 multi-source RAG
 * tool set.
 *
 * Covered:
 *  - Tools registered WITHOUT namespace prefix (rag_search, rag_list_sources,
 *    rag_list_folders, rag_list_documents, rag_get_document).
 *  - Multi-source fan-out: searching across multiple sources.
 *  - Per-source scope (allowedFolders) applied after search.
 *  - Unknown `source` parameter returns a clear error.
 *  - rag_get_document: mixed directFetchDisabled (one on / one off) —
 *    tool is registered; call refused for the disabled source.
 *  - rag_get_document NOT registered when ALL sources have directFetchDisabled=true.
 *  - tenantId is always forwarded to searchIndex.search().
 *  - rag_list_sources returns only sources in the profile (not all stored sources).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMergedDocumentRagTools } from '../merged-rag-tools.js';
import type { RegisterMergedDocumentRagToolsOpts, MergedSourceEntry } from '../merged-rag-tools.js';
import type {
  DocumentAdapterDeps,
  DocumentSearchIndex,
  DocumentStorage,
} from '../source-adapter.js';
import type { RagFolder, RagDocument, RagSearchResult } from '../types.js';
import type { Source, ScopeSelection } from '@calame/core';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeFolder = (overrides?: Partial<RagFolder>): RagFolder => ({
  id: 'folder-1',
  sourceId: 'src-1',
  parentId: null,
  path: 'docs/faq',
  name: 'faq',
  tenantId: 'default',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const makeDocument = (overrides?: Partial<RagDocument>): RagDocument => ({
  id: 'doc-1',
  sourceId: 'src-1',
  folderId: 'folder-1',
  path: 'docs/faq/intro.md',
  name: 'intro.md',
  mimeType: 'text/markdown',
  size: 1024,
  hash: 'abc123',
  etag: null,
  tenantId: 'default',
  lastIndexedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  ingestError: null,
  ...overrides,
});

const makeSource = (overrides?: Partial<Source>): Source => ({
  id: 'src-1',
  name: 'My KB',
  type: 'local',
  configEncrypted: '',
  capabilities: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const makeAllowAllScope = (): Extract<ScopeSelection, { kind: 'document' }> => ({
  kind: 'document',
  mode: 'allowAll',
  allowedFolders: [],
  allowedDocuments: [],
});

// Note: makeAllowListScope is used indirectly through makeEntry's selectionOverrides
// (tests pass allowedFolders/allowedDocuments directly in the overrides object).

const makeMcpServer = () => ({ tool: vi.fn() }) as unknown as McpServer;

function makeStorage(overrides?: Partial<DocumentStorage>): DocumentStorage {
  return {
    listFolders: vi.fn().mockResolvedValue([]),
    listDocuments: vi.fn().mockResolvedValue([]),
    getDocument: vi.fn().mockResolvedValue(null),
    listSources: vi.fn().mockResolvedValue([]),
    getDocumentFolderChain: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeSearchIndex(overrides?: Partial<DocumentSearchIndex>): DocumentSearchIndex {
  return {
    search: vi.fn().mockResolvedValue({ chunks: [] }),
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<DocumentAdapterDeps>): DocumentAdapterDeps {
  return {
    resolveConnector: vi.fn().mockReturnValue(null),
    storage: makeStorage(),
    searchIndex: makeSearchIndex(),
    ...overrides,
  };
}

function makeEntry(overrides?: {
  sourceOverrides?: Partial<Source>;
  selectionOverrides?: Partial<Extract<ScopeSelection, { kind: 'document' }>>;
}): MergedSourceEntry {
  return {
    source: makeSource(overrides?.sourceOverrides),
    selection: { ...makeAllowAllScope(), ...overrides?.selectionOverrides },
    config: { root: '/data' },
  };
}

function makeOpts(overrides?: Partial<RegisterMergedDocumentRagToolsOpts>): RegisterMergedDocumentRagToolsOpts {
  return {
    server: makeMcpServer(),
    deps: makeDeps(),
    tenantId: 'tenant-abc',
    sources: [makeEntry()],
    profileName: 'test-profile',
    responseMode: 'raw',
    onAuditLog: vi.fn(),
    ...overrides,
  };
}

/** Retrieve a registered tool handler by name. */
function getToolHandler(server: McpServer, toolName: string) {
  const calls = (server.tool as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
  const call = calls.find((c) => c[0] === toolName);
  if (!call) throw new Error(`Tool "${toolName}" not found in registrations`);
  return call[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerMergedDocumentRagTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Tool registration — no namespace prefix
  // -------------------------------------------------------------------------
  describe('tool registration', () => {
    it('registers exactly 5 tools', () => {
      const opts = makeOpts();
      registerMergedDocumentRagTools(opts);
      expect(opts.server.tool).toHaveBeenCalledTimes(5);
    });

    it('registers tools WITHOUT a namespace prefix', () => {
      const opts = makeOpts();
      registerMergedDocumentRagTools(opts);
      const names = (opts.server.tool as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      expect(names).toContain('rag_search');
      expect(names).toContain('rag_list_sources');
      expect(names).toContain('rag_list_folders');
      expect(names).toContain('rag_list_documents');
      expect(names).toContain('rag_get_document');
    });

    it('does NOT register rag_get_document when ALL sources have directFetchDisabled=true', () => {
      const opts = makeOpts({
        sources: [
          makeEntry({ selectionOverrides: { directFetchDisabled: true } }),
          makeEntry({ sourceOverrides: { id: 'src-2', name: 'KB2' }, selectionOverrides: { directFetchDisabled: true } }),
        ],
      });
      registerMergedDocumentRagTools(opts);
      const names = (opts.server.tool as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      expect(names).not.toContain('rag_get_document');
      expect(names).toHaveLength(4);
    });

    it('registers rag_get_document when at least ONE source has directFetchDisabled !== true', () => {
      const opts = makeOpts({
        sources: [
          makeEntry({ selectionOverrides: { directFetchDisabled: true } }),
          makeEntry({ sourceOverrides: { id: 'src-2', name: 'KB2' }, selectionOverrides: { directFetchDisabled: false } }),
        ],
      });
      registerMergedDocumentRagTools(opts);
      const names = (opts.server.tool as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      expect(names).toContain('rag_get_document');
    });

    it('registers nothing when sources is empty', () => {
      const opts = makeOpts({ sources: [] });
      registerMergedDocumentRagTools(opts);
      expect(opts.server.tool).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // rag_search — single source
  // -------------------------------------------------------------------------
  describe('rag_search — single source', () => {
    it('returns chunks from the single source (allowAll scope)', async () => {
      const chunks: RagSearchResult['chunks'] = [
        {
          text: 'hello world',
          score: 0.9,
          sourceId: 'src-1',
          folder: 'docs/faq',
          fileName: 'intro.md',
          position: 0,
          documentId: 'doc-1',
        },
      ];
      const searchIndex = makeSearchIndex({
        search: vi.fn().mockResolvedValue({ chunks }),
      });
      const opts = makeOpts({ deps: makeDeps({ searchIndex }) });
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_search');
      const response = await handler({ query: 'test' });
      const payload = JSON.parse(response.content[0].text) as { chunks: unknown[] };
      expect(payload.chunks).toHaveLength(1);
    });

    it('always passes tenantId to searchIndex.search', async () => {
      const searchIndex = makeSearchIndex();
      const opts = makeOpts({ deps: makeDeps({ searchIndex }), tenantId: 'tenant-xyz' });
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_search');
      await handler({ query: 'test' });
      expect(searchIndex.search).toHaveBeenCalledWith(
        expect.any(String),
        'test',
        expect.objectContaining({ tenantId: 'tenant-xyz' }),
      );
    });

    it('returns error for unknown source parameter', async () => {
      const opts = makeOpts();
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_search');
      const response = await handler({ query: 'test', source: 'NonExistentSource' });
      const payload = JSON.parse(response.content[0].text) as { error: string };
      expect(payload.error).toMatch(/Unknown source/);
      expect(payload.error).toMatch(/NonExistentSource/);
    });

    it('resolves source by name case-insensitively', async () => {
      const searchIndex = makeSearchIndex({
        search: vi.fn().mockResolvedValue({ chunks: [] }),
      });
      const opts = makeOpts({
        deps: makeDeps({ searchIndex }),
        sources: [makeEntry({ sourceOverrides: { name: 'My KB' } })],
      });
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_search');
      // Lowercase name — should resolve to 'My KB'
      await handler({ query: 'test', source: 'my kb' });
      expect(searchIndex.search).toHaveBeenCalled();
    });

    it('applies per-source allowList scope and filters out non-allowed chunks', async () => {
      const chunks: RagSearchResult['chunks'] = [
        {
          text: 'allowed',
          score: 0.9,
          sourceId: 'src-1',
          folder: 'docs/faq',
          fileName: 'intro.md',
          position: 0,
          documentId: 'doc-1',
        },
        {
          text: 'blocked',
          score: 0.8,
          sourceId: 'src-1',
          folder: 'docs/internal',
          fileName: 'secret.md',
          position: 0,
          documentId: 'doc-2',
        },
      ];
      const searchIndex = makeSearchIndex({ search: vi.fn().mockResolvedValue({ chunks }) });
      const opts = makeOpts({
        deps: makeDeps({ searchIndex }),
        sources: [makeEntry({ selectionOverrides: { mode: 'allowList', allowedFolders: ['docs/faq'], allowedDocuments: [] } })],
      });
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_search');
      const response = await handler({ query: 'test' });
      const payload = JSON.parse(response.content[0].text) as { chunks: Array<{ documentId: string }> };
      expect(payload.chunks).toHaveLength(1);
      expect(payload.chunks[0].documentId).toBe('doc-1');
    });

    it('each returned chunk carries a sourceName field', async () => {
      const chunks: RagSearchResult['chunks'] = [
        {
          text: 'hello',
          score: 0.9,
          sourceId: 'src-1',
          folder: 'docs',
          fileName: 'a.md',
          position: 0,
          documentId: 'doc-1',
        },
      ];
      const searchIndex = makeSearchIndex({ search: vi.fn().mockResolvedValue({ chunks }) });
      const opts = makeOpts({
        deps: makeDeps({ searchIndex }),
        sources: [makeEntry({ sourceOverrides: { name: 'Primary KB' } })],
      });
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_search');
      const response = await handler({ query: 'test' });
      const payload = JSON.parse(response.content[0].text) as { chunks: Array<{ sourceName: string }> };
      expect(payload.chunks[0].sourceName).toBe('Primary KB');
    });

    it('caps topK at 10', async () => {
      const searchIndex = makeSearchIndex();
      const opts = makeOpts({ deps: makeDeps({ searchIndex }) });
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_search');
      await handler({ query: 'test', topK: 99 });
      expect(searchIndex.search).toHaveBeenCalledWith(
        expect.any(String),
        'test',
        expect.objectContaining({ topK: 10 }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // rag_search — multi-source
  // -------------------------------------------------------------------------
  describe('rag_search — multi-source', () => {
    it('fans out across all sources when no source parameter is given', async () => {
      const searchIndex = makeSearchIndex({
        search: vi.fn().mockResolvedValue({ chunks: [] }),
      });
      const opts = makeOpts({
        deps: makeDeps({ searchIndex }),
        sources: [
          makeEntry({ sourceOverrides: { id: 'src-1', name: 'KB1' } }),
          makeEntry({ sourceOverrides: { id: 'src-2', name: 'KB2' } }),
        ],
      });
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_search');
      await handler({ query: 'test' });
      // With two sources and no `source` filter: sourceIds is passed.
      expect(searchIndex.search).toHaveBeenCalledWith(
        expect.any(String),
        'test',
        expect.objectContaining({ sourceIds: expect.arrayContaining(['src-1', 'src-2']) }),
      );
    });

    it('restricts to a specific source when source is given', async () => {
      const searchIndex = makeSearchIndex({
        search: vi.fn().mockResolvedValue({ chunks: [] }),
      });
      const opts = makeOpts({
        deps: makeDeps({ searchIndex }),
        sources: [
          makeEntry({ sourceOverrides: { id: 'src-1', name: 'KB1' } }),
          makeEntry({ sourceOverrides: { id: 'src-2', name: 'KB2' } }),
        ],
      });
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_search');
      await handler({ query: 'test', source: 'KB1' });
      // Single-source call: no sourceIds, just the single sourceId.
      const call = (searchIndex.search as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toBe('src-1');
      expect((call[2] as Record<string, unknown>).sourceIds).toBeUndefined();
    });

    it('applies per-source scope when returning multi-source results', async () => {
      // src-1: allowAll, src-2: allowList(['docs/public'])
      const chunksFromSrc1: RagSearchResult['chunks'] = [
        { text: 'src1-chunk', score: 0.9, sourceId: 'src-1', folder: 'docs/private', fileName: 'priv.md', position: 0, documentId: 'doc-1' },
      ];
      const chunksFromSrc2: RagSearchResult['chunks'] = [
        { text: 'src2-allowed', score: 0.85, sourceId: 'src-2', folder: 'docs/public', fileName: 'pub.md', position: 0, documentId: 'doc-2' },
        { text: 'src2-blocked', score: 0.8, sourceId: 'src-2', folder: 'docs/hidden', fileName: 'hidden.md', position: 0, documentId: 'doc-3' },
      ];
      // Multi-source returns merged chunks
      const searchIndex = makeSearchIndex({
        search: vi.fn().mockResolvedValue({ chunks: [...chunksFromSrc1, ...chunksFromSrc2] }),
      });
      const opts = makeOpts({
        deps: makeDeps({ searchIndex }),
        sources: [
          makeEntry({ sourceOverrides: { id: 'src-1', name: 'KB1' }, selectionOverrides: { mode: 'allowAll', allowedFolders: [], allowedDocuments: [] } }),
          makeEntry({ sourceOverrides: { id: 'src-2', name: 'KB2' }, selectionOverrides: { mode: 'allowList', allowedFolders: ['docs/public'], allowedDocuments: [] } }),
        ],
      });
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_search');
      const response = await handler({ query: 'test' });
      const payload = JSON.parse(response.content[0].text) as { chunks: Array<{ documentId: string }> };
      // src-1 chunk passes (allowAll), src-2 allowed chunk passes, src-2 blocked chunk filtered.
      const ids = payload.chunks.map((c) => c.documentId);
      expect(ids).toContain('doc-1');
      expect(ids).toContain('doc-2');
      expect(ids).not.toContain('doc-3');
    });
  });

  // -------------------------------------------------------------------------
  // rag_list_sources
  // -------------------------------------------------------------------------
  describe('rag_list_sources', () => {
    it('returns only sources belonging to this profile', async () => {
      const storage = makeStorage({
        listSources: vi.fn().mockResolvedValue([
          { id: 'src-1', name: 'My KB', type: 'local', folderCount: 5, documentCount: 42 },
          { id: 'src-other', name: 'Other', type: 'local', folderCount: 1, documentCount: 3 },
        ]),
      });
      const opts = makeOpts({ deps: makeDeps({ storage }) });
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_list_sources');
      const response = await handler({});
      const payload = JSON.parse(response.content[0].text) as { sources: Array<{ id: string }> };
      expect(payload.sources).toHaveLength(1);
      expect(payload.sources[0].id).toBe('src-1');
    });

    it('returns all configured sources when profile has multiple', async () => {
      const storage = makeStorage({
        listSources: vi.fn().mockResolvedValue([
          { id: 'src-1', name: 'KB1', type: 'local', folderCount: 2, documentCount: 10 },
          { id: 'src-2', name: 'KB2', type: 'local', folderCount: 1, documentCount: 5 },
        ]),
      });
      const opts = makeOpts({
        deps: makeDeps({ storage }),
        sources: [
          makeEntry({ sourceOverrides: { id: 'src-1', name: 'KB1' } }),
          makeEntry({ sourceOverrides: { id: 'src-2', name: 'KB2' } }),
        ],
      });
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_list_sources');
      const response = await handler({});
      const payload = JSON.parse(response.content[0].text) as { sources: Array<{ id: string }> };
      expect(payload.sources).toHaveLength(2);
    });

    it('calls onAuditLog', async () => {
      const onAuditLog = vi.fn();
      const opts = makeOpts({ onAuditLog });
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_list_sources');
      await handler({});
      expect(onAuditLog).toHaveBeenCalledOnce();
      const entry = onAuditLog.mock.calls[0][0] as { toolName: string; result: string };
      expect(entry.toolName).toBe('rag_list_sources');
      expect(entry.result).toBe('success');
    });
  });

  // -------------------------------------------------------------------------
  // rag_list_folders
  // -------------------------------------------------------------------------
  describe('rag_list_folders', () => {
    it('returns folders from all sources when no source is specified', async () => {
      const f1 = makeFolder({ id: 'f1', sourceId: 'src-1', path: 'docs/faq', name: 'faq' });
      const f2 = makeFolder({ id: 'f2', sourceId: 'src-2', path: 'files/pub', name: 'pub' });
      const storage = makeStorage({
        listFolders: vi
          .fn()
          .mockResolvedValueOnce([f1])
          .mockResolvedValueOnce([f2]),
      });
      const opts = makeOpts({
        deps: makeDeps({ storage }),
        sources: [
          makeEntry({ sourceOverrides: { id: 'src-1', name: 'KB1' } }),
          makeEntry({ sourceOverrides: { id: 'src-2', name: 'KB2' } }),
        ],
      });
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_list_folders');
      const response = await handler({});
      const payload = JSON.parse(response.content[0].text) as { folders: Array<{ id: string; sourceName: string }> };
      expect(payload.folders).toHaveLength(2);
      expect(payload.folders.find((f) => f.id === 'f1')?.sourceName).toBe('KB1');
      expect(payload.folders.find((f) => f.id === 'f2')?.sourceName).toBe('KB2');
    });

    it('returns error for unknown source parameter', async () => {
      const opts = makeOpts();
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_list_folders');
      const response = await handler({ source: 'NonExistent' });
      const payload = JSON.parse(response.content[0].text) as { error: string };
      expect(payload.error).toMatch(/Unknown source/);
    });

    it('applies allowList scope per source', async () => {
      const f1 = makeFolder({ id: 'f1', path: 'docs/faq', name: 'faq' });
      const f2 = makeFolder({ id: 'f2', path: 'docs/internal', name: 'internal' });
      const storage = makeStorage({ listFolders: vi.fn().mockResolvedValue([f1, f2]) });
      const opts = makeOpts({
        deps: makeDeps({ storage }),
        sources: [
          makeEntry({ selectionOverrides: { mode: 'allowList', allowedFolders: ['docs/faq'], allowedDocuments: [] } }),
        ],
      });
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_list_folders');
      const response = await handler({});
      const payload = JSON.parse(response.content[0].text) as { folders: Array<{ id: string }> };
      expect(payload.folders).toHaveLength(1);
      expect(payload.folders[0].id).toBe('f1');
    });
  });

  // -------------------------------------------------------------------------
  // rag_get_document — directFetchDisabled mixed
  // -------------------------------------------------------------------------
  describe('rag_get_document — directFetchDisabled', () => {
    it('refuses fetch when the owning source has directFetchDisabled=true', async () => {
      // tenantId must match opts.tenantId ('tenant-abc') so the tenant check passes
      // and the directFetchDisabled guard is reached.
      const doc = makeDocument({ id: 'doc-1', sourceId: 'src-disabled', tenantId: 'tenant-abc' });
      const storage = makeStorage({
        getDocument: vi.fn().mockResolvedValue({ doc, text: 'sensitive' }),
      });
      const opts = makeOpts({
        deps: makeDeps({ storage }),
        sources: [
          // src-disabled: fetch disabled
          makeEntry({ sourceOverrides: { id: 'src-disabled', name: 'Restricted KB' }, selectionOverrides: { directFetchDisabled: true } }),
          // src-enabled: fetch allowed
          makeEntry({ sourceOverrides: { id: 'src-enabled', name: 'Open KB' }, selectionOverrides: { directFetchDisabled: false } }),
        ],
      });
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_get_document');
      const response = await handler({ documentId: 'doc-1' });
      const payload = JSON.parse(response.content[0].text) as { error: string };
      expect(payload.error).toMatch(/direct document fetch is disabled/i);
    });

    it('succeeds when the owning source has directFetchDisabled=false', async () => {
      const doc = makeDocument({ id: 'doc-2', sourceId: 'src-enabled', path: 'docs/pub.md', folderId: null, tenantId: 'tenant-abc' });
      const storage = makeStorage({
        getDocument: vi.fn().mockResolvedValue({ doc, text: 'public content' }),
      });
      const opts = makeOpts({
        deps: makeDeps({ storage }),
        sources: [
          makeEntry({ sourceOverrides: { id: 'src-disabled', name: 'Restricted KB' }, selectionOverrides: { directFetchDisabled: true } }),
          makeEntry({ sourceOverrides: { id: 'src-enabled', name: 'Open KB' }, selectionOverrides: { directFetchDisabled: false } }),
        ],
      });
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_get_document');
      const response = await handler({ documentId: 'doc-2' });
      const payload = JSON.parse(response.content[0].text) as { id: string; text: string };
      expect(payload.id).toBe('doc-2');
      expect(payload.text).toBe('public content');
    });

    it('returns not-found when document source is not in profile', async () => {
      // Document is from a source not in this profile
      const doc = makeDocument({ id: 'doc-3', sourceId: 'src-other' });
      const storage = makeStorage({
        getDocument: vi.fn().mockResolvedValue({ doc, text: 'secret' }),
      });
      const opts = makeOpts({ deps: makeDeps({ storage }) });
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_get_document');
      const response = await handler({ documentId: 'doc-3' });
      const payload = JSON.parse(response.content[0].text) as { error: string };
      // Must not leak existence — surface as not found.
      expect(payload.error).toMatch(/not found/);
    });

    it('each response carries sourceName', async () => {
      const doc = makeDocument({ id: 'doc-4', sourceId: 'src-1', path: 'docs/x.md', folderId: null, tenantId: 'tenant-abc' });
      const storage = makeStorage({
        getDocument: vi.fn().mockResolvedValue({ doc, text: 'content' }),
      });
      const opts = makeOpts({
        deps: makeDeps({ storage }),
        sources: [makeEntry({ sourceOverrides: { id: 'src-1', name: 'Named KB' } })],
      });
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_get_document');
      const response = await handler({ documentId: 'doc-4' });
      const payload = JSON.parse(response.content[0].text) as { sourceName: string };
      expect(payload.sourceName).toBe('Named KB');
    });
  });

  // -------------------------------------------------------------------------
  // rag_get_document — cross-tenant isolation
  // -------------------------------------------------------------------------
  describe('rag_get_document — cross-tenant isolation', () => {
    it('returns not-found when the document belongs to a different tenant', async () => {
      // The document is stored under tenant "tenant-other", but the session runs
      // as "tenant-abc". getDocument returns a doc with a mismatched tenantId.
      const doc = makeDocument({ id: 'doc-cross', sourceId: 'src-1', tenantId: 'tenant-other' });
      const storage = makeStorage({
        getDocument: vi.fn().mockResolvedValue({ doc, text: 'sensitive cross-tenant content' }),
      });
      const opts = makeOpts({
        deps: makeDeps({ storage }),
        tenantId: 'tenant-abc',
        sources: [makeEntry({ sourceOverrides: { id: 'src-1', name: 'My KB' } })],
      });
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_get_document');
      const response = await handler({ documentId: 'doc-cross' });
      const payload = JSON.parse(response.content[0].text) as { error: string };

      // Must surface as "not found" — never reveal cross-tenant existence.
      expect(payload.error).toMatch(/not found/i);
      expect(payload.error).not.toMatch(/tenant/i);
      expect(payload.error).not.toMatch(/blocked/i);
    });

    it('returns the document when tenant matches (nominal path)', async () => {
      const doc = makeDocument({
        id: 'doc-same-tenant',
        sourceId: 'src-1',
        path: 'docs/report.md',
        folderId: null,
        tenantId: 'tenant-abc',
      });
      const storage = makeStorage({
        getDocument: vi.fn().mockResolvedValue({ doc, text: 'authorized content' }),
      });
      const opts = makeOpts({
        deps: makeDeps({ storage }),
        tenantId: 'tenant-abc',
        sources: [makeEntry({ sourceOverrides: { id: 'src-1', name: 'My KB' } })],
      });
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_get_document');
      const response = await handler({ documentId: 'doc-same-tenant' });
      const payload = JSON.parse(response.content[0].text) as { id: string; text: string };

      expect(payload.id).toBe('doc-same-tenant');
      expect(payload.text).toBe('authorized content');
    });
  });

  // -------------------------------------------------------------------------
  // tenantId forwarding
  // -------------------------------------------------------------------------
  describe('tenantId security invariant', () => {
    it('rag_search always forwards tenantId to the search index', async () => {
      const searchIndex = makeSearchIndex();
      const opts = makeOpts({ deps: makeDeps({ searchIndex }), tenantId: 'acme-corp' });
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_search');
      await handler({ query: 'hello' });
      const callOpts = (searchIndex.search as ReturnType<typeof vi.fn>).mock.calls[0]![2] as Record<string, unknown>;
      expect(callOpts.tenantId).toBe('acme-corp');
    });

    it('uses default tenant when tenantId is "default"', async () => {
      const searchIndex = makeSearchIndex();
      const opts = makeOpts({ deps: makeDeps({ searchIndex }), tenantId: 'default' });
      registerMergedDocumentRagTools(opts);

      const handler = getToolHandler(opts.server, 'rag_search');
      await handler({ query: 'hello' });
      const callOpts = (searchIndex.search as ReturnType<typeof vi.fn>).mock.calls[0]![2] as Record<string, unknown>;
      expect(callOpts.tenantId).toBe('default');
    });
  });
});
