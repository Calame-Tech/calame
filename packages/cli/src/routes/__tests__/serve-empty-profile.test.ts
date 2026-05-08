/**
 * Regression test for: MCP error -32601 "Method not found" on profiles with no matched tables.
 *
 * Root cause: when effectiveSelectedTables is empty (no table matched any connection schema),
 * registerDynamicTools was never called, leaving the McpServer without a tools/list handler.
 * The SDK then responds with -32601 to any tools/list request from the client, which breaks
 * the chat flow and external MCP clients (Claude Desktop, Cursor, etc.).
 *
 * Fix: call registerDynamicTools with tables:[] when tablesByConnection is empty so the MCP
 * server always registers the tools/list handler (returning an empty list rather than -32601).
 *
 * These tests verify the fixed behaviour by mocking heavy dependencies (MCP SDK, connectors,
 * core) and asserting that registerDynamicTools is called even for an empty profile.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted() — variables used inside vi.mock() factories must be created
// with vi.hoisted() so they are available before module initialisation.
// ---------------------------------------------------------------------------
const { registerDynamicToolsMock } = vi.hoisted(() => ({
  registerDynamicToolsMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock heavy dependencies before importing the module under test
// ---------------------------------------------------------------------------
vi.mock('@calame/core', () => ({
  registerDynamicTools: registerDynamicToolsMock,
  resolveUserScope: vi.fn().mockReturnValue([]),
  createScopeGuard: vi.fn().mockReturnValue({
    active: false,
    checkTableAccess: vi.fn(),
    getScopeInfo: vi.fn().mockReturnValue({ filters: [] }),
    applyToQuery: vi.fn((sql: string) => ({ sql, params: [] })),
  }),
  // Phase 2.5 — distinct-values pre-computation. Stubbed here because the
  // serve route now awaits it on the per-connection path; the real impl
  // would issue SELECT DISTINCT against the mocked connector and is out of
  // scope for this unit test.
  computeDistinctValues: vi.fn().mockResolvedValue({}),
  // Phase 2b — upgradeProfileShape must be in the mock or serve.ts throws at runtime.
  // The identity function is sufficient: the test fixtures already carry the needed
  // legacy fields (selectedTables etc.) so no actual migration is required here.
  upgradeProfileShape: vi.fn((p: unknown) => p),
}));

vi.mock('@calame/connectors', () => ({
  getConnector: vi.fn().mockReturnValue({
    query: vi.fn().mockResolvedValue({ rows: [], fields: [] }),
  }),
}));

const mcpConnectMock = vi.fn().mockResolvedValue(undefined);
const mcpCloseMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    connect: mcpConnectMock,
    close: mcpCloseMock,
  })),
}));

// handleRequest must actually send an HTTP response so supertest's request resolves.
// We implement it as a function that writes a minimal 200 JSON-RPC response to `res`.
const handleRequestMock = vi.fn().mockImplementation(
  (_req: unknown, res: { status: (c: number) => { json: (b: unknown) => void } }) => {
    res.status(200).json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test', version: '1.0' } } });
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
// Import module under test after mocks are registered
// ---------------------------------------------------------------------------
import express from 'express';
import request from 'supertest';
import { AppState } from '../../state.js';
import { registerServeRoute } from '../serve.js';
import type { ConnectionState } from '../../state.js';
import type { NamedConnection } from '@calame/core';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConnectionState(name: string): ConnectionState {
  return {
    connection: {
      name,
      label: name,
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

/**
 * Build an Express app with serve route + a fake user manager that accepts any
 * Bearer token as admin, so auth does not block these unit tests.
 */
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

/** POST an initialize request to /mcp/:profile and return the supertest response. */
async function postInitialize(
  app: express.Express,
  profileName: string,
): Promise<request.Response> {
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

describe('serve route — fix for MCP -32601 on empty / unmatched profiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls registerDynamicTools with tables:[] when profile selectedTables is empty', async () => {
    const state = new AppState();
    state.addConnection('main', makeConnectionState('main'));
    state.serveProfiles = {
      empty: { name: 'empty', label: 'Empty', selectedTables: {}, authMode: 'token' },
    };
    state.activeProfileNames.add('empty');

    const app = makeApp(state);
    const res = await postInitialize(app, 'empty');
    expect(res.status).toBe(200);

    // Critical assertion: registerDynamicTools must have been called even for an empty profile
    expect(registerDynamicToolsMock).toHaveBeenCalledOnce();
    const args = registerDynamicToolsMock.mock.calls[0][0];
    expect(args.tables).toEqual([]);
    expect(args.selectedTables).toEqual({});
    expect(args.profileName).toBe('empty');
  });

  it('calls registerDynamicTools in the normal path when tables match the schema', async () => {
    const state = new AppState();
    state.addConnection('main', makeConnectionState('main'));
    state.serveProfiles = {
      withTables: {
        name: 'withTables',
        label: 'With Tables',
        selectedTables: { users: ['id', 'email'] },
        authMode: 'token',
      },
    };
    state.activeProfileNames.add('withTables');

    const app = makeApp(state);
    const res = await postInitialize(app, 'withTables');
    expect(res.status).toBe(200);

    expect(registerDynamicToolsMock).toHaveBeenCalledOnce();
    const args = registerDynamicToolsMock.mock.calls[0][0];
    // Normal path: the matched table is passed through
    expect(args.tables).toHaveLength(1);
    expect(args.tables[0].name).toBe('users');
    expect(args.selectedTables).toEqual({ users: ['id', 'email'] });
  });

  it('uses the normal path (non-empty tablesByConnection) even when some tables are unmatched', async () => {
    const state = new AppState();
    state.addConnection('main', makeConnectionState('main'));
    state.serveProfiles = {
      partial: {
        name: 'partial',
        label: 'Partial',
        // 'users' matches the schema; 'ghost_table' does not
        selectedTables: { users: ['id', 'email'], ghost_table: ['col'] },
        authMode: 'token',
      },
    };
    state.activeProfileNames.add('partial');

    const app = makeApp(state);
    const res = await postInitialize(app, 'partial');
    expect(res.status).toBe(200);

    // Only 'users' matched → normal path, one registerDynamicTools call with one table
    expect(registerDynamicToolsMock).toHaveBeenCalledOnce();
    const args = registerDynamicToolsMock.mock.calls[0][0];
    expect(args.tables).toHaveLength(1);
    expect(args.tables[0].name).toBe('users');
  });

  it('returns 503 when the profile exists but is not active', async () => {
    const state = new AppState();
    state.addConnection('main', makeConnectionState('main'));
    state.serveProfiles = {
      demo: { name: 'demo', label: 'Demo', selectedTables: {}, authMode: 'token' },
    };
    // Not added to activeProfileNames

    const app = makeApp(state);
    const res = await postInitialize(app, 'demo');
    expect(res.status).toBe(503);
    expect(registerDynamicToolsMock).not.toHaveBeenCalled();
  });

  it('returns 503 for an unknown profileName', async () => {
    const state = new AppState();
    state.addConnection('main', makeConnectionState('main'));
    // No profiles registered at all

    const app = makeApp(state);
    const res = await postInitialize(app, 'unknown');
    expect(res.status).toBe(503);
    expect(registerDynamicToolsMock).not.toHaveBeenCalled();
  });

  it('returns 405 for GET requests (stateless mode does not support SSE streams)', async () => {
    const state = new AppState();
    state.addConnection('main', makeConnectionState('main'));
    state.serveProfiles = {
      demo: { name: 'demo', label: 'Demo', selectedTables: {}, authMode: 'token' },
    };
    state.activeProfileNames.add('demo');

    const app = makeApp(state);
    const res = await request(app)
      .get('/mcp/demo')
      .set('Authorization', 'Bearer valid-token');
    expect(res.status).toBe(405);
  });
});
