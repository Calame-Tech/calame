export type { DatabaseConnector, DatabaseType, SslConfig, ConnectionOptions } from './types.js';
export { PostgreSQLConnector } from './postgresql.js';
export { MySQLConnector } from './mysql.js';
export { SQLiteConnector } from './sqlite.js';

import type { DatabaseConnector, DatabaseType } from './types.js';
import { PostgreSQLConnector } from './postgresql.js';
import { MySQLConnector } from './mysql.js';
import { SQLiteConnector } from './sqlite.js';

// Singleton instances — one per connector type
const registry: Record<DatabaseType, DatabaseConnector> = {
  postgresql: new PostgreSQLConnector(),
  mysql: new MySQLConnector(),
  sqlite: new SQLiteConnector(),
};

/**
 * Look up the connector for a given database type.
 * Throws if an unsupported type is requested.
 */
export function getConnector(type: DatabaseType): DatabaseConnector {
  const connector = registry[type];
  if (!connector) {
    throw new Error(`No connector registered for database type "${type}"`);
  }
  return connector;
}

/**
 * Return all registered connectors in a stable order.
 * Useful for populating UI dropdowns.
 */
export function getAvailableConnectors(): DatabaseConnector[] {
  return Object.values(registry);
}
