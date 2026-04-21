import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks so they are initialised before the vi.mock() factory runs.
// vi.mock() calls are hoisted to the top of the compiled output by vitest,
// which means any variables they reference must also be hoisted.
// ---------------------------------------------------------------------------

const { mockQuery, mockEnd, mockConnection, mockCreateConnection } = vi.hoisted(() => {
  const mockQuery = vi.fn();
  const mockEnd = vi.fn();
  const mockConnection = { query: mockQuery, end: mockEnd };
  const mockCreateConnection = vi.fn().mockResolvedValue(mockConnection);
  return { mockQuery, mockEnd, mockConnection, mockCreateConnection };
});

vi.mock('mysql2/promise', () => ({
  default: {
    createConnection: mockCreateConnection,
  },
}));

import mysql from 'mysql2/promise';
import { MySQLConnector } from '../mysql.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_DSN = 'mysql://root:secret@localhost:3306/testdb';

/** Set up mockQuery to return empty rows for every call (persistent default). */
function mockEmptyIntrospect() {
  mockQuery.mockResolvedValue([[]]);
}

/** Prime the four information_schema queries that introspect() issues. */
function mockFullIntrospect() {
  // 1. tables
  mockQuery.mockResolvedValueOnce([
    [
      { table_name: 'users', table_schema: 'testdb' },
      { table_name: 'posts', table_schema: 'testdb' },
    ],
  ]);

  // 2. columns
  mockQuery.mockResolvedValueOnce([
    [
      { column_name: 'id',      data_type: 'int',     is_nullable: 'NO',  column_default: null, table_name: 'users' },
      { column_name: 'name',    data_type: 'varchar',  is_nullable: 'YES', column_default: null, table_name: 'users' },
      { column_name: 'id',      data_type: 'int',     is_nullable: 'NO',  column_default: null, table_name: 'posts' },
      { column_name: 'user_id', data_type: 'int',     is_nullable: 'NO',  column_default: null, table_name: 'posts' },
    ],
  ]);

  // 3. primary keys
  mockQuery.mockResolvedValueOnce([
    [
      { column_name: 'id', table_name: 'users' },
      { column_name: 'id', table_name: 'posts' },
    ],
  ]);

  // 4. foreign keys
  mockQuery.mockResolvedValueOnce([
    [
      { column_name: 'user_id', from_table: 'posts', to_table: 'users', to_column: 'id' },
    ],
  ]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MySQLConnector', () => {
  let connector: MySQLConnector;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateConnection.mockResolvedValue(mockConnection);
    mockEnd.mockResolvedValue(undefined);
    connector = new MySQLConnector();
  });

  // ── Metadata ─────────────────────────────────────────────────────────────

  it('exposes correct metadata', () => {
    expect(connector.name).toBe('mysql');
    expect(connector.displayName).toBe('MySQL / MariaDB');
    expect(connector.placeholderDsn).toBe('mysql://user:password@localhost:3306/mydb');
  });

  // ── disconnect ────────────────────────────────────────────────────────────

  it('disconnect() resolves without throwing (stateless connector)', async () => {
    await expect(connector.disconnect()).resolves.toBeUndefined();
  });

  // ── testConnection ────────────────────────────────────────────────────────

  describe('testConnection', () => {
    it('returns true when SELECT 1 succeeds', async () => {
      mockQuery.mockResolvedValueOnce([[{ '1': 1 }]]);

      const result = await connector.testConnection(VALID_DSN);

      expect(result).toBe(true);
      expect(mysql.createConnection).toHaveBeenCalledOnce();
      expect(mockQuery).toHaveBeenCalledWith('SELECT 1');
      expect(mockEnd).toHaveBeenCalledOnce();
    });

    it('returns false when createConnection rejects', async () => {
      mockCreateConnection.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await connector.testConnection(VALID_DSN);

      expect(result).toBe(false);
      // No connection object was obtained so end() must not be called.
      expect(mockEnd).not.toHaveBeenCalled();
    });

    it('returns false when SELECT 1 query rejects', async () => {
      mockQuery.mockRejectedValueOnce(new Error('ER_ACCESS_DENIED_ERROR'));

      const result = await connector.testConnection(VALID_DSN);

      expect(result).toBe(false);
      expect(mockEnd).toHaveBeenCalledOnce();
    });

    it('parses DSN with non-default port', async () => {
      mockQuery.mockResolvedValueOnce([[{ '1': 1 }]]);

      await connector.testConnection('mysql://admin:pass@db.example.com:3307/myapp');

      expect(mysql.createConnection).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'db.example.com', port: 3307, database: 'myapp' }),
      );
    });

    it('defaults port to 3306 when omitted from DSN', async () => {
      mockQuery.mockResolvedValueOnce([[{ '1': 1 }]]);

      await connector.testConnection('mysql://root@localhost/mydb');

      expect(mysql.createConnection).toHaveBeenCalledWith(
        expect.objectContaining({ port: 3306 }),
      );
    });

    it('throws when DSN has wrong protocol', async () => {
      await expect(
        connector.testConnection('postgres://user:pass@host/db'),
      ).rejects.toThrow('Unsupported protocol');
    });

    it('throws when DSN has no database name', async () => {
      await expect(
        connector.testConnection('mysql://user:pass@host:3306'),
      ).rejects.toThrow('database name');
    });
  });

  // ── introspect ────────────────────────────────────────────────────────────

  describe('introspect', () => {
    it('assembles tables, columns, primary keys, and relations', async () => {
      mockFullIntrospect();

      const schema = await connector.introspect(VALID_DSN);

      expect(schema.tables).toHaveLength(2);

      const usersTable = schema.tables.find((t) => t.name === 'users');
      expect(usersTable).toBeDefined();
      expect(usersTable!.schema).toBe('testdb');
      expect(usersTable!.primaryKeys).toEqual(['id']);
      expect(usersTable!.columns).toHaveLength(2);
      expect(usersTable!.columns[0]).toEqual({ name: 'id',   type: 'int',     nullable: false, defaultValue: null });
      expect(usersTable!.columns[1]).toEqual({ name: 'name', type: 'varchar', nullable: true,  defaultValue: null });

      const postsTable = schema.tables.find((t) => t.name === 'posts');
      expect(postsTable).toBeDefined();
      expect(postsTable!.primaryKeys).toEqual(['id']);
      expect(postsTable!.columns).toHaveLength(2);

      expect(schema.relations).toHaveLength(1);
      expect(schema.relations[0]).toEqual({
        fromTable: 'posts',
        fromColumn: 'user_id',
        toTable: 'users',
        toColumn: 'id',
      });
    });

    it('handles an empty database (no tables)', async () => {
      mockEmptyIntrospect();

      const schema = await connector.introspect(VALID_DSN);

      expect(schema.tables).toHaveLength(0);
      expect(schema.relations).toHaveLength(0);
      expect(mockEnd).toHaveBeenCalledOnce();
    });

    it('handles tables with no foreign keys', async () => {
      mockQuery.mockResolvedValueOnce([[{ table_name: 'users', table_schema: 'testdb' }]]);
      mockQuery.mockResolvedValueOnce([
        [{ column_name: 'id', data_type: 'int', is_nullable: 'NO', column_default: null, table_name: 'users' }],
      ]);
      mockQuery.mockResolvedValueOnce([[{ column_name: 'id', table_name: 'users' }]]);
      mockQuery.mockResolvedValueOnce([[]]); // no foreign keys

      const schema = await connector.introspect(VALID_DSN);

      expect(schema.tables).toHaveLength(1);
      expect(schema.relations).toHaveLength(0);
    });

    it('handles composite primary keys', async () => {
      mockQuery.mockResolvedValueOnce([[{ table_name: 'order_items', table_schema: 'shop' }]]);
      mockQuery.mockResolvedValueOnce([
        [
          { column_name: 'order_id',   data_type: 'int', is_nullable: 'NO', column_default: null, table_name: 'order_items' },
          { column_name: 'product_id', data_type: 'int', is_nullable: 'NO', column_default: null, table_name: 'order_items' },
        ],
      ]);
      mockQuery.mockResolvedValueOnce([
        [
          { column_name: 'order_id',   table_name: 'order_items' },
          { column_name: 'product_id', table_name: 'order_items' },
        ],
      ]);
      mockQuery.mockResolvedValueOnce([[]]); // no foreign keys

      const schema = await connector.introspect(VALID_DSN);

      expect(schema.tables[0]!.primaryKeys).toEqual(['order_id', 'product_id']);
    });

    it('runs exactly 4 queries against the DB', async () => {
      mockFullIntrospect();

      await connector.introspect(VALID_DSN);

      expect(mockQuery).toHaveBeenCalledTimes(4);
    });

    it('closes the connection even when a query throws', async () => {
      mockQuery.mockResolvedValueOnce([[{ table_name: 'users', table_schema: 'testdb' }]]);
      mockQuery.mockRejectedValueOnce(new Error('ER_QUERY_INTERRUPTED'));

      await expect(connector.introspect(VALID_DSN)).rejects.toThrow('ER_QUERY_INTERRUPTED');
      expect(mockEnd).toHaveBeenCalledOnce();
    });

    it('propagates error and does not call end() when createConnection throws', async () => {
      mockCreateConnection.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(connector.introspect(VALID_DSN)).rejects.toThrow('ECONNREFUSED');
      // Connection never obtained — end() must not be called.
      expect(mockEnd).not.toHaveBeenCalled();
    });

    it('URL-decodes special characters in user and password', async () => {
      mockEmptyIntrospect();

      await connector.introspect('mysql://my%40user:p%40ss%21@localhost:3306/db');

      expect(mysql.createConnection).toHaveBeenCalledWith(
        expect.objectContaining({ user: 'my@user', password: 'p@ss!' }),
      );
    });
  });
});
