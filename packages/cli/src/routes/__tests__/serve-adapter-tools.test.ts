/**
 * Tests for Phase 4 — adapter-driven MCP tool registration in serve.ts.
 *
 * Scenarios covered:
 *  1. Single-DB profile (new shape) → no namespace (backward compat invariant)
 *  2. Multi-DB profile (two relational sources) → <name>_ namespace on each
 *  3. Profile with one DB + one document source → DB adapter namespaced, RAG merged once (no prefix)
 *  4. Profile with document source only → registerMergedDocumentRagTools called once
 *  5. Profile with document source (allowList mode) → scope forwarded to merged tool registration
 *  6. Profile with unknown sourceId → skipped gracefully, fallback empty tool list
 *  7. Two document sources → registerMergedDocumentRagTools called once with both entries
 *  8. Empty sources → no adapter called, fallback registers 0 tools
 *  9. Two configs with allowList document scopes → union of allowlists forwarded to merged tools
 *  10. allowAll wins over allowList when merging configs
 *  11. Config document scopes win over stale profile.scopes for the same id
 *
 * Mocking strategy:
 *  - `@calame/core`: mock registerDynamicTools, sourceAdapterRegistry, upgradeProfileShape, etc.
 *  - `@calame/connectors`: mock getConnector
 *  - `@calame-ee/rag-core`: mock registerMergedDocumentRagTools (the new merged path)
 *  - MCP SDK and streamable transport: minimal mocks (same as serve-empty-profile.test.ts)
 *  - Document adapters in the registry are no longer expected to have registerMcpTools called;
 *    serve.ts now goes through registerMergedDocumentRagTools instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpRegistrationContext, ScopeSelection } from '@calame/core';

// ---------------------------------------------------------------------------
// vi.hoisted() — shared mock references
// ---------------------------------------------------------------------------
const {
  registerDynamicToolsMock,
  registerMergedDocumentRagToolsMock,
  registeredAdapters,
  mockRegistry,
} = vi.hoisted(() => {
  const registeredAdapters = new Map<string, { registerMcpTools: ReturnType<typeof vi.fn> }>();
  const mockRegistry = {
    get: vi.fn((type: string) => registeredAdapters.get(type)),
    has: vi.fn((type: string) => registeredAdapters.has(type)),
    register: vi.fn((adapter: { type: string; registerMcpTools?: ReturnType<typeof vi.fn> }) => {
      registeredAdapters.set(
        adapter.type,
        adapter as unknown as { registerMcpTools: ReturnType<typeof vi.fn> },
      );
    }),
    list: vi.fn(() => Array.from(registeredAdapters.values())),
  };
  return {
    registerDynamicToolsMock: vi.fn(),
    registerMergedDocumentRagToolsMock: vi.fn(),
    registeredAdapters,
    mockRegistry,
  };
});

vi.mock('@calame/core', () => ({
  registerDynamicTools: registerDynamicToolsMock,
  registerCalcTool: vi.fn(),
  resolveUserScope: vi.fn().mockReturnValue([]),
  createScopeGuard: vi.fn().mockReturnValue({
    active: false,
    checkTableAccess: vi.fn(),
    getScopeInfo: vi.fn().mockReturnValue({ filters: [] }),
    applyToQuery: vi.fn((sql: string) => ({ sql, params: [] })),
  }),
  computeDistinctValues: vi.fn().mockResolvedValue({}),
  upgradeProfileShape: vi.fn((p: unknown) => {
    // Minimal upgrade: set scopes from the raw profile if present, else return as-is.
    return p as Record<string, unknown>;
  }),
  sourceAdapterRegistry: mockRegistry,
  // Phase 5 profile accessors — passthrough mocks (legacy path).
  getProfileSelectedTables: vi.fn(
    (p: { selectedTables?: Record<string, string[]> }) => p.selectedTables ?? {},
  ),
  getProfileTableOptions: vi.fn((p: { tableOptions?: Record<string, unknown> }) => p.tableOptions),
  getProfileColumnMasking: vi.fn(
    (p: { columnMasking?: Record<string, Record<string, unknown>> }) => p.columnMasking,
  ),
  getProfileRelationalSources: vi.fn((p: { sources?: string[]; connections?: string[] }) =>
    p.sources && p.sources.length > 0 ? p.sources : (p.connections ?? []),
  ),
  // Configuration accessors — used by mergeConfigurations inside serve.ts.
  getConfigurationRelationalSources: vi.fn(
    (c: {
      connections?: string[];
      sources?: string[];
      scopes?: Record<string, { kind: string }>;
    }) => {
      if (c.sources && c.scopes) {
        return c.sources.filter((id: string) => c.scopes![id]?.kind === 'relational');
      }
      return c.connections ?? [];
    },
  ),
  getConfigurationSelectedTables: vi.fn(
    (c: {
      selectedTables?: Record<string, string[]>;
      scopes?: Record<string, { kind: string; selectedTables?: Record<string, string[]> }>;
    }) => {
      if (c.scopes) {
        const out: Record<string, string[]> = {};
        for (const scope of Object.values(c.scopes)) {
          if (scope.kind === 'relational' && scope.selectedTables) {
            Object.assign(out, scope.selectedTables);
          }
        }
        return out;
      }
      return c.selectedTables ?? {};
    },
  ),
  getConfigurationTableOptions: vi.fn(
    (c: { tableOptions?: Record<string, unknown> }) => c.tableOptions,
  ),
  getConfigurationColumnMasking: vi.fn(
    (c: { columnMasking?: Record<string, Record<string, unknown>> }) => c.columnMasking,
  ),
  getConfigurationDocumentScopes: vi.fn(
    (c: {
      scopes?: Record<
        string,
        {
          kind: string;
          mode?: string;
          allowedFolders?: readonly string[];
          allowedDocuments?: readonly string[];
        }
      >;
    }) => {
      if (!c.scopes) return {};
      const out: Record<
        string,
        {
          kind: 'document';
          mode: string;
          allowedFolders: readonly string[];
          allowedDocuments: readonly string[];
        }
      > = {};
      for (const [id, scope] of Object.entries(c.scopes)) {
        if (scope.kind === 'document') {
          out[id] = scope as {
            kind: 'document';
            mode: string;
            allowedFolders: readonly string[];
            allowedDocuments: readonly string[];
          };
        }
      }
      return out;
    },
  ),
}));

vi.mock('@calame/connectors', () => ({
  getConnector: vi.fn().mockReturnValue({
    query: vi.fn().mockResolvedValue({ rows: [], fields: [] }),
  }),
}));

const mcpServerToolMock = vi.fn();
const mcpConnectMock = vi.fn().mockResolvedValue(undefined);
const mcpCloseMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    tool: mcpServerToolMock,
    connect: mcpConnectMock,
    close: mcpCloseMock,
  })),
}));

const handleRequestMock = vi
  .fn()
  .mockImplementation(
    (_req: unknown, res: { status: (c: number) => { json: (b: unknown) => void } }) => {
      res.status(200).json({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          serverInfo: { name: 'test', version: '1.0' },
        },
      });
      return Promise.resolve();
    },
  );
vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: vi.fn().mockImplementation(() => ({
    handleRequest: handleRequestMock,
  })),
}));

vi.mock('../configurations.js', () => ({
  readConfigurationsFile: vi.fn().mockReturnValue({ configurations: {} }),
}));

vi.mock('../../chat-engine.js', () => ({
  INTERNAL_CHAT_SECRET: 'test-secret',
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
import express from 'express';
import request from 'supertest';
import { AppState } from '../../state.js';
import { registerServeRoute } from '../serve.js';
import type { ConnectionState } from '../../state.js';
import type { NamedConnection } from '@calame/core';
import { readConfigurationsFile } from '../configurations.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConnectionState(name: string, label?: string): ConnectionState {
  return {
    connection: {
      name,
      label: label ?? name,
      databaseType: 'postgresql',
      connectionString: `postgres://localhost/${name}`,
    } as NamedConnection,
    schema: {
      tables: [
        {
          name: 'users',
          schema: 'public',
          primaryKeys: ['id'],
          columns: [
            { name: 'id', type: 'integer', nullable: false, defaultValue: null },
            { name: 'email', type: 'text', nullable: false, defaultValue: null },
          ],
        },
      ],
      relations: [],
    },
    piiDetections: null,
  };
}

/** Relational scope selection for the 'users' table. */
function relationalScope(
  tables: Record<string, string[]> = { users: ['id', 'email'] },
): ScopeSelection {
  return { kind: 'relational', selectedTables: tables };
}

/** Document scope (allowAll). */
function documentScope(mode: 'allowAll' | 'allowList' = 'allowAll'): ScopeSelection {
  return {
    kind: 'document',
    mode,
    allowedFolders: mode === 'allowList' ? ['docs/faq'] : [],
    allowedDocuments: [],
  };
}

/**
 * Build a minimal ragRuntime mock that satisfies what serve.ts now needs:
 *  - ragRuntime.ragCore.registerMergedDocumentRagTools (the merged path)
 *  - ragRuntime.documentAdapterDeps (passed to the above)
 *  - ragRuntime.decryptConfig (used by resolveAdapterConfig for document sources)
 */
function makeRagRuntime(mockDb: { raw: { prepare: ReturnType<typeof vi.fn> } }) {
  return {
    vectorStore: { search: vi.fn().mockReturnValue([]) },
    resolveEmbeddingClient: vi.fn(),
    decryptConfig: vi.fn().mockImplementation((enc: string) => {
      // Return a valid JSON config for any encrypted string.
      void enc;
      return '{"root":"/docs"}';
    }),
    documentAdapterDeps: {
      resolveConnector: vi.fn().mockReturnValue(null),
      searchIndex: { search: vi.fn().mockResolvedValue({ chunks: [] }) },
      storage: {
        listFolders: vi.fn(),
        listDocuments: vi.fn(),
        getDocument: vi.fn(),
        listSources: vi.fn(),
      },
    },
    ragCore: {
      registerMergedDocumentRagTools: registerMergedDocumentRagToolsMock,
    },
    // Needed so resolveAdapterConfig can call decryptConfig
    db: mockDb,
  };
}

function makeApp(state: AppState): express.Express {
  state.userManager = {
    verifyToken: vi.fn().mockReturnValue({ id: 'admin', role: 'admin', status: 'active' }),
    save: vi.fn().mockResolvedValue(undefined),
    getUserByEmail: vi.fn().mockReturnValue(null),
    getUserProfileAccess: vi.fn().mockReturnValue(null),
  } as unknown as typeof state.userManager;

  state.tokenManager = {
    verifyToken: vi.fn().mockReturnValue(null),
    save: vi.fn().mockResolvedValue(undefined),
  } as unknown as typeof state.tokenManager;

  const app = express();
  app.use(express.json());
  registerServeRoute(app, state);
  return app;
}

async function postInitialize(app: express.Express, profileName: string) {
  return request(app)
    .post(`/mcp/${profileName}`)
    .set('Authorization', 'Bearer valid-token')
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0',
      method: 'initialize',
      id: 1,
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
    });
}

// Helper: build a mockDb that returns a given source type for rag_sources lookups.
// Each entry may include an optional `tenant_id` field — when present it is returned
// by both `SELECT type` and `SELECT tenant_id` queries so the cross-tenant guard in
// registerToolsViaAdapters can verify ownership. When absent, `tenant_id` is omitted
// from the row (simulates a source that hasn't been migrated yet — guard falls through).
function makeRagDb(sourceMap: Record<string, { type: string; name: string; tenant_id?: string }>) {
  return {
    raw: {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        get: vi.fn().mockImplementation((id: string) => {
          if (sql.includes('FROM rag_sources') && sourceMap[id]) {
            const { tenant_id, ...rest } = sourceMap[id];
            const row: Record<string, unknown> = { ...rest, embedding_setting_name: null };
            if (tenant_id !== undefined) row.tenant_id = tenant_id;
            return row;
          }
          return null;
        }),
        all: vi.fn().mockReturnValue([]),
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('serve route — Phase 4 adapter-driven tool registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredAdapters.clear();

    // Register a mock postgresql adapter into the mock registry.
    const pgAdapterMock = {
      type: 'postgresql',
      displayName: 'PostgreSQL',
      capabilities: ['introspect', 'query'],
      registerMcpTools: vi.fn(),
    };
    registeredAdapters.set('postgresql', pgAdapterMock);
  });

  // -------------------------------------------------------------------------
  // Test 1: Single-DB profile with new shape → no namespace (backward compat)
  // -------------------------------------------------------------------------
  it('single relational source: registerMcpTools called with toolNamespace=""', async () => {
    const state = new AppState();
    const conn = makeConnectionState('main', 'Main DB');
    state.addConnection('main', conn);

    state.serveProfiles = {
      single: {
        name: 'single',
        label: 'Single',
        sources: ['main'],
        scopes: {
          main: relationalScope(),
        },
      },
    };
    state.activeProfileNames.add('single');

    const app = makeApp(state);
    const res = await postInitialize(app, 'single');
    expect(res.status).toBe(200);

    const pgAdapter = registeredAdapters.get('postgresql');
    expect(pgAdapter?.registerMcpTools).toHaveBeenCalledOnce();

    const ctx = pgAdapter?.registerMcpTools.mock.calls[0][0] as McpRegistrationContext;
    // Single source of its kind → no prefix.
    expect(ctx.toolNamespace).toBe('');
    expect(ctx.profileName).toBe('single');
    expect(ctx.source.id).toBe('main');
  });

  // -------------------------------------------------------------------------
  // Test 2: Two relational sources → prefixed tool names
  // -------------------------------------------------------------------------
  it('two relational sources: registerMcpTools called twice with sanitized namespace', async () => {
    const state = new AppState();
    state.addConnection('prod', makeConnectionState('prod', 'Production DB'));
    state.addConnection('staging', makeConnectionState('staging', 'Staging DB'));

    state.serveProfiles = {
      multi: {
        name: 'multi',
        label: 'Multi',
        sources: ['prod', 'staging'],
        scopes: {
          prod: relationalScope(),
          staging: relationalScope(),
        },
      },
    };
    state.activeProfileNames.add('multi');

    const app = makeApp(state);
    const res = await postInitialize(app, 'multi');
    expect(res.status).toBe(200);

    const pgAdapter = registeredAdapters.get('postgresql');
    expect(pgAdapter?.registerMcpTools).toHaveBeenCalledTimes(2);

    const ctxProd = pgAdapter?.registerMcpTools.mock.calls[0][0] as McpRegistrationContext;
    const ctxStaging = pgAdapter?.registerMcpTools.mock.calls[1][0] as McpRegistrationContext;

    // Two sources of same kind → prefixed with sanitized source name.
    expect(ctxProd.toolNamespace).toBe('production_db_');
    expect(ctxStaging.toolNamespace).toBe('staging_db_');
  });

  // -------------------------------------------------------------------------
  // Test 3: Profile with one DB + one document source
  //         → DB adapter gets registerMcpTools (no prefix, single relational)
  //         → registerMergedDocumentRagTools called once for the document source
  // -------------------------------------------------------------------------
  it('mixed profile (DB + document): DB adapter called, registerMergedDocumentRagTools called once', async () => {
    const state = new AppState();
    state.addConnection('main', makeConnectionState('main', 'Main DB'));

    // Register a document adapter (still needed for resolveAdapterForSource lookup).
    const docAdapterMock = {
      type: 'local',
      displayName: 'Local folder',
      capabilities: ['search', 'enumerate'],
      registerMcpTools: vi.fn(),
    };
    registeredAdapters.set('local', docAdapterMock);

    const mockDb = makeRagDb({ kb1: { type: 'local', name: 'Knowledge Base 1' } });
    state.db = mockDb as unknown as typeof state.db;
    state.ragRuntime = makeRagRuntime(mockDb) as unknown as typeof state.ragRuntime;

    state.serveProfiles = {
      mixed: {
        name: 'mixed',
        label: 'Mixed',
        sources: ['main', 'kb1'],
        scopes: {
          main: relationalScope(),
          kb1: documentScope('allowAll'),
        },
      },
    };
    state.activeProfileNames.add('mixed');

    const app = makeApp(state);
    const res = await postInitialize(app, 'mixed');
    expect(res.status).toBe(200);

    // DB adapter registered (only one relational source → no prefix).
    const pgAdapter = registeredAdapters.get('postgresql');
    expect(pgAdapter?.registerMcpTools).toHaveBeenCalledOnce();
    const dbCtx = pgAdapter?.registerMcpTools.mock.calls[0][0] as McpRegistrationContext;
    expect(dbCtx.toolNamespace).toBe(''); // single relational source → no prefix

    // Document source: registerMergedDocumentRagTools called once (not docAdapter.registerMcpTools).
    expect(docAdapterMock.registerMcpTools).not.toHaveBeenCalled();
    expect(registerMergedDocumentRagToolsMock).toHaveBeenCalledOnce();

    const mergedOpts = registerMergedDocumentRagToolsMock.mock.calls[0][0] as {
      sources: Array<{ source: { id: string }; selection: ScopeSelection }>;
      profileName: string;
    };
    expect(mergedOpts.profileName).toBe('mixed');
    expect(mergedOpts.sources).toHaveLength(1);
    expect(mergedOpts.sources[0].source.id).toBe('kb1');
    expect(mergedOpts.sources[0].selection.kind).toBe('document');
  });

  // -------------------------------------------------------------------------
  // Test 4: Unknown relational source id falls back to live connections (legacy parity)
  // -------------------------------------------------------------------------
  it('unknown relational source id falls back to live connections (legacy parity)', async () => {
    const state = new AppState();
    state.addConnection('main', makeConnectionState('main'));

    // Profile references a sourceId that does NOT match any state.connection key.
    // This mirrors the case where the migrator synthesised a placeholder id
    // (e.g. 'default') for a legacy profile whose `connections` field was empty
    // but the actual connection is named otherwise. The legacy serve.ts path
    // fell back to `state.connections.keys()` when no relational source matched a
    // live connection; the adapter path mirrors that fallback (cf.
    // registerToolsViaAdapters in serve.ts).
    state.serveProfiles = {
      ghost: {
        name: 'ghost',
        label: 'Ghost',
        sources: ['nonexistent'],
        scopes: {
          nonexistent: relationalScope(),
        },
      },
    };
    state.activeProfileNames.add('ghost');

    const app = makeApp(state);
    const res = await postInitialize(app, 'ghost');
    expect(res.status).toBe(200);

    // The placeholder id falls back to the live `main` connection. The pg adapter
    // is called once with the resolved live source.
    const pgAdapter = registeredAdapters.get('postgresql');
    expect(pgAdapter?.registerMcpTools).toHaveBeenCalledOnce();
    const ctx = pgAdapter!.registerMcpTools.mock.calls[0][0];
    expect(ctx.source.id).toBe('main');
    expect(ctx.toolNamespace).toBe('');
  });

  // -------------------------------------------------------------------------
  // Test 5: Legacy profile (no scopes) → legacy path (unchanged behavior)
  // -------------------------------------------------------------------------
  it('legacy profile (no scopes) still falls through to legacy registerDynamicTools path', async () => {
    const state = new AppState();
    state.addConnection('main', makeConnectionState('main'));

    state.serveProfiles = {
      // Cast: this fixture intentionally carries a legacy `selectedTables`
      // root field (now dropped from `ServeProfile`) to validate that the
      // serve route still falls back to `registerDynamicTools` for legacy
      // profiles that the upgrade-mock leaves unchanged.
      legacy: {
        name: 'legacy',
        label: 'Legacy',
        selectedTables: { users: ['id', 'email'] },
        authMode: 'token',
      } as unknown as import('@calame/core').ServeProfile,
    };
    state.activeProfileNames.add('legacy');

    const app = makeApp(state);
    const res = await postInitialize(app, 'legacy');
    expect(res.status).toBe(200);

    // Legacy path: direct registerDynamicTools, not adapter.registerMcpTools.
    expect(registerDynamicToolsMock).toHaveBeenCalledOnce();
    const pgAdapter = registeredAdapters.get('postgresql');
    expect(pgAdapter?.registerMcpTools).not.toHaveBeenCalled();
    expect(registerMergedDocumentRagToolsMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 6: Document scope allowList is forwarded to registerMergedDocumentRagTools
  // -------------------------------------------------------------------------
  it('document allowList scope is forwarded to registerMergedDocumentRagTools unchanged', async () => {
    const state = new AppState();

    const docAdapterMock = {
      type: 'local',
      displayName: 'Local folder',
      capabilities: ['search'],
      registerMcpTools: vi.fn(),
    };
    registeredAdapters.set('local', docAdapterMock);

    const mockDb = makeRagDb({ kb1: { type: 'local', name: 'KB1' } });
    state.db = mockDb as unknown as typeof state.db;
    state.ragRuntime = makeRagRuntime(mockDb) as unknown as typeof state.ragRuntime;

    const allowListScope = documentScope('allowList');
    state.serveProfiles = {
      restrictedKb: {
        name: 'restrictedKb',
        label: 'Restricted KB',
        sources: ['kb1'],
        scopes: { kb1: allowListScope },
      },
    };
    state.activeProfileNames.add('restrictedKb');

    const app = makeApp(state);
    const res = await postInitialize(app, 'restrictedKb');
    expect(res.status).toBe(200);

    // Document adapter's registerMcpTools is NOT called — merged path is used.
    expect(docAdapterMock.registerMcpTools).not.toHaveBeenCalled();

    expect(registerMergedDocumentRagToolsMock).toHaveBeenCalledOnce();
    const mergedOpts = registerMergedDocumentRagToolsMock.mock.calls[0][0] as {
      sources: Array<{ source: { id: string }; selection: ScopeSelection }>;
    };
    expect(mergedOpts.sources).toHaveLength(1);
    const sel = mergedOpts.sources[0].selection;
    expect(sel.kind).toBe('document');
    if (sel.kind === 'document') {
      expect(sel.mode).toBe('allowList');
      expect(sel.allowedFolders).toEqual(['docs/faq']);
    }
  });

  // -------------------------------------------------------------------------
  // Test 7: Two document sources → registerMergedDocumentRagTools called once
  //         with both entries (no per-source namespace)
  // -------------------------------------------------------------------------
  it('two document sources: registerMergedDocumentRagTools called once with two entries', async () => {
    const state = new AppState();

    const docAdapterMock = {
      type: 'local',
      displayName: 'Local folder',
      capabilities: ['search'],
      registerMcpTools: vi.fn(),
    };
    registeredAdapters.set('local', docAdapterMock);

    const mockDb = makeRagDb({
      kb1: { type: 'local', name: 'Knowledge Base 1' },
      kb2: { type: 'local', name: 'Knowledge Base 2' },
    });
    state.db = mockDb as unknown as typeof state.db;
    state.ragRuntime = makeRagRuntime(mockDb) as unknown as typeof state.ragRuntime;

    state.serveProfiles = {
      dualKb: {
        name: 'dualKb',
        label: 'Dual KB',
        sources: ['kb1', 'kb2'],
        scopes: {
          kb1: documentScope('allowAll'),
          kb2: documentScope('allowAll'),
        },
      },
    };
    state.activeProfileNames.add('dualKb');

    const app = makeApp(state);
    const res = await postInitialize(app, 'dualKb');
    expect(res.status).toBe(200);

    // Document adapter's registerMcpTools is NOT called for either source.
    expect(docAdapterMock.registerMcpTools).not.toHaveBeenCalled();

    // registerMergedDocumentRagTools called exactly ONCE with both sources.
    expect(registerMergedDocumentRagToolsMock).toHaveBeenCalledOnce();
    const mergedOpts = registerMergedDocumentRagToolsMock.mock.calls[0][0] as {
      sources: Array<{ source: { id: string; name: string } }>;
    };
    expect(mergedOpts.sources).toHaveLength(2);
    const ids = mergedOpts.sources.map((s) => s.source.id).sort();
    expect(ids).toEqual(['kb1', 'kb2']);
  });

  // -------------------------------------------------------------------------
  // Test 8: Empty sources/scopes → adapter path NOT taken, fallback registers
  // zero concrete tools (but still wires the MCP tools/list handler)
  // -------------------------------------------------------------------------
  it('empty sources array: no adapter is called, fallback registers 0 tools', async () => {
    const state = new AppState();
    state.addConnection('orphan', makeConnectionState('orphan', 'Orphan DB'));

    state.serveProfiles = {
      empty: {
        name: 'empty',
        label: 'Empty Profile',
        sources: [],
        scopes: {},
      },
    };
    state.activeProfileNames.add('empty');

    const app = makeApp(state);
    const res = await postInitialize(app, 'empty');
    expect(res.status).toBe(200);

    // The adapter-driven path is not taken (Object.keys(scopes).length === 0).
    const pgAdapter = registeredAdapters.get('postgresql');
    expect(pgAdapter?.registerMcpTools).not.toHaveBeenCalled();
    expect(registerMergedDocumentRagToolsMock).not.toHaveBeenCalled();

    // The legacy path runs the "fallback for empty profile" branch: 1 call to
    // registerDynamicTools with empty tables/selectedTables to wire tools/list.
    expect(registerDynamicToolsMock).toHaveBeenCalledTimes(1);
    const args = registerDynamicToolsMock.mock.calls[0][0] as {
      tables: unknown[];
      selectedTables: Record<string, unknown>;
    };
    expect(args.tables).toEqual([]);
    expect(args.selectedTables).toEqual({});
  });

  // -------------------------------------------------------------------------
  // Test 9: Two configurations with allowList document scopes → union of allowlists
  //         forwarded to registerMergedDocumentRagTools
  // -------------------------------------------------------------------------
  it('two configs with allowList document scopes: merged scope is union of allowedFolders', async () => {
    const state = new AppState();

    const docAdapterMock = {
      type: 'local',
      displayName: 'Local folder',
      capabilities: ['search'],
      registerMcpTools: vi.fn(),
    };
    registeredAdapters.set('local', docAdapterMock);

    const mockDb = makeRagDb({ kb1: { type: 'local', name: 'KB1' } });
    state.db = mockDb as unknown as typeof state.db;
    state.ragRuntime = makeRagRuntime(mockDb) as unknown as typeof state.ragRuntime;

    // Two configurations: cfg-a allows docs/public, cfg-b allows docs/legal.
    const cfgA = {
      name: 'cfg-a',
      sources: ['kb1'],
      scopes: {
        kb1: {
          kind: 'document' as const,
          mode: 'allowList' as const,
          allowedFolders: ['docs/public'],
          allowedDocuments: [],
        },
      },
    };
    const cfgB = {
      name: 'cfg-b',
      sources: ['kb1'],
      scopes: {
        kb1: {
          kind: 'document' as const,
          mode: 'allowList' as const,
          allowedFolders: ['docs/legal'],
          allowedDocuments: [],
        },
      },
    };

    vi.mocked(readConfigurationsFile).mockReturnValue({
      configurations: { 'cfg-a': cfgA as never, 'cfg-b': cfgB as never },
    });

    // Profile references both configurations, no direct scopes.
    state.serveProfiles = {
      cfgMerge: {
        name: 'cfgMerge',
        label: 'Config Merge',
        configurations: ['cfg-a', 'cfg-b'],
        sources: [],
        scopes: {},
      },
    };
    state.activeProfileNames.add('cfgMerge');

    const app = makeApp(state);
    const res = await postInitialize(app, 'cfgMerge');
    expect(res.status).toBe(200);

    // Document adapter's registerMcpTools is NOT called — merged path is used.
    expect(docAdapterMock.registerMcpTools).not.toHaveBeenCalled();

    // registerMergedDocumentRagTools called once with the merged allowList scope.
    expect(registerMergedDocumentRagToolsMock).toHaveBeenCalledOnce();
    const mergedOpts = registerMergedDocumentRagToolsMock.mock.calls[0][0] as {
      sources: Array<{ source: { id: string }; selection: ScopeSelection }>;
    };
    expect(mergedOpts.sources).toHaveLength(1);
    const sel = mergedOpts.sources[0].selection;
    expect(sel.kind).toBe('document');
    if (sel.kind === 'document') {
      expect(sel.mode).toBe('allowList');
      // Union of both folder allowlists.
      expect([...sel.allowedFolders].sort()).toEqual(['docs/legal', 'docs/public']);
    }
  });

  // -------------------------------------------------------------------------
  // Test 10: allowAll wins — if one config has allowAll, merged scope is allowAll
  // -------------------------------------------------------------------------
  it('allowAll wins: config A allowAll + config B allowList → merged scope is allowAll', async () => {
    const state = new AppState();

    const docAdapterMock = {
      type: 'local',
      displayName: 'Local folder',
      capabilities: ['search'],
      registerMcpTools: vi.fn(),
    };
    registeredAdapters.set('local', docAdapterMock);

    const mockDb = makeRagDb({ kb1: { type: 'local', name: 'KB1' } });
    state.db = mockDb as unknown as typeof state.db;
    state.ragRuntime = makeRagRuntime(mockDb) as unknown as typeof state.ragRuntime;

    const cfgAllowAll = {
      name: 'cfg-all',
      sources: ['kb1'],
      scopes: {
        kb1: {
          kind: 'document' as const,
          mode: 'allowAll' as const,
          allowedFolders: [],
          allowedDocuments: [],
        },
      },
    };
    const cfgAllowList = {
      name: 'cfg-list',
      sources: ['kb1'],
      scopes: {
        kb1: {
          kind: 'document' as const,
          mode: 'allowList' as const,
          allowedFolders: ['docs/restricted'],
          allowedDocuments: [],
        },
      },
    };

    vi.mocked(readConfigurationsFile).mockReturnValue({
      configurations: {
        'cfg-all': cfgAllowAll as never,
        'cfg-list': cfgAllowList as never,
      },
    });

    state.serveProfiles = {
      allowAllWins: {
        name: 'allowAllWins',
        label: 'AllowAll Wins',
        configurations: ['cfg-all', 'cfg-list'],
        sources: [],
        scopes: {},
      },
    };
    state.activeProfileNames.add('allowAllWins');

    const app = makeApp(state);
    const res = await postInitialize(app, 'allowAllWins');
    expect(res.status).toBe(200);

    expect(docAdapterMock.registerMcpTools).not.toHaveBeenCalled();
    expect(registerMergedDocumentRagToolsMock).toHaveBeenCalledOnce();
    const mergedOpts = registerMergedDocumentRagToolsMock.mock.calls[0][0] as {
      sources: Array<{ source: { id: string }; selection: ScopeSelection }>;
    };
    expect(mergedOpts.sources).toHaveLength(1);
    const sel = mergedOpts.sources[0].selection;
    expect(sel.kind).toBe('document');
    if (sel.kind === 'document') {
      // allowAll wins regardless of which config has it.
      expect(sel.mode).toBe('allowAll');
      expect(sel.allowedFolders).toEqual([]);
    }
  });

  // -------------------------------------------------------------------------
  // Test 12: cross-tenant source isolation
  //
  // A document source whose rag_sources.tenant_id does not match the tenant
  // resolved from the MCP URL must be excluded from registerMergedDocumentRagTools
  // and a warn must be emitted. Sources belonging to the correct tenant are kept.
  // -------------------------------------------------------------------------
  it('cross-tenant document source is excluded and warn is logged', async () => {
    const state = new AppState();

    const docAdapterMock = {
      type: 'local',
      displayName: 'Local folder',
      capabilities: ['search'],
      registerMcpTools: vi.fn(),
    };
    registeredAdapters.set('local', docAdapterMock);

    // kb-own belongs to 'default', kb-foreign belongs to 'other-tenant'.
    const mockDb = makeRagDb({
      'kb-own': { type: 'local', name: 'Own KB', tenant_id: 'default' },
      'kb-foreign': { type: 'local', name: 'Foreign KB', tenant_id: 'other-tenant' },
    });
    state.db = mockDb as unknown as typeof state.db;

    const warnMessages: string[] = [];
    state.logger = {
      info: vi.fn(),
      warn: vi.fn((...args: unknown[]) => {
        if (typeof args[0] === 'string') warnMessages.push(args[0]);
      }),
      error: vi.fn(),
    } as unknown as typeof state.logger;

    state.ragRuntime = makeRagRuntime(mockDb) as unknown as typeof state.ragRuntime;

    // Profile declares both sources; request is for the default tenant.
    state.serveProfiles = {
      tenantProfile: {
        name: 'tenantProfile',
        label: 'Tenant Profile',
        sources: ['kb-own', 'kb-foreign'],
        scopes: {
          'kb-own': documentScope('allowAll'),
          'kb-foreign': documentScope('allowAll'),
        },
      },
    };
    state.activeProfileNames.add('tenantProfile');

    const app = makeApp(state);
    // Default tenant: the MCP URL is /mcp/tenantProfile (single-segment → tenant='default').
    const res = await postInitialize(app, 'tenantProfile');
    expect(res.status).toBe(200);

    // registerMergedDocumentRagTools must have been called with only the own source.
    expect(registerMergedDocumentRagToolsMock).toHaveBeenCalledOnce();
    const mergedOpts = registerMergedDocumentRagToolsMock.mock.calls[0][0] as {
      sources: Array<{ source: { id: string } }>;
    };
    expect(mergedOpts.sources).toHaveLength(1);
    expect(mergedOpts.sources[0].source.id).toBe('kb-own');

    // A warn must have been emitted for the excluded cross-tenant source.
    const crossTenantWarn = warnMessages.find((m) => m.includes('kb-foreign'));
    expect(crossTenantWarn).toBeDefined();
    expect(crossTenantWarn).toMatch(/tenant/i);
  });

  // -------------------------------------------------------------------------
  // Test 11: config document scopes win over profile.scopes for the same id
  //
  // The Knowledge tab moved from MCP detail to the data Configuration view, so
  // the Configuration is now the single source of truth for document scopes.
  // A stale profile.scopes[id] (e.g. left over from the removed MCP-detail
  // Knowledge tab) MUST NOT shadow the user's current Configuration setting.
  // -------------------------------------------------------------------------
  it('config document scopes win over profile.scopes when both declare the same id', async () => {
    const state = new AppState();

    const docAdapterMock = {
      type: 'local',
      displayName: 'Local folder',
      capabilities: ['search'],
      registerMcpTools: vi.fn(),
    };
    registeredAdapters.set('local', docAdapterMock);

    const mockDb = makeRagDb({ kb1: { type: 'local', name: 'KB1' } });
    state.db = mockDb as unknown as typeof state.db;
    state.ragRuntime = makeRagRuntime(mockDb) as unknown as typeof state.ragRuntime;

    // Config declares allowAll for kb1.
    const cfgAllowAll = {
      name: 'cfg-all',
      sources: ['kb1'],
      scopes: {
        kb1: {
          kind: 'document' as const,
          mode: 'allowAll' as const,
          allowedFolders: [],
          allowedDocuments: [],
        },
      },
    };

    vi.mocked(readConfigurationsFile).mockReturnValue({
      configurations: { 'cfg-all': cfgAllowAll as never },
    });

    // Profile also declares kb1 with a stricter allowList — but the config
    // now wins, so this stale profile scope should be ignored.
    const profileDocScope = {
      kind: 'document' as const,
      mode: 'allowList' as const,
      allowedFolders: ['docs/strict'],
      allowedDocuments: [],
    };

    state.serveProfiles = {
      configWins: {
        name: 'configWins',
        label: 'Config Wins',
        configurations: ['cfg-all'],
        sources: ['kb1'],
        scopes: { kb1: profileDocScope },
      },
    };
    state.activeProfileNames.add('configWins');

    const app = makeApp(state);
    const res = await postInitialize(app, 'configWins');
    expect(res.status).toBe(200);

    expect(docAdapterMock.registerMcpTools).not.toHaveBeenCalled();
    expect(registerMergedDocumentRagToolsMock).toHaveBeenCalledOnce();
    const mergedOpts = registerMergedDocumentRagToolsMock.mock.calls[0][0] as {
      sources: Array<{ source: { id: string }; selection: ScopeSelection }>;
    };
    expect(mergedOpts.sources).toHaveLength(1);
    const sel = mergedOpts.sources[0].selection;
    expect(sel.kind).toBe('document');
    if (sel.kind === 'document') {
      // Config's allowAll overrides the profile's stale allowList.
      expect(sel.mode).toBe('allowAll');
      expect([...sel.allowedFolders]).toEqual([]);
    }
  });
});
