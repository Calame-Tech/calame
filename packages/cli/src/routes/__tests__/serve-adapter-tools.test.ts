/**
 * Tests for Phase 3c — adapter-driven MCP tool registration in serve.ts.
 *
 * Scenarios covered:
 *  1. Single-DB profile (new shape) → no namespace (backward compat invariant)
 *  2. Multi-DB profile (two relational sources) → <name>_ namespace on each
 *  3. Profile with one DB + one document source → both tools registered (namespaced)
 *  4. Profile with document source only → rag tools registered (no DB tools)
 *  5. Profile with document source (allowList mode) → scope passed through to adapter
 *  6. Profile with unknown sourceId → skipped gracefully, fallback empty tool list
 *
 * Mocking strategy:
 *  - `@calame/core`: mock registerDynamicTools, sourceAdapterRegistry, upgradeProfileShape, etc.
 *  - `@calame/connectors`: mock getConnector
 *  - MCP SDK and streamable transport: minimal mocks (same as serve-empty-profile.test.ts)
 *  - The DocumentSourceAdapter's registerMcpTools is a spy so we can assert it was called
 *    with the expected toolNamespace and selection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpRegistrationContext, ScopeSelection } from '@calame/core';

// ---------------------------------------------------------------------------
// vi.hoisted() — shared mock references
// ---------------------------------------------------------------------------
const {
  registerDynamicToolsMock,
  registeredAdapters,
  mockRegistry,
} = vi.hoisted(() => {
  const registeredAdapters = new Map<string, { registerMcpTools: ReturnType<typeof vi.fn> }>();
  const mockRegistry = {
    get: vi.fn((type: string) => registeredAdapters.get(type)),
    has: vi.fn((type: string) => registeredAdapters.has(type)),
    register: vi.fn((adapter: { type: string; registerMcpTools?: ReturnType<typeof vi.fn> }) => {
      registeredAdapters.set(adapter.type, adapter as unknown as { registerMcpTools: ReturnType<typeof vi.fn> });
    }),
    list: vi.fn(() => Array.from(registeredAdapters.values())),
  };
  return {
    registerDynamicToolsMock: vi.fn(),
    registeredAdapters,
    mockRegistry,
  };
});

vi.mock('@calame/core', () => ({
  registerDynamicTools: registerDynamicToolsMock,
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

const handleRequestMock = vi.fn().mockImplementation(
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
function relationalScope(tables: Record<string, string[]> = { users: ['id', 'email'] }): ScopeSelection {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('serve route — Phase 3c adapter-driven tool registration', () => {
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
        selectedTables: {},
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
        selectedTables: {},
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
  // Test 3: Profile with one DB + one document source → both registered
  // -------------------------------------------------------------------------
  it('mixed profile (DB + document): both adapters registerMcpTools called', async () => {
    const state = new AppState();
    state.addConnection('main', makeConnectionState('main', 'Main DB'));

    // Register a mock document adapter.
    const docAdapterMock = {
      type: 'local',
      displayName: 'Local folder',
      capabilities: ['search', 'enumerate'],
      registerMcpTools: vi.fn(),
    };
    registeredAdapters.set('local', docAdapterMock);

    // Simulate a rag_sources SQLite lookup by providing a mock db.
    const mockDb = {
      raw: {
        prepare: vi.fn().mockImplementation((sql: string) => ({
          get: vi.fn().mockImplementation((id: string) => {
            if (sql.includes('FROM rag_sources') && id === 'kb1') {
              return { type: 'local', name: 'Knowledge Base 1', embedding_setting_name: null };
            }
            return null;
          }),
          all: vi.fn().mockReturnValue([]),
        })),
      },
    };
    state.db = mockDb as unknown as typeof state.db;

    // Simulate ragRuntime presence (document adapter needs it).
    const mockRagRuntime = {
      vectorStore: { search: vi.fn().mockReturnValue([]) },
      resolveEmbeddingClient: vi.fn(),
      decryptConfig: vi.fn().mockReturnValue('{"root":"/docs"}'),
    };
    state.ragRuntime = mockRagRuntime as unknown as typeof state.ragRuntime;

    state.serveProfiles = {
      mixed: {
        name: 'mixed',
        label: 'Mixed',
        selectedTables: {},
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
    expect(dbCtx.toolNamespace).toBe(''); // single of its kind

    // Document adapter registered (only one document source → no prefix).
    expect(docAdapterMock.registerMcpTools).toHaveBeenCalledOnce();
    const docCtx = docAdapterMock.registerMcpTools.mock.calls[0][0] as McpRegistrationContext;
    expect(docCtx.toolNamespace).toBe(''); // single of its kind
    expect(docCtx.selection.kind).toBe('document');
  });

  // -------------------------------------------------------------------------
  // Test 4: Unknown sourceId → skipped gracefully, fallback registers empty DB tools
  // -------------------------------------------------------------------------
  it('unknown source id is skipped; fallback empty tools registered to avoid -32601', async () => {
    const state = new AppState();
    state.addConnection('main', makeConnectionState('main'));

    // Profile references a source that is not in connections and not in rag_sources.
    state.serveProfiles = {
      ghost: {
        name: 'ghost',
        label: 'Ghost',
        selectedTables: {},
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

    // The nonexistent adapter produces no call; the fallback registerDynamicTools fires.
    const pgAdapter = registeredAdapters.get('postgresql');
    expect(pgAdapter?.registerMcpTools).not.toHaveBeenCalled();

    // Fallback must have fired so MCP server always has tools/list handler.
    expect(registerDynamicToolsMock).toHaveBeenCalledOnce();
    const fallbackArgs = registerDynamicToolsMock.mock.calls[0][0];
    expect(fallbackArgs.tables).toEqual([]);
    expect(fallbackArgs.profileName).toBe('ghost');
  });

  // -------------------------------------------------------------------------
  // Test 5: Legacy profile (no scopes) → legacy path (unchanged behavior)
  // -------------------------------------------------------------------------
  it('legacy profile (no scopes) still falls through to legacy registerDynamicTools path', async () => {
    const state = new AppState();
    state.addConnection('main', makeConnectionState('main'));

    state.serveProfiles = {
      legacy: {
        name: 'legacy',
        label: 'Legacy',
        selectedTables: { users: ['id', 'email'] },
        authMode: 'token',
        // No sources/scopes — upgradeProfileShape returns the raw object unchanged in mock
      },
    };
    state.activeProfileNames.add('legacy');

    const app = makeApp(state);
    const res = await postInitialize(app, 'legacy');
    expect(res.status).toBe(200);

    // Legacy path: direct registerDynamicTools, not adapter.registerMcpTools.
    expect(registerDynamicToolsMock).toHaveBeenCalledOnce();
    const pgAdapter = registeredAdapters.get('postgresql');
    expect(pgAdapter?.registerMcpTools).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 6: Document scope allowList is forwarded to the adapter
  // -------------------------------------------------------------------------
  it('document allowList scope is forwarded to registerMcpTools unchanged', async () => {
    const state = new AppState();

    const docAdapterMock = {
      type: 'local',
      displayName: 'Local folder',
      capabilities: ['search'],
      registerMcpTools: vi.fn(),
    };
    registeredAdapters.set('local', docAdapterMock);

    const mockDb = {
      raw: {
        prepare: vi.fn().mockImplementation((sql: string) => ({
          get: vi.fn().mockImplementation((id: string) => {
            if (sql.includes('FROM rag_sources') && id === 'kb1') {
              return { type: 'local', name: 'KB1', embedding_setting_name: null };
            }
            return null;
          }),
          all: vi.fn().mockReturnValue([]),
        })),
      },
    };
    state.db = mockDb as unknown as typeof state.db;

    const mockRagRuntime = {
      vectorStore: { search: vi.fn().mockReturnValue([]) },
      resolveEmbeddingClient: vi.fn(),
      decryptConfig: vi.fn().mockReturnValue('{"root":"/docs"}'),
    };
    state.ragRuntime = mockRagRuntime as unknown as typeof state.ragRuntime;

    const allowListScope = documentScope('allowList');
    state.serveProfiles = {
      restrictedKb: {
        name: 'restrictedKb',
        label: 'Restricted KB',
        selectedTables: {},
        sources: ['kb1'],
        scopes: { kb1: allowListScope },
      },
    };
    state.activeProfileNames.add('restrictedKb');

    const app = makeApp(state);
    const res = await postInitialize(app, 'restrictedKb');
    expect(res.status).toBe(200);

    expect(docAdapterMock.registerMcpTools).toHaveBeenCalledOnce();
    const ctx = docAdapterMock.registerMcpTools.mock.calls[0][0] as McpRegistrationContext;
    expect(ctx.selection.kind).toBe('document');
    if (ctx.selection.kind === 'document') {
      expect(ctx.selection.mode).toBe('allowList');
      expect(ctx.selection.allowedFolders).toEqual(['docs/faq']);
    }
  });

  // -------------------------------------------------------------------------
  // Test 7: Two document sources → prefixed namespaces
  // -------------------------------------------------------------------------
  it('two document sources: each gets a sanitized namespace', async () => {
    const state = new AppState();

    const docAdapterMock = {
      type: 'local',
      displayName: 'Local folder',
      capabilities: ['search'],
      registerMcpTools: vi.fn(),
    };
    registeredAdapters.set('local', docAdapterMock);

    const mockDb = {
      raw: {
        prepare: vi.fn().mockImplementation((sql: string) => ({
          get: vi.fn().mockImplementation((id: string) => {
            if (sql.includes('FROM rag_sources')) {
              if (id === 'kb1') return { type: 'local', name: 'Knowledge Base 1', embedding_setting_name: null };
              if (id === 'kb2') return { type: 'local', name: 'Knowledge Base 2', embedding_setting_name: null };
            }
            return null;
          }),
          all: vi.fn().mockReturnValue([]),
        })),
      },
    };
    state.db = mockDb as unknown as typeof state.db;

    const mockRagRuntime = {
      vectorStore: { search: vi.fn().mockReturnValue([]) },
      resolveEmbeddingClient: vi.fn(),
      decryptConfig: vi.fn().mockReturnValue('{"root":"/docs"}'),
    };
    state.ragRuntime = mockRagRuntime as unknown as typeof state.ragRuntime;

    state.serveProfiles = {
      dualKb: {
        name: 'dualKb',
        label: 'Dual KB',
        selectedTables: {},
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

    // Both document adapters called — two document sources → prefixed.
    expect(docAdapterMock.registerMcpTools).toHaveBeenCalledTimes(2);

    const ctx1 = docAdapterMock.registerMcpTools.mock.calls[0][0] as McpRegistrationContext;
    const ctx2 = docAdapterMock.registerMcpTools.mock.calls[1][0] as McpRegistrationContext;

    expect(ctx1.toolNamespace).toBe('knowledge_base_1_');
    expect(ctx2.toolNamespace).toBe('knowledge_base_2_');
  });
});
