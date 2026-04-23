import type { Express } from 'express';
import { z } from 'zod';
import { getConnector } from '@calame/connectors';
import type { SslConfig } from '@calame/connectors';
import type { AppState } from '../state.js';
import { redactSecrets } from '../sanitize.js';

const sslConfigSchema: z.ZodType<SslConfig> = z.object({
  enabled: z.boolean(),
  ca: z.string().optional(),
  cert: z.string().optional(),
  key: z.string().optional(),
  rejectUnauthorized: z.boolean().optional(),
});

const connectBodySchema = z.object({
  connectionString: z.string().min(1, 'connectionString is required'),
  databaseType: z.enum(['postgresql', 'mysql', 'sqlite']).default('postgresql'),
  name: z.string().optional(),
  sslConfig: sslConfigSchema.optional(),
});

export function registerConnectRoute(app: Express, state: AppState): void {
  app.post('/api/connect', async (req, res) => {
    try {
      const parsed = connectBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          message: parsed.error.issues[0]?.message ?? 'Invalid request body',
          errors: parsed.error.issues,
        });
        return;
      }

      const { connectionString, databaseType: dbType, name: connectionName, sslConfig } = parsed.data;

      const connector = getConnector(dbType);
      const schema = await connector.introspect(connectionString, {
        ssl: sslConfig,
      });

      state.cachedSchema = schema;
      state.cachedConnectionString = connectionString;
      state.cachedDatabaseType = dbType;
      state.cachedPiiDetections = null;

      // Also register as a named connection
      const connName = connectionName && connectionName.length > 0 ? connectionName : 'default';
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
      res.status(500).json({ success: false, message });
    }
  });
}
