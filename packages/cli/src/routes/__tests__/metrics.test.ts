import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerMetricsRoute } from '../metrics.js';
import { AppState } from '../../state.js';
import type { ConnectionState } from '../../state.js';
import type { NamedConnection } from '@calame/core';

/** Create a minimal mock DB with a configurable .raw.prepare().all() chain. */
function makeMockDb(queryResults: Record<string, unknown[][]>) {
  let callIndex = 0;
  const resultsInOrder = Object.values(queryResults);

  return {
    raw: {
      prepare: vi.fn(() => ({
        all: vi.fn(() => {
          const result = resultsInOrder[callIndex] ?? [];
          callIndex++;
          return result;
        }),
      })),
    },
  };
}

describe('metrics routes', () => {
  let app: express.Express;
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    app = express();
    app.use(express.json());
    registerMetricsRoute(app, state);
  });

  describe('GET /api/metrics/summary', () => {
    it('returns 500 when db is not initialised', async () => {
      const res = await request(app).get('/api/metrics/summary');
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Database not initialised.');
    });

    it('rejects invalid period values', async () => {
      state.db = makeMockDb({}) as unknown as typeof state.db;
      const res = await request(app).get('/api/metrics/summary?period=bad');
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBeDefined();
    });

    it('defaults period to 24h when not provided', async () => {
      const mockRequestsByHour = [{ hour: '2026-03-26T10:00', profile_name: 'prod', count: 5 }];
      const mockDb = makeMockDb({
        requestsByHour: [mockRequestsByHour],
        topTools: [[]],
        topTokens: [[]],
        errorRate: [[]],
        avgResponse: [[]],
      });
      state.db = mockDb as unknown as typeof state.db;

      const res = await request(app).get('/api/metrics/summary');
      expect(res.status).toBe(200);
      expect(res.body.period).toBe('24h');
      expect(res.body.since).toBeDefined();
    });

    it('returns structured metrics for period=7d', async () => {
      const mockDb = {
        raw: {
          prepare: vi.fn().mockReturnValue({
            all: vi
              .fn()
              .mockReturnValueOnce([{ hour: '2026-03-20T08:00', profile_name: 'prod', count: 12 }])
              .mockReturnValueOnce([{ tool_name: 'query_users', count: 42 }])
              .mockReturnValueOnce([{ token_label: 'alice', count: 10 }])
              .mockReturnValueOnce([
                { result: 'success', count: 50 },
                { result: 'error', count: 2 },
              ])
              .mockReturnValueOnce([{ profile_name: 'prod', avg_ms: 123.4, count: 52 }]),
          }),
        },
      };
      state.db = mockDb as unknown as typeof state.db;

      const res = await request(app).get('/api/metrics/summary?period=7d');
      expect(res.status).toBe(200);
      expect(res.body.period).toBe('7d');
      expect(res.body.requestsByHour).toHaveLength(1);
      expect(res.body.requestsByHour[0].count).toBe(12);
      expect(res.body.requestsByHour[0].profile).toBe('prod');
      expect(res.body.topTools[0].toolName).toBe('query_users');
      expect(res.body.topTokens[0].tokenLabel).toBe('alice');
      expect(res.body.errorRate).toHaveLength(2);
      expect(res.body.avgResponseTime[0].profileName).toBe('prod');
      expect(res.body.avgResponseTime[0].avgMs).toBe(123.4);
    });

    it('accepts period=30d', async () => {
      const mockDb = {
        raw: {
          prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) }),
        },
      };
      state.db = mockDb as unknown as typeof state.db;

      const res = await request(app).get('/api/metrics/summary?period=30d');
      expect(res.status).toBe(200);
      expect(res.body.period).toBe('30d');
    });

    it('returns 500 when db throws', async () => {
      state.db = {
        raw: {
          prepare: vi.fn(() => {
            throw new Error('DB exploded');
          }),
        },
      } as unknown as typeof state.db;

      const res = await request(app).get('/api/metrics/summary');
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Failed to fetch metrics summary');
    });
  });

  describe('GET /api/metrics/pool', () => {
    it('returns empty pools when there are no connections', async () => {
      const res = await request(app).get('/api/metrics/pool');
      expect(res.status).toBe(200);
      expect(res.body.pools).toEqual([]);
    });

    it('returns pool stats only for connectors that expose getPoolStats()', async () => {
      const connWithStats: ConnectionState = {
        connection: {
          name: 'pg-main',
          label: 'Postgres Main',
          databaseType: 'postgresql',
          connectionString: 'postgres://localhost/db',
          getPoolStats: () => ({ active: 2, idle: 3, waiting: 0, total: 5 }),
        } as unknown as NamedConnection,
        schema: { tables: [], relations: [] },
        piiDetections: null,
      };
      const connWithoutStats: ConnectionState = {
        connection: {
          name: 'sqlite-local',
          label: 'SQLite',
          databaseType: 'sqlite',
          connectionString: '/tmp/db.sqlite',
        } as unknown as NamedConnection,
        schema: { tables: [], relations: [] },
        piiDetections: null,
      };

      state.addConnection('pg-main', connWithStats);
      state.addConnection('sqlite-local', connWithoutStats);

      const res = await request(app).get('/api/metrics/pool');
      expect(res.status).toBe(200);
      expect(res.body.pools).toHaveLength(1);
      expect(res.body.pools[0].connectionName).toBe('pg-main');
      expect(res.body.pools[0].stats.total).toBe(5);
      expect(res.body.pools[0].stats.active).toBe(2);
    });

    it('returns 500 when an unexpected error occurs', async () => {
      // Simulate a broken connections map
      vi.spyOn(state, 'connections', 'get').mockImplementation(() => {
        throw new Error('Map is broken');
      });

      const res = await request(app).get('/api/metrics/pool');
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Failed to fetch pool metrics');
    });
  });
});
