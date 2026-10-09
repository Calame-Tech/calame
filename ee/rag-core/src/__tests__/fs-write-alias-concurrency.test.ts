import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const barrier = vi.hoisted(() => ({
  entered: 0,
  wait: undefined as Promise<void> | undefined,
  firstEntered: undefined as (() => void) | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      barrier.entered++;
      barrier.firstEntered?.();
      await barrier.wait;
      return fs.rename(...args);
    },
  };
});
import { sha256Hex, writeTextFile } from '../fs-write.js';

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  barrier.entered = 0;
  barrier.wait = undefined;
  barrier.firstEntered = undefined;
});

it('serializes case aliases through final rename on a case-insensitive volume', async (context) => {
  dir = await mkdtemp(path.join(tmpdir(), 'calame-alias-'));
  await writeFile(path.join(dir, 'Note.md'), 'original');
  // A skip on a case-sensitive runner is not evidence of alias safety.
  const original = await lstat(path.join(dir, 'Note.md'));
  let alias;
  try {
    alias = await lstat(path.join(dir, 'note.md'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    context.skip();
    return;
  }
  expect(alias.ino).toBe(original.ino);
  let release!: () => void;
  barrier.wait = new Promise<void>((resolve) => { release = resolve; });
  const firstEntered = new Promise<void>((resolve) => { barrier.firstEntered = resolve; });
  const expectedVersion = sha256Hex('original');
  const first = writeTextFile({ rootPath: dir, relPath: 'Note.md', content: 'first', expectedVersion });
  await firstEntered;
  const second = writeTextFile({ rootPath: dir, relPath: 'note.md', content: 'second', expectedVersion });
  // A second final rename while the first is paused proves both final CAS
  // checks accepted the same old bytes, independently of rename scheduling.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const enteredBeforeRelease = barrier.entered;
  release();
  const results = await Promise.allSettled([first, second]);
  expect(enteredBeforeRelease).toBe(1);
  expect(results[0].status).toBe('fulfilled');
  expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'version_conflict' } });
  expect(await readFile(path.join(dir, 'Note.md'), 'utf8')).toBe('first');
});
