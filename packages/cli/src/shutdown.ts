import type http from 'http';
import type { Logger } from './logger.js';
import type { AppState } from './state.js';
import { getAvailableConnectors } from '@calame/connectors';

const SHUTDOWN_TIMEOUT_MS = 15000;

export async function gracefulShutdown(
  server: http.Server,
  logger: Logger,
  state?: AppState,
): Promise<void> {
  const log = logger.child({ component: 'shutdown' });
  log.info('Shutdown signal received — starting graceful shutdown...');

  // Retrieve AppState from the request pipeline is tricky; access connectors directly
  // Mark shutdown in health via the state (caller should set state.shutdownRequested)
  // We handle it via the signal handler in index.ts

  // Set a hard timeout
  const forceTimer = setTimeout(() => {
    log.error('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  // Allow the process to exit even if the timer is still pending
  forceTimer.unref();

  try {
    // 1. Stop accepting new connections
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    log.info('HTTP server closed');
  } catch (err) {
    log.error('Error closing HTTP server', { error: String(err) });
  }

  // 2. Disconnect all database connectors (drain pools)
  try {
    const connectors = getAvailableConnectors();
    for (const connector of connectors) {
      await connector.disconnect();
    }
    log.info('Database connection pools drained');
  } catch (err) {
    log.error('Error disconnecting databases', { error: String(err) });
  }

  // 3. Close all active SSH tunnels
  try {
    if (state) {
      await state.closeAllTunnels();
      log.info('SSH tunnels closed');
    }
  } catch (err) {
    log.error('Error closing SSH tunnels', { error: String(err) });
  }

  // 4. Close internal SQLite database
  try {
    state?.db?.close();
    log.info('Internal database closed');
  } catch (err) {
    log.error('Error closing internal database', { error: String(err) });
  }

  log.info('Graceful shutdown complete');
  process.exit(0);
}
