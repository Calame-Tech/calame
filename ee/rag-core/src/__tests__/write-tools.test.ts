// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuditLogEntry } from '@calame/core';
import { registerDocumentWriteTools } from '../write-tools.js';
import type { ResolveWriteTarget, IndexTriggerResult } from '../write-tools.js';
import { sha256Hex } from '../fs-write.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

let base: string;
let root: string;
let audits: AuditLogEntry[];
let handlers: Record<string, Handler>;
let allowed: boolean;
let folder: string | undefined;
let trigger: IndexTriggerResult;
let triggerSpy: ReturnType<typeof vi.fn>;

function setup() {
  handlers = {};
  const server = {
    tool: vi.fn((name: string, _d: string, _s: unknown, h: Handler) => {
      handlers[name] = h;
    }),
  } as unknown as McpServer;
  const resolveTarget: ResolveWriteTarget = async (name) =>
    allowed && name === 'Nationex'
      ? { ok: true, sourceId: 'src-1', sourceName: 'Nationex', rootPath: root, folder }
      : { ok: false, reason: 'nope' };
  triggerSpy = vi.fn(() => trigger);
  registerDocumentWriteTools({
    server,
    profileName: 'p',
    sourceNames: ['Nationex'],
    resolveTarget,
    triggerIndex: triggerSpy as unknown as (id: string) => IndexTriggerResult,
    isIndexed: async () => false,
    onAuditLog: (e) => audits.push(e),
  });
}

const call = async (tool: string, args: Record<string, unknown>) => {
  const r = await handlers[tool]!(args);
  return {
    isError: r.isError === true,
    body: JSON.parse(r.content[0]!.text) as Record<string, unknown> & {
      code?: string;
      version?: string;
      content?: string;
      piiMasked?: boolean;
      saved?: boolean;
      indexing: { status: string; indexed: boolean };
    },
  };
};

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'wtools-'));
  root = join(base, 'root');
  await mkdir(join(root, 'notes'), { recursive: true });
  audits = [];
  allowed = true;
  folder = undefined;
  trigger = { status: 'queued', jobId: 'j1' };
  setup();
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('rag_write_document', () => {
  it('registers both tools', () => {
    expect(Object.keys(handlers).sort()).toEqual(['rag_read_note', 'rag_write_document']);
  });

  it('creates a note, triggers indexing, reports saved vs indexing separately', async () => {
    const { isError, body } = await call('rag_write_document', {
      source: 'Nationex',
      path: 'notes/a.md',
      content: '---\nstatus: open\n---\nhello',
    });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ saved: true, operation: 'created', path: 'notes/a.md' });
    expect(body.indexing).toMatchObject({ status: 'queued', indexed: false });
    expect(body.version).toBe(sha256Hex('---\nstatus: open\n---\nhello'));
    expect(JSON.stringify(body)).not.toContain(root);
    expect(triggerSpy).toHaveBeenCalledWith('src-1');
    expect(await readFile(join(root, 'notes/a.md'), 'utf8')).toContain('hello');
  });

  it('read-back returns raw front-matter + version; replace round-trip works; stale version conflicts', async () => {
    await call('rag_write_document', { source: 'Nationex', path: 'n.md', content: 'v1' });
    const read = await call('rag_read_note', { source: 'Nationex', path: 'n.md' });
    expect(read.body.content).toBe('v1');
    const w = await call('rag_write_document', {
      source: 'Nationex',
      path: 'n.md',
      content: 'v2',
      expectedVersion: read.body.version,
    });
    expect(w.body).toMatchObject({ saved: true, operation: 'replaced' });
    const stale = await call('rag_write_document', {
      source: 'Nationex',
      path: 'n.md',
      content: 'v3',
      expectedVersion: read.body.version,
    });
    expect(stale.isError).toBe(true);
    expect(stale.body.code).toBe('version_conflict');
    expect(await readFile(join(root, 'n.md'), 'utf8')).toBe('v2');
  });

  it('create over existing file is refused', async () => {
    await writeFile(join(root, 'x.md'), 'old');
    const r = await call('rag_write_document', { source: 'Nationex', path: 'x.md', content: 'new' });
    expect(r.body.code).toBe('already_exists');
    expect(await readFile(join(root, 'x.md'), 'utf8')).toBe('old');
  });

  it('indexing status degrades honestly (already_running / throwing trigger)', async () => {
    trigger = { status: 'already_running' };
    const a = await call('rag_write_document', { source: 'Nationex', path: 'a.md', content: 'a' });
    expect(a.body.saved).toBe(true);
    expect(a.body.indexing.status).toBe('already_running');
    triggerSpy.mockImplementation(() => {
      throw new Error('boom');
    });
    const b = await call('rag_write_document', { source: 'Nationex', path: 'b.md', content: 'b' });
    expect(b.body.saved).toBe(true);
    expect(b.body.indexing.status).toBe('unavailable');
  });

  it('is fail-closed when authorization is revoked after registration', async () => {
    allowed = false;
    const w = await call('rag_write_document', { source: 'Nationex', path: 'z.md', content: 'z' });
    expect(w.isError).toBe(true);
    expect(w.body.code).toBe('not_permitted');
    const r = await call('rag_read_note', { source: 'Nationex', path: 'z.md' });
    expect(r.body.code).toBe('not_permitted');
    expect(await readdir(root)).toEqual(['notes']);
    expect(triggerSpy).not.toHaveBeenCalled();
  });

  it('unknown source is refused', async () => {
    const r = await call('rag_write_document', { source: 'Other', path: 'a.md', content: 'a' });
    expect(r.body.code).toBe('not_permitted');
  });

  it('enforces the authorized sub-folder', async () => {
    folder = 'notes';
    const ok = await call('rag_write_document', { source: 'Nationex', path: 'notes/ok.md', content: 'a' });
    expect(ok.body.saved).toBe(true);
    const bad = await call('rag_write_document', { source: 'Nationex', path: 'other.md', content: 'a' });
    expect(bad.body.code).toBe('outside_authorized_folder');
    const sibling = await call('rag_write_document', { source: 'Nationex', path: 'notes2/x.md', content: 'a' });
    expect(sibling.isError).toBe(true);
    expect((await readdir(root)).sort()).toEqual(['notes']);
  });

  it('traversal and bad extensions are refused through the tool', async () => {
    for (const p of ['../x.md', '/etc/x.md', 'a.sh', '.env.md']) {
      const r = await call('rag_write_document', { source: 'Nationex', path: p, content: 'x' });
      expect(r.isError).toBe(true);
    }
    expect(await readdir(base)).toEqual(['root']);
  });

  it('audits every call without content or absolute paths', async () => {
    await call('rag_write_document', { source: 'Nationex', path: 'a.md', content: 'SECRET-BODY' });
    await call('rag_write_document', { source: 'Nationex', path: '../b.md', content: 'SECRET-BODY' });
    allowed = false;
    await call('rag_write_document', { source: 'Nationex', path: 'c.md', content: 'SECRET-BODY' });
    expect(audits).toHaveLength(3);
    expect(audits.map((a) => a.result)).toEqual(['success', 'error', 'error']);
    const dump = JSON.stringify(audits);
    expect(dump).not.toContain('SECRET-BODY');
    expect(dump).not.toContain(root);
    expect(audits.every((a) => a.profileName === 'p' && a.toolName === 'rag_write_document')).toBe(true);
  });
});

describe('rag_read_note masking', () => {
  it('masks returned text but keeps the raw-file version', async () => {
    await writeFile(join(root, 'p.md'), 'mail a@b.com');
    handlers = {};
    registerDocumentWriteTools({
      server: {
        tool: (n: string, _d: string, _s: unknown, h: Handler) => {
          handlers[n] = h;
        },
      } as unknown as McpServer,
      profileName: 'p',
      sourceNames: ['Nationex'],
      resolveTarget: async () => ({ ok: true, sourceId: 's', sourceName: 'Nationex', rootPath: root }),
      triggerIndex: () => ({ status: 'unavailable' }),
      maskText: (t) => ({ text: t.replace('a@b.com', '[EMAIL]'), redacted: true }),
      onAuditLog: () => {},
    });
    const r = await call('rag_read_note', { source: 'Nationex', path: 'p.md' });
    expect(r.body.content).toBe('mail [EMAIL]');
    expect(r.body.piiMasked).toBe(true);
    expect(r.body.version).toBe(sha256Hex('mail a@b.com'));
  });
});
