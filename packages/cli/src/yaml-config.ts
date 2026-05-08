import fs from 'fs';
import yaml from 'js-yaml';
import type { AppConfig } from './config.js';
import type { AppState } from './state.js';
import type { Logger } from './logger.js';
import { upgradeProfileShape } from '@calame/core';

interface YamlDatabase {
  name: string;
  type: 'postgresql' | 'mysql' | 'sqlite';
  connectionString: string;
  ssl?: { ca?: string; cert?: string; key?: string; rejectUnauthorized?: boolean };
}

/**
 * A YAML profile may be expressed in either the legacy shape (with `tables`,
 * `database`) or the new shape (with `sources` + `scopes`). Both are accepted —
 * `upgradeProfileShape` normalises them at the boundary.
 */
interface YamlProfile {
  name: string;
  /** Legacy: single database reference */
  database?: string;
  queryTimeout?: number;
  maxRowLimit?: number;
  /** Legacy table allowlist */
  tables?: Record<
    string,
    {
      columns?: string[];
      tools?: string[];
      piiMasking?: Record<string, string>;
    }
  >;
  /** New shape: list of source ids */
  sources?: string[];
  /** New shape: per-source scope selections */
  scopes?: Record<string, unknown>;
  /** Legacy: list of connection names */
  connections?: string[];
  /** Legacy: table→columns map */
  selectedTables?: Record<string, string[]>;
  [key: string]: unknown;
}

interface YamlMcpServer {
  name: string;
  profiles: string[];
  autoStart?: boolean;
  tokens?: Array<{ label: string }>;
}

interface YamlConfig {
  databases?: YamlDatabase[];
  dataProfiles?: YamlProfile[];
  mcpServers?: YamlMcpServer[];
}

/** Replace ${VAR_NAME} with process.env.VAR_NAME. Warns on missing vars. */
const _missingVars = new Set<string>();
function interpolateEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const val = process.env[varName];
    if (val === undefined && !_missingVars.has(varName)) {
      _missingVars.add(varName);
      console.warn(`[yaml] Warning: environment variable \${${varName}} is not set`);
    }
    return val ?? '';
  });
}

/** Deep-walk an object and interpolate all string values */
function interpolateDeep(obj: unknown): unknown {
  if (typeof obj === 'string') return interpolateEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(interpolateDeep);
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = interpolateDeep(v);
    }
    return result;
  }
  return obj;
}

export async function loadYamlConfig(
  filePath: string,
  state: AppState,
  _config: AppConfig,
  logger?: Logger,
): Promise<void> {
  const log = logger ?? {
    info: (msg: string) => console.log(msg),
    warn: (msg: string) => console.warn(msg),
    error: (msg: string) => console.error(msg),
  };

  if (!fs.existsSync(filePath)) {
    log.warn(`YAML config file not found: ${filePath}`);
    return;
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = yaml.load(raw) as YamlConfig | null;
  if (!parsed) {
    log.warn('YAML config file is empty');
    return;
  }

  const config = interpolateDeep(parsed) as YamlConfig;

  // Apply databases
  if (config.databases) {
    const { getConnector } = await import('@calame/connectors');
    for (const db of config.databases) {
      if (state.connections.has(db.name)) {
        log.info(`[yaml] Connection "${db.name}" already exists, skipping`);
        continue;
      }
      try {
        const sslConfig = db.ssl ? { enabled: true, ...db.ssl } : undefined;
        const connOptions = sslConfig ? { ssl: sslConfig } : undefined;
        const connector = getConnector(db.type);
        const schema = await connector.introspect(db.connectionString, connOptions);
        state.addConnection(db.name, {
          connection: {
            name: db.name,
            label: db.name,
            databaseType: db.type,
            connectionString: db.connectionString,
            sslConfig,
          },
          schema,
          piiDetections: null,
        });
        log.info(`[yaml] Connected "${db.name}" (${schema.tables.length} tables)`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[yaml] Failed to connect "${db.name}": ${msg}`);
      }
    }
  }

  // Apply dataProfiles — convert each YAML profile to a ServeProfile and load into state.
  // Both legacy (database + tables) and new (sources + scopes) shapes are accepted;
  // upgradeProfileShape normalises them at the boundary so downstream code always sees
  // the full new shape with legacy fields preserved (until Phase 3 removes them).
  if (config.dataProfiles) {
    for (const yamlProfile of config.dataProfiles) {
      if (!yamlProfile.name) {
        log.warn('[yaml] Skipping dataProfile entry with missing name');
        continue;
      }

      // Build a raw profile object from the YAML definition.
      // For the legacy `database + tables` shape, synthesise `connections` and
      // `selectedTables` from the table list so that upgradeProfileShape can convert them.
      const rawProfile: Record<string, unknown> = { ...yamlProfile };

      if (yamlProfile.database && !rawProfile['connections']) {
        rawProfile['connections'] = [yamlProfile.database];
      }

      if (yamlProfile.tables && !rawProfile['selectedTables']) {
        const selectedTables: Record<string, string[]> = {};
        for (const [tableName, opts] of Object.entries(yamlProfile.tables)) {
          selectedTables[tableName] = opts.columns ?? [];
        }
        rawProfile['selectedTables'] = selectedTables;
      }

      try {
        const upgraded = upgradeProfileShape(rawProfile);
        state.serveProfiles[upgraded.name] = upgraded;
        log.info(`[yaml] Profile "${upgraded.name}" loaded`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[yaml] Failed to load profile "${yamlProfile.name}": ${msg}`);
      }
    }
  }

  log.info(`[yaml] Configuration loaded from ${filePath}`);
}
