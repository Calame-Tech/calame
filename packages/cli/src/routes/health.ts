import type { Express, Request, Response } from 'express';
import type { AppState } from '../state.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cachedVersion: string | null = null;

function getVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    cachedVersion = pkg.version ?? 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion!;
}

export function registerHealthRoute(app: Express, state: AppState): void {
  app.get('/health', (_req: Request, res: Response) => {
    const status = state.shutdownRequested ? 'shutting_down' : 'ok';
    const uptimeSeconds = Math.floor((Date.now() - state.startedAt) / 1000);

    const databases: Array<{
      name: string;
      connected: boolean;
      type: string;
      tableCount: number;
    }> = [];

    for (const [name, connState] of state.connections) {
      databases.push({
        name,
        connected: !!connState.connection.connectionString,
        type: connState.connection.databaseType,
        tableCount: connState.schema?.tables?.length ?? 0,
      });
    }

    const mcpProfiles = Array.from(state.activeProfileNames);

    res.json({
      status,
      version: getVersion(),
      uptime_seconds: uptimeSeconds,
      // Whether the RAG runtime was successfully loaded at boot.
      // `false` means the ee/rag-core package is missing or sqlite-vec
      // native bindings failed. When `false`, `ragDisabledReason` carries a
      // human-readable explanation suitable for a tooltip in the frontend nav.
      ragEnabled: state.ragRuntime !== undefined,
      // Non-null when `ragEnabled` is false — describes why initialization
      // failed (missing EE package, migration error, dimension mismatch, etc.).
      // Always `null` when `ragEnabled` is true.
      ragDisabledReason: state.ragDisabledReason,
      databases: {
        connected: databases.filter((d) => d.connected).length,
        total: databases.length,
        details: databases,
      },
      mcpServers: {
        active: mcpProfiles.length,
        total: Object.keys(state.serveProfiles).length,
        profiles: mcpProfiles,
      },
    });
  });
}
