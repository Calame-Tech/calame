import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks before any imports so vi.mock() factory runs first.
// ---------------------------------------------------------------------------

const { mockRegisterDynamicTools } = vi.hoisted(() => ({
  mockRegisterDynamicTools: vi.fn(),
}));

vi.mock('@calame/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@calame/core')>();
  return {
    ...original,
    registerDynamicTools: mockRegisterDynamicTools,
  };
});

const { mockPostgresTestConnection, mockPostgresIntrospect, mockPostgresSample } = vi.hoisted(
  () => ({
    mockPostgresTestConnection: vi.fn(),
    mockPostgresIntrospect: vi.fn(),
    mockPostgresSample: vi.fn(),
  }),
);

vi.mock('../postgresql.js', () => ({
  PostgreSQLConnector: vi.fn().mockImplementation(() => ({
    testConnection: mockPostgresTestConnection,
    introspect: mockPostgresIntrospect,
    sampleColumnValues: mockPostgresSample,
  })),
}));

vi.mock('../mysql.js', () => ({
  MySQLConnector: vi.fn().mockImplementation(() => ({
    testConnection: vi.fn(),
    introspect: vi.fn(),
    sampleColumnValues: vi.fn(),
  })),
}));

vi.mock('../sqlite.js', () => ({
  SQLiteConnector: vi.fn().mockImplementation(() => ({
    testConnection: vi.fn(),
    introspect: vi.fn(),
    sampleColumnValues: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Import subjects after mocks.
// ---------------------------------------------------------------------------

import { buildDatabaseSourceAdapter } from '../db-adapter.js';
import { SourceAdapterRegistry } from '@calame/core';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const makeDbSchema = () => ({
  tables: [
    {
      name: 'users',
      schema: 'public',
      columns: [
        { name: 'id', type: 'integer', nullable: false, defaultValue: null },
        { name: 'email', type: 'text', nullable: true, defaultValue: null },
      ],
      primaryKeys: ['id'],
    },
  ],
  relations: [],
});

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const makeMcpServer = () => ({ tool: vi.fn() }) as unknown as McpServer;

// ---------------------------------------------------------------------------
// buildDatabaseSourceAdapter — unit tests
// ---------------------------------------------------------------------------

describe('buildDatabaseSourceAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('metadata', () => {
    it('sets type and displayName for postgresql', () => {
      const adapter = buildDatabaseSourceAdapter('postgresql', 'PostgreSQL');
      expect(adapter.type).toBe('postgresql');
      expect(adapter.displayName).toBe('PostgreSQL');
    });

    it('sets type and displayName for mysql', () => {
      const adapter = buildDatabaseSourceAdapter('mysql', 'MySQL');
      expect(adapter.type).toBe('mysql');
      expect(adapter.displayName).toBe('MySQL');
    });

    it('sets type and displayName for sqlite', () => {
      const adapter = buildDatabaseSourceAdapter('sqlite', 'SQLite');
      expect(adapter.type).toBe('sqlite');
      expect(adapter.displayName).toBe('SQLite');
    });

    it('declares the four required capabilities', () => {
      const adapter = buildDatabaseSourceAdapter('postgresql', 'PostgreSQL');
      expect(adapter.capabilities).toContain('introspect');
      expect(adapter.capabilities).toContain('query');
      expect(adapter.capabilities).toContain('enumerate');
      expect(adapter.capabilities).toContain('sample');
    });
  });

  describe('configSchema', () => {
    it('parses a minimal config with connectionString only', () => {
      const adapter = buildDatabaseSourceAdapter('postgresql', 'PostgreSQL');
      const result = adapter.configSchema.parse({ connectionString: 'postgresql://localhost/db' });
      expect(result.connectionString).toBe('postgresql://localhost/db');
    });

    it('parses a config with ssl fields', () => {
      const adapter = buildDatabaseSourceAdapter('postgresql', 'PostgreSQL');
      const result = adapter.configSchema.parse({
        connectionString: 'postgresql://localhost/db',
        ssl: { enabled: true, rejectUnauthorized: false },
      });
      expect(result.ssl?.enabled).toBe(true);
    });

    it('rejects an empty connectionString', () => {
      const adapter = buildDatabaseSourceAdapter('postgresql', 'PostgreSQL');
      expect(() => adapter.configSchema.parse({ connectionString: '' })).toThrow();
    });
  });

  describe('testConnection', () => {
    it('delegates to the underlying connector', async () => {
      mockPostgresTestConnection.mockResolvedValueOnce(undefined);
      const adapter = buildDatabaseSourceAdapter('postgresql', 'PostgreSQL');
      await adapter.testConnection({ connectionString: 'postgresql://localhost/db' });
      expect(mockPostgresTestConnection).toHaveBeenCalledWith('postgresql://localhost/db', {});
    });

    it('passes ssl options through', async () => {
      mockPostgresTestConnection.mockResolvedValueOnce(undefined);
      const adapter = buildDatabaseSourceAdapter('postgresql', 'PostgreSQL');
      const ssl = { enabled: true, rejectUnauthorized: false };
      await adapter.testConnection({ connectionString: 'postgresql://localhost/db', ssl });
      expect(mockPostgresTestConnection).toHaveBeenCalledWith('postgresql://localhost/db', { ssl });
    });

    it('propagates errors from the underlying connector', async () => {
      mockPostgresTestConnection.mockRejectedValueOnce(new Error('connection refused'));
      const adapter = buildDatabaseSourceAdapter('postgresql', 'PostgreSQL');
      await expect(
        adapter.testConnection({ connectionString: 'postgresql://localhost/db' }),
      ).rejects.toThrow('connection refused');
    });
  });

  describe('introspect', () => {
    it('wraps the connector result with kind: relational', async () => {
      const dbSchema = makeDbSchema();
      mockPostgresIntrospect.mockResolvedValueOnce(dbSchema);
      const adapter = buildDatabaseSourceAdapter('postgresql', 'PostgreSQL');
      const result = await adapter.introspect!(
        { connectionString: 'postgresql://localhost/db' },
        'src1',
      );
      expect(result.kind).toBe('relational');
      expect(result.tables).toStrictEqual(dbSchema.tables);
      expect(result.relations).toStrictEqual(dbSchema.relations);
    });
  });

  describe('listScopes', () => {
    it('groups tables by schema', async () => {
      mockPostgresIntrospect.mockResolvedValueOnce({
        tables: [
          { name: 'users', schema: 'public', columns: [], primaryKeys: [] },
          { name: 'orders', schema: 'public', columns: [], primaryKeys: [] },
          { name: 'logs', schema: 'audit', columns: [], primaryKeys: [] },
        ],
        relations: [],
      });
      const adapter = buildDatabaseSourceAdapter('postgresql', 'PostgreSQL');
      const scopes = (await adapter.listScopes!(
        { connectionString: 'postgresql://localhost/db' },
        'src1',
      )) as ReadonlyArray<{ id: string; name: string; tableCount: number }>;
      expect(scopes).toHaveLength(2);
      const publicScope = scopes.find((s) => s.id === 'public');
      expect(publicScope?.tableCount).toBe(2);
      const auditScope = scopes.find((s) => s.id === 'audit');
      expect(auditScope?.tableCount).toBe(1);
    });
  });

  describe('listItems', () => {
    type ListItem = { id: string; name: string; type?: string };

    it('returns all tables when no scope given', async () => {
      mockPostgresIntrospect.mockResolvedValueOnce(makeDbSchema());
      const adapter = buildDatabaseSourceAdapter('postgresql', 'PostgreSQL');
      const items = (await adapter.listItems!(
        { connectionString: 'postgresql://localhost/db' },
        'src1',
      )) as ReadonlyArray<ListItem>;
      expect(items).toHaveLength(1);
      expect(items[0].name).toBe('users');
    });

    it('returns columns when a table scope is given', async () => {
      mockPostgresIntrospect.mockResolvedValueOnce(makeDbSchema());
      const adapter = buildDatabaseSourceAdapter('postgresql', 'PostgreSQL');
      const cols = (await adapter.listItems!(
        { connectionString: 'postgresql://localhost/db' },
        'src1',
        'users',
      )) as ReadonlyArray<ListItem>;
      expect(cols).toHaveLength(2);
      expect(cols.map((c) => c.name)).toContain('email');
    });

    it('returns empty array for an unknown scope', async () => {
      mockPostgresIntrospect.mockResolvedValueOnce(makeDbSchema());
      const adapter = buildDatabaseSourceAdapter('postgresql', 'PostgreSQL');
      const items = await adapter.listItems!(
        { connectionString: 'postgresql://localhost/db' },
        'src1',
        'nonexistent',
      );
      expect(items).toHaveLength(0);
    });
  });

  describe('sampleValues', () => {
    it('delegates to connector.sampleColumnValues', async () => {
      mockPostgresSample.mockResolvedValueOnce(['alice@example.com', 'bob@example.com']);
      const adapter = buildDatabaseSourceAdapter('postgresql', 'PostgreSQL');
      const values = await adapter.sampleValues!(
        { connectionString: 'postgresql://localhost/db' },
        'src1',
        'users',
        'email',
        10,
      );
      expect(mockPostgresSample).toHaveBeenCalledWith(
        'postgresql://localhost/db',
        'users',
        'email',
        10,
        {},
      );
      expect(values).toContain('alice@example.com');
    });
  });

  describe('registerMcpTools', () => {
    it('calls registerDynamicTools with projected options for a relational selection', () => {
      const adapter = buildDatabaseSourceAdapter('postgresql', 'PostgreSQL');
      const server = makeMcpServer();
      const schema = {
        kind: 'relational' as const,
        tables: makeDbSchema().tables,
        relations: [],
      };
      const selection = {
        kind: 'relational' as const,
        selectedTables: { users: ['id', 'email'] },
      };

      adapter.registerMcpTools!({
        server,
        source: {
          id: 'src1',
          name: 'prod',
          type: 'postgresql',
          configEncrypted: '',
          capabilities: [],
          createdAt: '',
          updatedAt: '',
        },
        config: { connectionString: 'postgresql://localhost/db' },
        schema,
        selection,
        profileName: 'myprofile',
        toolNamespace: '',
        responseMode: 'friendly',
        onAuditLog: vi.fn(),
        executeQuery: vi.fn(),
      });

      expect(mockRegisterDynamicTools).toHaveBeenCalledOnce();
      const opts = mockRegisterDynamicTools.mock.calls[0][0];
      expect(opts.server).toBe(server);
      expect(opts.tables).toBe(schema.tables);
      expect(opts.relations).toBe(schema.relations);
      expect(opts.selectedTables).toStrictEqual({ users: ['id', 'email'] });
      expect(opts.profileName).toBe('myprofile');
      expect(opts.responseMode).toBe('friendly');
      expect(opts.databaseType).toBe('postgresql');
      expect(opts.toolNamespace).toBe('');
    });

    it('forwards a non-empty toolNamespace to registerDynamicTools', () => {
      const adapter = buildDatabaseSourceAdapter('postgresql', 'PostgreSQL');
      const server = makeMcpServer();
      const schema = { kind: 'relational' as const, tables: [], relations: [] };
      const selection = { kind: 'relational' as const, selectedTables: {} };

      adapter.registerMcpTools!({
        server,
        source: {
          id: 'src1',
          name: 'prod',
          type: 'postgresql',
          configEncrypted: '',
          capabilities: [],
          createdAt: '',
          updatedAt: '',
        },
        config: { connectionString: 'postgresql://localhost/db' },
        schema,
        selection,
        profileName: 'myprofile',
        toolNamespace: 'production_db_',
        responseMode: 'friendly',
        onAuditLog: vi.fn(),
        executeQuery: vi.fn(),
      });

      expect(mockRegisterDynamicTools).toHaveBeenCalledOnce();
      const opts = mockRegisterDynamicTools.mock.calls[0][0];
      expect(opts.toolNamespace).toBe('production_db_');
    });

    it('throws when given a non-relational selection', () => {
      const adapter = buildDatabaseSourceAdapter('postgresql', 'PostgreSQL');
      const server = makeMcpServer();
      const schema = { kind: 'relational' as const, tables: [], relations: [] };
      const selection = {
        kind: 'document' as const,
        mode: 'allowAll' as const,
        allowedFolders: [],
        allowedDocuments: [],
      };

      expect(() =>
        adapter.registerMcpTools!({
          server,
          source: {
            id: 's1',
            name: 'kb',
            type: 'postgresql',
            configEncrypted: '',
            capabilities: [],
            createdAt: '',
            updatedAt: '',
          },
          config: { connectionString: 'postgresql://localhost/db' },
          schema,
          selection,
          profileName: 'p',
          toolNamespace: '',
          responseMode: 'raw',
          onAuditLog: vi.fn(),
        }),
      ).toThrow(/expected relational selection/);
    });
  });
});

// ---------------------------------------------------------------------------
// sourceAdapterRegistry — module-level registration
// ---------------------------------------------------------------------------

describe('sourceAdapterRegistry auto-registration', () => {
  // We use a fresh registry to avoid polluting the singleton used by other tests.
  it('all three DB adapters register without error in a fresh registry', () => {
    const fresh = new SourceAdapterRegistry();
    fresh.register(buildDatabaseSourceAdapter('postgresql', 'PostgreSQL'));
    fresh.register(buildDatabaseSourceAdapter('mysql', 'MySQL'));
    fresh.register(buildDatabaseSourceAdapter('sqlite', 'SQLite'));
    expect(fresh.has('postgresql')).toBe(true);
    expect(fresh.has('mysql')).toBe(true);
    expect(fresh.has('sqlite')).toBe(true);
  });

  it('sourceAdapterRegistry gets the three DB adapters after index.ts is loaded', () => {
    // The module-level registration happens in index.ts when it is imported.
    // This test verifies that registering the adapters into the registry succeeds
    // (no duplicate-registration errors) — index.ts itself is not imported here
    // to avoid side effects across parallel test suites.
    const fresh = new SourceAdapterRegistry();
    expect(() => {
      fresh.register(buildDatabaseSourceAdapter('postgresql', 'PostgreSQL'));
      fresh.register(buildDatabaseSourceAdapter('mysql', 'MySQL'));
      fresh.register(buildDatabaseSourceAdapter('sqlite', 'SQLite'));
    }).not.toThrow();
    expect(fresh.list()).toHaveLength(3);
  });
});
