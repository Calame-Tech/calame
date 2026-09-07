import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Pool lifecycle tests for the SQL Server connector.
//
// These need the driver stubbed (the real one would open a socket), so the
// whole `mssql` module is mocked here rather than in mssql.test.ts, which
// exercises the pure DSN parsing against the real module.
//
// The behaviour under test is a leak guard: `Transaction.begin()` borrows a
// pool connection before it issues BEGIN TRANSACTION, and mssql/tedious does
// not hand that connection back if the round-trip fails. `idleTimeoutMillis`
// never reclaims a borrowed slot, so the connector must close the whole pool
// and rebuild it on the next call.
// ---------------------------------------------------------------------------

const { state, poolInstances, recordedInputs } = vi.hoisted(() => ({
  recordedInputs: [] as [string, unknown][],
  state: {
    connect: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    close: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    begin: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    rollback: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    query: vi.fn<(sqlText: string) => Promise<{ recordset: Record<string, unknown>[] }>>(() =>
      Promise.resolve({ recordset: [] }),
    ),
  },
  poolInstances: [] as unknown[],
}));

vi.mock('mssql', () => {
  class ConnectionPool {
    borrowed = 0;
    available = 0;
    pending = 0;
    size = 0;
    constructor(public config: unknown) {
      poolInstances.push(this);
    }
    on(): this {
      return this;
    }
    connect(): Promise<void> {
      return state.connect();
    }
    close(): Promise<void> {
      return state.close();
    }
    request(): Request {
      return new Request();
    }
  }
  class Transaction {
    constructor(public pool?: unknown) {}
    begin(): Promise<void> {
      return state.begin();
    }
    rollback(): Promise<void> {
      return state.rollback();
    }
  }
  class Request {
    constructor(public parent?: unknown) {}
    input(name: string, value: unknown): this {
      recordedInputs.push([name, value]);
      return this;
    }
    query(sqlText: string): Promise<{ recordset: Record<string, unknown>[] }> {
      return state.query(sqlText);
    }
  }
  return { default: { ConnectionPool, Transaction, Request, Int: {} } };
});

import { MSSQLConnector } from '../mssql.js';

const DSN = 'Server=localhost,1433;Database=testdb;User Id=sa;Password=secret';

describe('MSSQLConnector pool lifecycle', () => {
  let connector: MSSQLConnector;

  beforeEach(() => {
    poolInstances.length = 0;
    recordedInputs.length = 0;
    state.connect.mockReset().mockResolvedValue(undefined);
    state.close.mockReset().mockResolvedValue(undefined);
    state.begin.mockReset().mockResolvedValue(undefined);
    state.rollback.mockReset().mockResolvedValue(undefined);
    state.query.mockReset().mockResolvedValue({ recordset: [] });
    connector = new MSSQLConnector();
  });

  it('reuses one pool across successive queries', async () => {
    await connector.query(DSN, 'SELECT 1');
    await connector.query(DSN, 'SELECT 2');
    expect(poolInstances).toHaveLength(1);
  });

  it('rolls the transaction back on success — SQL Server has no read-only mode', async () => {
    await connector.query(DSN, 'SELECT 1');
    expect(state.rollback).toHaveBeenCalledTimes(1);
  });

  it('binds positional params as @p1..@pN in order', async () => {
    await connector.query(DSN, 'SELECT @p1, @p2', { params: ['a', 2] });
    expect(recordedInputs).toEqual([
      ['p1', 'a'],
      ['p2', 2],
    ]);
    expect(state.query).toHaveBeenCalledWith('SELECT @p1, @p2');
  });

  it('binds undefined and null params as SQL NULL', async () => {
    await connector.query(DSN, 'SELECT @p1, @p2', { params: [undefined, null] });
    expect(recordedInputs).toEqual([
      ['p1', null],
      ['p2', null],
    ]);
  });

  // --- R-7: BEGIN TRANSACTION failure must not leak the borrowed slot -------

  it('surfaces a clean error when BEGIN TRANSACTION fails', async () => {
    state.begin.mockRejectedValue(new Error('socket hang up'));
    await expect(connector.query(DSN, 'SELECT 1')).rejects.toThrow(
      /Failed to open a read transaction on SQL Server: socket hang up/,
    );
  });

  it('preserves the driver error as the cause', async () => {
    const driverError = new Error('socket hang up');
    state.begin.mockRejectedValue(driverError);
    await expect(connector.query(DSN, 'SELECT 1')).rejects.toMatchObject({
      cause: driverError,
    });
  });

  it('closes the pool when BEGIN TRANSACTION fails, reclaiming the borrowed connection', async () => {
    state.begin.mockRejectedValue(new Error('socket hang up'));
    await expect(connector.query(DSN, 'SELECT 1')).rejects.toThrow();
    expect(state.close).toHaveBeenCalledTimes(1);
  });

  it('evicts the pool so the next query rebuilds instead of reusing a leaked one', async () => {
    state.begin.mockRejectedValue(new Error('socket hang up'));
    await expect(connector.query(DSN, 'SELECT 1')).rejects.toThrow();
    expect(poolInstances).toHaveLength(1);

    // Second call must construct a brand-new pool rather than reuse the
    // evicted one, which still counts the failed connection as borrowed.
    state.begin.mockResolvedValue(undefined);
    await connector.query(DSN, 'SELECT 1');
    expect(poolInstances).toHaveLength(2);
  });

  it('does not evict the pool when the query itself fails after a successful BEGIN', async () => {
    state.query.mockRejectedValue(new Error('invalid column'));
    await expect(connector.query(DSN, 'SELECT bad')).rejects.toThrow(/invalid column/);
    // The transaction is rolled back, which returns the connection to the pool,
    // so the pool stays usable and cached.
    expect(state.rollback).toHaveBeenCalled();
    expect(state.close).not.toHaveBeenCalled();

    state.query.mockResolvedValue({ recordset: [] });
    await connector.query(DSN, 'SELECT 1');
    expect(poolInstances).toHaveLength(1);
  });

  it('closes a half-open pool when the initial connect fails', async () => {
    state.connect.mockRejectedValue(new Error('login failed'));
    await expect(connector.query(DSN, 'SELECT 1')).rejects.toThrow(/login failed/);
    expect(state.close).toHaveBeenCalledTimes(1);
  });

  it('disconnect closes every cached pool', async () => {
    await connector.query(DSN, 'SELECT 1');
    await connector.disconnect();
    expect(state.close).toHaveBeenCalledTimes(1);
    expect(connector.getPoolStats()).toEqual({ active: 0, idle: 0, waiting: 0, total: 0 });
  });
});
