import type { Express } from 'express';
import type { AppState } from '../state.js';
import type { NamedConnection } from '@calame/core';
import { getConnector } from '@calame/connectors';
import type { DatabaseType } from '@calame/connectors';
import type { CalameDatabase } from '../database.js';
import { encrypt, decrypt, isEncrypted, getSecretKey, verifyPassword } from '../crypto.js';
import { validateSession } from '../session.js';
import { createSshTunnel } from '../ssh-tunnel.js';
import type { SshTunnelConfig } from '../ssh-tunnel.js';
import { resolveSecret } from '../secrets.js';

/** SSH config shape as stored in the DB / sent over the API. */
export interface SshConfig {
  enabled: boolean;
  host: string;
  port?: number;
  username: string;
  privateKey?: string;
  password?: string;
  dbHost?: string;
  dbPort?: number;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const [key, ...rest] = pair.split('=');
    if (key) cookies[key.trim()] = rest.join('=').trim();
  }
  return cookies;
}

/** Database types accepted by the connections endpoints. */
const VALID_DB_TYPES: ReadonlySet<string> = new Set<DatabaseType>([
  'postgresql',
  'mysql',
  'sqlite',
]);

function isDatabaseType(value: unknown): value is DatabaseType {
  return typeof value === 'string' && VALID_DB_TYPES.has(value);
}

/** Encrypt a connection string if a secret key is available. */
function encryptConnectionString(connStr: string): string {
  const secret = getSecretKey();
  if (!secret) return connStr;
  return encrypt(connStr, secret);
}

/** Decrypt a connection string if it appears encrypted and a secret key is available. */
function decryptConnectionString(connStr: string): string {
  const secret = getSecretKey();
  if (!secret || !isEncrypted(connStr)) return connStr;
  return decrypt(connStr, secret);
}

type PersistedConnection = Omit<NamedConnection, 'name'>;

interface ConnectionsFileData {
  connections: Record<string, PersistedConnection>;
}

/** Read all connections from SQLite. Decrypts connection strings automatically. */
function readConnectionsFile(db: CalameDatabase): ConnectionsFileData {
  const rows = db.raw
    .prepare(
      'SELECT name, label, database_type, connection_string, ssl_config, ssh_config FROM connections',
    )
    .all() as Array<{
    name: string;
    label: string;
    database_type: string;
    connection_string: string;
    ssl_config: string | null;
    ssh_config: string | null;
  }>;

  const connections: Record<string, PersistedConnection> = {};
  for (const row of rows) {
    const conn: PersistedConnection = {
      label: row.label,
      databaseType: row.database_type as DatabaseType,
      connectionString: decryptConnectionString(row.connection_string),
    };
    if (row.ssl_config) {
      try {
        conn.sslConfig = JSON.parse(row.ssl_config);
      } catch { /* ignore malformed JSON */ }
    }
    if (row.ssh_config) {
      try {
        conn.sshConfig = JSON.parse(row.ssh_config);
      } catch { /* ignore malformed JSON */ }
    }
    connections[row.name] = conn;
  }
  return { connections };
}

/** Write a single connection to SQLite. Encrypts the connection string automatically. */
function writeConnection(
  db: CalameDatabase,
  name: string,
  conn: PersistedConnection,
): void {
  const sslConfigJson = conn.sslConfig ? JSON.stringify(conn.sslConfig) : null;
  const sshConfigJson = conn.sshConfig ? JSON.stringify(conn.sshConfig) : null;
  db.raw
    .prepare(
      `INSERT OR REPLACE INTO connections
         (name, label, database_type, connection_string, ssl_config, ssh_config)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      name,
      conn.label,
      conn.databaseType,
      encryptConnectionString(conn.connectionString),
      sslConfigJson,
      sshConfigJson,
    );
}

/** Delete a single connection from SQLite. */
function deleteConnection(db: CalameDatabase, name: string): void {
  db.raw.prepare('DELETE FROM connections WHERE name = ?').run(name);
}

/**
 * Rewrite the host:port portion of a connection string to use localhost:<localPort>.
 * Handles both URL-style (postgresql://host:port/...) and DSN-style (host=... port=...).
 */
function rewriteConnStringPort(connectionString: string, localPort: number): string {
  // URL-style: postgresql://user:pass@host:port/db
  try {
    const url = new URL(connectionString);
    if (url.hostname) {
      url.hostname = '127.0.0.1';
      url.port = String(localPort);
      return url.toString();
    }
  } catch { /* not a URL — fall through to DSN style */ }

  // DSN key=value style: host=myhost port=5432 ...
  let result = connectionString
    .replace(/\bhost\s*=\s*\S+/gi, 'host=127.0.0.1')
    .replace(/\bport\s*=\s*\d+/gi, `port=${localPort}`);

  // If no host= found, append it
  if (!/\bhost\s*=/i.test(result)) result += ` host=127.0.0.1`;
  if (!/\bport\s*=/i.test(result)) result += ` port=${localPort}`;

  return result;
}

export function registerConnectionsRoute(app: Express, state: AppState): void {
  /**
   * Ensure state.db is initialised before any SQLite access.
   * On the very first request, CalameDatabase may not have been created yet
   * (serve/start lazily creates it). We mirror that lazy-init here.
   */
  async function getDb(): Promise<CalameDatabase> {
    if (!state.db) {
      const dataDir = state.config?.dataDir ?? process.cwd();
      const { CalameDatabase } = await import('../database.js');
      state.db = new CalameDatabase(dataDir);
    }
    return state.db;
  }

  /**
   * Load connections from SQLite into state if state is currently empty.
   * Attempts to introspect each saved connection to make them "connected".
   * If a connection has an SSH config, a tunnel is created first.
   */
  async function ensureConnectionsLoaded(): Promise<void> {
    if (state.connections.size > 0) return;
    const db = await getDb();
    const fileData = readConnectionsFile(db);
    for (const [name, conn] of Object.entries(fileData.connections)) {
      if (state.connections.has(name)) continue;
      try {
        // Resolve secret:// references before connecting
        let effectiveConnString = await resolveSecret(conn.connectionString, state.secretsProvider);

        // Create SSH tunnel if configured
        if (conn.sshConfig?.enabled) {
          const tunnelCfg: SshTunnelConfig = {
            host: conn.sshConfig.host,
            port: conn.sshConfig.port ?? 22,
            username: conn.sshConfig.username,
            privateKey: conn.sshConfig.privateKey,
            password: conn.sshConfig.password,
            dbHost: conn.sshConfig.dbHost ?? '127.0.0.1',
            dbPort: conn.sshConfig.dbPort ?? 5432,
          };
          const tunnel = await createSshTunnel(tunnelCfg);
          state._tunnels.set(name, tunnel);
          effectiveConnString = rewriteConnStringPort(conn.connectionString, tunnel.localPort);
          state.logger?.info(`SSH tunnel for "${name}" opened on port ${tunnel.localPort}`, {
            component: 'connections',
          });
        }

        const connOpts = conn.sslConfig?.enabled ? { ssl: conn.sslConfig } : undefined;
        const connector = getConnector(conn.databaseType as DatabaseType);
        const schema = await connector.introspect(effectiveConnString, connOpts);
        state.addConnection(name, {
          connection: {
            name,
            label: conn.label,
            databaseType: conn.databaseType as DatabaseType,
            connectionString: effectiveConnString,
            sslConfig: conn.sslConfig,
          },
          schema,
          piiDetections: null,
        });
        state.logger?.info(`Loaded "${name}" from SQLite (${schema.tables.length} tables)`, {
          component: 'connections',
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        state.logger?.warn(`Failed to connect "${name}" from SQLite: ${msg}`, {
          component: 'connections',
        });
      }
    }
  }

  /** Sanitize SSH config for API responses — remove private keys and passwords. */
  function sanitizeSshConfig(
    sshCfg: SshConfig | undefined,
  ): Omit<SshConfig, 'privateKey' | 'password'> | undefined {
    if (!sshCfg) return undefined;
    const { privateKey: _pk, password: _pw, ...safe } = sshCfg;
    return safe;
  }

  // GET /api/connections — List all connections
  app.get('/api/connections', async (_req, res) => {
    try {
      await ensureConnectionsLoaded();

      const result: Record<
        string,
        {
          label: string;
          databaseType: string;
          tableCount: number;
          connected: boolean;
          sslConfig?: NamedConnection['sslConfig'];
          sshConfig?: ReturnType<typeof sanitizeSshConfig>;
        }
      > = {};

      // Read saved connections to retrieve sshConfig (state only stores effective conn string)
      const db = await getDb();
      const fileData = readConnectionsFile(db);

      // Add connections currently in state (connected)
      for (const [name, connState] of state.connections) {
        result[name] = {
          label: connState.connection.label,
          databaseType: connState.connection.databaseType,
          tableCount: connState.schema?.tables?.length ?? 0,
          connected: true,
          sslConfig: connState.connection.sslConfig,
          sshConfig: sanitizeSshConfig(fileData.connections[name]?.sshConfig),
        };
      }

      // Merge saved connections from SQLite (mark as disconnected if not in state)
      for (const [name, conn] of Object.entries(fileData.connections)) {
        if (!result[name]) {
          result[name] = {
            label: conn.label,
            databaseType: conn.databaseType,
            tableCount: 0,
            connected: false,
            sslConfig: conn.sslConfig,
            sshConfig: sanitizeSshConfig(conn.sshConfig),
          };
        }
      }

      res.json({ success: true, connections: result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('GET error', { component: 'connections', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  // POST /api/connections — Add/update a named connection
  app.post('/api/connections', async (req, res) => {
    try {
      const { name, label, databaseType, connectionString, sslConfig, sshConfig } = req.body as {
        name?: unknown;
        label?: unknown;
        databaseType?: unknown;
        connectionString?: unknown;
        sslConfig?: NamedConnection['sslConfig'];
        sshConfig?: SshConfig;
      };

      // Validate inputs
      if (!name || typeof name !== 'string') {
        res.status(400).json({ success: false, message: 'name is required and must be a string' });
        return;
      }

      if (!connectionString || typeof connectionString !== 'string') {
        res
          .status(400)
          .json({ success: false, message: 'connectionString is required and must be a string' });
        return;
      }

      if (!isDatabaseType(databaseType)) {
        res.status(400).json({
          success: false,
          message: `databaseType must be one of: ${[...VALID_DB_TYPES].join(', ')}`,
        });
        return;
      }

      const connLabel = typeof label === 'string' && label.length > 0 ? label : name;

      // Close existing tunnel for this connection if any
      if (state._tunnels.has(name as string)) {
        await state.closeTunnel(name as string);
      }

      // Resolve secret:// references before connecting (store original with secret:// in SQLite)
      let effectiveConnString = await resolveSecret(connectionString as string, state.secretsProvider);

      // Create SSH tunnel if configured
      if (sshConfig?.enabled) {
        const tunnelCfg: SshTunnelConfig = {
          host: sshConfig.host,
          port: sshConfig.port ?? 22,
          username: sshConfig.username,
          privateKey: sshConfig.privateKey,
          password: sshConfig.password,
          dbHost: sshConfig.dbHost ?? '127.0.0.1',
          dbPort: sshConfig.dbPort ?? 5432,
        };
        const tunnel = await createSshTunnel(tunnelCfg);
        state._tunnels.set(name as string, tunnel);
        effectiveConnString = rewriteConnStringPort(connectionString as string, tunnel.localPort);
        state.logger?.info(
          `SSH tunnel for "${name}" opened on local port ${tunnel.localPort}`,
          { component: 'connections' },
        );
      }

      // Build connection options from SSL config
      const connOptions = sslConfig?.enabled ? { ssl: sslConfig } : undefined;

      // Test the connection by introspecting
      const connector = getConnector(databaseType);
      const schema = await connector.introspect(effectiveConnString, connOptions);

      const namedConnection: NamedConnection = {
        name: name as string,
        label: connLabel,
        databaseType,
        // Store the effective (tunnel-rewritten) connection string in state
        connectionString: effectiveConnString,
        sslConfig: sslConfig?.enabled ? sslConfig : undefined,
      };

      // Add to state
      state.addConnection(name as string, {
        connection: namedConnection,
        schema,
        piiDetections: null,
      });

      // Set backward-compat fields if this is the first connection
      if (state.connections.size === 1) {
        state.cachedConnectionString = effectiveConnString;
        state.cachedDatabaseType = databaseType;
        state.cachedSchema = schema;
      }

      // Persist to SQLite — store original connectionString (not the tunnel-rewritten one)
      const db = await getDb();
      writeConnection(db, name as string, {
        label: connLabel,
        databaseType,
        connectionString: connectionString as string,
        sslConfig: namedConnection.sslConfig,
        sshConfig: sshConfig?.enabled ? {
          enabled: true,
          host: sshConfig.host,
          port: sshConfig.port ?? 22,
          username: sshConfig.username,
          privateKey: sshConfig.privateKey,
          password: sshConfig.password,
          dbHost: sshConfig.dbHost ?? '127.0.0.1',
          dbPort: sshConfig.dbPort ?? 5432,
        } : undefined,
      });

      res.json({ success: true, name, tableCount: schema.tables.length });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('POST error', { component: 'connections', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  // DELETE /api/connections/:name — Remove a connection
  app.delete('/api/connections/:name', async (req, res) => {
    try {
      const { name } = req.params;
      const db = await getDb();

      // Check existence in state or SQLite
      const fileData = readConnectionsFile(db);
      const existsInState = state.connections.has(name);
      const existsInDb = name in fileData.connections;

      if (!existsInState && !existsInDb) {
        res.status(404).json({ success: false, message: `Connection "${name}" not found` });
        return;
      }

      // Close and remove any SSH tunnel for this connection
      await state.closeTunnel(name);

      // Remove from state
      state.removeConnection(name);

      // Remove from SQLite
      deleteConnection(db, name);

      res.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('DELETE error', { component: 'connections', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  // POST /api/connections/:name/test — Test a connection without saving
  app.post('/api/connections/:name/test', async (req, res) => {
    try {
      const { name } = req.params;
      let connString = req.body?.connectionString as string | undefined;
      let dbType = req.body?.databaseType as string | undefined;

      // If body doesn't provide credentials, try to load from saved connection
      if (!connString || !dbType) {
        const connState = state.getConnection(name);
        if (connState) {
          connString = connString || connState.connection.connectionString;
          dbType = dbType || connState.connection.databaseType;
        } else {
          const db = await getDb();
          const fileData = readConnectionsFile(db);
          const saved = fileData.connections[name];
          if (saved) {
            connString = connString || saved.connectionString;
            dbType = dbType || saved.databaseType;
          }
        }
      }

      if (!connString || typeof connString !== 'string') {
        res
          .status(400)
          .json({ success: false, message: 'connectionString is required and must be a string' });
        return;
      }

      if (!isDatabaseType(dbType)) {
        res.status(400).json({
          success: false,
          message: `databaseType must be one of: ${[...VALID_DB_TYPES].join(', ')}`,
        });
        return;
      }

      const reqSslConfig = req.body?.sslConfig as NamedConnection['sslConfig'] | undefined;
      const testConnOptions = reqSslConfig?.enabled ? { ssl: reqSslConfig } : undefined;
      const connector = getConnector(dbType);
      await connector.testConnection(connString, testConnOptions);

      res.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, message });
    }
  });

  // POST /api/connections/:name/reveal — Reveal connection string (requires admin password re-confirmation)
  app.post('/api/connections/:name/reveal', async (req, res) => {
    try {
      const { name } = req.params;
      const { password } = req.body as { password?: string };

      if (!password || typeof password !== 'string') {
        res.status(400).json({ success: false, message: 'Admin password is required.' });
        return;
      }

      // Get the current admin user from session and verify their password
      const cookies = parseCookies(req.headers.cookie);
      const sessionId = cookies.calame_session as string | undefined;
      if (!sessionId) {
        res.status(401).json({ success: false, message: 'Authentication required.' });
        return;
      }
      const session = validateSession(sessionId);
      if (!session?.userId) {
        res.status(401).json({ success: false, message: 'Authentication required.' });
        return;
      }

      const userManager = state.userManager;
      if (!userManager) {
        res.status(500).json({ success: false, message: 'User manager not initialized.' });
        return;
      }

      const user = userManager.getUserById(session.userId);
      if (!user || user.role !== 'admin') {
        res.status(403).json({ success: false, message: 'Admin access required.' });
        return;
      }

      // Verify admin password
      const userRow = state.db?.raw
        .prepare('SELECT password_hash FROM users WHERE id = ?')
        .get(session.userId) as { password_hash: string | null } | undefined;

      if (!userRow?.password_hash || !verifyPassword(password, userRow.password_hash)) {
        res.status(403).json({ success: false, message: 'Incorrect password.' });
        return;
      }

      // Retrieve the connection string
      const db = await getDb();
      const fileData = readConnectionsFile(db);
      const conn = fileData.connections[name];
      if (!conn) {
        res.status(404).json({ success: false, message: `Connection "${name}" not found.` });
        return;
      }

      res.json({ success: true, connectionString: conn.connectionString });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Reveal error', { component: 'connections', error: message });
      res.status(500).json({ success: false, message });
    }
  });
}
