import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConnect = vi.fn();
const mockQuery = vi.fn();
const mockEnd = vi.fn();

vi.mock('pg', () => {
  return {
    Client: vi.fn().mockImplementation(() => ({
      connect: mockConnect,
      query: mockQuery,
      end: mockEnd,
    })),
  };
});

import { introspectDatabase } from '../postgres.js';

describe('introspectDatabase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return tables and columns', async () => {
    // 1. tables query
    mockQuery.mockResolvedValueOnce({
      rows: [
        { table_name: 'users', table_schema: 'public' },
        { table_name: 'posts', table_schema: 'public' },
      ],
    });

    // 2. columns query
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          column_name: 'id',
          data_type: 'integer',
          is_nullable: 'NO',
          column_default: null,
          table_name: 'users',
          table_schema: 'public',
        },
        {
          column_name: 'name',
          data_type: 'text',
          is_nullable: 'YES',
          column_default: null,
          table_name: 'users',
          table_schema: 'public',
        },
        {
          column_name: 'id',
          data_type: 'integer',
          is_nullable: 'NO',
          column_default: null,
          table_name: 'posts',
          table_schema: 'public',
        },
        {
          column_name: 'user_id',
          data_type: 'integer',
          is_nullable: 'NO',
          column_default: null,
          table_name: 'posts',
          table_schema: 'public',
        },
      ],
    });

    // 3. primary keys query
    mockQuery.mockResolvedValueOnce({
      rows: [
        { column_name: 'id', table_name: 'users' },
        { column_name: 'id', table_name: 'posts' },
      ],
    });

    // 4. foreign keys query
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          column_name: 'user_id',
          from_table: 'posts',
          to_table: 'users',
          to_column: 'id',
        },
      ],
    });

    const result = await introspectDatabase('postgresql://localhost/testdb');

    expect(result.tables).toHaveLength(2);

    const usersTable = result.tables.find((t) => t.name === 'users');
    expect(usersTable).toBeDefined();
    expect(usersTable!.columns).toHaveLength(2);
    expect(usersTable!.primaryKeys).toEqual(['id']);
    expect(usersTable!.schema).toBe('public');

    const postsTable = result.tables.find((t) => t.name === 'posts');
    expect(postsTable).toBeDefined();
    expect(postsTable!.primaryKeys).toEqual(['id']);

    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]).toEqual({
      fromTable: 'posts',
      fromColumn: 'user_id',
      toTable: 'users',
      toColumn: 'id',
    });

    expect(mockConnect).toHaveBeenCalledOnce();
    expect(mockEnd).toHaveBeenCalledOnce();
  });

  it('should handle empty database', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // tables
    mockQuery.mockResolvedValueOnce({ rows: [] }); // columns
    mockQuery.mockResolvedValueOnce({ rows: [] }); // primary keys
    mockQuery.mockResolvedValueOnce({ rows: [] }); // foreign keys

    const result = await introspectDatabase('postgresql://localhost/emptydb');

    expect(result.tables).toHaveLength(0);
    expect(result.relations).toHaveLength(0);
    expect(mockEnd).toHaveBeenCalledOnce();
  });

  it('should close connection on error', async () => {
    mockConnect.mockRejectedValueOnce(new Error('Connection refused'));

    await expect(introspectDatabase('postgresql://localhost/baddb')).rejects.toThrow(
      'Connection refused',
    );

    expect(mockEnd).toHaveBeenCalledOnce();
  });
});
