/**
 * MCP tenant routing tests.
 *
 * Two URL formats are supported by the MCP serve endpoint:
 *   1. `/mcp/<profile>`              — legacy, implicitly tenant='default'
 *   2. `/mcp/<tenant>/<profile>`     — tenant-qualified
 *
 * These tests cover the route resolution (including the ambiguity policy on
 * single-segment URLs), tenant-aware token validation, and the cross-tenant
 * isolation invariant (no profile in tenant A reachable from a /mcp/B/<name>
 * URL).
 *
 * Heavy MCP SDK dependencies are mocked the same way as the existing
 * serve-empty-profile.test.ts — we only assert the route behaviour, not the
 * actual MCP tool execution.
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
  computeDistinctValues: vi.fn().mockResolvedValue({}),
  upgradeProfileShape: vi.fn((p: unknown) => p),
  getProfileSelectedTables: vi.fn(
    (p: { selectedTables?: Record<string, string[]> }) => p.selectedTables ?? {},
  ),
  getProfileTableOptions: vi.fn(
    (p: { tableOptions?: Record<string, unknown> }) => p.tableOptions,
  ),
  getProfileColumnMasking: vi.fn(
    (p: { columnMasking?: Record<string, Record<string, unknown>> }) => p.columnMasking,
  ),
  getProfileRelationalSources: vi.fn(
    (p: { sources?: string[]; connections?: string[] }) =>
      p.sources && p.sources.length > 0 ? p.sources : (p.connections ?? []),
  ),
  sourceAdapterRegistry: { get: vi.fn().mockReturnValue(null) },
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
// Imports must come AFTER vi.mock() calls above
// ---------------------------------------------------------------------------
import express from 'express';
import request from 'supertest';
import { AppState } from '../../state.js';
import type { ConnectionState } from '../../state.js';
import type { NamedConnection } from '@calame/core';
import { registerServeRoute, resolveMcpRoute } from '../serve.js';

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
 * Minimal `db.raw` mock — supports `.prepare(sql).get(...)` for the
 * `SELECT data FROM profiles WHERE key='main' AND tenant_id = ?` lookup
 * used by `loadServeProfileForTenant`.
 */
function makeMockDb(profileRowsByTenant: Record<string, Record<string, unknown>>) {
  const prepare = (sql: string) => {
    if (sql.includes("FROM profiles WHERE key = 'main' AND tenant_id = ?")) {
      return {
        get: (tenantId: string) => {
          const profiles = profileRowsByTenant[tenantId];
          if (!profiles) return undefined;
          return { data: JSON.stringify({ profiles }) };
        },
      };
    }
    // Default catch-all: returns undefined.
    return { get: () => undefined, all: () => [] };
  };
  return { raw: { prepare } } as unknown as AppState['db'];
}

/**
 * Build an Express app with the serve route + a fake user manager that
 * accepts any Bearer token as admin, so auth doesn't block these tests.
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

/** POST a JSON-RPC initialize to the supplied path. */
function postInitialize(app: express.Express, path: string) {
  return request(app)
    .post(path)
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
// Pure unit tests for resolveMcpRoute (no Express needed)
// ---------------------------------------------------------------------------

describe('resolveMcpRoute', () => {
  it('single-segment URL is always interpreted as legacy (tenant=default)', () => {
    expect(resolveMcpRoute('my-profile', undefined)).toEqual({
      tenantId: 'default',
      profileName: 'my-profile',
    });
  });

  it('single segment that happens to match a tenant id still routes as legacy', () => {
    // Ambiguity policy: 1 segment is ALWAYS legacy, even when the segment
    // would form a valid tenant id. An admin who wants to hit a tenant must
    // include the profile name explicitly.
    expect(resolveMcpRoute('acme-corp', undefined)).toEqual({
      tenantId: 'default',
      profileName: 'acme-corp',
    });
  });

  it('two-segment URL routes to the qualified (tenant, profile) pair', () => {
    expect(resolveMcpRoute('acme-corp', 'sales')).toEqual({
      tenantId: 'acme-corp',
      profileName: 'sales',
    });
  });

  it('rejects malformed tenant ids on the qualified form', () => {
    // Spaces, dots, and other non-[A-Za-z0-9_-] characters fail the regex.
    expect(resolveMcpRoute('bad tenant', 'sales')).toEqual({ error: 'invalid_tenant_id' });
    expect(resolveMcpRoute('bad.tenant', 'sales')).toEqual({ error: 'invalid_tenant_id' });
    expect(resolveMcpRoute('bad/tenant', 'sales')).toEqual({ error: 'invalid_tenant_id' });
  });

  it('rejects empty and over-long tenant ids', () => {
    expect(resolveMcpRoute('', 'sales')).toEqual({ error: 'invalid_tenant_id' });
    expect(resolveMcpRoute('a'.repeat(65), 'sales')).toEqual({ error: 'invalid_tenant_id' });
  });

  it('accepts edge alphabet (underscore, hyphen, mixed case, digits)', () => {
    expect(resolveMcpRoute('Acme_Corp-2', 'p')).toEqual({
      tenantId: 'Acme_Corp-2',
      profileName: 'p',
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end route tests
// ---------------------------------------------------------------------------

describe('MCP route — legacy URL /mcp/<profile>', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes /mcp/<profile> to the default tenant using state.serveProfiles', async () => {
    const state = new AppState();
    state.addConnection('main', makeConnectionState('main'));
    state.serveProfiles = {
      sales: { name: 'sales', label: 'Sales', authMode: 'token' },
    };
    state.activeProfileNames.add('sales');

    const app = makeApp(state);
    const res = await postInitialize(app, '/mcp/sales');
    expect(res.status).toBe(200);
    // Legacy path → registerDynamicTools called once for the default profile.
    expect(registerDynamicToolsMock).toHaveBeenCalledOnce();
    expect(registerDynamicToolsMock.mock.calls[0][0].profileName).toBe('sales');
  });

  it('returns 503 for an inactive profile under the legacy URL', async () => {
    const state = new AppState();
    state.addConnection('main', makeConnectionState('main'));
    state.serveProfiles = {
      sales: { name: 'sales', label: 'Sales', authMode: 'token' },
    };
    // NOT added to activeProfileNames

    const app = makeApp(state);
    const res = await postInitialize(app, '/mcp/sales');
    expect(res.status).toBe(503);
  });
});

describe('MCP route — tenant-qualified URL /mcp/<tenant>/<profile>', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 for a malformed tenant id in the URL', async () => {
    const state = new AppState();
    state.addConnection('main', makeConnectionState('main'));

    const app = makeApp(state);
    // "bad tenant" with a space — fails the alphabet regex.
    // Express won't decode "%20" back into ":firstSeg" with a literal space
    // because `:firstSeg` is bound to a single path segment. We use a `.` to
    // trigger a rejection (also outside the alphabet).
    const res = await postInitialize(app, '/mcp/bad.tenant/sales');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/tenant/i);
  });

  it('returns 503 when the tenant has no profile of that name in the DB', async () => {
    const state = new AppState();
    state.addConnection('main', makeConnectionState('main'));
    // No profile row for tenant 'acme-corp'.
    state.db = makeMockDb({});

    const app = makeApp(state);
    const res = await postInitialize(app, '/mcp/acme-corp/sales');
    // No DB row → `loadServeProfileForTenant` returns null → early auth-mode
    // resolution defaults to 'token', then the active-profile check
    // succeeds (non-default tenant → active), then the second profile load
    // returns null too and yields 404 "is not being served".
    expect([404, 503]).toContain(res.status);
  });

  it('loads a non-default tenant profile from the DB and registers tools', async () => {
    const state = new AppState();
    state.addConnection('main', makeConnectionState('main'));
    state.db = makeMockDb({
      'acme-corp': {
        sales: {
          name: 'sales',
          label: 'Sales',
          authMode: 'token',
          selectedTables: { users: ['id', 'email'] },
        },
      },
    });

    const app = makeApp(state);
    const res = await postInitialize(app, '/mcp/acme-corp/sales');
    expect(res.status).toBe(200);
    // The legacy path runs because no `scopes` are populated → tools register
    // through registerDynamicTools.
    expect(registerDynamicToolsMock).toHaveBeenCalledOnce();
    expect(registerDynamicToolsMock.mock.calls[0][0].profileName).toBe('sales');
  });

  it('isolates tenants: a profile registered for tenant A is not reachable from /mcp/B/<name>', async () => {
    const state = new AppState();
    state.addConnection('main', makeConnectionState('main'));
    state.db = makeMockDb({
      'tenant-a': {
        sales: { name: 'sales', label: 'A Sales', authMode: 'token' },
      },
      // tenant-b has no profile named 'sales'
      'tenant-b': {
        marketing: { name: 'marketing', label: 'B Marketing', authMode: 'token' },
      },
    });

    const app = makeApp(state);
    // tenant-b doesn't carry 'sales' — must surface 404, not 200.
    const res = await postInitialize(app, '/mcp/tenant-b/sales');
    expect(res.status).toBe(404);
    // And the per-tenant routing must NOT have leaked into tenant-a.
    expect(registerDynamicToolsMock).not.toHaveBeenCalled();
  });

  it('routes the same profile name to the right tenant when present in both', async () => {
    // Build a schema that carries both `tenantA_table` and `tenantB_table`
    // so each tenant's profile can reference its own table and the legacy
    // tool-registration path picks it up (the path drops table names that
    // don't match any live connection's schema — see the comment around
    // `tablesByConnection` in serve.ts).
    const connState: ConnectionState = {
      connection: {
        name: 'main',
        label: 'main',
        databaseType: 'postgresql',
        connectionString: 'postgres://localhost/main',
      } as NamedConnection,
      schema: {
        tables: [
          {
            name: 'tenantA_table',
            schema: 'public',
            primaryKeys: ['id'],
            columns: [
              { name: 'id', type: 'integer', nullable: false, defaultValue: null },
            ],
          },
          {
            name: 'tenantB_table',
            schema: 'public',
            primaryKeys: ['id'],
            columns: [
              { name: 'id', type: 'integer', nullable: false, defaultValue: null },
            ],
          },
        ],
        relations: [],
      },
      piiDetections: null,
    };

    const state = new AppState();
    state.addConnection('main', connState);
    state.db = makeMockDb({
      'tenant-a': {
        sales: {
          name: 'sales',
          label: 'A Sales',
          authMode: 'token',
          selectedTables: { tenantA_table: ['id'] },
        },
      },
      'tenant-b': {
        sales: {
          name: 'sales',
          label: 'B Sales',
          authMode: 'token',
          selectedTables: { tenantB_table: ['id'] },
        },
      },
    });

    const app = makeApp(state);
    const resA = await postInitialize(app, '/mcp/tenant-a/sales');
    expect(resA.status).toBe(200);
    const callsForA = registerDynamicToolsMock.mock.calls;
    expect(callsForA.length).toBeGreaterThanOrEqual(1);

    registerDynamicToolsMock.mockClear();

    const resB = await postInitialize(app, '/mcp/tenant-b/sales');
    expect(resB.status).toBe(200);
    const callsForB = registerDynamicToolsMock.mock.calls;
    expect(callsForB.length).toBeGreaterThanOrEqual(1);

    // The two profile blobs must be distinct — tenant-a got 'tenantA_table',
    // tenant-b got 'tenantB_table'. registerDynamicTools receives the
    // narrowed selectedTables payload at args[0].selectedTables; assert the
    // payload reflects the correct tenant's profile.
    const aTables = callsForA[0][0].selectedTables;
    const bTables = callsForB[0][0].selectedTables;
    expect(Object.keys(aTables)).toContain('tenantA_table');
    expect(Object.keys(bTables)).toContain('tenantB_table');
  });

  it('does NOT consult state.serveProfiles for a non-default tenant', async () => {
    // Belt-and-suspenders: even when `state.serveProfiles[<name>]` is
    // populated for the default tenant, hitting `/mcp/<other>/<name>` must
    // hit the DB lookup path for the other tenant, not silently fall back
    // to the in-memory cache.
    const state = new AppState();
    state.addConnection('main', makeConnectionState('main'));
    state.serveProfiles = {
      sales: { name: 'sales', label: 'Default Sales', authMode: 'token' },
    };
    state.activeProfileNames.add('sales');
    state.db = makeMockDb({}); // empty — no rows for any tenant.

    const app = makeApp(state);
    const res = await postInitialize(app, '/mcp/acme-corp/sales');
    // No DB row for tenant 'acme-corp' → 404, NOT 200 (would have happened
    // if we leaked the default-tenant cache).
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Token / tenant cross-binding tests
// ---------------------------------------------------------------------------

describe('MCP route — token validation honours the URL tenant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts a legacy token (tenant_id="default") on the legacy URL', async () => {
    const state = new AppState();
    state.addConnection('main', makeConnectionState('main'));
    state.serveProfiles = {
      sales: { name: 'sales', label: 'Sales', authMode: 'token' },
    };
    state.activeProfileNames.add('sales');

    // user manager returns null → fall through to tokenManager.
    state.userManager = {
      verifyToken: vi.fn().mockReturnValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      getUserByEmail: vi.fn().mockReturnValue(null),
      getUserProfileAccess: vi.fn().mockReturnValue(null),
    } as unknown as typeof state.userManager;

    state.tokenManager = {
      verifyToken: vi.fn().mockReturnValue({
        id: 'tok1',
        tokenHash: 'h',
        profileName: 'sales',
        label: 'legacy',
        createdAt: 'now',
        tenantId: 'default',
      }),
      save: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof state.tokenManager;

    const app = express();
    app.use(express.json());
    registerServeRoute(app, state);
    const res = await postInitialize(app, '/mcp/sales');
    expect(res.status).toBe(200);
  });

  it('rejects a token whose tenant_id does not match the URL tenant', async () => {
    // Token belongs to 'tenant-a', URL targets 'tenant-b'. Even when the
    // profile exists in tenant-b, the token must not be honoured.
    const state = new AppState();
    state.addConnection('main', makeConnectionState('main'));
    state.db = makeMockDb({
      'tenant-b': {
        sales: { name: 'sales', label: 'Sales', authMode: 'token' },
      },
    });

    state.userManager = {
      verifyToken: vi.fn().mockReturnValue(null), // not a user-manager token
      save: vi.fn().mockResolvedValue(undefined),
      getUserByEmail: vi.fn().mockReturnValue(null),
      getUserProfileAccess: vi.fn().mockReturnValue(null),
    } as unknown as typeof state.userManager;

    state.tokenManager = {
      verifyToken: vi.fn().mockReturnValue({
        id: 'tok1',
        tokenHash: 'h',
        profileName: 'sales',
        label: 'cross-tenant token',
        createdAt: 'now',
        tenantId: 'tenant-a', // wrong tenant
      }),
      save: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof state.tokenManager;

    const app = express();
    app.use(express.json());
    registerServeRoute(app, state);
    const res = await postInitialize(app, '/mcp/tenant-b/sales');
    expect(res.status).toBe(403);
    expect(registerDynamicToolsMock).not.toHaveBeenCalled();
  });

  it('accepts a token whose tenant_id matches the URL tenant', async () => {
    const state = new AppState();
    state.addConnection('main', makeConnectionState('main'));
    state.db = makeMockDb({
      'tenant-b': {
        sales: { name: 'sales', label: 'Sales', authMode: 'token' },
      },
    });

    state.userManager = {
      verifyToken: vi.fn().mockReturnValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      getUserByEmail: vi.fn().mockReturnValue(null),
      getUserProfileAccess: vi.fn().mockReturnValue(null),
    } as unknown as typeof state.userManager;

    state.tokenManager = {
      verifyToken: vi.fn().mockReturnValue({
        id: 'tok1',
        tokenHash: 'h',
        profileName: 'sales',
        label: 'right tenant',
        createdAt: 'now',
        tenantId: 'tenant-b',
      }),
      save: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof state.tokenManager;

    const app = express();
    app.use(express.json());
    registerServeRoute(app, state);
    const res = await postInitialize(app, '/mcp/tenant-b/sales');
    expect(res.status).toBe(200);
  });
});
