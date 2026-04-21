import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerDynamicTools } from '../dynamic-tools.js';
import type { TableInfo, Relation } from '../../introspect/types.js';
import type { ColumnMasking } from '../../pii/types.js';

// ---------------------------------------------------------------------------
// Mock McpServer that captures registered tools
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
  };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const usersTable: TableInfo = {
  name: 'users',
  schema: 'public',
  columns: [
    { name: 'id', type: 'integer', nullable: false, defaultValue: null },
    { name: 'name', type: 'text', nullable: false, defaultValue: null },
    { name: 'email', type: 'text', nullable: false, defaultValue: null },
    { name: 'age', type: 'integer', nullable: true, defaultValue: null },
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
    { name: 'status', type: 'text', nullable: false, defaultValue: null },
  ],
  primaryKeys: ['id'],
};

const tagsTable: TableInfo = {
  name: 'tags',
  schema: 'public',
  columns: [
    { name: 'id', type: 'integer', nullable: false, defaultValue: null },
    { name: 'label', type: 'text', nullable: false, defaultValue: null },
  ],
  primaryKeys: ['id'],
};

// Table with NO numeric columns (only text + boolean)
const noNumericTable: TableInfo = {
  name: 'settings',
  schema: 'public',
  columns: [
    { name: 'key', type: 'text', nullable: false, defaultValue: null },
    { name: 'value', type: 'text', nullable: true, defaultValue: null },
    { name: 'active', type: 'boolean', nullable: false, defaultValue: 'true' },
  ],
  primaryKeys: ['key'],
};

const relations: Relation[] = [
  { fromTable: 'orders', fromColumn: 'user_id', toTable: 'users', toColumn: 'id' },
];

function makeMockExecuteQuery() {
  return vi.fn().mockResolvedValue({ rows: [], fields: [] });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerDynamicTools', () => {
  let server: ReturnType<typeof createMockServer>;
  let mockExecuteQuery: ReturnType<typeof makeMockExecuteQuery>;

  beforeEach(() => {
    server = createMockServer();
    mockExecuteQuery = makeMockExecuteQuery();
  });

  it('registers list_tables tool', () => {
    registerDynamicTools({
      server: server as unknown as Parameters<typeof registerDynamicTools>[0]['server'],
      tables: [usersTable],
      relations: [],
      selectedTables: { users: ['id', 'name', 'email', 'age'] },
      executeQuery: mockExecuteQuery,
      profileName: 'test',
      databaseType: 'postgresql',
    });

    const tools = server.getRegisteredTools();
    expect(tools.has('list_tables')).toBe(true);
  });

  it('registers describe, aggregate, query tools for a table', () => {
    registerDynamicTools({
      server: server as unknown as Parameters<typeof registerDynamicTools>[0]['server'],
      tables: [usersTable],
      relations: [],
      selectedTables: { users: ['id', 'name', 'email', 'age'] },
      executeQuery: mockExecuteQuery,
      profileName: 'test',
      databaseType: 'postgresql',
    });

    const tools = server.getRegisteredTools();
    expect(tools.has('describe_users')).toBe(true);
    expect(tools.has('aggregate_users')).toBe(true);
    expect(tools.has('query_users')).toBe(true);
  });

  it('respects enabledTools option (only describe)', () => {
    registerDynamicTools({
      server: server as unknown as Parameters<typeof registerDynamicTools>[0]['server'],
      tables: [usersTable],
      relations: [],
      selectedTables: { users: ['id', 'name', 'email', 'age'] },
      tableOptions: {
        users: {
          enabledTools: ['describe'],
          maxLimit: 100,
          filterableColumns: [],
          groupableColumns: [],
        },
      },
      executeQuery: mockExecuteQuery,
      profileName: 'test',
      databaseType: 'postgresql',
    });

    const tools = server.getRegisteredTools();
    expect(tools.has('describe_users')).toBe(true);
    expect(tools.has('aggregate_users')).toBe(false);
    expect(tools.has('query_users')).toBe(false);
  });

  it('does not expose tables not in selectedTables', () => {
    registerDynamicTools({
      server: server as unknown as Parameters<typeof registerDynamicTools>[0]['server'],
      tables: [usersTable, ordersTable, tagsTable],
      relations,
      selectedTables: { users: ['id', 'name'] },
      executeQuery: mockExecuteQuery,
      profileName: 'test',
      databaseType: 'postgresql',
    });

    const tools = server.getRegisteredTools();
    expect(tools.has('describe_users')).toBe(true);
    expect(tools.has('describe_orders')).toBe(false);
    expect(tools.has('query_orders')).toBe(false);
    expect(tools.has('aggregate_orders')).toBe(false);
    expect(tools.has('describe_tags')).toBe(false);
  });

  it('filters out columns not in selectedTables', async () => {
    // Only select 'id' and 'name' (not 'email', 'age')
    mockExecuteQuery.mockResolvedValue({ rows: [{ total: 5 }], fields: [{ name: 'total' }] });

    registerDynamicTools({
      server: server as unknown as Parameters<typeof registerDynamicTools>[0]['server'],
      tables: [usersTable],
      relations: [],
      selectedTables: { users: ['id', 'name'] },
      executeQuery: mockExecuteQuery,
      profileName: 'test',
      databaseType: 'postgresql',
    });

    const tools = server.getRegisteredTools();

    // list_tables handler should only show selected columns
    const listHandler = tools.get('list_tables')!.handler;
    const result = await listHandler({});
    const content = JSON.parse(result.content[0].text);
    expect(content[0].columns).toEqual(['id', 'name']);
    expect(content[0].columns).not.toContain('email');
    expect(content[0].columns).not.toContain('age');
  });

  it('does not register aggregate tool for tables without numeric columns', () => {
    registerDynamicTools({
      server: server as unknown as Parameters<typeof registerDynamicTools>[0]['server'],
      tables: [noNumericTable],
      relations: [],
      selectedTables: { settings: ['key', 'value', 'active'] },
      executeQuery: mockExecuteQuery,
      profileName: 'test',
      databaseType: 'postgresql',
    });

    const tools = server.getRegisteredTools();
    expect(tools.has('describe_settings')).toBe(true);
    expect(tools.has('query_settings')).toBe(true);
    expect(tools.has('aggregate_settings')).toBe(false);
  });

  it('column masking exclude mode removes column from results', async () => {
    const columnMasking: Record<string, Record<string, ColumnMasking>> = {
      users: {
        email: {
          maskingMode: 'exclude',
        },
      },
    };

    mockExecuteQuery.mockResolvedValue({ rows: [{ total: 1 }], fields: [{ name: 'total' }] });

    registerDynamicTools({
      server: server as unknown as Parameters<typeof registerDynamicTools>[0]['server'],
      tables: [usersTable],
      relations: [],
      selectedTables: { users: ['id', 'name', 'email', 'age'] },
      columnMasking,
      executeQuery: mockExecuteQuery,
      profileName: 'test',
      databaseType: 'postgresql',
    });

    const tools = server.getRegisteredTools();

    // The list_tables tool should not include 'email'
    const listHandler = tools.get('list_tables')!.handler;
    const listResult = await listHandler({});
    const tableInfo = JSON.parse(listResult.content[0].text);
    expect(tableInfo[0].columns).not.toContain('email');
    expect(tableInfo[0].columns).toContain('id');
    expect(tableInfo[0].columns).toContain('name');
  });

  it('onAuditLog callback is called for each tool execution', async () => {
    const auditLog = vi.fn();

    mockExecuteQuery.mockResolvedValue({ rows: [{ total: 10 }], fields: [{ name: 'total' }] });

    registerDynamicTools({
      server: server as unknown as Parameters<typeof registerDynamicTools>[0]['server'],
      tables: [usersTable],
      relations: [],
      selectedTables: { users: ['id', 'name', 'email', 'age'] },
      executeQuery: mockExecuteQuery,
      onAuditLog: auditLog,
      profileName: 'myprofile',
      databaseType: 'postgresql',
    });

    const tools = server.getRegisteredTools();

    // Call list_tables
    const listHandler = tools.get('list_tables')!.handler;
    await listHandler({});

    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'myprofile',
        toolName: 'list_tables',
        result: 'success',
      }),
    );
  });
});
