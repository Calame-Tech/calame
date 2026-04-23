import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConnect = vi.fn();
const mockQuery = vi.fn();
const mockEnd = vi.fn();

vi.mock('pg', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    query: mockQuery,
    end: mockEnd,
  })),
}));

import { PostgreSQLConnector } from '../postgresql.js';

describe('PostgreSQLConnector', () => {
  let connector: PostgreSQLConnector;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new PostgreSQLConnector();
  });

  it('has the correct metadata', () => {
    expect(connector.name).toBe('postgresql');
    expect(connector.displayName).toBe('PostgreSQL');
    expect(connector.placeholderDsn).toContain('postgresql://');
  });

  describe('testConnection', () => {
    it('resolves when SELECT 1 succeeds', async () => {
      mockConnect.mockResolvedValueOnce(undefined);
      mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

      await expect(connector.testConnection('postgresql://localhost/test')).resolves.toBeUndefined();
      expect(mockEnd).toHaveBeenCalledOnce();
    });

    it('throws when the connection fails', async () => {
      mockConnect.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(connector.testConnection('postgresql://localhost/bad')).rejects.toThrow(
        'ECONNREFUSED',
      );
      expect(mockEnd).toHaveBeenCalledOnce();
    });
  });

  describe('introspect', () => {
    it('returns tables and relations correctly', async () => {
      // Tables
      mockQuery.mockResolvedValueOnce({
        rows: [{ table_name: 'users', table_schema: 'public' }],
      });
      // Columns
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
        ],
      });
      // Primary keys
      mockQuery.mockResolvedValueOnce({
        rows: [{ column_name: 'id', table_name: 'users' }],
      });
      // Foreign keys
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const schema = await connector.introspect('postgresql://localhost/testdb');

      expect(schema.tables).toHaveLength(1);
      expect(schema.tables[0]?.name).toBe('users');
      expect(schema.tables[0]?.primaryKeys).toEqual(['id']);
      expect(schema.relations).toHaveLength(0);
      expect(mockEnd).toHaveBeenCalledOnce();
    });

    it('closes the connection even when a query throws', async () => {
      mockConnect.mockResolvedValueOnce(undefined);
      mockQuery.mockRejectedValueOnce(new Error('Query failed'));

      await expect(connector.introspect('postgresql://localhost/testdb')).rejects.toThrow(
        'Query failed',
      );
      expect(mockEnd).toHaveBeenCalledOnce();
    });
  });

  describe('disconnect', () => {
    it('resolves without error (connector is stateless)', async () => {
      await expect(connector.disconnect()).resolves.toBeUndefined();
    });
  });
});
