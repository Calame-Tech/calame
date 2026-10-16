/**
 * Integration tests for POST /api/serve/mcp-probe.
 *
 * The probe talks to a real MCP server (SDK McpServer + Streamable HTTP
 * transport) mounted on `/mcp/:profile` of a real listening Express app, so
 * the initialize handshake and tools/list really go over HTTP. No LLM
 * provider is configured: the probe must succeed without one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import net from 'net';
import type { Server } from 'http';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ServeProfile } from '@calame/core';
import { AppState } from '../../state.js';
import { CalameDatabase } from '../../database.js';
import { UserManager } from '../../user.js';
import { createSession } from '../../session.js';
import { classifyMcpProbeError, registerMcpProbeRoute } from '../mcp-probe.js';
import type { McpProbeOptions } from '../mcp-probe.js';

/** Real MCP server answering one stateless request. */
async function handleWithRealMcp(req: express.Request, res: express.Response): Promise<void> {
  const server = new McpServer({ name: 'probe-test-server', version: '9.9.9' });
  server.tool('ping', 'Answers pong', { text: z.string().optional() }, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

describe('POST /api/serve/mcp-probe', () => {
  let tmpDir: string;
  let db: CalameDatabase;
  let state: AppState;
  let listener: Server;
  let origin: string;
  let adminToken: string;
  let adminCookie: string;
  let originalSecret: string | undefined;
  let mcpRequests: Array<{ authorization?: string; method?: string }>;

  async function start(options: McpProbeOptions = {}): Promise<void> {
    const app = express();
    app.use(express.json());
    app.post('/mcp/:profile', (req, res) => {
      mcpRequests.push({ authorization: req.headers.authorization, method: req.body?.method });
      const profile = req.params.profile;
      if (profile === 'protected' && req.headers.authorization !== `Bearer ${adminToken}`) {
        res.status(401).json({ success: false, message: 'Invalid token.' });
        return;
      }
      if (profile === 'inactive') {
        res.status(503).json({ success: false, message: 'Profile "inactive" is not active.' });
        return;
      }
      if (profile === 'boom') {
        res.status(500).json({ success: false, message: 'Database not initialised.' });
        return;
      }
      if (profile === 'garbage') {
        res.type('text/plain').send('hello, I am not MCP');
        return;
      }
      if (profile === 'hang') return; // never answers
      if (profile === 'notools' && req.body?.method === 'tools/list') {
        res.json({
          jsonrpc: '2.0',
          id: req.body.id,
          error: { code: -32601, message: 'Method not found' },
        });
        return;
      }
      void handleWithRealMcp(req, res).catch(() => {
        if (!res.headersSent) res.sendStatus(500);
      });
    });
    registerMcpProbeRoute(app, state, { timeoutMs: 1_000, ...options });
    listener = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const address = listener.address() as net.AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  }

  function serve(name: string, profile: Partial<ServeProfile> = {}): void {
    state.serveProfiles = { ...state.serveProfiles, [name]: { name, label: name, ...profile } };
    state.activeProfileNames.add(name);
  }

  beforeEach(async () => {
    originalSecret = process.env.CALAME_SECRET_KEY;
    process.env.CALAME_SECRET_KEY = 'probe-test-secret-key-0123456789abcdef';
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'calame-mcp-probe-'));
    db = new CalameDatabase(tmpDir);
    state = new AppState();
    state.db = db;
    state.userManager = new UserManager(db);
    const admin = state.userManager.createAdminAccount({
      name: 'Admin',
      email: 'admin@test.com',
      password: 'testpass123',
    });
    adminToken = admin._plaintextToken;
    adminCookie = `calame_session=${createSession(admin.id)}`;
    mcpRequests = [];
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (listener ? listener.close(() => resolve()) : resolve()));
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    if (originalSecret === undefined) delete process.env.CALAME_SECRET_KEY;
    else process.env.CALAME_SECRET_KEY = originalSecret;
  });

  const probe = (body: Record<string, unknown> = {}) =>
    request(origin).post('/api/serve/mcp-probe').set('Cookie', adminCookie).send(body);

  it('initializes and lists tools of an open profile without any AI configuration', async () => {
    serve('docs', { authMode: 'open' });
    await start();

    const res = await probe({ profileName: 'docs' }).expect(200);

    expect(res.body).toMatchObject({
      success: true,
      profileName: 'docs',
      endpoint: '/mcp/docs',
      transport: 'streamable-http',
      serverInfo: { name: 'probe-test-server', version: '9.9.9' },
      tools: [{ name: 'ping', description: 'Answers pong' }],
    });
    expect(typeof res.body.protocolVersion).toBe('string');
    expect(mcpRequests.map((r) => r.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
    expect(state.aiSettingsManager).toBeNull();
  });

  it('defaults to the first active profile', async () => {
    serve('docs', { authMode: 'open' });
    await start();
    const res = await probe().expect(200);
    expect(res.body.profileName).toBe('docs');
  });

  it('authenticates a protected profile with the admin token without leaking it', async () => {
    serve('protected', { authMode: 'token' });
    await start();

    const res = await probe({ profileName: 'protected' }).expect(200);

    expect(res.body.success).toBe(true);
    expect(mcpRequests[0]?.authorization).toBe(`Bearer ${adminToken}`);
    expect(JSON.stringify(res.body)).not.toContain(adminToken);
  });

  it('reports a stopped server when the MCP server is not running', async () => {
    await start();
    const res = await probe().expect(409);
    expect(res.body.error).toMatchObject({
      category: 'unreachable',
      stage: 'preflight',
      code: 'server_stopped',
    });
    expect(res.body.error.action).toMatch(/Click Start/);
    expect(mcpRequests).toHaveLength(0);
  });

  it('reports a stopped server for a profile that was stopped', async () => {
    serve('docs', { authMode: 'open' });
    serve('other', { authMode: 'open' });
    state.activeProfileNames.delete('other');
    await start();
    const res = await probe({ profileName: 'other' }).expect(409);
    expect(res.body.error).toMatchObject({
      category: 'unreachable',
      stage: 'preflight',
      code: 'server_stopped',
    });
    expect(res.body.error.message).toContain('"other" is stopped');
    expect(mcpRequests).toHaveLength(0);
  });

  it('remembers the last probe of each profile on the server', async () => {
    serve('docs', { authMode: 'open' });
    await start();
    const last = () => request(origin).get('/api/serve/mcp-probe/last').set('Cookie', adminCookie);

    expect((await last().expect(200)).body).toEqual({ results: {} });

    await probe({ profileName: 'docs' }).expect(200);
    expect((await last()).body.results.docs).toMatchObject({ success: true, toolCount: 1 });

    // Stopping the server then re-testing replaces the success with the failure.
    state.activeProfileNames.delete('docs');
    await probe({ profileName: 'docs' }).expect(409);
    expect((await last()).body.results.docs).toMatchObject({
      success: false,
      error: { category: 'unreachable', code: 'server_stopped' },
    });
    expect(typeof (await last()).body.results.docs.at).toBe('string');
  });

  it('stops reporting a success once the profile is stopped, without a new test', async () => {
    serve('docs', { authMode: 'open' });
    await start();
    const last = () => request(origin).get('/api/serve/mcp-probe/last').set('Cookie', adminCookie);

    await probe({ profileName: 'docs' }).expect(200);
    expect((await last()).body.results.docs).toMatchObject({ success: true });

    state.activeProfileNames.delete('docs');
    expect((await last()).body.results).toEqual({});
  });

  it('rejects an unknown profile without remembering it', async () => {
    serve('docs', { authMode: 'open' });
    await start();
    const res = await probe({ profileName: 'ghost' }).expect(404);
    expect(res.body.error).toMatchObject({
      category: 'config',
      stage: 'preflight',
      code: 'unknown_profile',
    });
    expect(mcpRequests).toHaveLength(0);
    const last = await request(origin)
      .get('/api/serve/mcp-probe/last')
      .set('Cookie', adminCookie)
      .expect(200);
    expect(last.body).toEqual({ results: {} });

    await probe({ profileName: 'x'.repeat(201) }).expect(400);
  });

  it('says what to configure when no admin token can be recovered', async () => {
    serve('protected', { authMode: 'token' });
    await start();
    delete process.env.CALAME_SECRET_KEY;

    const res = await probe({ profileName: 'protected' }).expect(409);

    expect(res.body.error).toMatchObject({ category: 'config', stage: 'preflight' });
    expect(res.body.error.action).toContain('CALAME_SECRET_KEY');
    expect(mcpRequests).toHaveLength(0);
  });

  it('classifies a refused token as an authentication error', async () => {
    serve('protected', { authMode: 'token' });
    await start();
    adminToken = 'something-else';

    const res = await probe({ profileName: 'protected' }).expect(502);

    expect(res.body.error).toMatchObject({
      category: 'auth',
      stage: 'initialize',
      httpStatus: 401,
    });
    expect(res.body.error.detail).toContain('Invalid token.');
  });

  it('classifies an endpoint that is not serving the profile', async () => {
    serve('inactive', { authMode: 'open' });
    await start();
    const res = await probe({ profileName: 'inactive' }).expect(502);
    expect(res.body.error).toMatchObject({ category: 'unreachable', httpStatus: 503 });
  });

  it('classifies a closed port as an unreachable server', async () => {
    const closed = net.createServer();
    const port = await new Promise<number>((resolve) =>
      closed.listen(0, '127.0.0.1', () => resolve((closed.address() as net.AddressInfo).port)),
    );
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    serve('docs', { authMode: 'open' });
    await start({ resolveOrigin: () => `http://127.0.0.1:${port}` });

    const res = await probe({ profileName: 'docs' }).expect(502);

    expect(res.body.error).toMatchObject({ category: 'unreachable', stage: 'initialize' });
  });

  it('classifies a silent endpoint as a timeout', async () => {
    serve('hang', { authMode: 'open' });
    await start({ timeoutMs: 200 });
    const res = await probe({ profileName: 'hang' }).expect(504);
    expect(res.body.error).toMatchObject({ category: 'timeout', stage: 'initialize' });
  });

  it('classifies a non-MCP answer as a protocol error', async () => {
    serve('garbage', { authMode: 'open' });
    await start();
    const res = await probe({ profileName: 'garbage' }).expect(502);
    expect(res.body.error).toMatchObject({ category: 'protocol', stage: 'initialize' });
  });

  it('reports a JSON-RPC error during discovery as a protocol error at list_tools', async () => {
    serve('notools', { authMode: 'open' });
    await start();
    const res = await probe({ profileName: 'notools' }).expect(502);
    expect(res.body.error).toMatchObject({ category: 'protocol', stage: 'list_tools' });
    expect(res.body.error.detail).toContain('Method not found');
  });

  it('classifies an endpoint 5xx as a backend error', async () => {
    serve('boom', { authMode: 'open' });
    await start();
    const res = await probe({ profileName: 'boom' }).expect(502);
    expect(res.body.error).toMatchObject({ category: 'backend', httpStatus: 500 });
    expect(res.body.error.detail).toContain('Database not initialised.');
  });
});

describe('classifyMcpProbeError', () => {
  it('redacts tokens and credentials from the technical detail', () => {
    const err = new McpError(
      -32603,
      'failed with Bearer fmcp_abc123 at postgres://user:pw@db/x?token=zzz secret-value',
    );
    const out = classifyMcpProbeError(err, 'list_tools', ['secret-value']);
    expect(out.detail).not.toMatch(/fmcp_abc123|user:pw|zzz|secret-value/);
    expect(out.category).toBe('protocol');
  });

  it('falls back to a backend error for unknown failures', () => {
    const out = classifyMcpProbeError(new Error('kaboom'), 'initialize');
    expect(out).toMatchObject({ category: 'backend', detail: 'kaboom' });
  });
});
