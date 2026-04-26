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

  it('registers the generic describe, aggregate, query tools when a table is visible', () => {
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
    expect(tools.has('describe')).toBe(true);
    expect(tools.has('aggregate')).toBe(true);
    expect(tools.has('query')).toBe(true);
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
    expect(tools.has('describe')).toBe(true);
    // No aggregate / query because no table enables them.
    expect(tools.has('aggregate')).toBe(false);
    expect(tools.has('query')).toBe(false);
  });

  it('does not expose tables not in selectedTables', async () => {
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
    // Generic tools share a single registration; table arg drives access.
    expect(tools.has('list_tables')).toBe(true);
    expect(tools.has('describe')).toBe(true);
    // list_tables payload reflects what's actually accessible.
    const listHandler = tools.get('list_tables')!.handler;
    const listResult = await listHandler({});
    const tableInfo = JSON.parse(listResult.content[0].text);
    const names = tableInfo.map((t: { name: string }) => t.name);
    expect(names).toContain('users');
    expect(names).not.toContain('orders');
    expect(names).not.toContain('tags');
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

  it('does not register aggregate when no visible table has numeric columns', () => {
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
    expect(tools.has('describe')).toBe(true);
    expect(tools.has('query')).toBe(true);
    // The settings table has only text + boolean columns -> no aggregate target.
    expect(tools.has('aggregate')).toBe(false);
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
