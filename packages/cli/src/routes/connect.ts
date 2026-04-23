import type { Express } from 'express';
import { getConnector } from '@calame/connectors';
import type { DatabaseType } from '@calame/connectors';
import type { AppState } from '../state.js';
import { redactSecrets } from '../sanitize.js';

/** Database types accepted by the connect endpoint. */
const VALID_DB_TYPES: ReadonlySet<string> = new Set<DatabaseType>([
  'postgresql',
  'mysql',
  'sqlite',
]);

function isDatabaseType(value: unknown): value is DatabaseType {
  return typeof value === 'string' && VALID_DB_TYPES.has(value);
}

export function registerConnectRoute(app: Express, state: AppState): void {
  app.post('/api/connect', async (req, res) => {
    try {
      const { connectionString, databaseType, name: connectionName } = req.body as {
        connectionString?: unknown;
        databaseType?: unknown;
        name?: unknown;
      };

      if (!connectionString || typeof connectionString !== 'string') {
        res.json({ success: false, message: 'connectionString is required' });
        return;
      }

      // Default to postgresql for backwards-compatibility.
      const dbType: DatabaseType = isDatabaseType(databaseType) ? databaseType : 'postgresql';

      const connector = getConnector(dbType);
      const schema = await connector.introspect(connectionString, {
        ssl: typeof req.body.sslConfig === 'object' && req.body.sslConfig ? req.body.sslConfig : undefined,
      });

      state.cachedSchema = schema;
      state.cachedConnectionString = connectionString;
      state.cachedDatabaseType = dbType;
      state.cachedPiiDetections = null;

      // Also register as a named connection
      const connName =
        typeof connectionName === 'string' && connectionName.length > 0
          ? connectionName
          : 'default';
      state.addConnection(connName, {
        connection: {
          name: connName,
          label: connName === 'default' ? 'Default' : connName,
          databaseType: dbType,
          connectionString,
        },
        schema,
        piiDetections: null,
      });

      res.json({ success: true, tableCount: schema.tables.length, databaseType: dbType });
    } catch (error: unknown) {
      const rawMessage = error instanceof Error ? error.message : 'Unknown error';
      const message = redactSecrets(rawMessage);
      res.json({ success: false, message });
    }
  });
}
