import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted() declares variables before the vi.mock() hoisting boundary,
// so they are safely accessible inside the factory function.
// ---------------------------------------------------------------------------

const { MockDatabase, mockPrepare, mockClose } = vi.hoisted(() => {
  const mockClose = vi.fn();
  const mockPrepare = vi.fn();

  const MockDatabase = vi.fn().mockImplementation(() => ({
    prepare: mockPrepare,
    close: mockClose,
  }));

  return { MockDatabase, mockPrepare, mockClose };
});

vi.mock('better-sqlite3', () => ({
  default: MockDatabase,
}));

// Import AFTER the mock is registered.
import { SQLiteConnector } from '../sqlite.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wire mockPrepare so that `.prepare(sql).all()` returns `rows`. */
function mockPragma(rows: unknown[]): void {
  mockPrepare.mockReturnValueOnce({ all: vi.fn().mockReturnValue(rows) });
}

/** Wire mockPrepare so that `.prepare(sql).get()` returns `row`. */
function mockStatement(row: unknown): void {
  mockPrepare.mockReturnValueOnce({ get: vi.fn().mockReturnValue(row) });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SQLiteConnector', () => {
  let connector: SQLiteConnector;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new SQLiteConnector();
  });

  // -------------------------------------------------------------------------
  // Static metadata
  // -------------------------------------------------------------------------

  describe('metadata', () => {
    it('has correct name, displayName and placeholderDsn', () => {
      expect(connector.name).toBe('sqlite');
      expect(connector.displayName).toBe('SQLite');
      expect(connector.placeholderDsn).toBe('sqlite:///path/to/database.db');
    });
  });

  // -------------------------------------------------------------------------
  // testConnection
  // -------------------------------------------------------------------------

  describe('testConnection', () => {
    it('resolves when SELECT 1 succeeds', async () => {
      mockStatement(1);

      await expect(connector.testConnection('sqlite:///valid.db')).resolves.toBeUndefined();
      expect(MockDatabase).toHaveBeenCalledWith('/valid.db', {
        readonly: true,
        fileMustExist: true,
      });
      expect(mockClose).toHaveBeenCalledOnce();
    });

    it('resolves with a bare file path (no scheme)', async () => {
      mockStatement(1);

      await expect(
        connector.testConnection('/absolute/path/db.sqlite'),
      ).resolves.toBeUndefined();
      expect(MockDatabase).toHaveBeenCalledWith('/absolute/path/db.sqlite', {
        readonly: true,
        fileMustExist: true,
      });
    });

    it('throws when the database constructor throws (file not found)', async () => {
      MockDatabase.mockImplementationOnce(() => {
        throw new Error('ENOENT: no such file or directory');
      });

      await expect(connector.testConnection('sqlite:///missing.db')).rejects.toThrow(
        'ENOENT',
      );
      // close should NOT be called because the db handle was never created
      expect(mockClose).not.toHaveBeenCalled();
    });

    it('throws when SELECT 1 throws (corrupt database)', async () => {
      const mockGetFn = vi.fn().mockImplementation(() => {
        throw new Error('SQLITE_CORRUPT: database disk image is malformed');
      });
      mockPrepare.mockReturnValueOnce({ get: mockGetFn });

      await expect(connector.testConnection('sqlite:///corrupt.db')).rejects.toThrow(
        'SQLITE_CORRUPT',
      );
      // close is still called in the finally block
      expect(mockClose).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // introspect
  // -------------------------------------------------------------------------

  describe('introspect', () => {
    it('returns correct schema for a database with tables and foreign keys', async () => {
      // sqlite_master → two tables
      mockPragma([{ name: 'users' }, { name: 'posts' }]);

      // PRAGMA table_info("users")
      mockPragma([
        { cid: 0, name: 'id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 },
        { cid: 1, name: 'name', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
        { cid: 2, name: 'email', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      ]);

      // PRAGMA foreign_key_list("users") → no FKs
      mockPragma([]);

      // PRAGMA table_info("posts")
      mockPragma([
        { cid: 0, name: 'id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 },
        { cid: 1, name: 'title', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
        { cid: 2, name: 'user_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      ]);

      // PRAGMA foreign_key_list("posts") → one FK
      mockPragma([
        {
          id: 0,
          seq: 0,
          table: 'users',
          from: 'user_id',
          to: 'id',
          on_update: 'NO ACTION',
          on_delete: 'NO ACTION',
          match: 'NONE',
        },
      ]);

      const schema = await connector.introspect('sqlite:///test.db');

      expect(schema.tables).toHaveLength(2);

      const users = schema.tables.find((t) => t.name === 'users');
      expect(users).toBeDefined();
      expect(users!.schema).toBe('main');
      expect(users!.primaryKeys).toEqual(['id']);
      expect(users!.columns).toHaveLength(3);
      expect(users!.columns[0]).toEqual({
        name: 'id',
        type: 'INTEGER',
        nullable: false,
        defaultValue: null,
      });
      expect(users!.columns[1]).toMatchObject({ name: 'name', nullable: true });

      const posts = schema.tables.find((t) => t.name === 'posts');
      expect(posts).toBeDefined();
      expect(posts!.primaryKeys).toEqual(['id']);

      expect(schema.relations).toHaveLength(1);
      expect(schema.relations[0]).toEqual({
        fromTable: 'posts',
        fromColumn: 'user_id',
        toTable: 'users',
        toColumn: 'id',
      });

      // Database must be closed after introspection
      expect(mockClose).toHaveBeenCalledOnce();
    });

    it('returns empty schema for a database with no user tables', async () => {
      mockPragma([]);

      const schema = await connector.introspect('sqlite:///empty.db');

      expect(schema.tables).toHaveLength(0);
      expect(schema.relations).toHaveLength(0);
      expect(mockClose).toHaveBeenCalledOnce();
    });

    it('handles composite primary keys (pk ordinal ordering)', async () => {
      mockPragma([{ name: 'order_items' }]);

      // Columns returned out of pk-ordinal order to verify sort
      mockPragma([
        { cid: 0, name: 'order_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 2 },
        { cid: 1, name: 'product_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 },
        { cid: 2, name: 'qty', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      ]);

      mockPragma([]); // No FKs

      const schema = await connector.introspect('/data/shop.db');

      const tbl = schema.tables[0];
      expect(tbl!.name).toBe('order_items');
      // PK ordinal 1 first, then 2
      expect(tbl!.primaryKeys).toEqual(['product_id', 'order_id']);
    });

    it('handles columns with default values and nullable flags correctly', async () => {
      mockPragma([{ name: 'settings' }]);

      mockPragma([
        { cid: 0, name: 'id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 },
        { cid: 1, name: 'enabled', type: 'INTEGER', notnull: 1, dflt_value: '1', pk: 0 },
        { cid: 2, name: 'label', type: 'TEXT', notnull: 0, dflt_value: "'default'", pk: 0 },
      ]);

      mockPragma([]);

      const schema = await connector.introspect('sqlite:///settings.db');
      const cols = schema.tables[0]!.columns;

      expect(cols[1]).toMatchObject({ name: 'enabled', nullable: false, defaultValue: '1' });
      expect(cols[2]).toMatchObject({ name: 'label', nullable: true, defaultValue: "'default'" });
    });

    it('rethrows when the database constructor fails (file not found)', async () => {
      MockDatabase.mockImplementationOnce(() => {
        throw new Error('SQLITE_CANTOPEN: unable to open database file');
      });

      await expect(connector.introspect('sqlite:///nonexistent.db')).rejects.toThrow(
        'SQLITE_CANTOPEN',
      );

      // db handle was never created so close should not be called
      expect(mockClose).not.toHaveBeenCalled();
    });

    it('closes the database when a mid-introspection query throws', async () => {
      // sqlite_master returns one table
      mockPragma([{ name: 'broken_table' }]);

      // PRAGMA table_info throws
      mockPrepare.mockImplementationOnce(() => {
        throw new Error('SQLITE_ERROR: database is locked');
      });

      await expect(connector.introspect('sqlite:///locked.db')).rejects.toThrow(
        'database is locked',
      );

      // db was opened → close must have been called in the finally block
      expect(mockClose).toHaveBeenCalledOnce();
    });

    it('correctly parses sqlite:// (two-slash) DSN as a relative path', async () => {
      mockPragma([]);

      await connector.introspect('sqlite://relative/path/db.sqlite');

      expect(MockDatabase).toHaveBeenCalledWith('relative/path/db.sqlite', expect.any(Object));
    });
  });

  // -------------------------------------------------------------------------
  // disconnect
  // -------------------------------------------------------------------------

  describe('disconnect', () => {
    it('is a no-op when no database is open', async () => {
      await expect(connector.disconnect()).resolves.toBeUndefined();
      expect(mockClose).not.toHaveBeenCalled();
    });

    it('closes database handles left open on the instance', async () => {
      // Inject a fake open handle via the private handles Map
      const fakeDb = { close: mockClose };
      const handles = (connector as unknown as Record<string, unknown>)['handles'] as Map<string, unknown>;
      handles.set('test-dsn', fakeDb);

      await connector.disconnect();

      expect(mockClose).toHaveBeenCalledOnce();
    });
  });
});
