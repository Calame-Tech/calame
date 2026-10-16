/**
 * End-to-end check of POST /api/serve/mcp-probe against Calame's own MCP
 * endpoint (`registerServeRoute`) — the route external MCP clients hit —
 * backed by a real SQLite source. No AI setting exists in this state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { SQLiteConnector } from '@calame/connectors';
import type { ServeProfile } from '@calame/core';
import { AppState } from '../../state.js';
import { CalameDatabase } from '../../database.js';
import { UserManager } from '../../user.js';
import { registerServeRoute } from '../serve.js';
import { registerMcpProbeRoute } from '../mcp-probe.js';

describe('MCP probe against the real Calame MCP endpoint', () => {
  let dir: string;
  let db: CalameDatabase;
  let state: AppState;
  let listener: Server;
  let origin: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'calame-probe-serve-'));
    db = new CalameDatabase(dir);
    state = new AppState();
    state.db = db;
    state.userManager = new UserManager(db);
    const app = express();
    app.use(express.json());
    registerServeRoute(app, state);
    registerMcpProbeRoute(app, state);
    listener = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    db.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  function serve(profile: Partial<ServeProfile>): void {
    state.serveProfiles = {
      demo: { name: 'demo', label: 'demo', authMode: 'open', ...profile } as ServeProfile,
    };
    state.activeProfileNames.add('demo');
  }

  it('initializes and discovers tools over Streamable HTTP without an AI setting', async () => {
    const file = path.join(dir, 'demo.sqlite');
    const raw = new Database(file);
    raw.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
    raw.close();
    const schema = await new SQLiteConnector().introspect(file);
    state.addConnection('default', {
      connection: {
        name: 'default',
        label: 'Demo',
        databaseType: 'sqlite',
        connectionString: file,
      },
      schema,
      piiDetections: null,
    });
    serve({
      sources: ['default'],
      scopes: { default: { kind: 'relational', selectedTables: { main: ['items'] } } },
    });

    const res = await request(origin).post('/api/serve/mcp-probe').send({}).expect(200);

    expect(res.body).toMatchObject({
      success: true,
      profileName: 'demo',
      endpoint: '/mcp/demo',
      transport: 'streamable-http',
      serverInfo: { name: 'calame-demo' },
    });
    expect(res.body.tools.map((t: { name: string }) => t.name)).toContain('calc');
    expect(state.aiSettingsManager).toBeNull();
  });

  it('surfaces the endpoint reason when the profile has no data source', async () => {
    serve({});

    const res = await request(origin).post('/api/serve/mcp-probe').send({}).expect(502);

    expect(res.body.error).toMatchObject({
      category: 'backend',
      stage: 'initialize',
      httpStatus: 500,
    });
    expect(res.body.error.detail).toContain('No data source available for this profile.');
  });
});
