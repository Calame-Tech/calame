// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Real-filesystem regressions for the parent/ancestor-swap race.
 *
 * The test build of the helper (dist/native/calame-fsat-hooks, built by
 * `pnpm --filter @calame-ee/rag-core build:test-helper`) pauses at named points
 * inside the operation. While it is paused the test performs a REAL rename +
 * symlink of the directory the writer is working in, then releases it. No fs
 * function is mocked in the hook tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  access,
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FsWriteError,
  __setFsatHelperPathForTests,
  readTextFile,
  sha256Hex,
  writeTextFile,
} from '../fs-write.js';

const HOOKS_BIN = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../dist/native/calame-fsat-hooks',
);
const isPosix = process.platform !== 'win32';

let base: string;
let root: string; // base/allowed
let outside: string; // base/outside
let hookDir: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'fsconf-'));
  root = join(base, 'allowed');
  outside = join(base, 'outside');
  hookDir = join(base, 'hooks');
  await mkdir(join(root, 'notes'), { recursive: true });
  await mkdir(outside);
  await mkdir(hookDir);
  process.env.CALAME_FSAT_HOOK_DIR = hookDir;
  __setFsatHelperPathForTests(HOOKS_BIN);
});

afterEach(async () => {
  delete process.env.CALAME_FSAT_HOOK_DIR;
  __setFsatHelperPathForTests(undefined);
  await rm(base, { recursive: true, force: true });
});

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

async function waitFor(cond: () => Promise<boolean>, what: string, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Starts `op`, waits until the helper is paused at `hook`, runs `swap` against
 * the real tree, releases the helper and returns the settled outcome.
 */
async function swapAt<T>(
  hook: string,
  op: () => Promise<T>,
  swap: () => Promise<void>,
): Promise<{ ok: true; value: T } | { ok: false; error: FsWriteError }> {
  let finished = false;
  await writeFile(join(hookDir, `${hook}.arm`), '');
  const p = op().then(
    (value) => ({ ok: true as const, value }),
    (error: FsWriteError) => ({ ok: false as const, error }),
  );
  void p.then(() => {
    finished = true;
  });
  await waitFor(
    async () => (await exists(join(hookDir, `${hook}.reached`))) || finished,
    `hook ${hook}`,
  );
  if (finished) {
    throw new Error(`operation finished without reaching hook "${hook}" (helper not in use?)`);
  }
  await swap();
  await writeFile(join(hookDir, `${hook}.go`), '');
  return p;
}

/** Replace `<root>/notes` by a symlink to `outside`, keeping the real dir elsewhere. */
async function swapNotesForSymlink(): Promise<void> {
  await rename(join(root, 'notes'), join(root, 'notes-original'));
  await symlink(outside, join(root, 'notes'), 'dir');
}

async function expectNothingOutside(): Promise<void> {
  expect(await readdir(outside)).toEqual([]);
}

/** Staging dir and temp file names inside `dir` while the helper is paused. */
async function stagingNames(dir: string): Promise<{ stage: string; tmp: string }> {
  const stage = (await readdir(dir)).find((n) => n.startsWith('.calame-stage-'));
  if (!stage) throw new Error('staging dir not found');
  const tmp = (await readdir(join(dir, stage))).find((n) => n.startsWith('.calame-tmp-'));
  if (!tmp) throw new Error('temp file not found');
  return { stage, tmp };
}

/**
 * Pauses at `first` to read the staging names (the temp file is still staged
 * there), then pauses at `second` and runs `act` with them.
 */
async function withStagingNames<T>(
  first: string,
  second: string,
  op: () => Promise<T>,
  act: (names: { stage: string; tmp: string }) => Promise<void>,
): Promise<{ ok: true; value: T } | { ok: false; error: FsWriteError }> {
  let finished = false;
  await writeFile(join(hookDir, `${first}.arm`), '');
  await writeFile(join(hookDir, `${second}.arm`), '');
  const p = op().then(
    (value) => ({ ok: true as const, value }),
    (error: FsWriteError) => ({ ok: false as const, error }),
  );
  void p.then(() => {
    finished = true;
  });
  await waitFor(
    async () => (await exists(join(hookDir, `${first}.reached`))) || finished,
    `hook ${first}`,
  );
  if (finished) throw new Error(`operation finished without reaching hook "${first}"`);
  const names = await stagingNames(join(root, 'notes'));
  await writeFile(join(hookDir, `${first}.go`), '');
  await waitFor(
    async () => (await exists(join(hookDir, `${second}.reached`))) || finished,
    `hook ${second}`,
  );
  if (finished) throw new Error(`operation finished without reaching hook "${second}"`);
  await act(names);
  await writeFile(join(hookDir, `${second}.go`), '');
  return p;
}

/** Moves the staging dir away and puts a symlink to `outside` under its name. */
async function swapStageForOutsideSymlink(stage: string, tmp: string): Promise<void> {
  await rename(join(root, 'notes', stage), join(root, 'notes', 'moved-stage'));
  await symlink(outside, join(root, 'notes', stage), 'dir');
  // A sentinel carrying the exact temp file name: a cleanup that resolves
  // "<stage>/<tmp>" by path would delete it.
  await writeFile(join(outside, tmp), 'SENTINEL');
}

describe.runIf(isPosix)('parent swap during write (real filesystem)', () => {
  it.each(['before_tmp', 'before_publish'])(
    'create: parent swapped to a symlink at %s never writes outside the root',
    async (hook) => {
      const r = await swapAt(
        hook,
        () => writeTextFile({ rootPath: root, relPath: 'notes/probe.md', content: 'PROBE\n' }),
        swapNotesForSymlink,
      );
      // Whatever the outcome, nothing may exist outside the root...
      await expectNothingOutside();
      // ...and the write, if it succeeded, landed in the directory that was validated.
      if (r.ok) {
        expect(await readFile(join(root, 'notes-original', 'probe.md'), 'utf8')).toBe('PROBE\n');
      }
      // Cleanup only touched the validated directory.
      expect(
        (await readdir(join(root, 'notes-original'))).filter((n) => n.includes('tmp')),
      ).toEqual([]);
    },
  );

  it.each(['before_tmp', 'before_publish'])(
    'replace: parent swapped to a symlink at %s never writes outside the root',
    async (hook) => {
      await writeFile(join(root, 'notes', 'a.md'), 'old');
      await writeFile(join(outside, 'a.md'), 'OUTSIDE UNTOUCHED');
      const r = await swapAt(
        hook,
        () =>
          writeTextFile({
            rootPath: root,
            relPath: 'notes/a.md',
            content: 'new',
            expectedVersion: sha256Hex('old'),
          }),
        swapNotesForSymlink,
      );
      expect(r.ok).toBe(true);
      expect(await readFile(join(outside, 'a.md'), 'utf8')).toBe('OUTSIDE UNTOUCHED');
      expect(await readdir(outside)).toEqual(['a.md']);
      expect(await readFile(join(root, 'notes-original', 'a.md'), 'utf8')).toBe('new');
      expect(
        (await readdir(join(root, 'notes-original'))).filter((n) => n.includes('tmp')),
      ).toEqual([]);
    },
  );

  it('parent swapped to a symlink after the root is open but before the walk: refused', async () => {
    const r = await swapAt(
      'walk_root',
      () => writeTextFile({ rootPath: root, relPath: 'notes/probe.md', content: 'PROBE\n' }),
      swapNotesForSymlink,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('symlink_refused');
    await expectNothingOutside();
    expect(await readdir(join(root, 'notes-original'))).toEqual([]);
  });

  it('ancestor swap: a deep parent chain renamed away and symlinked mid-walk stays confined', async () => {
    await mkdir(join(root, 'a', 'b'), { recursive: true });
    const r = await swapAt(
      'walk_0', // 'a' is open, 'b' not yet
      () => writeTextFile({ rootPath: root, relPath: 'a/b/probe.md', content: 'PROBE\n' }),
      async () => {
        await rename(join(root, 'a', 'b'), join(root, 'a', 'b-original'));
        await symlink(outside, join(root, 'a', 'b'), 'dir');
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('symlink_refused');
    await expectNothingOutside();
  });

  it('root swap: root replaced by a symlink after it was opened stays confined', async () => {
    const moved = join(base, 'allowed-moved');
    const r = await swapAt(
      'walk_root',
      () => writeTextFile({ rootPath: root, relPath: 'notes/probe.md', content: 'PROBE\n' }),
      async () => {
        await rename(root, moved);
        await symlink(outside, root, 'dir');
      },
    );
    expect(r.ok).toBe(true); // the opened root object is the one validated
    await expectNothingOutside();
    expect(await readFile(join(moved, 'notes', 'probe.md'), 'utf8')).toBe('PROBE\n');
  });

  it('target swapped for a symlink before publication: replace refuses, outside untouched', async () => {
    await writeFile(join(root, 'notes', 'a.md'), 'old');
    await writeFile(join(outside, 'victim.md'), 'VICTIM');
    const r = await swapAt(
      'before_publish',
      () =>
        writeTextFile({
          rootPath: root,
          relPath: 'notes/a.md',
          content: 'new',
          expectedVersion: sha256Hex('old'),
        }),
      async () => {
        await rm(join(root, 'notes', 'a.md'));
        await symlink(join(outside, 'victim.md'), join(root, 'notes', 'a.md'));
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('symlink_refused');
    expect(await readFile(join(outside, 'victim.md'), 'utf8')).toBe('VICTIM');
    // No temp file left behind inside the (validated) directory.
    expect((await readdir(join(root, 'notes'))).filter((n) => n.includes('tmp'))).toEqual([]);
  });

  it('CAS: file modified between check and publication → version_conflict, temp cleaned', async () => {
    await writeFile(join(root, 'notes', 'a.md'), 'old');
    const r = await swapAt(
      'before_publish',
      () =>
        writeTextFile({
          rootPath: root,
          relPath: 'notes/a.md',
          content: 'new',
          expectedVersion: sha256Hex('old'),
        }),
      async () => {
        await appendFile(join(root, 'notes', 'a.md'), '!');
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('version_conflict');
    expect(await readFile(join(root, 'notes', 'a.md'), 'utf8')).toBe('old!');
    expect(await readdir(join(root, 'notes'))).toEqual(['a.md']);
  });

  it('create-only: file appearing before publication → already_exists, writer data not clobbered', async () => {
    const r = await swapAt(
      'before_publish',
      () => writeTextFile({ rootPath: root, relPath: 'notes/c.md', content: 'mine' }),
      async () => {
        await writeFile(join(root, 'notes', 'c.md'), 'theirs');
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('already_exists');
    expect(await readFile(join(root, 'notes', 'c.md'), 'utf8')).toBe('theirs');
    expect(await readdir(join(root, 'notes'))).toEqual(['c.md']);
  });

  it('read: parent swapped to a symlink mid-read returns the validated file, not the outside one', async () => {
    await writeFile(join(root, 'notes', 'r.md'), 'INSIDE');
    await writeFile(join(outside, 'r.md'), 'OUTSIDE SECRET');
    const r = await swapAt(
      'before_target',
      () => readTextFile({ rootPath: root, relPath: 'notes/r.md' }),
      swapNotesForSymlink,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.content).toBe('INSIDE');
  });

  it('serializes in-process callers: a second write does not start until the first publishes', async () => {
    await writeFile(join(root, 'notes', 'a.md'), 'old');
    const expectedVersion = sha256Hex('old');
    await writeFile(join(hookDir, 'before_publish.arm'), '');
    const first = writeTextFile({
      rootPath: root,
      relPath: 'notes/a.md',
      content: 'first',
      expectedVersion,
    });
    await waitFor(() => exists(join(hookDir, 'before_publish.reached')), 'first at publish');
    const second = writeTextFile({
      rootPath: root,
      relPath: 'notes/a.md',
      content: 'second',
      expectedVersion,
    });
    await new Promise((r) => setTimeout(r, 150));
    // Only the first process has reached its publish point.
    const reached = (await readFile(join(hookDir, 'before_publish.reached'), 'utf8'))
      .split('\n')
      .filter(Boolean);
    expect(reached).toHaveLength(1);
    await writeFile(join(hookDir, 'before_publish.go'), '');
    const results = await Promise.allSettled([first, second]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'version_conflict' } });
    expect(await readFile(join(root, 'notes', 'a.md'), 'utf8')).toBe('first');
  });
});

describe.runIf(isPosix)('staging tampering (real filesystem)', () => {
  it('create: staging dir swapped to an outside symlink before cleanup deletes nothing outside', async () => {
    let tmpName = '';
    const r = await withStagingNames(
      'before_publish',
      'before_cleanup',
      () => writeTextFile({ rootPath: root, relPath: 'notes/probe.md', content: 'PROBE\n' }),
      async ({ stage, tmp }) => {
        tmpName = tmp;
        await swapStageForOutsideSymlink(stage, tmp);
      },
    );
    expect(r.ok).toBe(true);
    expect(await readFile(join(outside, tmpName), 'utf8')).toBe('SENTINEL');
    expect(await readdir(outside)).toEqual([tmpName]);
    expect(await readFile(join(root, 'notes', 'probe.md'), 'utf8')).toBe('PROBE\n');
  });

  it('replace: staging dir swapped to an outside symlink before cleanup deletes nothing outside', async () => {
    await writeFile(join(root, 'notes', 'a.md'), 'old');
    let tmpName = '';
    const r = await withStagingNames(
      'before_publish',
      'before_cleanup',
      () =>
        writeTextFile({
          rootPath: root,
          relPath: 'notes/a.md',
          content: 'new',
          expectedVersion: sha256Hex('old'),
        }),
      async ({ stage, tmp }) => {
        tmpName = tmp;
        await swapStageForOutsideSymlink(stage, tmp);
      },
    );
    expect(r.ok).toBe(true);
    expect(await readFile(join(outside, tmpName), 'utf8')).toBe('SENTINEL');
    expect(await readdir(outside)).toEqual([tmpName]);
    expect(await readFile(join(root, 'notes', 'a.md'), 'utf8')).toBe('new');
    // The old file was removed through the held staging fd, in the real (moved) dir.
    expect(await readdir(join(root, 'notes', 'moved-stage'))).toEqual([]);
  });

  it('create: temp substituted by a symlink before the check → refused, nothing published', async () => {
    await writeFile(join(outside, 'victim.md'), 'VICTIM');
    const r = await swapAt(
      'before_publish',
      () => writeTextFile({ rootPath: root, relPath: 'notes/probe.md', content: 'PROBE\n' }),
      async () => {
        const { stage, tmp } = await stagingNames(join(root, 'notes'));
        await rm(join(root, 'notes', stage, tmp));
        await symlink(join(outside, 'victim.md'), join(root, 'notes', stage, tmp));
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('io_error');
    expect(await exists(join(root, 'notes', 'probe.md'))).toBe(false);
    expect(await readFile(join(outside, 'victim.md'), 'utf8')).toBe('VICTIM');
  });

  it('create: temp substituted after the check → published_unverified, not a plain refusal', async () => {
    await writeFile(join(outside, 'victim.md'), 'VICTIM');
    const r = await swapAt(
      'before_rename',
      () => writeTextFile({ rootPath: root, relPath: 'notes/probe.md', content: 'PROBE\n' }),
      async () => {
        const { stage, tmp } = await stagingNames(join(root, 'notes'));
        await rm(join(root, 'notes', stage, tmp));
        await symlink(join(outside, 'victim.md'), join(root, 'notes', stage, tmp));
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('published_unverified');
    // Truthful: the substituted entry WAS published under the target name...
    expect((await lstat(join(root, 'notes', 'probe.md'))).isSymbolicLink()).toBe(true);
    // ...and nothing was written through it.
    expect(await readFile(join(outside, 'victim.md'), 'utf8')).toBe('VICTIM');
  });

  it('replace: old entry replaced after the check → published_unverified, displaced file kept', async () => {
    await writeFile(join(root, 'notes', 'a.md'), 'old');
    let names = { stage: '', tmp: '' };
    const r = await swapAt(
      'before_rename',
      () =>
        writeTextFile({
          rootPath: root,
          relPath: 'notes/a.md',
          content: 'new',
          expectedVersion: sha256Hex('old'),
        }),
      async () => {
        names = await stagingNames(join(root, 'notes'));
        // New inode guaranteed: created while the old one still exists.
        await writeFile(join(root, 'notes', 'other.md'), 'THEIRS');
        await rename(join(root, 'notes', 'other.md'), join(root, 'notes', 'a.md'));
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('published_unverified');
    expect(await readFile(join(root, 'notes', 'a.md'), 'utf8')).toBe('new');
    // The foreign entry swapped out is never deleted.
    expect(await readFile(join(root, 'notes', names.stage, names.tmp), 'utf8')).toBe('THEIRS');
  });
});

describe('fail-closed and normal paths', () => {
  it('uses the path-based mode on Windows (no helper needed)', async () => {
    const desc = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    __setFsatHelperPathForTests(join(base, 'does-not-exist'));
    try {
      const c = await writeTextFile({ rootPath: root, relPath: 'notes/w.md', content: 'x' });
      expect(c).toMatchObject({ created: true, bytes: 1 });
      const rd = await readTextFile({ rootPath: root, relPath: 'notes/w.md' });
      await writeTextFile({
        rootPath: root,
        relPath: 'notes/w.md',
        content: 'y',
        expectedVersion: rd.version,
      });
    } finally {
      Object.defineProperty(process, 'platform', desc);
      __setFsatHelperPathForTests(undefined);
    }
    expect(await readFile(join(root, 'notes', 'w.md'), 'utf8')).toBe('y');
    expect(await readdir(join(root, 'notes'))).toEqual(['w.md']);
  });

  it('fails closed on macOS/Linux (no path-based fallback) when the helper is missing', async () => {
    __setFsatHelperPathForTests(join(base, 'does-not-exist'));
    await expect(
      writeTextFile({ rootPath: root, relPath: 'notes/w.md', content: 'x' }),
    ).rejects.toMatchObject({ code: 'unsupported_platform' });
    expect(await readdir(join(root, 'notes'))).toEqual([]);
  });

  it.runIf(isPosix)(
    'create, read and replace work with the shipped (hook-free) helper',
    async () => {
      __setFsatHelperPathForTests(undefined);
      delete process.env.CALAME_FSAT_HOOK_DIR;
      const c = await writeTextFile({ rootPath: root, relPath: 'notes/n.md', content: 'héllo\n' });
      expect(c).toMatchObject({ created: true, bytes: 7 });
      const rd = await readTextFile({ rootPath: root, relPath: 'notes/n.md' });
      expect(rd).toMatchObject({ content: 'héllo\n', version: sha256Hex('héllo\n') });
      const u = await writeTextFile({
        rootPath: root,
        relPath: 'notes/n.md',
        content: 'v2',
        expectedVersion: rd.version,
      });
      expect(u.created).toBe(false);
      expect(await readFile(join(root, 'notes', 'n.md'), 'utf8')).toBe('v2');
      expect(await readdir(join(root, 'notes'))).toEqual(['n.md']);
    },
  );

  it.runIf(isPosix)('replace keeps the existing file mode', async () => {
    __setFsatHelperPathForTests(undefined);
    await writeFile(join(root, 'notes', 'm.md'), 'old', { mode: 0o600 });
    await writeTextFile({
      rootPath: root,
      relPath: 'notes/m.md',
      content: 'new',
      expectedVersion: sha256Hex('old'),
    });
    const { mode } = await (await import('node:fs/promises')).stat(join(root, 'notes', 'm.md'));
    expect(mode & 0o777).toBe(0o600);
  });
});
