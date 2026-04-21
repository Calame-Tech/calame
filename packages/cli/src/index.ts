#!/usr/bin/env node

import express from 'express';
import http from 'http';
import https from 'https';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import { createApp } from './app.js';
import { AppState } from './state.js';
import { CalameDatabase } from './database.js';
import { runMigrations } from './migration.js';
import { loadConfig, validateConfig } from './config.js';
import { createLogger } from './logger.js';
import { gracefulShutdown } from './shutdown.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve project root (monorepo root where pnpm-workspace.yaml lives)
function findProjectRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = path.dirname(dir);
  }
  return startDir;
}
const projectRoot = findProjectRoot(__dirname);
process.chdir(projectRoot);

// Parse CLI args
function parsePort(args: string[]): number | undefined {
  const portIndex = args.indexOf('--port');
  if (portIndex !== -1 && args[portIndex + 1]) {
    const port = parseInt(args[portIndex + 1], 10);
    if (!isNaN(port) && port > 0 && port < 65536) return port;
  }
  return undefined;
}

const cliPort = parsePort(process.argv.slice(2));

// Load configuration
const config = loadConfig(cliPort ? { port: cliPort } : undefined);

// Create logger
const logger = createLogger({ level: config.logLevel, format: config.logFormat });

// Ensure data directory exists (needed before secret persistence)
if (config.dataDir !== process.cwd()) {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

// Auto-generate CALAME_SECRET_KEY if not set, persisted in dataDir so it
// survives container restarts (volume-mounted in Docker, working dir in dev).
const SECRET_FILE = path.join(config.dataDir, '.calame-secret');

if (!config.secretKey) {
  let secret: string | null = null;
  try {
    secret = fs.readFileSync(SECRET_FILE, 'utf-8').trim();
  } catch {
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
    logger.info(`Generated CALAME_SECRET_KEY and saved to ${SECRET_FILE}`, {
      component: 'security',
    });
  }
  process.env.CALAME_SECRET_KEY = secret;
  config.secretKey = secret;
}

// Validate configuration (after secret auto-gen so prod doesn't fail unnecessarily)
try {
  validateConfig(config);
} catch (err) {
  logger.error((err as Error).message, { component: 'config' });
  process.exit(1);
}

// Initialize internal SQLite database and run schema migrations
const appState = new AppState();
appState.db = new CalameDatabase(config.dataDir);
runMigrations(appState.db);

const app = createApp({ state: appState, config, logger });

// Serve the frontend static files
const staticPath = path.join(__dirname, '../../web/dist');

if (config.basePath !== '/') {
  // Mount under base path
  const router = express.Router();
  router.use(express.static(staticPath));
  router.get('*', (req, res, next) => {
    if (
      req.path.startsWith('/.well-known') ||
      req.path.startsWith('/authorize') ||
      req.path.startsWith('/token') ||
      req.path.startsWith('/register') ||
      req.path.startsWith('/mcp/')
    ) {
      next();
      return;
    }
    res.sendFile(path.join(staticPath, 'index.html'));
  });
  app.use(config.basePath, router);
} else {
  app.use(express.static(staticPath));
  app.get('*', (req, res, next) => {
    if (
      req.path.startsWith('/.well-known') ||
      req.path.startsWith('/authorize') ||
      req.path.startsWith('/token') ||
      req.path.startsWith('/register') ||
      req.path.startsWith('/mcp/')
    ) {
      next();
      return;
    }
    res.sendFile(path.join(staticPath, 'index.html'));
  });
}

// Create server (HTTP or HTTPS)
let server: http.Server;
if (config.tlsCert && config.tlsKey) {
  const cert = fs.readFileSync(config.tlsCert, 'utf-8');
  const key = fs.readFileSync(config.tlsKey, 'utf-8');
  server = https.createServer({ cert, key }, app);
  logger.info('TLS enabled — using provided certificate', { component: 'server' });
} else {
  server = http.createServer(app);
}

// Graceful shutdown
const shutdown = () => gracefulShutdown(server, logger, appState);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(config.port, () => {
  const protocol = config.tlsCert ? 'https' : 'http';
  logger.info(`Calame is running on ${protocol}://localhost:${config.port}${config.basePath}`, {
    component: 'server',
  });

  // Only open browser in development
  if (process.env.NODE_ENV !== 'production') {
    import('open').then((mod) => mod.default(`http://localhost:${config.port}${config.basePath}`));
  }
});
