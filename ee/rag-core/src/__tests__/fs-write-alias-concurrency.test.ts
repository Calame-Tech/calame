import { afterEach, beforeEach, expect, it } from 'vitest';
import { access, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { __setFsatHelperPathForTests, sha256Hex, writeTextFile } from '../fs-write.js';

// The final publication (renameat) now happens inside the calame-fsat helper,
// so the pause point is the helper's test-only `before_publish` hook (built by
// `build:test-helper`), not a mock of node:fs/promises.rename.
const HOOKS_BIN = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../dist/native/calame-fsat-hooks',
);

let dir: string;
let hookDir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'calame-alias-'));
  hookDir = await mkdtemp(path.join(tmpdir(), 'calame-alias-hooks-'));
  process.env.CALAME_FSAT_HOOK_DIR = hookDir;
  __setFsatHelperPathForTests(HOOKS_BIN);
});
afterEach(async () => {
  delete process.env.CALAME_FSAT_HOOK_DIR;
  __setFsatHelperPathForTests(undefined);
  await rm(dir, { recursive: true, force: true });
  await rm(hookDir, { recursive: true, force: true });
});

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

it.runIf(process.platform !== 'win32')(
  'serializes case aliases through final rename on a case-insensitive volume',
  async (context) => {
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
    await writeFile(path.join(hookDir, 'before_publish.arm'), '');
    const expectedVersion = sha256Hex('original');
    const first = writeTextFile({
      rootPath: dir,
      relPath: 'Note.md',
      content: 'first',
      expectedVersion,
    });
    const t0 = Date.now();
    while (!(await exists(path.join(hookDir, 'before_publish.reached')))) {
      if (Date.now() - t0 > 4000) throw new Error('first write never reached publication');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const second = writeTextFile({
      rootPath: dir,
      relPath: 'note.md',
      content: 'second',
      expectedVersion,
    });
    // A second helper reaching its publish point while the first is paused
    // proves both CAS checks accepted the same old bytes.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const reached = (await readFile(path.join(hookDir, 'before_publish.reached'), 'utf8'))
      .split('\n')
      .filter(Boolean);
    await writeFile(path.join(hookDir, 'before_publish.go'), '');
    const results = await Promise.allSettled([first, second]);
    expect(reached).toHaveLength(1);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'version_conflict' } });
    expect(await readFile(path.join(dir, 'Note.md'), 'utf8')).toBe('first');
  },
);
