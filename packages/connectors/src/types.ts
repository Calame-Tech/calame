import type { DatabaseSchema } from '@calame/core';

export interface SslConfig {
  enabled: boolean;
  /** PEM certificate string for the CA. */
  ca?: string;
  /** Client certificate PEM. */
  cert?: string;
  /** Client private key PEM. */
  key?: string;
  /** Whether to reject unauthorized certificates (default: true). */
  rejectUnauthorized?: boolean;
}

export interface QueryOptions {
  /** Statement timeout in milliseconds (0 = no timeout). */
  timeoutMs?: number;
  /** SSL configuration for establishing pooled connections. */
  ssl?: SslConfig;
  /** Bind parameters for parameterized queries. */
  params?: unknown[];
}

export interface QueryResult {
  rows: Record<string, unknown>[];
}

export interface PoolOptions {
  /** Maximum number of connections in the pool (default: 10). */
  maxSize?: number;
  /** Idle connection timeout in milliseconds (default: 30000). */
  idleTimeoutMs?: number;
}

export interface ConnectionOptions {
  ssl?: SslConfig;
  timeoutMs?: number;
}

export interface DatabaseConnector {
  /** Machine-readable identifier, e.g. "postgresql", "mysql", "sqlite" */
  name: string;
  /** Human-readable label shown in the UI */
  displayName: string;
  /** Example connection string shown as placeholder in forms */
  placeholderDsn: string;
  /** Verify the DSN resolves to a reachable database. Resolves on success, throws the underlying driver error on failure. */
  testConnection(dsn: string, options?: ConnectionOptions): Promise<void>;
  /** Introspect the schema for all user tables in the database. */
  introspect(dsn: string, options?: ConnectionOptions): Promise<DatabaseSchema>;
  /** Sample distinct non-null values from a column, cast to strings. Used for PII detection. */
  sampleColumnValues(
    dsn: string,
    table: string,
    column: string,
    limit?: number,
    options?: ConnectionOptions,
  ): Promise<string[]>;
  /**
   * Execute a read-only SQL query using a pooled connection.
   * The query runs inside a read-only transaction with the configured timeout.
   */
  query(dsn: string, sql: string, options?: QueryOptions): Promise<QueryResult>;
  /** Release any open connections / pools held by this connector instance. */
  disconnect(): Promise<void>;
  /** Return current pool statistics if the connector maintains a connection pool. */
  getPoolStats?(): { active: number; idle: number; waiting: number; total: number };
}

export type DatabaseType = 'postgresql' | 'mysql' | 'sqlite';
