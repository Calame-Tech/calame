import type { Express } from 'express';
import { getConnector } from '@calame/connectors';
import { detectColumnPii } from '@calame/core';
import type { PiiDetection } from '@calame/core';
import type { AppState } from '../state.js';

/** Column types considered as text (candidates for PII data-sample scanning). */
const TEXT_TYPE_PATTERNS = /char|text|varchar|string|clob/i;

export function registerPiiRoute(app: Express, state: AppState): void {
  app.post('/api/pii/scan', async (req, res) => {
    try {
      if (state.connections.size === 0) {
        res.status(400).json({ error: 'No database connection. Connect first.' });
        return;
      }

      const detections: Record<string, Record<string, PiiDetection>> = {};

      // Scan all connections
      for (const [, connState] of state.connections) {
        const connector = getConnector(connState.connection.databaseType);
        const dsn = connState.connection.connectionString;

        for (const table of connState.schema.tables) {
          const tableDetections: Record<string, PiiDetection> = {};

          for (const column of table.columns) {
            // Sample data only for text-like columns
            let samples: string[] | undefined;
            if (TEXT_TYPE_PATTERNS.test(column.type)) {
              const connOptions = connState.connection.sslConfig ? { ssl: connState.connection.sslConfig } : undefined;
              samples = await connector.sampleColumnValues(dsn, table.name, column.name, 100, connOptions);
            }

            const detection = detectColumnPii(column.name, samples);
            if (detection) {
              tableDetections[column.name] = detection;
            }
          }

          if (Object.keys(tableDetections).length > 0) {
            detections[table.name] = tableDetections;
          }
        }

        // Store per-connection PII detections
        connState.piiDetections = detections;
      }

      // Also set backward-compat field
      state.cachedPiiDetections = detections;
      res.json({ detections });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Scan error', { component: 'pii', error: message });
      res.status(500).json({ error: 'PII scan failed', details: message });
    }
  });
}
