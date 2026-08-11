/**
 * WriteQueue — action_json round-trip (Slice 1: MCP write-approval).
 *
 * Regression coverage the route-level tests don't isolate: `addRequest` /
 * `getById` / `getPending` / `getAll` must serialize and deserialize a
 * `kind: 'mcp-tool'` action through the additive `action_json` column
 * (migration v16), while a plain SQL entry (no `action` supplied) keeps
 * working exactly as before AND gets a `kind: 'sql'` action synthesized on
 * read from its flat columns (see the PendingWriteAction doc comment in
 * @calame/core/serve/types.ts).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CalameDatabase } from '../database.js';
import { WriteQueue } from '../write-queue.js';

function makeQueue(): { queue: WriteQueue; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calame-write-queue-test-'));
  const db = new CalameDatabase(tmpDir);
  return {
    queue: new WriteQueue(db),
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('WriteQueue — SQL entries (unchanged path)', () => {
  it('round-trips a SQL entry with no action supplied — a compat action is synthesized on read', () => {
    const { queue, cleanup } = makeQueue();
    try {
      const id = queue.addRequest({
        profileName: 'p1',
        sql: 'INSERT INTO t (a) VALUES (?)',
        params: [1],
        tableName: 't',
        operation: 'insert',
        description: 'test',
        connectionName: 'demo',
        databaseType: 'sqlite',
      });
      const entry = queue.getById(id);
      expect(entry).not.toBeNull();
      expect(entry!.action).toEqual({
        kind: 'sql',
        sql: 'INSERT INTO t (a) VALUES (?)',
        params: [1],
        tableName: 't',
        operation: 'insert',
        connectionName: 'demo',
        databaseType: 'sqlite',
      });
      // Legacy flat fields are still the ones a pre-Slice-1 caller would read.
      expect(entry!.sql).toBe('INSERT INTO t (a) VALUES (?)');
      expect(entry!.tableName).toBe('t');
    } finally {
      cleanup();
    }
  });
});

describe('WriteQueue — mcp-tool entries (Slice 1, action_json)', () => {
  it('round-trips an mcp-tool entry through action_json via addRequest/getById', () => {
    const { queue, cleanup } = makeQueue();
    try {
      const id = queue.addRequest({
        profileName: 'p1',
        sql: '',
        params: [],
        tableName: 'add_memory',
        operation: 'insert',
        description: 'MCP write "add_memory" with args {"fact":"hello"}',
        action: {
          kind: 'mcp-tool',
          sourceId: 'src1',
          toolName: 'add_memory',
          args: { fact: 'hello' },
        },
      });

      const entry = queue.getById(id);
      expect(entry).not.toBeNull();
      expect(entry!.action).toEqual({
        kind: 'mcp-tool',
        sourceId: 'src1',
        toolName: 'add_memory',
        args: { fact: 'hello' },
      });
      // Compat flat fields remain readable for any consumer that hasn't been
      // updated to branch on `action` yet.
      expect(entry!.tableName).toBe('add_memory');
      expect(entry!.operation).toBe('insert');
      expect(entry!.sql).toBe('');
      expect(entry!.params).toEqual([]);
      expect(entry!.status).toBe('pending');
    } finally {
      cleanup();
    }
  });

  it('surfaces the deserialized action through getPending and getAll too', () => {
    const { queue, cleanup } = makeQueue();
    try {
      queue.addRequest({
        profileName: 'p1',
        sql: '',
        params: [],
        tableName: 'add_memory',
        operation: 'insert',
        description: 'MCP write',
        action: { kind: 'mcp-tool', sourceId: 'src1', toolName: 'add_memory', args: {} },
      });

      const pending = queue.getPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].action).toEqual({
        kind: 'mcp-tool',
        sourceId: 'src1',
        toolName: 'add_memory',
        args: {},
      });

      const all = queue.getAll();
      expect(all.total).toBe(1);
      expect(all.entries[0].action?.kind).toBe('mcp-tool');
    } finally {
      cleanup();
    }
  });

  it('approveMcpTool executes the supplied executor and records executionResult, leaving approve() untouched', async () => {
    const { queue, cleanup } = makeQueue();
    try {
      const id = queue.addRequest({
        profileName: 'p1',
        sql: '',
        params: [],
        tableName: 'add_memory',
        operation: 'insert',
        description: 'MCP write',
        action: { kind: 'mcp-tool', sourceId: 'src1', toolName: 'add_memory', args: { fact: 'x' } },
      });

      const entry = await queue.approveMcpTool(id, async () => 'added: x');
      expect(entry?.status).toBe('approved');
      expect(entry?.executionResult).toBe('added: x');
      expect(entry?.executionError).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('approveMcpTool records executionError (and still marks approved) when the executor throws', async () => {
    const { queue, cleanup } = makeQueue();
    try {
      const id = queue.addRequest({
        profileName: 'p1',
        sql: '',
        params: [],
        tableName: 'add_memory',
        operation: 'insert',
        description: 'MCP write',
        action: { kind: 'mcp-tool', sourceId: 'src1', toolName: 'add_memory', args: {} },
      });

      const entry = await queue.approveMcpTool(id, async () => {
        throw new Error('upstream boom');
      });
      expect(entry?.status).toBe('approved');
      expect(entry?.executionError).toBe('upstream boom');
      expect(entry?.executionResult).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('approveMcpTool returns null for an already non-pending entry, mirroring approve()', async () => {
    const { queue, cleanup } = makeQueue();
    try {
      const id = queue.addRequest({
        profileName: 'p1',
        sql: '',
        params: [],
        tableName: 'add_memory',
        operation: 'insert',
        description: 'MCP write',
        action: { kind: 'mcp-tool', sourceId: 'src1', toolName: 'add_memory', args: {} },
      });
      queue.reject(id);

      const entry = await queue.approveMcpTool(id, async () => 'should not run');
      expect(entry).toBeNull();
    } finally {
      cleanup();
    }
  });
});
