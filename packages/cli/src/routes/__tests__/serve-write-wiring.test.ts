/**
 * Proves the Part A fix: the MCP `write` tool (packages/core/src/serve/tools/write.ts)
 * is only ever registered when `registerDynamicTools` receives `onWriteRequest` —
 * and before this fix, none of the CLI call sites passed it, so the tool
 * silently never appeared for any profile, regardless of `enabledTools`.
 *
 * This test exercises the real (unmocked) `registerDynamicTools` from
 * `@calame/core` together with the real `createOnWriteRequest` helper
 * (packages/cli/src/routes/serve/write-wiring.ts) and a real on-disk
 * `CalameDatabase`, proving end to end that invoking the `write` MCP tool:
 *   1. Creates a pending row in `write_queue`.
 *   2. Triggers an in-app notification row in `notifications`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { registerDynamicTools } from '@calame/core';
import type { McpRegistrationContext, TableInfo } from '@calame/core';
import { buildDatabaseSourceAdapter } from '@calame/connectors';
import { AppState } from '../../state.js';
import { CalameDatabase } from '../../database.js';
import { NotificationDispatcher } from '../../notifications.js';
import { createOnWriteRequest } from '../serve/write-wiring.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolHandler = (...args: any[]) => any;

function createMockServer() {
  const tools = new Map<string, { handler: ToolHandler }>();
  return {
    tool: vi.fn((name: string, _description: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, { handler });
    }),
    getTool: (name: string) => tools.get(name),
  };
}

const usersTable: TableInfo = {
  name: 'users',
  schema: 'public',
  primaryKeys: ['id'],
  columns: [
    { name: 'id', type: 'integer', nullable: false, defaultValue: null },
    { name: 'email', type: 'text', nullable: false, defaultValue: null },
  ],
};

describe('write tool wiring — MCP write tool -> write_queue -> in-app notification', () => {
  let state: AppState;
  let db: CalameDatabase;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `calame-write-wiring-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    state = new AppState();
    db = new CalameDatabase(tmpDir);
    state.db = db;
    // In production this is initialized once in app.ts; wired directly here
    // since this test calls registerDynamicTools without booting the full app.
    state.notifications = new NotificationDispatcher(db, () => null);
  });

  afterEach(async () => {
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('registers the write tool once onWriteRequest is wired (gating unchanged otherwise)', () => {
    const server = createMockServer();
    registerDynamicTools({
      server: server as unknown as Parameters<typeof registerDynamicTools>[0]['server'],
      tables: [usersTable],
      relations: [],
      selectedTables: { users: ['id', 'email'] },
      tableOptions: {
        users: {
          enabledTools: ['describe', 'query', 'write'],
          maxLimit: 100,
          filterableColumns: [],
          groupableColumns: [],
        },
      },
      executeQuery: vi.fn().mockResolvedValue({ rows: [], fields: [] }),
      profileName: 'test',
      databaseType: 'postgresql',
      // No onWriteRequest here — mirrors every CLI call site before Part A.
    });

    expect(server.getTool('write')).toBeUndefined();
  });

  it('creates a write_queue entry and an in-app notification when the write tool is invoked', async () => {
    const server = createMockServer();

    registerDynamicTools({
      server: server as unknown as Parameters<typeof registerDynamicTools>[0]['server'],
      tables: [usersTable],
      relations: [],
      selectedTables: { users: ['id', 'email'] },
      tableOptions: {
        users: {
          enabledTools: ['describe', 'query', 'write'],
          maxLimit: 100,
          filterableColumns: [],
          groupableColumns: [],
        },
      },
      executeQuery: vi.fn().mockResolvedValue({ rows: [], fields: [] }),
      profileName: 'test',
      databaseType: 'postgresql',
      onWriteRequest: createOnWriteRequest(state, 'default'),
    });

    const writeTool = server.getTool('write');
    expect(writeTool).toBeDefined();

    const result = await writeTool!.handler({
      table: 'users',
      operation: 'update',
      description: 'Fix typo in email',
      values: { email: 'fixed@example.com' },
      filters: { id: { op: 'eq', value: 1 } },
    });
    expect(result.content[0].text).toContain('submitted for approval');

    // 1. The proposed write landed in write_queue as 'pending'.
    const wqRow = db.raw.prepare('SELECT * FROM write_queue').get() as
      | { table_name: string; operation: string; status: string; profile_name: string }
      | undefined;
    expect(wqRow).toBeDefined();
    expect(wqRow!.table_name).toBe('users');
    expect(wqRow!.operation).toBe('update');
    expect(wqRow!.status).toBe('pending');
    expect(wqRow!.profile_name).toBe('test');

    // 2. An in-app notification was dispatched for the pending write, in the
    //    same tenant passed to createOnWriteRequest.
    const notifRow = db.raw.prepare('SELECT * FROM notifications').get() as
      | { type: string; tenant_id: string; title: string; read_at: string | null }
      | undefined;
    expect(notifRow).toBeDefined();
    expect(notifRow!.type).toBe('write_queue.pending');
    expect(notifRow!.tenant_id).toBe('default');
    expect(notifRow!.read_at).toBeNull();
  });

  it('registers the write tool through the ADAPTER path (db-adapter registerMcpTools)', async () => {
    // Regression: the modern adapter path (used by every profile that has a
    // Data Configuration) forwards ctx.onWriteRequest to registerDynamicTools.
    // It used to drop it entirely — write tools only worked on the fallback
    // and legacy paths, and this test would have caught it.
    const server = createMockServer();
    const adapter = buildDatabaseSourceAdapter('sqlite', 'SQLite');

    adapter.registerMcpTools!({
      server: server as unknown as McpRegistrationContext['server'],
      source: { id: 'src', name: 'src', type: 'sqlite' },
      config: { connectionString: ':memory:' },
      schema: { kind: 'relational', tables: [usersTable], relations: [] },
      selection: {
        kind: 'relational',
        selectedTables: { users: ['id', 'email'] },
        tableOptions: {
          users: {
            enabledTools: ['describe', 'query', 'write'],
            maxLimit: 100,
            filterableColumns: [],
            groupableColumns: [],
          },
        },
      },
      profileName: 'test',
      toolNamespace: '',
      responseMode: 'raw',
      onAuditLog: () => {},
      executeQuery: vi.fn().mockResolvedValue({ rows: [], fields: [] }),
      onWriteRequest: createOnWriteRequest(state, 'default'),
    } as unknown as Parameters<NonNullable<typeof adapter.registerMcpTools>>[0]);

    const writeTool = server.getTool('write');
    expect(writeTool).toBeDefined();

    await writeTool!.handler({
      table: 'users',
      operation: 'insert',
      description: 'New user',
      values: { email: 'new@example.com' },
    });
    const wqRow = db.raw.prepare('SELECT status FROM write_queue').get() as
      | { status: string }
      | undefined;
    expect(wqRow?.status).toBe('pending');
  });

  it('creates a fresh WriteQueue on state lazily, mirroring serve-status.ts', async () => {
    // state.writeQueue is intentionally left null to prove the lazy-init path.
    expect(state.writeQueue).toBeNull();

    const server = createMockServer();
    registerDynamicTools({
      server: server as unknown as Parameters<typeof registerDynamicTools>[0]['server'],
      tables: [usersTable],
      relations: [],
      selectedTables: { users: ['id', 'email'] },
      tableOptions: {
        users: {
          enabledTools: ['write'],
          maxLimit: 100,
          filterableColumns: [],
          groupableColumns: [],
        },
      },
      executeQuery: vi.fn().mockResolvedValue({ rows: [], fields: [] }),
      profileName: 'test',
      databaseType: 'postgresql',
      onWriteRequest: createOnWriteRequest(state, 'default'),
    });

    await server.getTool('write')!.handler({
      table: 'users',
      operation: 'delete',
      description: 'Remove stale row',
      filters: { id: { op: 'eq', value: 42 } },
    });

    expect(state.writeQueue).not.toBeNull();
    expect(state.writeQueue!.getPending()).toHaveLength(1);
  });
});
