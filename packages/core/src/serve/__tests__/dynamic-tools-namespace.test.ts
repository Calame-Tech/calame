import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerDynamicTools, registerCalcTool } from '../dynamic-tools.js';
import type { TableInfo, Relation } from '../../introspect/types.js';

// ---------------------------------------------------------------------------
// Mock McpServer that captures registered tool names
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolHandler = (...args: any[]) => any;

function createMockServer() {
  const tools = new Map<string, { description: string; schema: unknown; handler: ToolHandler }>();
  return {
    tool: vi.fn((name: string, description: string, schema: unknown, handler: ToolHandler) => {
      tools.set(name, { description, schema, handler });
    }),
    getRegisteredTools: () => tools,
    getToolNames: () => [...tools.keys()],
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const usersTable: TableInfo = {
  name: 'users',
  schema: 'public',
  columns: [
    { name: 'id', type: 'integer', nullable: false, defaultValue: null },
    { name: 'name', type: 'text', nullable: false, defaultValue: null },
    { name: 'score', type: 'integer', nullable: true, defaultValue: null },
  ],
  primaryKeys: ['id'],
};

const ordersTable: TableInfo = {
  name: 'orders',
  schema: 'public',
  columns: [
    { name: 'id', type: 'integer', nullable: false, defaultValue: null },
    { name: 'user_id', type: 'integer', nullable: false, defaultValue: null },
    { name: 'amount', type: 'numeric', nullable: false, defaultValue: null },
  ],
  primaryKeys: ['id'],
};

const relations: Relation[] = [
  { fromTable: 'orders', fromColumn: 'user_id', toTable: 'users', toColumn: 'id' },
];

function makeBaseOptions(
  server: ReturnType<typeof createMockServer>,
  extraOptions?: Partial<Parameters<typeof registerDynamicTools>[0]>,
): Parameters<typeof registerDynamicTools>[0] {
  return {
    server: server as unknown as Parameters<typeof registerDynamicTools>[0]['server'],
    tables: [usersTable, ordersTable],
    relations,
    selectedTables: {
      users: ['id', 'name', 'score'],
      orders: ['id', 'user_id', 'amount'],
    },
    executeQuery: vi.fn().mockResolvedValue({ rows: [], fields: [] }),
    profileName: 'test',
    databaseType: 'postgresql',
    ...extraOptions,
  };
}

// ---------------------------------------------------------------------------
// Tests — toolNamespace backward compat (no prefix)
// ---------------------------------------------------------------------------

describe('registerDynamicTools — toolNamespace', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    server = createMockServer();
  });

  describe('when toolNamespace is unset', () => {
    it('registers tools with unprefixed names', () => {
      registerCalcTool(
        server as unknown as Parameters<typeof registerCalcTool>[0],
        'test',
        (s) => s,
      );
      registerDynamicTools(makeBaseOptions(server));

      const names = server.getToolNames();
      // calc is registered globally (no prefix) by the caller, not by registerDynamicTools
      expect(names).toContain('calc');
      expect(names).toContain('list_tables');
      expect(names).toContain('describe');
      expect(names).toContain('aggregate');
      expect(names).toContain('query');
      expect(names).toContain('join_aggregate');
    });

    it('registers NO prefixed variants when namespace is absent', () => {
      registerDynamicTools(makeBaseOptions(server));

      const names = server.getToolNames();
      // None of the names should start with an underscore-separated prefix
      const prefixed = names.filter(
        (n) => /^[a-z]+_[a-z]/.test(n) && n !== 'list_tables' && n !== 'join_aggregate',
      );
      expect(prefixed).toHaveLength(0);
    });

    it('does not register calc — calc is registered globally by the caller', () => {
      registerDynamicTools(makeBaseOptions(server));

      const names = server.getToolNames();
      expect(names).not.toContain('calc');
    });
  });

  describe('when toolNamespace is empty string', () => {
    it('behaves identically to unset (no prefix) for source-scoped tools', () => {
      registerDynamicTools(makeBaseOptions(server, { toolNamespace: '' }));

      const names = server.getToolNames();
      // calc is NOT registered by registerDynamicTools — it is the caller's responsibility
      expect(names).not.toContain('calc');
      expect(names).toContain('list_tables');
      expect(names).toContain('describe');
      expect(names).toContain('aggregate');
      expect(names).toContain('query');
      expect(names).toContain('join_aggregate');
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — toolNamespace with prefix applied
  // ---------------------------------------------------------------------------

  describe('when toolNamespace is "prod_"', () => {
    it('prefixes every source-scoped tool name (calc excluded — it is global)', () => {
      registerDynamicTools(makeBaseOptions(server, { toolNamespace: 'prod_' }));

      const names = server.getToolNames();
      // calc is global, registered once by the caller without a namespace — not by registerDynamicTools
      expect(names).not.toContain('prod_calc');
      expect(names).toContain('prod_list_tables');
      expect(names).toContain('prod_describe');
      expect(names).toContain('prod_aggregate');
      expect(names).toContain('prod_query');
      expect(names).toContain('prod_join_aggregate');
    });

    it('registers NO unprefixed source-scoped tool names', () => {
      registerDynamicTools(makeBaseOptions(server, { toolNamespace: 'prod_' }));

      const names = server.getToolNames();
      expect(names).not.toContain('calc');
      expect(names).not.toContain('list_tables');
      expect(names).not.toContain('describe');
      expect(names).not.toContain('aggregate');
      expect(names).not.toContain('query');
      expect(names).not.toContain('join_aggregate');
    });
  });

  describe('when toolNamespace is "staging_"', () => {
    it('prefixes every source-scoped tool name with staging_ (calc excluded — it is global)', () => {
      registerDynamicTools(makeBaseOptions(server, { toolNamespace: 'staging_' }));

      const names = server.getToolNames();
      // calc is global, not registered by registerDynamicTools
      expect(names).not.toContain('staging_calc');
      expect(names).toContain('staging_list_tables');
      expect(names).toContain('staging_describe');
      expect(names).toContain('staging_aggregate');
      expect(names).toContain('staging_query');
      expect(names).toContain('staging_join_aggregate');
    });

    it('does not register any unprefixed source-scoped tool names', () => {
      registerDynamicTools(makeBaseOptions(server, { toolNamespace: 'staging_' }));

      const names = server.getToolNames();
      expect(names).not.toContain('calc');
      expect(names).not.toContain('list_tables');
      expect(names).not.toContain('describe');
      expect(names).not.toContain('aggregate');
      expect(names).not.toContain('query');
      expect(names).not.toContain('join_aggregate');
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — write tool is also namespaced
  // ---------------------------------------------------------------------------

  describe('write tool namespacing', () => {
    it('prefixes write tool when toolNamespace is set', () => {
      const onWriteRequest = vi.fn().mockReturnValue('req-1');
      registerDynamicTools(
        makeBaseOptions(server, {
          toolNamespace: 'kb1_',
          onWriteRequest,
          tableOptions: {
            users: {
              enabledTools: ['describe', 'aggregate', 'query', 'write'],
              maxLimit: 100,
              filterableColumns: [],
              groupableColumns: [],
            },
            orders: {
              enabledTools: ['describe', 'aggregate', 'query'],
              maxLimit: 100,
              filterableColumns: [],
              groupableColumns: [],
            },
          },
        }),
      );

      const names = server.getToolNames();
      expect(names).toContain('kb1_write');
      expect(names).not.toContain('write');
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — server.tool spy call count
  // ---------------------------------------------------------------------------

  describe('server.tool call count', () => {
    it('calls server.tool the same number of times regardless of namespace', () => {
      const server1 = createMockServer();
      const server2 = createMockServer();

      registerDynamicTools(makeBaseOptions(server1));
      registerDynamicTools(makeBaseOptions(server2, { toolNamespace: 'ns_' }));

      expect(server1.tool).toHaveBeenCalledTimes(server2.tool.mock.calls.length);
    });

    it('all tool names returned by server1 match those of server2 when prefixed', () => {
      const server1 = createMockServer();
      const server2 = createMockServer();

      registerDynamicTools(makeBaseOptions(server1));
      registerDynamicTools(makeBaseOptions(server2, { toolNamespace: 'x_' }));

      const names1 = server1.getToolNames().sort();
      const names2 = server2
        .getToolNames()
        .map((n) => n.replace(/^x_/, ''))
        .sort();

      expect(names2).toEqual(names1);
    });
  });
});
