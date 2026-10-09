// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsWriteError, readTextFile, sha256Hex, writeTextFile } from '../fs-write.js';

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'fswrite-'));
  root = join(base, 'root');
  outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await mkdir(join(root, 'notes'));
});

afterEach(async () => {
  await rm(join(root, '..'), { recursive: true, force: true });
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FsWriteError) return e.code;
    throw e;
  }
  return 'ok';
}

describe('writeTextFile', () => {
  it('creates a new file and returns its version', async () => {
    const r = await writeTextFile({ rootPath: root, relPath: 'notes/a.md', content: '# hi\n' });
    expect(r).toMatchObject({ relPath: 'notes/a.md', created: true, bytes: 5 });
    expect(r.version).toBe(sha256Hex('# hi\n'));
    expect(await readFile(join(root, 'notes/a.md'), 'utf8')).toBe('# hi\n');
  });

  it('refuses create when the file exists (create-only)', async () => {
    await writeFile(join(root, 'a.md'), 'old');
    expect(await code(writeTextFile({ rootPath: root, relPath: 'a.md', content: 'new' }))).toBe(
      'already_exists',
    );
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('old');
  });

  it('replaces with the right expectedVersion', async () => {
    await writeFile(join(root, 'a.md'), 'old');
    const r = await writeTextFile({
      rootPath: root,
      relPath: 'a.md',
      content: 'new',
      expectedVersion: sha256Hex('old'),
    });
    expect(r.created).toBe(false);
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('new');
  });

  it('stale version → conflict, no mutation, no temp leftovers', async () => {
    await writeFile(join(root, 'a.md'), 'current');
    const c = await code(
      writeTextFile({
        rootPath: root,
        relPath: 'a.md',
        content: 'new',
        expectedVersion: sha256Hex('stale'),
      }),
    );
    expect(c).toBe('version_conflict');
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('current');
    expect(await readdir(root)).toEqual(['a.md', 'notes']);
  });

  it('replace of a missing file → not_found', async () => {
    expect(
      await code(
        writeTextFile({
          rootPath: root,
          relPath: 'x.md',
          content: 'a',
          expectedVersion: sha256Hex('a'),
        }),
      ),
    ).toBe('not_found');
  });

  it('serializes concurrent creates: exactly one wins', async () => {
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        code(writeTextFile({ rootPath: root, relPath: 'race.md', content: `v${i}` })),
      ),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'already_exists')).toHaveLength(4);
    expect(await readdir(root)).not.toContain(expect.stringMatching(/calame-tmp/));
  });

  it.each([
    ['../escape.md', 'invalid_path'],
    ['notes/../../escape.md', 'invalid_path'],
    ['/etc/passwd.md', 'invalid_path'],
    ['C:/x.md', 'invalid_path'],
    ['\\\\server\\share\\x.md', 'invalid_path'],
    ['notes\\a.md', 'invalid_path'],
    ['notes/%2e%2e/a.md', 'invalid_path'],
    ['notes/a%2fb.md', 'invalid_path'],
    ['notes//a.md', 'invalid_path'],
    ['notes/./a.md', 'invalid_path'],
    ['notes/a\u0000.md', 'invalid_path'],
    ['.env.md', 'forbidden_path'],
    ['notes/.hidden.md', 'forbidden_path'],
    ['credentials.md', 'forbidden_path'],
    ['secrets.txt', 'forbidden_path'],
    ['server.pem', 'forbidden_path'],
    ['a.exe', 'extension_not_allowed'],
    ['noext', 'extension_not_allowed'],
    ['a.md.sh', 'extension_not_allowed'],
  ])('rejects path %j → %s', async (relPath, expected) => {
    expect(await code(writeTextFile({ rootPath: root, relPath, content: 'x' }))).toBe(expected);
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(root)).toEqual(['notes']);
  });

  it('does not create missing parents', async () => {
    expect(await code(writeTextFile({ rootPath: root, relPath: 'new/dir/a.md', content: 'x' }))).toBe(
      'parent_missing',
    );
    expect(await readdir(root)).toEqual(['notes']);
  });

  it('refuses a symlinked parent directory', async () => {
    await symlink(outside, join(root, 'link'));
    expect(await code(writeTextFile({ rootPath: root, relPath: 'link/a.md', content: 'x' }))).toBe(
      'symlink_refused',
    );
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses a deeper symlinked parent', async () => {
    await symlink(outside, join(root, 'notes', 'deep'));
    expect(
      await code(writeTextFile({ rootPath: root, relPath: 'notes/deep/a.md', content: 'x' })),
    ).toBe('symlink_refused');
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses a symlinked target file (create and replace)', async () => {
    await writeFile(join(outside, 'victim.md'), 'victim');
    await symlink(join(outside, 'victim.md'), join(root, 'l.md'));
    expect(await code(writeTextFile({ rootPath: root, relPath: 'l.md', content: 'x' }))).toBe(
      'symlink_refused',
    );
    expect(
      await code(
        writeTextFile({
          rootPath: root,
          relPath: 'l.md',
          content: 'x',
          expectedVersion: sha256Hex('victim'),
        }),
      ),
    ).toBe('symlink_refused');
    expect(await readFile(join(outside, 'victim.md'), 'utf8')).toBe('victim');
  });

  it('refuses a dangling symlink target', async () => {
    await symlink(join(outside, 'nope.md'), join(root, 'd.md'));
    expect(await code(writeTextFile({ rootPath: root, relPath: 'd.md', content: 'x' }))).toBe(
      'symlink_refused',
    );
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses a symlinked source root', async () => {
    const linkRoot = join(root, '..', 'rootlink');
    await symlink(outside, linkRoot);
    expect(await code(writeTextFile({ rootPath: linkRoot, relPath: 'a.md', content: 'x' }))).toBe(
      'symlink_refused',
    );
    expect(await readdir(outside)).toEqual([]);
  });

  it('enforces size and content rules', async () => {
    expect(
      await code(writeTextFile({ rootPath: root, relPath: 'big.md', content: 'x'.repeat(101), maxBytes: 100 })),
    ).toBe('too_large');
    expect(await code(writeTextFile({ rootPath: root, relPath: 'nul.md', content: 'a\u0000b' }))).toBe(
      'invalid_content',
    );
    // multi-byte: 60 × 2 bytes = 120 > 100
    expect(
      await code(writeTextFile({ rootPath: root, relPath: 'mb.md', content: 'é'.repeat(60), maxBytes: 100 })),
    ).toBe('too_large');
    expect(await readdir(root)).toEqual(['notes']);
  });

  it('error messages never leak absolute paths', async () => {
    try {
      await writeTextFile({ rootPath: root, relPath: 'a/b.md', content: 'x' });
    } catch (e) {
      expect((e as Error).message).not.toContain(root);
    }
    try {
      await writeTextFile({ rootPath: join(root, 'nope'), relPath: 'b.md', content: 'x' });
    } catch (e) {
      expect((e as Error).message).not.toContain(root);
    }
  });

  it('keeps frontmatter verbatim', async () => {
    const md = '---\nstatus: open\nowner: tom\n---\n# Body\n';
    await writeTextFile({ rootPath: root, relPath: 'fm.md', content: md });
    const r = await readTextFile({ rootPath: root, relPath: 'fm.md' });
    expect(r.content).toBe(md);
    expect(r.version).toBe(sha256Hex(md));
  });
});

describe('readTextFile', () => {
  it('returns raw content + version; rejects missing, symlink, invalid utf8', async () => {
    await writeFile(join(root, 'a.md'), 'abc');
    expect((await readTextFile({ rootPath: root, relPath: 'a.md' })).version).toBe(sha256Hex('abc'));
    expect(await code(readTextFile({ rootPath: root, relPath: 'zz.md' }))).toBe('not_found');
    await writeFile(join(outside, 'o.md'), 'o');
    await symlink(join(outside, 'o.md'), join(root, 'l.md'));
    expect(await code(readTextFile({ rootPath: root, relPath: 'l.md' }))).toBe('symlink_refused');
    await writeFile(join(root, 'bad.md'), Buffer.from([0xff, 0xfe, 0xfd]));
    expect(await code(readTextFile({ rootPath: root, relPath: 'bad.md' }))).toBe('invalid_content');
  });
});
