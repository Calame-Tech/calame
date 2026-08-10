/**
 * Write-queue approval — mcp-tool action path (Slice 1, MCP write-approval).
 *
 * Companion to write-queue-tenant.test.ts (which covers the SQL path's
 * tenant scoping + target-connection resolution, including the v15 "target
 * connection is gone" regression). This file proves the equivalent contract
 * for a `kind: 'mcp-tool'` queue entry:
 *  - approval resolves the upstream Source by `action.sourceId` (never from
 *    config stored on the queue row) and forwards the call via
 *    `callUpstreamTool`, recording the result in `executionResult`;
 *  - a vanished/unresolvable source fails the approval cleanly — nothing is
 *    persisted (entry stays 'pending') and the upstream is never called —
 *    the same failure shape as the SQL "target connection is gone" case;
 *  - the existing tenant scoping on the queue (404 on cross-tenant approve)
 *    covers mcp-tool entries too, since it only branches on `existing.action`
 *    AFTER the tenant check.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createApp } from '../../app.js';
import { AppState } from '../../state.js';
import { CalameDatabase } from '../../database.js';
import { UserManager } from '../../user.js';
import { WriteQueue } from '../../write-queue.js';
import { setupAdminAndGetCookie } from './helpers.js';
import { callUpstreamTool } from '@calame/connectors';

vi.mock('@calame/connectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@calame/connectors')>();
  return { ...actual, callUpstreamTool: vi.fn() };
});

const mockedCallUpstreamTool = vi.mocked(callUpstreamTool);

describe('write-queue routes — mcp-tool action approval (Slice 1)', () => {
  let app: ReturnType<typeof createApp>;
  let state: AppState;
  let db: CalameDatabase;
  let originalCwd: string;
  let tmpDir: string;
  let cookie: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = path.join(os.tmpdir(), `calame-wq-mcp-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    process.chdir(tmpDir);

    state = new AppState();
    db = new CalameDatabase(tmpDir);
    state.db = db;
    state.userManager = new UserManager(db);
    state.writeQueue = new WriteQueue(db);
    app = createApp(state);
    cookie = await setupAdminAndGetCookie(app);

    // Slice 0's unified-sources storage for non-relational sources (see
    // registration.ts's resolveAdapterConfig): a minimal rag_sources table
    // holding the encrypted upstream config, keyed by sourceId.
    db.raw.exec(
      `CREATE TABLE rag_sources (id TEXT PRIMARY KEY, type TEXT, name TEXT, config_encrypted TEXT, tenant_id TEXT, deleted_at TEXT)`,
    );
    db.raw
      .prepare(
        `INSERT INTO rag_sources (id, type, name, config_encrypted, tenant_id) VALUES (?, 'mcp', 'Graphiti', ?, 'default')`,
      )
      .run('src1', 'enc:{"url":"https://upstream.example.com/mcp"}');

    // A minimal ragRuntime stand-in — resolveMcpWriteTarget only calls
    // decryptConfig; the rest of the real RagRuntime surface is unused here.
    state.ragRuntime = {
      decryptConfig: (enc: string) => enc.replace(/^enc:/, ''),
    } as unknown as AppState['ragRuntime'];

    mockedCallUpstreamTool.mockReset();
  });

  afterEach(async () => {
    state.db?.close();
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  function queueMcpWrite(tenantId: string, sourceId = 'src1'): string {
    return state.writeQueue!.addRequest({
      profileName: 'p1',
      sql: '',
      params: [],
      tableName: 'add_memory',
      operation: 'insert',
      description: 'MCP write "add_memory" with args {"fact":"hello"}',
      tenantId,
      action: { kind: 'mcp-tool', sourceId, toolName: 'add_memory', args: { fact: 'hello' } },
    });
  }

  it('approves an mcp-tool entry: resolves the source by sourceId, calls callUpstreamTool, records executionResult', async () => {
    mockedCallUpstreamTool.mockResolvedValue({ text: 'added: hello', isError: false });
    const id = queueMcpWrite('default');

    const res = await request(app)
      .post(`/api/write-queue/${id}/approve`)
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body.entry.status).toBe('approved');
    expect(res.body.entry.executionResult).toBe('added: hello');
    expect(res.body.entry.executionError).toBeUndefined();

    expect(mockedCallUpstreamTool).toHaveBeenCalledTimes(1);
    expect(mockedCallUpstreamTool).toHaveBeenCalledWith(
      { url: 'https://upstream.example.com/mcp' },
      'add_memory',
      { fact: 'hello' },
    );
  });

  it('records executionError (still approved) when the upstream call itself reports isError', async () => {
    mockedCallUpstreamTool.mockResolvedValue({ text: 'tool blew up', isError: true });
    const id = queueMcpWrite('default');

    const res = await request(app)
      .post(`/api/write-queue/${id}/approve`)
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body.entry.status).toBe('approved');
    expect(res.body.entry.executionError).toBe('tool blew up');
    expect(res.body.entry.executionResult).toBeUndefined();
  });

  it('fails cleanly without executing when the mcp source is gone — entry stays pending', async () => {
    const id = queueMcpWrite('default', 'vanished-source');

    const res = await request(app)
      .post(`/api/write-queue/${id}/approve`)
      .set('Cookie', cookie)
      .expect(500);

    expect(res.body.message).toContain('vanished-source');
    expect(mockedCallUpstreamTool).not.toHaveBeenCalled();
    expect(state.writeQueue!.getById(id)?.status).toBe('pending');
  });

  it('returns 404 (not 403) for a cross-tenant mcp-tool entry — existing scoping covers action entries', async () => {
    const id = queueMcpWrite('acme');

    await request(app).post(`/api/write-queue/${id}/approve`).set('Cookie', cookie).expect(404);

    expect(mockedCallUpstreamTool).not.toHaveBeenCalled();
    expect(state.writeQueue!.getById(id)?.status).toBe('pending');
  });

  // -------------------------------------------------------------------------
  // Review fixes — security hardening
  // -------------------------------------------------------------------------

  it('refuses to execute against a source owned by ANOTHER tenant — entry stays pending', async () => {
    // The entry belongs to 'default' but references a source owned by
    // 'tenant-b': source resolution filters on the ENTRY's tenant, so this
    // must fail before any mutation — tenant B's credentials are never
    // decrypted into an upstream call for tenant A's approval.
    db.raw
      .prepare(
        `INSERT INTO rag_sources (id, type, name, config_encrypted, tenant_id) VALUES (?, 'mcp', 'Foreign', ?, 'tenant-b')`,
      )
      .run('src-foreign', 'enc:{"url":"https://foreign.example.com/mcp"}');
    const id = queueMcpWrite('default', 'src-foreign');

    const res = await request(app)
      .post(`/api/write-queue/${id}/approve`)
      .set('Cookie', cookie)
      .expect(500);

    expect(res.body.success).toBe(false);
    expect(mockedCallUpstreamTool).not.toHaveBeenCalled();
    expect(state.writeQueue!.getById(id)?.status).toBe('pending');
  });

  it('refuses to execute against a soft-deleted source — entry stays pending', async () => {
    db.raw
      .prepare(
        `INSERT INTO rag_sources (id, type, name, config_encrypted, tenant_id, deleted_at) VALUES (?, 'mcp', 'Deleted', ?, 'default', ?)`,
      )
      .run('src-deleted', 'enc:{"url":"https://old.example.com/mcp"}', new Date().toISOString());
    const id = queueMcpWrite('default', 'src-deleted');

    await request(app).post(`/api/write-queue/${id}/approve`).set('Cookie', cookie).expect(500);

    expect(mockedCallUpstreamTool).not.toHaveBeenCalled();
    expect(state.writeQueue!.getById(id)?.status).toBe('pending');
  });

  it('concurrent approves execute the upstream tool exactly once (atomic claim)', async () => {
    // The upstream call is slow (50ms) — under the old check-then-act shape
    // both requests would pass the pending check and both would execute.
    mockedCallUpstreamTool.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ text: 'added once', isError: false }), 50),
        ),
    );
    const id = queueMcpWrite('default');

    const [a, b] = await Promise.all([
      request(app).post(`/api/write-queue/${id}/approve`).set('Cookie', cookie),
      request(app).post(`/api/write-queue/${id}/approve`).set('Cookie', cookie),
    ]);

    expect(mockedCallUpstreamTool).toHaveBeenCalledTimes(1);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 404]); // one winner, one clean loser
    expect(state.writeQueue!.getById(id)?.status).toBe('approved');
  });

  it('a corrupt action_json row is listable and rejectable but never executable', async () => {
    const id = queueMcpWrite('default');
    db.raw.prepare(`UPDATE write_queue SET action_json = ? WHERE id = ?`).run('{not json!', id);

    // Listable — the corruption is surfaced, not thrown.
    const list = await request(app).get('/api/write-queue').set('Cookie', cookie).expect(200);
    const listed = (list.body.entries as Array<{ id: string; description: string }>).find(
      (e) => e.id === id,
    );
    expect(listed?.description).toContain('[corrupt action]');

    // Never executable.
    const approve = await request(app)
      .post(`/api/write-queue/${id}/approve`)
      .set('Cookie', cookie)
      .expect(500);
    expect(approve.body.message).toContain('corrupt action payload');
    expect(mockedCallUpstreamTool).not.toHaveBeenCalled();
    expect(state.writeQueue!.getById(id)?.status).toBe('pending');

    // Rejectable — the admin's way out.
    await request(app).post(`/api/write-queue/${id}/reject`).set('Cookie', cookie).expect(200);
    expect(state.writeQueue!.getById(id)?.status).toBe('rejected');
  });

  it('an unknown action kind is refused without mutation (no fall-through to the SQL path)', async () => {
    const id = queueMcpWrite('default');
    db.raw
      .prepare(`UPDATE write_queue SET action_json = ? WHERE id = ?`)
      .run(JSON.stringify({ kind: 'future-kind', anything: true }), id);

    const res = await request(app)
      .post(`/api/write-queue/${id}/approve`)
      .set('Cookie', cookie)
      .expect(400);

    expect(res.body.message).toContain('Unsupported write action kind');
    expect(mockedCallUpstreamTool).not.toHaveBeenCalled();
    expect(state.writeQueue!.getById(id)?.status).toBe('pending');
  });
});
