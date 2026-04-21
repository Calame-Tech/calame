import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { AppState } from '../state.js';

/** Valid period values for the metrics summary endpoint. */
const PERIOD_MS: Record<string, number> = {
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

const periodSchema = z.enum(['24h', '7d', '30d']).default('24h');

/** Row returned by the requests-by-hour query. */
interface RequestsByHourRow {
  hour: string;
  profile_name: string;
  count: number;
}

/** Row returned by the top-tools query. */
interface TopToolRow {
  tool_name: string;
  count: number;
}

/** Row returned by the top-tokens query. */
interface TopTokenRow {
  token_label: string;
  count: number;
}

/** Row returned by the error-rate query. */
interface ErrorRateRow {
  result: string;
  count: number;
}

/** Row returned by the avg-response-time query. */
interface AvgResponseRow {
  profile_name: string;
  avg_ms: number;
  count: number;
}

export function registerMetricsRoute(app: Express, state: AppState): void {
  /**
   * GET /api/metrics/summary?period=24h|7d|30d
   * Returns aggregated metrics from the audit_log table.
   */
  app.get('/api/metrics/summary', (req: Request, res: Response) => {
    try {
      const parseResult = periodSchema.safeParse(req.query.period);
      if (!parseResult.success) {
        res.status(400).json({ error: 'Invalid period. Use 24h, 7d, or 30d.' });
        return;
      }
      const period = parseResult.data;
      const periodMs = PERIOD_MS[period];
      const since = new Date(Date.now() - periodMs).toISOString();

      if (!state.db) {
        res.status(500).json({ error: 'Database not initialised.' });
        return;
      }
      const db = state.db.raw;

      const requestsByHour = db
        .prepare(
          `SELECT strftime('%Y-%m-%dT%H:00', timestamp) AS hour,
                  profile_name,
                  COUNT(*) AS count
           FROM audit_log
           WHERE timestamp >= ?
           GROUP BY hour, profile_name
           ORDER BY hour`,
        )
        .all(since) as RequestsByHourRow[];

      const topTools = db
        .prepare(
          `SELECT tool_name, COUNT(*) AS count
           FROM audit_log
           WHERE timestamp >= ?
           GROUP BY tool_name
           ORDER BY count DESC
           LIMIT 20`,
        )
        .all(since) as TopToolRow[];

      const topTokens = db
        .prepare(
          `SELECT token_label, COUNT(*) AS count
           FROM audit_log
           WHERE timestamp >= ?
             AND token_label IS NOT NULL
           GROUP BY token_label
           ORDER BY count DESC
           LIMIT 20`,
        )
        .all(since) as TopTokenRow[];

      const errorRate = db
        .prepare(
          `SELECT result, COUNT(*) AS count
           FROM audit_log
           WHERE timestamp >= ?
           GROUP BY result`,
        )
        .all(since) as ErrorRateRow[];

      const avgResponseTime = db
        .prepare(
          `SELECT profile_name,
                  ROUND(AVG(duration_ms), 1) AS avg_ms,
                  COUNT(*) AS count
           FROM audit_log
           WHERE timestamp >= ?
           GROUP BY profile_name`,
        )
        .all(since) as AvgResponseRow[];

      res.json({
        period,
        since,
        requestsByHour,
        topTools,
        topTokens,
        errorRate,
        avgResponseTime,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[GET /api/metrics/summary] ${message}`);
      res.status(500).json({ error: 'Failed to fetch metrics summary', details: message });
    }
  });

  /**
   * GET /api/metrics/pool
   * Returns connection pool statistics for every active connector that exposes getPoolStats().
   */
  app.get('/api/metrics/pool', (req: Request, res: Response) => {
    try {
      const poolStats: Array<{
        connectionName: string;
        stats: { active: number; idle: number; waiting: number; total: number };
      }> = [];

      for (const [name, connState] of state.connections) {
        // Only collect stats if the connector exposes getPoolStats
        const connector = connState.connection as unknown as Record<string, unknown>;
        if (typeof connector['getPoolStats'] === 'function') {
          const stats = (
            connector['getPoolStats'] as () => { active: number; idle: number; waiting: number; total: number }
          )();
          poolStats.push({ connectionName: name, stats });
        }
      }

      res.json({ pools: poolStats });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[GET /api/metrics/pool] ${message}`);
      res.status(500).json({ error: 'Failed to fetch pool metrics', details: message });
    }
  });
}
