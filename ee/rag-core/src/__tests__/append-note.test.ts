// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * rag_append_note: real filesystem through the production write path. The
 * concurrent-writer cases pause the hook-enabled helper (no fs mocking) and
 * write the file for real while it is paused. Only the bounded-retry and
 * published_unverified cases inject outcomes into writeTextFile, to count calls.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuditLogEntry } from '@calame/core';
import * as fsWrite from '../fs-write.js';
import {
  APPEND_MAX_ATTEMPTS,
  APPEND_MAX_BYTES,
  registerDocumentWriteTools,
} from '../write-tools.js';
import type { ResolvedWriteTarget, ResolveWriteTarget } from '../write-tools.js';
import { HOOKS_BIN, buildHooksHelper } from './fsat-hooks.js';

vi.mock('../fs-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fs-write.js')>();
  return { ...actual, writeTextFile: vi.fn(actual.writeTextFile) };
});

const { FsWriteError, sha256Hex, __setFsatHelperPathForTests } = fsWrite;
const writeSpy = vi.mocked(fsWrite.writeTextFile);
const { writeTextFile: actualWrite } =
  await vi.importActual<typeof import('../fs-write.js')>('../fs-write.js');
const isPosix = process.platform !== 'win32';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

let base: string;
let root: string;
let audits: AuditLogEntry[];
let handlers: Record<string, Handler>;
let descriptions: Record<string, string>;
let allowed: boolean;
let extra: Partial<ResolvedWriteTarget>;
let triggerSpy: ReturnType<typeof vi.fn>;

beforeAll(buildHooksHelper, 60_000);

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'append-'));
  root = join(base, 'root');
  await mkdir(join(root, 'notes'), { recursive: true });
  audits = [];
  allowed = true;
  extra = {};
  handlers = {};
  descriptions = {};
  const server = {
    tool: vi.fn((name: string, d: string, _s: unknown, h: Handler) => {
      handlers[name] = h;
      descriptions[name] = d;
    }),
  } as unknown as McpServer;
  const resolveTarget: ResolveWriteTarget = async (name) =>
    allowed && name === 'Nationex'
      ? { ok: true, sourceId: 'src-1', sourceName: 'Nationex', rootPath: root, ...extra }
      : { ok: false, reason: 'nope' };
  triggerSpy = vi.fn(() => ({ status: 'queued', jobId: 'j1' }));
  registerDocumentWriteTools({
    server,
    profileName: 'p',
    sourceNames: ['Nationex'],
    resolveTarget,
    triggerIndex: triggerSpy as never,
    onAuditLog: (e) => audits.push(e),
  });
});

afterEach(async () => {
  writeSpy.mockReset();
  writeSpy.mockImplementation(actualWrite);
  delete process.env.CALAME_FSAT_HOOK_DIR;
  __setFsatHelperPathForTests(undefined);
  await rm(base, { recursive: true, force: true });
});

const append = async (path: string, text: string, source = 'Nationex') => {
  const r = await handlers.rag_append_note!({ source, path, text });
  return {
    isError: r.isError === true,
    body: JSON.parse(r.content[0]!.text) as Record<string, unknown> & {
      code?: string;
      error?: string;
      version?: string;
    },
  };
};

const note = (p: string) => readFile(join(root, p), 'utf8');

describe('rag_append_note', () => {
  it('is described in English, steering "add" to append and full replacement to write', () => {
    const d = descriptions.rag_append_note!;
    expect(d).toMatch(/PREFER this tool to add a remark/);
    expect(d).toContain('use rag_write_document only to replace the WHOLE content');
    expect(d).toContain(`Max ${APPEND_MAX_BYTES} UTF-8 bytes`);
    expect(d).toMatch(/published_unverified.*re-read the file/);
  });

  it('creates an absent note, then appends exactly, without any expectedVersion', async () => {
    const c = await append('notes/j.md', '# Journal\n');
    expect(c.isError).toBe(false);
    expect(c.body).toMatchObject({
      saved: true,
      operation: 'created',
      path: 'notes/j.md',
      bytes: 10,
      appendedBytes: 10,
      indexing: { status: 'queued', indexed: false },
    });
    const a = await append('notes/j.md', '- été ✓ 🙂');
    expect(a.body).toMatchObject({ saved: true, operation: 'appended' });
    const expected = '# Journal\n- été ✓ 🙂';
    expect(await note('notes/j.md')).toBe(expected);
    expect(a.body.version).toBe(sha256Hex(expected));
    expect(a.body.bytes).toBe(Buffer.byteLength(expected));
    expect(triggerSpy).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(a.body)).not.toContain(root);
  });

  it('preserves the existing bytes exactly (BOM, CRLF, no trailing newline added)', async () => {
    const original = Buffer.from('\uFEFF---\r\ntitle: x\r\n---\r\nbody', 'utf8');
    await writeFile(join(root, 'bom.md'), original);
    await append('bom.md', 'tail');
    const now = await readFile(join(root, 'bom.md'));
    expect(now.equals(Buffer.concat([original, Buffer.from('tail')]))).toBe(true);
  });

  it('refuses a non-UTF-8 note without modifying it', async () => {
    const bad = Buffer.from([0x61, 0xff, 0x62]);
    await writeFile(join(root, 'bad.md'), bad);
    const r = await append('bad.md', 'x');
    expect(r.body.code).toBe('invalid_content');
    expect((await readFile(join(root, 'bad.md'))).equals(bad)).toBe(true);
  });

  it('serializes concurrent in-process appends: none lost, none duplicated', async () => {
    await writeFile(join(root, 'c.md'), 'start\n');
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}\n`);
    const results = await Promise.all(lines.map((l) => append('c.md', l)));
    expect(results.every((r) => r.body.saved === true)).toBe(true);
    const final = await note('c.md');
    expect(final.startsWith('start\n')).toBe(true);
    for (const l of lines) expect(final.split(l).length - 1).toBe(1);
    expect(final.length).toBe('start\n'.length + lines.join('').length);
  });

  it('concurrent creation of the same absent note keeps both texts once', async () => {
    const [a, b] = await Promise.all([append('new.md', 'A'), append('new.md', 'B')]);
    expect([a.body.operation, b.body.operation].sort()).toEqual(['appended', 'created']);
    expect(['AB', 'BA']).toContain(await note('new.md'));
  });

  it('accepts exactly the UTF-8 byte limit and refuses one byte more without mutation', async () => {
    extra = { maxBytes: 2 * APPEND_MAX_BYTES };
    await writeFile(join(root, 'big.md'), 'x');
    // 'é' is 2 UTF-8 bytes: the limit counts bytes, not characters.
    const ok = 'é'.repeat(APPEND_MAX_BYTES / 2);
    expect((await append('big.md', ok)).body.saved).toBe(true);
    const tooBig = 'é'.repeat(APPEND_MAX_BYTES / 2) + 'y';
    const r = await append('big.md', tooBig);
    expect(r.isError).toBe(true);
    expect(r.body.code).toBe('too_large');
    expect(r.body.error).toContain(`${APPEND_MAX_BYTES}-byte limit`);
    expect(await note('big.md')).toBe('x' + ok);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    // An oversized text never creates the note either.
    expect((await append('absent.md', tooBig)).body.code).toBe('too_large');
    await expect(access(join(root, 'absent.md'))).rejects.toThrow();
  });

  it('refuses an append that would push the file past the source limit, unchanged', async () => {
    extra = { maxBytes: 20 };
    await writeFile(join(root, 'f.md'), '0123456789');
    expect((await append('f.md', '0123456789')).body.saved).toBe(true);
    const r = await append('f.md', '!');
    expect(r.body.code).toBe('too_large');
    expect(r.body.error).toContain('nothing was appended');
    expect(await note('f.md')).toBe('01234567890123456789');
  });

  it('enforces the write perimeter: profile, folder, read scope, extensions, paths', async () => {
    await writeFile(join(root, 'top.md'), 'top');
    allowed = false;
    expect((await append('top.md', 'x')).body.code).toBe('not_permitted');
    allowed = true;
    expect((await append('top.md', 'x', 'Other')).body.code).toBe('not_permitted');
    extra = { folder: 'notes' };
    expect((await append('top.md', 'x')).body.code).toBe('outside_authorized_folder');
    extra = {
      readScopes: [
        {
          kind: 'document',
          mode: 'allowList',
          allowedFolders: ['elsewhere'],
          allowedDocuments: [],
        },
      ] as never,
    };
    expect((await append('top.md', 'x')).body.code).toBe('outside_authorized_folder');
    extra = {};
    expect((await append('a.pdf', 'x')).body.code).toBe('extension_not_allowed');
    expect((await append('a.json', 'x')).body.code).toBe('extension_not_allowed');
    expect((await append('../escape.md', 'x')).body.code).toBe('invalid_path');
    expect((await append('.env.md', 'x')).body.code).toBe('forbidden_path');
    expect((await append('missing/a.md', 'x')).body.code).toBe('parent_missing');
    expect(await note('top.md')).toBe('top');
    expect((await readdir(root)).sort()).toEqual(['notes', 'top.md']);
    expect(await readdir(base)).toEqual(['root']);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('never discloses a version in its refusals', async () => {
    await writeFile(join(root, 'top.md'), 'top');
    allowed = false;
    const r = await append('top.md', 'x');
    expect(r.body.version).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain(sha256Hex('top'));
  });

  it('audits metadata (attempts, sizes) but never the appended text', async () => {
    await append('notes/s.md', 'SECRET-TEXT');
    allowed = false;
    await append('notes/s.md', 'SECRET-TEXT');
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ toolName: 'rag_append_note', result: 'success' });
    expect(audits[0]!.toolArgs).toMatchObject({ op: 'append', attempts: 1, appendedBytes: 11 });
    expect(audits[1]).toMatchObject({ toolName: 'rag_append_note', result: 'error' });
    expect(JSON.stringify(audits)).not.toContain('SECRET-TEXT');
    expect(JSON.stringify(audits)).not.toContain(root);
  });
});

describe('rag_append_note internal retries', () => {
  it(`gives up after ${APPEND_MAX_ATTEMPTS} conflicting attempts, nothing appended`, async () => {
    await writeFile(join(root, 'r.md'), 'base');
    writeSpy.mockImplementation(async () => {
      throw new FsWriteError('version_conflict', 'conflict');
    });
    const r = await append('r.md', 'x');
    expect(writeSpy).toHaveBeenCalledTimes(APPEND_MAX_ATTEMPTS);
    expect(r.isError).toBe(true);
    expect(r.body.code).toBe('version_conflict');
    expect(r.body.error).toContain('nothing was appended');
    expect(await note('r.md')).toBe('base');
  });

  it('retries a refused attempt and succeeds on the next one', async () => {
    await writeFile(join(root, 'r.md'), 'base');
    writeSpy
      .mockImplementationOnce(async () => {
        throw new FsWriteError('already_exists', 'exists');
      })
      .mockImplementation(actualWrite);
    const r = await append('r.md', '+x');
    expect(r.body.saved).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(2);
    expect(await note('r.md')).toBe('base+x');
    expect(audits.at(-1)!.toolArgs).toMatchObject({ attempts: 2 });
  });

  it('never retries after published_unverified (no duplicate) and asks to re-read', async () => {
    await writeFile(join(root, 'u.md'), 'base');
    // Publish for real, then report the outcome as uncertain.
    writeSpy.mockImplementationOnce(async (input) => {
      await actualWrite(input);
      throw new FsWriteError(
        'published_unverified',
        'The write was probably published, but the result could not be verified. Re-read the file before retrying; do not repeat the write blindly.',
      );
    });
    const r = await append('u.md', '+once');
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(r.isError).toBe(true);
    expect(r.body.code).toBe('published_unverified');
    expect(r.body.error).toMatch(/probably published.*Re-read the file before retrying/);
    expect(await note('u.md')).toBe('base+once');
  });

  it('does not retry other errors (e.g. io_error)', async () => {
    await writeFile(join(root, 'e.md'), 'base');
    writeSpy.mockImplementationOnce(async () => {
      throw new FsWriteError('io_error', 'boom');
    });
    expect((await append('e.md', 'x')).body.code).toBe('io_error');
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!isPosix)('rag_append_note vs a real concurrent writer (helper paused)', () => {
  let hookDir: string;
  beforeEach(async () => {
    hookDir = join(base, 'hooks');
    await mkdir(hookDir);
    process.env.CALAME_FSAT_HOOK_DIR = hookDir;
    __setFsatHelperPathForTests(HOOKS_BIN);
  });

  async function pausedAt(hook: string): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const ok = await access(join(hookDir, `${hook}.reached`)).then(
        () => true,
        () => false,
      );
      if (ok) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`hook ${hook} not reached`);
  }

  it('an external append during the replace is kept, and ours is added once', async () => {
    await writeFile(join(root, 'notes/n.md'), 'base\n');
    await writeFile(join(hookDir, 'before_publish.arm'), '');
    const p = append('notes/n.md', 'ours\n');
    await pausedAt('before_publish');
    await appendFile(join(root, 'notes/n.md'), 'theirs\n');
    await writeFile(join(hookDir, 'before_publish.go'), '');
    const r = await p;
    expect(r.body).toMatchObject({ saved: true, operation: 'appended' });
    expect(await note('notes/n.md')).toBe('base\ntheirs\nours\n');
    expect(writeSpy).toHaveBeenCalledTimes(2); // first refused (version_conflict), then published
  });

  it('a concurrent creation by another writer is kept, and ours is appended once', async () => {
    await writeFile(join(hookDir, 'before_rename.arm'), '');
    const p = append('notes/new.md', 'ours');
    await pausedAt('before_rename');
    await writeFile(join(root, 'notes/new.md'), 'theirs-');
    await writeFile(join(hookDir, 'before_rename.go'), '');
    const r = await p;
    expect(r.body).toMatchObject({ saved: true, operation: 'appended' });
    expect(await note('notes/new.md')).toBe('theirs-ours');
    expect(writeSpy).toHaveBeenCalledTimes(2); // create refused (already_exists), then replace
    expect((await readdir(join(root, 'notes'))).sort()).toEqual(['new.md']);
  });
});
