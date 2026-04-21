import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- PostgreSQL Pool mock ---
const pgMockRelease = vi.fn();
const pgMockPoolQuery = vi.fn();
const pgMockPoolConnect = vi.fn().mockResolvedValue({
  query: pgMockPoolQuery,
  release: pgMockRelease,
});
const pgMockPoolEnd = vi.fn().mockResolvedValue(undefined);

vi.mock('pg', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ rows: [] }),
    end: vi.fn().mockResolvedValue(undefined),
  })),
  Pool: vi.fn().mockImplementation(() => ({
    connect: pgMockPoolConnect,
    end: pgMockPoolEnd,
    on: vi.fn(),
  })),
}));

import { PostgreSQLConnector } from '../postgresql.js';

describe('PostgreSQLConnector — query() with pooling', () => {
  let connector: PostgreSQLConnector;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new PostgreSQLConnector();
    // Reset pool query to succeed by default
    pgMockPoolQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // SET TRANSACTION READ ONLY
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Alice' }] }) // actual query
      .mockResolvedValueOnce(undefined); // COMMIT
  });

  it('executes a read-only query via the pool', async () => {
    const result = await connector.query('postgresql://localhost/test', 'SELECT * FROM users');

    expect(result.rows).toEqual([{ id: 1, name: 'Alice' }]);
    expect(pgMockPoolConnect).toHaveBeenCalledOnce();
    expect(pgMockPoolQuery).toHaveBeenCalledWith('BEGIN');
    expect(pgMockPoolQuery).toHaveBeenCalledWith('SET TRANSACTION READ ONLY');
    expect(pgMockPoolQuery).toHaveBeenCalledWith('SELECT * FROM users');
    expect(pgMockPoolQuery).toHaveBeenCalledWith('COMMIT');
    expect(pgMockRelease).toHaveBeenCalledOnce();
  });

  it('sets statement_timeout when timeoutMs is provided', async () => {
    pgMockPoolQuery
      .mockReset()
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // SET TRANSACTION READ ONLY
      .mockResolvedValueOnce(undefined) // SET statement_timeout
      .mockResolvedValueOnce({ rows: [] }) // query
      .mockResolvedValueOnce(undefined); // COMMIT

    await connector.query('postgresql://localhost/test', 'SELECT 1', { timeoutMs: 5000 });

    expect(pgMockPoolQuery).toHaveBeenCalledWith('SET statement_timeout = 5000');
  });

  it('does not set statement_timeout when timeoutMs is 0', async () => {
    await connector.query('postgresql://localhost/test', 'SELECT 1', { timeoutMs: 0 });

    const calls = pgMockPoolQuery.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).not.toContainEqual(expect.stringContaining('statement_timeout'));
  });

  it('releases the client back to pool even on error', async () => {
    pgMockPoolQuery
      .mockReset()
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // SET TRANSACTION READ ONLY
      .mockRejectedValueOnce(new Error('query failed')) // query fails
      .mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(
      connector.query('postgresql://localhost/test', 'BAD SQL'),
    ).rejects.toThrow('query failed');

    expect(pgMockRelease).toHaveBeenCalledOnce();
  });

  it('translates statement timeout errors into a clear message', async () => {
    pgMockPoolQuery
      .mockReset()
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // SET TRANSACTION READ ONLY
      .mockResolvedValueOnce(undefined) // SET statement_timeout
      .mockRejectedValueOnce(new Error('canceling statement due to statement timeout')) // query fails
      .mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(
      connector.query('postgresql://localhost/test', 'SELECT * FROM huge_table', { timeoutMs: 1000 }),
    ).rejects.toThrow('Query timed out after 1000ms');
  });

  it('reuses the same pool for the same DSN', async () => {
    pgMockPoolQuery
      .mockResolvedValue(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);

    await connector.query('postgresql://localhost/test', 'SELECT 1');
    await connector.query('postgresql://localhost/test', 'SELECT 2');

    // Pool constructor (via pg.Pool) should have been called once for this DSN
    const { Pool } = await import('pg');
    expect(Pool).toHaveBeenCalledTimes(1);
  });

  it('disconnect() ends all pools', async () => {
    // Trigger pool creation
    pgMockPoolQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);
    await connector.query('postgresql://localhost/test', 'SELECT 1');

    await connector.disconnect();

    expect(pgMockPoolEnd).toHaveBeenCalled();
  });
});
