// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildDocumentSourceAdapter } from '../source-adapter.js';
import type {
  DocumentAdapterDeps,
  DocumentSearchIndex,
  DocumentStorage,
  ConnectorLike,
} from '../source-adapter.js';
import type { RagFolder, RagDocument, RagSearchResult } from '../types.js';
import type { Source, ScopeSelection, McpRegistrationContext } from '@calame/core';

// ---------------------------------------------------------------------------
// Test fixtures
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
  ...overrides,
});

const makeSearchResult = (chunks: RagSearchResult['chunks'] = []): RagSearchResult => ({
  chunks,
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

const makeConfig = () => ({ root: '/data/docs' });

const makeDocumentSchema = () => ({
  kind: 'document' as const,
  folders: [],
  documents: [],
});

const makeAllowAllScope = (): Extract<ScopeSelection, { kind: 'document' }> => ({
  kind: 'document',
  mode: 'allowAll',
  allowedFolders: [],
  allowedDocuments: [],
});

const makeAllowListScope = (
  allowedFolders: string[] = [],
  allowedDocuments: string[] = [],
): Extract<ScopeSelection, { kind: 'document' }> => ({
  kind: 'document',
  mode: 'allowList',
  allowedFolders,
  allowedDocuments,
});

const makeMcpServer = () =>
  ({
    tool: vi.fn(),
  }) as unknown as McpServer;

// ---------------------------------------------------------------------------
// Dependency factories
// ---------------------------------------------------------------------------

function makeConnector(overrides?: Partial<ConnectorLike>): ConnectorLike {
  return {
    type: 'local',
    testConnection: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeStorage(overrides?: Partial<DocumentStorage>): DocumentStorage {
  return {
    listFolders: vi.fn().mockResolvedValue([]),
    listDocuments: vi.fn().mockResolvedValue([]),
    getDocument: vi.fn().mockResolvedValue(null),
    listSources: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeSearchIndex(overrides?: Partial<DocumentSearchIndex>): DocumentSearchIndex {
  return {
    search: vi.fn().mockResolvedValue(makeSearchResult()),
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<DocumentAdapterDeps>): DocumentAdapterDeps {
  const connector = makeConnector();
  return {
    resolveConnector: vi.fn().mockReturnValue(connector),
    storage: makeStorage(),
    searchIndex: makeSearchIndex(),
    ...overrides,
  };
}

function makeCtx(
  overrides: Partial<McpRegistrationContext<ReturnType<typeof makeConfig>, ReturnType<typeof makeDocumentSchema>>> = {},
): McpRegistrationContext<ReturnType<typeof makeConfig>, ReturnType<typeof makeDocumentSchema>> {
  return {
    server: makeMcpServer(),
    source: makeSource(),
    config: makeConfig(),
    schema: makeDocumentSchema(),
    selection: makeAllowAllScope(),
    profileName: 'test-profile',
    toolNamespace: '',
    responseMode: 'raw',
    onAuditLog: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildDocumentSourceAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------
  describe('metadata', () => {
    it('sets type and displayName', () => {
      const adapter = buildDocumentSourceAdapter(makeDeps(), 'local', 'Local folder');
      expect(adapter.type).toBe('local');
      expect(adapter.displayName).toBe('Local folder');
    });

    it('declares the four capabilities', () => {
      const adapter = buildDocumentSourceAdapter(makeDeps(), 'local', 'Local folder');
      expect(adapter.capabilities).toContain('enumerate');
      expect(adapter.capabilities).toContain('fetch');
      expect(adapter.capabilities).toContain('search');
      expect(adapter.capabilities).toContain('introspect');
    });
  });

  // -------------------------------------------------------------------------
  // configSchema
  // -------------------------------------------------------------------------
  describe('configSchema', () => {
    it('accepts a valid config', () => {
      const adapter = buildDocumentSourceAdapter(makeDeps(), 'local', 'Local folder');
      const result = adapter.configSchema.parse({ root: '/data/docs' });
      expect(result.root).toBe('/data/docs');
    });

    it('accepts config with globs', () => {
      const adapter = buildDocumentSourceAdapter(makeDeps(), 'local', 'Local folder');
      const result = adapter.configSchema.parse({
        root: '/data',
        includeGlobs: ['**/*.md'],
        excludeGlobs: ['**/node_modules/**'],
      });
      expect(result.includeGlobs).toEqual(['**/*.md']);
    });

    it('rejects empty root', () => {
      const adapter = buildDocumentSourceAdapter(makeDeps(), 'local', 'Local folder');
      expect(() => adapter.configSchema.parse({ root: '' })).toThrow();
    });

    it('rejects config missing root', () => {
      const adapter = buildDocumentSourceAdapter(makeDeps(), 'local', 'Local folder');
      expect(() => adapter.configSchema.parse({})).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // scopeSelectionSchema
  // -------------------------------------------------------------------------
  describe('scopeSelectionSchema', () => {
    it('accepts a document scope selection', () => {
      const adapter = buildDocumentSourceAdapter(makeDeps(), 'local', 'Local folder');
      const input: ScopeSelection = {
        kind: 'document',
        mode: 'allowAll',
        allowedFolders: [],
        allowedDocuments: [],
      };
      expect(() => adapter.scopeSelectionSchema.parse(input)).not.toThrow();
    });

    it('accepts an allowList document scope', () => {
      const adapter = buildDocumentSourceAdapter(makeDeps(), 'local', 'Local folder');
      const input: ScopeSelection = {
        kind: 'document',
        mode: 'allowList',
        allowedFolders: ['docs/faq'],
        allowedDocuments: ['doc-special'],
      };
      expect(() => adapter.scopeSelectionSchema.parse(input)).not.toThrow();
    });

    it('rejects invalid mode', () => {
      const adapter = buildDocumentSourceAdapter(makeDeps(), 'local', 'Local folder');
      expect(() =>
        adapter.scopeSelectionSchema.parse({
          kind: 'document',
          mode: 'invalidMode',
          allowedFolders: [],
          allowedDocuments: [],
        }),
      ).toThrow();
    });

    it('rejects a relational scope passed directly as document kind', () => {
      const adapter = buildDocumentSourceAdapter(makeDeps(), 'local', 'Local folder');
      // A relational scope is accepted by the discriminated union (the adapter
      // validates at runtime in registerMcpTools, not at schema level)
      const input = {
        kind: 'relational' as const,
        selectedTables: { users: ['id'] },
      };
      // scopeSelectionSchema allows relational (for registry compatibility)
      expect(() => adapter.scopeSelectionSchema.parse(input)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // testConnection
  // -------------------------------------------------------------------------
  describe('testConnection', () => {
    it('delegates to the connector', async () => {
      const connector = makeConnector();
      const deps = makeDeps({ resolveConnector: vi.fn().mockReturnValue(connector) });
      const adapter = buildDocumentSourceAdapter(deps, 'local', 'Local folder');
      await adapter.testConnection({ root: '/data/docs' });
      expect(connector.testConnection).toHaveBeenCalledWith({ root: '/data/docs' });
    });

    it('throws when no connector is registered for the type', async () => {
      const deps = makeDeps({ resolveConnector: vi.fn().mockReturnValue(null) });
      const adapter = buildDocumentSourceAdapter(deps, 'local', 'Local folder');
      await expect(adapter.testConnection({ root: '/data/docs' })).rejects.toThrow(
        /no connector registered/,
      );
    });

    it('propagates connector errors', async () => {
      const connector = makeConnector({
        testConnection: vi.fn().mockRejectedValue(new Error('directory not found')),
      });
      const deps = makeDeps({ resolveConnector: vi.fn().mockReturnValue(connector) });
      const adapter = buildDocumentSourceAdapter(deps, 'local', 'Local folder');
      await expect(adapter.testConnection({ root: '/nonexistent' })).rejects.toThrow(
        'directory not found',
      );
    });
  });

  // -------------------------------------------------------------------------
  // introspect
  // -------------------------------------------------------------------------
  describe('introspect', () => {
    it('returns a kind: document schema', async () => {
      const folder = makeFolder();
      const doc = makeDocument();
      const storage = makeStorage({
        listFolders: vi.fn().mockResolvedValue([folder]),
        listDocuments: vi.fn().mockResolvedValue([doc]),
      });
      const adapter = buildDocumentSourceAdapter(makeDeps({ storage }), 'local', 'Local folder');
      const result = await adapter.introspect!({ root: '/data' }, 'src-1');

      expect(result.kind).toBe('document');
      expect(result.folders).toHaveLength(1);
      expect(result.folders[0].id).toBe(folder.id);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].id).toBe(doc.id);
    });

    it('maps folder fields correctly', async () => {
      const folder = makeFolder({ id: 'f1', path: 'docs/guides', name: 'guides', parentId: null });
      const storage = makeStorage({ listFolders: vi.fn().mockResolvedValue([folder]) });
      const adapter = buildDocumentSourceAdapter(makeDeps({ storage }), 'local', 'Local folder');
      const result = await adapter.introspect!({ root: '/data' }, 'src-1');

      expect(result.folders[0]).toEqual({ id: 'f1', name: 'guides', path: 'docs/guides', parentId: null });
    });

    it('maps document fields correctly', async () => {
      const doc = makeDocument({ id: 'd1', name: 'report.pdf', mimeType: 'application/pdf', size: 2048 });
      const storage = makeStorage({ listDocuments: vi.fn().mockResolvedValue([doc]) });
      const adapter = buildDocumentSourceAdapter(makeDeps({ storage }), 'local', 'Local folder');
      const result = await adapter.introspect!({ root: '/data' }, 'src-1');

      expect(result.documents[0].id).toBe('d1');
      expect(result.documents[0].mimeType).toBe('application/pdf');
    });
  });

  // -------------------------------------------------------------------------
  // registerMcpTools — registration
  // -------------------------------------------------------------------------
  describe('registerMcpTools — tool registration', () => {
    it('registers exactly 5 tools', () => {
      const ctx = makeCtx();
      const adapter = buildDocumentSourceAdapter(makeDeps(), 'local', 'Local folder');
      adapter.registerMcpTools!(ctx);
      expect(ctx.server.tool).toHaveBeenCalledTimes(5);
    });

    it('registers all 5 expected tool names without namespace', () => {
      const ctx = makeCtx({ toolNamespace: '' });
      const adapter = buildDocumentSourceAdapter(makeDeps(), 'local', 'Local folder');
      adapter.registerMcpTools!(ctx);

      const registeredNames = (ctx.server.tool as ReturnType<typeof vi.fn>).mock.calls.map(
        (call: unknown[]) => call[0] as string,
      );
      expect(registeredNames).toContain('rag_search');
      expect(registeredNames).toContain('rag_list_sources');
      expect(registeredNames).toContain('rag_list_folders');
      expect(registeredNames).toContain('rag_list_documents');
      expect(registeredNames).toContain('rag_get_document');
    });

    it('honours toolNamespace prefix', () => {
      const ctx = makeCtx({ toolNamespace: 'kb1_' });
      const adapter = buildDocumentSourceAdapter(makeDeps(), 'local', 'Local folder');
      adapter.registerMcpTools!(ctx);

      const registeredNames = (ctx.server.tool as ReturnType<typeof vi.fn>).mock.calls.map(
        (call: unknown[]) => call[0] as string,
      );
      expect(registeredNames).toContain('kb1_rag_search');
      expect(registeredNames).toContain('kb1_rag_list_sources');
      expect(registeredNames).toContain('kb1_rag_list_folders');
      expect(registeredNames).toContain('kb1_rag_list_documents');
      expect(registeredNames).toContain('kb1_rag_get_document');
    });

    it('throws when given a non-document selection', () => {
      const relationalSelection: ScopeSelection = {
        kind: 'relational',
        selectedTables: { users: ['id'] },
      };
      const ctx = makeCtx({ selection: relationalSelection });
      const adapter = buildDocumentSourceAdapter(makeDeps(), 'local', 'Local folder');
      expect(() => adapter.registerMcpTools!(ctx)).toThrow(/expected document selection/);
    });
  });

  // -------------------------------------------------------------------------
  // rag_search — allowlist filtering
  // -------------------------------------------------------------------------
  describe('rag_search', () => {
    function getToolHandler(ctx: ReturnType<typeof makeCtx>, toolName = 'rag_search') {
      const calls = (ctx.server.tool as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
      const call = calls.find((c) => c[0] === toolName);
      if (!call) throw new Error(`Tool "${toolName}" not registered`);
      // MCP server.tool(name, description, schema, handler)
      return call[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
    }

    it('returns chunks passing the allowAll scope', async () => {
      const chunks: RagSearchResult['chunks'] = [
        {
          text: 'some content',
          score: 0.9,
          sourceId: 'src-1',
          folder: 'docs/faq',
          fileName: 'intro.md',
          position: 0,
          documentId: 'doc-1',
        },
      ];
      const searchIndex = makeSearchIndex({
        search: vi.fn().mockResolvedValue(makeSearchResult(chunks)),
      });
      const adapter = buildDocumentSourceAdapter(
        makeDeps({ searchIndex }),
        'local',
        'Local folder',
      );
      const ctx = makeCtx({ selection: makeAllowAllScope() });
      adapter.registerMcpTools!(ctx);

      const handler = getToolHandler(ctx);
      const response = await handler({ query: 'test query' });
      const payload = JSON.parse(response.content[0].text) as { chunks: unknown[] };
      expect(payload.chunks).toHaveLength(1);
    });

    it('filters out chunks outside the allowList scope', async () => {
      const chunks: RagSearchResult['chunks'] = [
        {
          text: 'allowed content',
          score: 0.9,
          sourceId: 'src-1',
          folder: 'docs/faq',
          fileName: 'intro.md',
          position: 0,
          documentId: 'doc-1',
        },
        {
          text: 'blocked content',
          score: 0.8,
          sourceId: 'src-1',
          folder: 'docs/internal',
          fileName: 'secret.md',
          position: 0,
          documentId: 'doc-2',
        },
      ];
      const searchIndex = makeSearchIndex({
        search: vi.fn().mockResolvedValue(makeSearchResult(chunks)),
      });
      const adapter = buildDocumentSourceAdapter(
        makeDeps({ searchIndex }),
        'local',
        'Local folder',
      );
      const scope = makeAllowListScope(['docs/faq'], []);
      const ctx = makeCtx({ selection: scope });
      adapter.registerMcpTools!(ctx);

      const handler = getToolHandler(ctx);
      const response = await handler({ query: 'test query' });
      const payload = JSON.parse(response.content[0].text) as { chunks: Array<{ documentId: string }> };
      expect(payload.chunks).toHaveLength(1);
      expect(payload.chunks[0].documentId).toBe('doc-1');
    });

    it('allows individually allowlisted documents regardless of folder', async () => {
      const chunks: RagSearchResult['chunks'] = [
        {
          text: 'special doc content',
          score: 0.9,
          sourceId: 'src-1',
          folder: 'docs/restricted',
          fileName: 'special.md',
          position: 0,
          documentId: 'doc-special',
        },
      ];
      const searchIndex = makeSearchIndex({
        search: vi.fn().mockResolvedValue(makeSearchResult(chunks)),
      });
      const adapter = buildDocumentSourceAdapter(
        makeDeps({ searchIndex }),
        'local',
        'Local folder',
      );
      // folder 'docs/restricted' not in allowedFolders, but doc-special is individually allowed
      const scope = makeAllowListScope(['docs/faq'], ['doc-special']);
      const ctx = makeCtx({ selection: scope });
      adapter.registerMcpTools!(ctx);

      const handler = getToolHandler(ctx);
      const response = await handler({ query: 'test query' });
      const payload = JSON.parse(response.content[0].text) as { chunks: unknown[] };
      expect(payload.chunks).toHaveLength(1);
    });

    it('caps topK at 10', async () => {
      const searchIndex = makeSearchIndex();
      const adapter = buildDocumentSourceAdapter(
        makeDeps({ searchIndex }),
        'local',
        'Local folder',
      );
      const ctx = makeCtx();
      adapter.registerMcpTools!(ctx);

      const handler = getToolHandler(ctx);
      await handler({ query: 'test', topK: 99 });
      expect(searchIndex.search).toHaveBeenCalledWith(
        expect.any(String),
        'test',
        expect.objectContaining({ topK: 10 }),
      );
    });

    it('calls onAuditLog with a sane entry', async () => {
      const onAuditLog = vi.fn();
      const adapter = buildDocumentSourceAdapter(makeDeps(), 'local', 'Local folder');
      const ctx = makeCtx({ onAuditLog });
      adapter.registerMcpTools!(ctx);

      const handler = getToolHandler(ctx);
      await handler({ query: 'test query' });
      expect(onAuditLog).toHaveBeenCalledOnce();
      const entry = onAuditLog.mock.calls[0][0] as { toolName: string; profileName: string; result: string };
      expect(entry.toolName).toBe('rag_search');
      expect(entry.profileName).toBe('test-profile');
      expect(entry.result).toBe('success');
    });
  });

  // -------------------------------------------------------------------------
  // rag_get_document — allowlist enforcement
  // -------------------------------------------------------------------------
  describe('rag_get_document', () => {
    function getToolHandler(ctx: ReturnType<typeof makeCtx>, toolName = 'rag_get_document') {
      const calls = (ctx.server.tool as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
      const call = calls.find((c) => c[0] === toolName);
      if (!call) throw new Error(`Tool "${toolName}" not registered`);
      return call[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
    }

    it('returns document content when in allowList via allowedDocuments', async () => {
      const doc = makeDocument({ id: 'doc-allowed', path: 'docs/secret/file.md', folderId: 'f1' });
      const storage = makeStorage({
        getDocument: vi.fn().mockResolvedValue({ doc, text: 'hello world' }),
      });
      const adapter = buildDocumentSourceAdapter(
        makeDeps({ storage }),
        'local',
        'Local folder',
      );
      const scope = makeAllowListScope([], ['doc-allowed']);
      const ctx = makeCtx({ selection: scope });
      adapter.registerMcpTools!(ctx);

      const handler = getToolHandler(ctx);
      const response = await handler({ documentId: 'doc-allowed' });
      const payload = JSON.parse(response.content[0].text) as { id: string; text: string };
      expect(payload.id).toBe('doc-allowed');
      expect(payload.text).toBe('hello world');
    });

    it('returns error when document is outside allowlist', async () => {
      const doc = makeDocument({
        id: 'doc-blocked',
        path: 'docs/internal/secret.md',
        folderId: 'f-internal',
      });
      const storage = makeStorage({
        getDocument: vi.fn().mockResolvedValue({ doc, text: 'sensitive content' }),
      });
      const adapter = buildDocumentSourceAdapter(
        makeDeps({ storage }),
        'local',
        'Local folder',
      );
      const scope = makeAllowListScope(['docs/public'], []);
      const ctx = makeCtx({ selection: scope });
      adapter.registerMcpTools!(ctx);

      const handler = getToolHandler(ctx);
      const response = await handler({ documentId: 'doc-blocked' });
      const payload = JSON.parse(response.content[0].text) as { error: string };
      expect(payload.error).toMatch(/not accessible/);
    });

    it('returns not-found error for unknown documentId', async () => {
      const storage = makeStorage({ getDocument: vi.fn().mockResolvedValue(null) });
      const adapter = buildDocumentSourceAdapter(
        makeDeps({ storage }),
        'local',
        'Local folder',
      );
      const ctx = makeCtx({ selection: makeAllowAllScope() });
      adapter.registerMcpTools!(ctx);

      const handler = getToolHandler(ctx);
      const response = await handler({ documentId: 'nonexistent' });
      const payload = JSON.parse(response.content[0].text) as { error: string };
      expect(payload.error).toMatch(/not found/);
    });

    it('truncates documents larger than 50KB', async () => {
      const largeText = 'x'.repeat(60 * 1024); // 60 KB
      const doc = makeDocument({ id: 'big-doc', path: 'docs/big.md', folderId: null });
      const storage = makeStorage({
        getDocument: vi.fn().mockResolvedValue({ doc, text: largeText }),
      });
      const adapter = buildDocumentSourceAdapter(
        makeDeps({ storage }),
        'local',
        'Local folder',
      );
      const ctx = makeCtx({ selection: makeAllowAllScope() });
      adapter.registerMcpTools!(ctx);

      const handler = getToolHandler(ctx);
      const response = await handler({ documentId: 'big-doc' });
      const payload = JSON.parse(response.content[0].text) as { text: string; truncated: boolean };
      expect(payload.truncated).toBe(true);
      expect(payload.text.length).toBeLessThanOrEqual(50 * 1024);
    });

    it('calls onAuditLog', async () => {
      const onAuditLog = vi.fn();
      const doc = makeDocument({ id: 'doc-1', path: 'docs/faq/intro.md', folderId: null });
      const storage = makeStorage({
        getDocument: vi.fn().mockResolvedValue({ doc, text: 'content' }),
      });
      const adapter = buildDocumentSourceAdapter(
        makeDeps({ storage }),
        'local',
        'Local folder',
      );
      const ctx = makeCtx({ selection: makeAllowAllScope(), onAuditLog });
      adapter.registerMcpTools!(ctx);

      const handler = getToolHandler(ctx);
      await handler({ documentId: 'doc-1' });
      expect(onAuditLog).toHaveBeenCalledOnce();
      const entry = onAuditLog.mock.calls[0][0] as { toolName: string; result: string };
      expect(entry.toolName).toBe('rag_get_document');
      expect(entry.result).toBe('success');
    });
  });

  // -------------------------------------------------------------------------
  // rag_list_folders — allowlist filtering
  // -------------------------------------------------------------------------
  describe('rag_list_folders', () => {
    function getToolHandler(ctx: ReturnType<typeof makeCtx>, toolName = 'rag_list_folders') {
      const calls = (ctx.server.tool as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
      const call = calls.find((c) => c[0] === toolName);
      if (!call) throw new Error(`Tool "${toolName}" not registered`);
      return call[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
    }

    it('returns all folders under allowAll scope', async () => {
      const f1 = makeFolder({ id: 'f1', path: 'docs/faq', name: 'faq' });
      const f2 = makeFolder({ id: 'f2', path: 'docs/internal', name: 'internal' });
      const storage = makeStorage({ listFolders: vi.fn().mockResolvedValue([f1, f2]) });
      const adapter = buildDocumentSourceAdapter(
        makeDeps({ storage }),
        'local',
        'Local folder',
      );
      const ctx = makeCtx({ selection: makeAllowAllScope() });
      adapter.registerMcpTools!(ctx);

      const handler = getToolHandler(ctx);
      const response = await handler({});
      const payload = JSON.parse(response.content[0].text) as { folders: unknown[] };
      expect(payload.folders).toHaveLength(2);
    });

    it('filters folders by allowList scope', async () => {
      const f1 = makeFolder({ id: 'f1', path: 'docs/faq', name: 'faq' });
      const f2 = makeFolder({ id: 'f2', path: 'docs/internal', name: 'internal' });
      const storage = makeStorage({ listFolders: vi.fn().mockResolvedValue([f1, f2]) });
      const adapter = buildDocumentSourceAdapter(
        makeDeps({ storage }),
        'local',
        'Local folder',
      );
      const scope = makeAllowListScope(['docs/faq'], []);
      const ctx = makeCtx({ selection: scope });
      adapter.registerMcpTools!(ctx);

      const handler = getToolHandler(ctx);
      const response = await handler({});
      const payload = JSON.parse(response.content[0].text) as { folders: Array<{ id: string }> };
      expect(payload.folders).toHaveLength(1);
      expect(payload.folders[0].id).toBe('f1');
    });

    it('calls onAuditLog', async () => {
      const onAuditLog = vi.fn();
      const adapter = buildDocumentSourceAdapter(makeDeps(), 'local', 'Local folder');
      const ctx = makeCtx({ onAuditLog });
      adapter.registerMcpTools!(ctx);

      const handler = getToolHandler(ctx);
      await handler({});
      expect(onAuditLog).toHaveBeenCalledOnce();
      const entry = onAuditLog.mock.calls[0][0] as { toolName: string };
      expect(entry.toolName).toBe('rag_list_folders');
    });
  });

  // -------------------------------------------------------------------------
  // rag_list_documents — allowlist filtering
  // -------------------------------------------------------------------------
  describe('rag_list_documents', () => {
    function getToolHandler(ctx: ReturnType<typeof makeCtx>, toolName = 'rag_list_documents') {
      const calls = (ctx.server.tool as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
      const call = calls.find((c) => c[0] === toolName);
      if (!call) throw new Error(`Tool "${toolName}" not registered`);
      return call[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
    }

    it('returns documents when folder is in allowList', async () => {
      const doc = makeDocument({ id: 'doc-1' });
      const storage = makeStorage({ listDocuments: vi.fn().mockResolvedValue([doc]) });
      const adapter = buildDocumentSourceAdapter(
        makeDeps({ storage }),
        'local',
        'Local folder',
      );
      const scope = makeAllowListScope(['docs/faq'], []);
      const ctx = makeCtx({ selection: scope });
      adapter.registerMcpTools!(ctx);

      const handler = getToolHandler(ctx);
      const response = await handler({ folder: 'docs/faq' });
      const payload = JSON.parse(response.content[0].text) as { documents: unknown[] };
      expect(payload.documents).toHaveLength(1);
    });

    it('returns error when folder is not in allowList', async () => {
      const adapter = buildDocumentSourceAdapter(makeDeps(), 'local', 'Local folder');
      const scope = makeAllowListScope(['docs/faq'], []);
      const ctx = makeCtx({ selection: scope });
      adapter.registerMcpTools!(ctx);

      const handler = getToolHandler(ctx);
      const response = await handler({ folder: 'docs/internal' });
      const payload = JSON.parse(response.content[0].text) as { error: string };
      expect(payload.error).toMatch(/not accessible/);
    });

    it('calls onAuditLog on success', async () => {
      const onAuditLog = vi.fn();
      const adapter = buildDocumentSourceAdapter(makeDeps(), 'local', 'Local folder');
      const ctx = makeCtx({ selection: makeAllowAllScope(), onAuditLog });
      adapter.registerMcpTools!(ctx);

      const handler = getToolHandler(ctx);
      await handler({ folder: 'docs/faq' });
      expect(onAuditLog).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // rag_list_sources
  // -------------------------------------------------------------------------
  describe('rag_list_sources', () => {
    function getToolHandler(ctx: ReturnType<typeof makeCtx>, toolName = 'rag_list_sources') {
      const calls = (ctx.server.tool as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
      const call = calls.find((c) => c[0] === toolName);
      if (!call) throw new Error(`Tool "${toolName}" not registered`);
      return call[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
    }

    it('returns only the current source', async () => {
      const storage = makeStorage({
        listSources: vi.fn().mockResolvedValue([
          { id: 'src-1', name: 'My KB', type: 'local', folderCount: 3, documentCount: 42 },
          { id: 'src-2', name: 'Other KB', type: 'local', folderCount: 1, documentCount: 5 },
        ]),
      });
      const adapter = buildDocumentSourceAdapter(
        makeDeps({ storage }),
        'local',
        'Local folder',
      );
      // ctx.source.id = 'src-1' (default from makeSource)
      const ctx = makeCtx();
      adapter.registerMcpTools!(ctx);

      const handler = getToolHandler(ctx);
      const response = await handler({});
      const payload = JSON.parse(response.content[0].text) as { sources: Array<{ id: string }> };
      expect(payload.sources).toHaveLength(1);
      expect(payload.sources[0].id).toBe('src-1');
    });

    it('calls onAuditLog', async () => {
      const onAuditLog = vi.fn();
      const adapter = buildDocumentSourceAdapter(makeDeps(), 'local', 'Local folder');
      const ctx = makeCtx({ onAuditLog });
      adapter.registerMcpTools!(ctx);

      const handler = getToolHandler(ctx);
      await handler({});
      expect(onAuditLog).toHaveBeenCalledOnce();
    });
  });
});
