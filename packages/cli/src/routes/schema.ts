import type { Express } from 'express';
import type { AppState } from '../state.js';

export function registerSchemaRoute(app: Express, state: AppState): void {
  // Return schema for a specific named connection
  app.get('/api/schema/:connectionName', (req, res) => {
    const { connectionName } = req.params;
    const connState = state.getConnection(connectionName);
    if (connState) {
      res.json({ success: true, schema: connState.schema });
    } else {
      res
        .status(404)
        .json({ success: false, message: `Connection "${connectionName}" not found.` });
    }
  });

  // Backward compat: return first connection's schema
  app.get('/api/schema', (_req, res) => {
    if (state.cachedSchema) {
      res.json({ success: true, schema: state.cachedSchema });
    } else {
      res.json({ success: true, schema: { tables: [], relations: [] } });
    }
  });
}
