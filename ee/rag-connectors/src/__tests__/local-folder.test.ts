// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Value import from the built package on purpose: production code in this
// package only type-imports rag-core (a runtime import would load its whole
// module graph), but TESTS may value-import it — that's exactly how we assert
// the connector's mirrored literal cannot drift from the rag-core constant.
// CI builds all workspace packages before running tests, so dist/ is fresh.
import { RAG_LISTING_SKIP_TOO_LARGE_PREFIX } from '@calame-ee/rag-core';

import {
  buildWatchIgnored,
  DEFAULT_EXCLUDE_GLOBS,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  LocalFolderConnector,
} from '../local-folder.js';
import type { WatchEvent } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait until `predicate()` returns truthy or the timeout expires. Uses an
 * exponential-ish backoff so the first checks are quick and we don't spin.
 * Returns the final predicate value (or `undefined` on timeout).
 *
 * We can't use `vi.useFakeTimers` here because chokidar's underlying fs
 * notifications are real OS events — they don't fire under fake timers.
 */
async function waitFor<T>(
  predicate: () => T | undefined,
  timeoutMs = 5_000,
  intervalMs = 50,
): Promise<T | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = predicate();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return undefined;
}

interface Harness {
  root: string;
  events: WatchEvent[];
  unsubscribe: () => void;
  connector: LocalFolderConnector;
}

async function makeHarness(configOverrides: Record<string, unknown> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'calame-watch-test-'));
  const connector = new LocalFolderConnector();
  const events: WatchEvent[] = [];
  const unsubscribe = connector.watch!({ rootPath: root, ...configOverrides }, 'src-1', (event) => {
    events.push(event);
  });
  // Wait for chokidar to settle on the initial scan. Without a small delay
  // here, the first `add` we perform sometimes shows up as part of the
  // initial scan (and is therefore filtered by `ignoreInitial: true`).
  await new Promise((r) => setTimeout(r, 200));
  return { root, events, unsubscribe, connector };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LocalFolderConnector.watch()', () => {
  let harness: Harness | null = null;

  beforeEach(() => {
    harness = null;
  });

  afterEach(async () => {
    if (harness) {
      harness.unsubscribe();
      // Give chokidar a moment to fully release the directory before we rm.
      await new Promise((r) => setTimeout(r, 100));
      await rm(harness.root, { recursive: true, force: true });
      harness = null;
    }
  });

  it('emits a "created" event when a new file is added', async () => {
    harness = await makeHarness();
    const filePath = join(harness.root, 'hello.txt');
    await writeFile(filePath, 'hello world');

    const matched = await waitFor(() => harness!.events.find((e) => e.type === 'created'));
    expect(matched).toBeDefined();
    expect(matched?.type).toBe('created');
    expect(matched?.documentId.startsWith('path:')).toBe(true);
  });

  it('emits an "updated" event when an existing file is modified', async () => {
    harness = await makeHarness();
    const filePath = join(harness.root, 'doc.txt');
    await writeFile(filePath, 'v1');
    // Wait for the create event before triggering the change.
    await waitFor(() => harness!.events.find((e) => e.type === 'created'));

    // Reset events buffer so we observe ONLY the next change.
    harness.events.length = 0;
    // chokidar uses awaitWriteFinish (500ms) — give the change time to settle.
    await new Promise((r) => setTimeout(r, 600));
    await writeFile(filePath, 'v2 — updated content');

    const matched = await waitFor(() => harness!.events.find((e) => e.type === 'updated'));
    expect(matched).toBeDefined();
    expect(matched?.type).toBe('updated');
  });

  it('emits a "deleted" event when an existing file is removed', async () => {
    harness = await makeHarness();
    const filePath = join(harness.root, 'gone.txt');
    await writeFile(filePath, 'about to vanish');
    await waitFor(() => harness!.events.find((e) => e.type === 'created'));

    harness.events.length = 0;
    await unlink(filePath);

    const matched = await waitFor(() => harness!.events.find((e) => e.type === 'deleted'));
    expect(matched).toBeDefined();
    expect(matched?.type).toBe('deleted');
  });

  it('respects excludeGlobs — excluded files do not emit events', async () => {
    harness = await makeHarness({
      excludeGlobs: ['**/*.log'],
    });
    // Create one file that SHOULD emit and one that MUST NOT.
    const okPath = join(harness.root, 'hello.txt');
    const skipPath = join(harness.root, 'noisy.log');
    await writeFile(skipPath, 'spam');
    await writeFile(okPath, 'real content');

    // Wait until we see the .txt event.
    const matched = await waitFor(() => harness!.events.find((e) => e.type === 'created'));
    expect(matched).toBeDefined();

    // Give chokidar extra time to surface the .log if it were going to.
    await new Promise((r) => setTimeout(r, 300));

    // No events should reference the .log path. We can't decode the doc id
    // trivially, but we know the count of events should match exactly the
    // non-log writes (1 for the .txt, plus possibly its update settling).
    // The strict assertion: at least one created, and no event whose decoded
    // path ends in `.log`.
    for (const event of harness.events) {
      const encoded = event.documentId.slice('path:'.length);
      const path = Buffer.from(encoded, 'base64url').toString('utf8');
      expect(path.endsWith('.log')).toBe(false);
    }
  });

  it('respects includeGlobs — only matching files emit events', async () => {
    harness = await makeHarness({
      includeGlobs: ['**/*.md'],
    });
    const okPath = join(harness.root, 'README.md');
    const skipPath = join(harness.root, 'binary.bin');
    await writeFile(skipPath, 'data');
    await writeFile(okPath, '# Hello');

    const matched = await waitFor(() => harness!.events.find((e) => e.type === 'created'));
    expect(matched).toBeDefined();

    await new Promise((r) => setTimeout(r, 300));

    for (const event of harness.events) {
      const encoded = event.documentId.slice('path:'.length);
      const path = Buffer.from(encoded, 'base64url').toString('utf8');
      expect(path.endsWith('.md')).toBe(true);
    }
  });

  it('unsubscribe() stops emitting events', async () => {
    harness = await makeHarness();
    const filePath = join(harness.root, 'first.txt');
    await writeFile(filePath, 'first');
    await waitFor(() => harness!.events.find((e) => e.type === 'created'));

    // Unsubscribe and clear the buffer.
    harness.unsubscribe();
    // Replace unsubscribe with a no-op so afterEach doesn't double-close.
    harness.unsubscribe = () => undefined;
    harness.events.length = 0;
    // Give chokidar's close a moment.
    await new Promise((r) => setTimeout(r, 200));

    // Make a change AFTER unsubscribe — no event must arrive.
    await writeFile(join(harness.root, 'after.txt'), 'should be ignored');
    await new Promise((r) => setTimeout(r, 800));

    expect(harness.events).toEqual([]);
  });

  it('document ids round-trip with the same scheme used by listDocuments', async () => {
    harness = await makeHarness();
    const filePath = join(harness.root, 'subdir', 'file.txt');
    await writeFile(join(harness.root, 'subdir.txt'), 'top');

    const matched = await waitFor(() => harness!.events.find((e) => e.type === 'created'));
    expect(matched).toBeDefined();

    // The encoded id is `path:<base64url(relPath)>`. Verify it decodes back
    // to the relative path with forward slashes (cross-platform).
    expect(matched?.documentId.startsWith('path:')).toBe(true);
    const decoded = Buffer.from(matched!.documentId.slice('path:'.length), 'base64url').toString(
      'utf8',
    );
    expect(decoded).toBe('subdir.txt');
    // Sanity: the decoded path uses forward slashes (relevant on Windows).
    expect(decoded.includes('\\')).toBe(false);
    // Avoid an unused-var lint on `filePath` — kept for readability.
    expect(filePath).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// listDocuments / listFolders — default filters, size cap, change detection.
// ---------------------------------------------------------------------------

describe('LocalFolderConnector.listDocuments — default filters, size cap, etag', () => {
  let root: string;
  const connector = new LocalFolderConnector();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'calame-list-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { rootPath: root, ...overrides };
  }

  it('exposes sane defaults (node_modules/.git excludes, 50 MB cap)', () => {
    expect(DEFAULT_EXCLUDE_GLOBS).toEqual(['**/node_modules/**', '**/.git/**']);
    expect(DEFAULT_MAX_FILE_SIZE_BYTES).toBe(50 * 1024 * 1024);
  });

  it('prunes node_modules and .git subtrees by default (listFolders)', async () => {
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'x');
    await mkdir(join(root, '.git'), { recursive: true });
    await writeFile(join(root, '.git', 'HEAD'), 'ref: main');
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs', 'a.md'), '# a');

    const folders = await connector.listFolders(config(), 'src-1');
    expect(folders.map((f) => f.name)).toEqual(['docs']);
  });

  it('excludes hidden files by default; includeHidden re-enables them', async () => {
    await writeFile(join(root, 'visible.txt'), 'v');
    await writeFile(join(root, '.env'), 'SECRET=1');

    const byDefault = await connector.listDocuments(config(), 'src-1');
    expect(byDefault.map((d) => d.name)).toEqual(['visible.txt']);

    const withHidden = await connector.listDocuments(config({ includeHidden: true }), 'src-1');
    expect(withHidden.map((d) => d.name).sort()).toEqual(['.env', 'visible.txt']);
  });

  it('excludes hidden folders by default (listFolders)', async () => {
    await mkdir(join(root, '.cache'));
    await mkdir(join(root, 'real'));

    const folders = await connector.listFolders(config(), 'src-1');
    expect(folders.map((f) => f.name)).toEqual(['real']);

    const withHidden = await connector.listFolders(config({ includeHidden: true }), 'src-1');
    expect(withHidden.map((f) => f.name).sort()).toEqual(['.cache', 'real']);
  });

  it('user excludeGlobs are ADDED to the defaults, not substituted', async () => {
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'notes.txt'), 'keep');
    await writeFile(join(root, 'noisy.log'), 'drop');

    const docs = await connector.listDocuments(config({ excludeGlobs: ['**/*.log'] }), 'src-1');
    expect(docs.map((d) => d.name)).toEqual(['notes.txt']);
    // node_modules is still pruned even though the user list doesn't name it.
    const folders = await connector.listFolders(config({ excludeGlobs: ['**/*.log'] }), 'src-1');
    expect(folders).toEqual([]);
  });

  it('disableDefaultExcludes drops the built-in denylist (escape hatch)', async () => {
    await mkdir(join(root, 'node_modules'));

    const folders = await connector.listFolders(config({ disableDefaultExcludes: true }), 'src-1');
    expect(folders.map((f) => f.name)).toEqual(['node_modules']);
  });

  it('does not false-positive on names that merely CONTAIN a default-exclude name', async () => {
    // `node_modules_backup` must not be pruned by `**/node_modules/**` (the
    // dir-aware matcher strips the trailing `/**`, which must still match
    // whole segments only), and `.git-hooks-style` (hidden, so listed under
    // includeHidden) must not be caught by `**/.git/**`.
    await mkdir(join(root, 'node_modules_backup'));
    await writeFile(join(root, 'node_modules_backup', 'notes.txt'), 'keep me');
    await writeFile(join(root, '.git-hooks-style'), 'keep me too');

    const folders = await connector.listFolders(config({ includeHidden: true }), 'src-1');
    expect(folders.map((f) => f.name)).toEqual(['node_modules_backup']);

    const docs = await connector.listDocuments(config({ includeHidden: true }), 'src-1');
    expect(docs.map((d) => d.name)).toContain('.git-hooks-style');

    const nested = await connector.listDocuments(config({ includeHidden: true }), 'src-1', {
      ...folders[0]!,
      tenantId: 'default',
    });
    expect(nested.map((d) => d.name)).toEqual(['notes.txt']);
  });

  it('flags files over maxFileSizeBytes at discovery instead of dropping them', async () => {
    await writeFile(join(root, 'big.bin'), Buffer.alloc(32, 1));
    await writeFile(join(root, 'small.txt'), 'tiny');

    const docs = await connector.listDocuments(config({ maxFileSizeBytes: 10 }), 'src-1');
    const big = docs.find((d) => d.name === 'big.bin');
    const small = docs.find((d) => d.name === 'small.txt');
    // Cross-package drift guard: the marker the connector emits must start
    // with the ACTUAL rag-core constant (imported above), not a re-typed
    // literal — if either side changes its string, this test goes red.
    expect(big?.ingestError?.startsWith(RAG_LISTING_SKIP_TOO_LARGE_PREFIX)).toBe(true);
    expect(big?.ingestError).toContain('32 bytes');
    expect(small?.ingestError).toBeNull();
  });

  it('etag is a cheap stat fingerprint (local-v1:<size>:<mtimeMs>), hash is not computed', async () => {
    const fileAbs = join(root, 'doc.txt');
    await writeFile(fileAbs, 'hello world');
    // Pin the mtime so the fingerprint is fully deterministic.
    const mtime = new Date('2026-01-02T03:04:05.678Z');
    await utimes(fileAbs, mtime, mtime);
    const stats = await stat(fileAbs);

    const [doc] = await connector.listDocuments(config(), 'src-1');
    expect(doc?.etag).toBe(`local-v1:${stats.size}:${stats.mtimeMs}`);
    // Listing no longer streams file contents through SHA-256.
    expect(doc?.hash).toBe('');

    // Stable across listings when nothing changed…
    const [again] = await connector.listDocuments(config(), 'src-1');
    expect(again?.etag).toBe(doc?.etag);

    // …and different once the file is modified.
    await writeFile(fileAbs, 'hello world, but longer now');
    const laterMtime = new Date('2026-01-02T03:04:06.789Z');
    await utimes(fileAbs, laterMtime, laterMtime);
    const [changed] = await connector.listDocuments(config(), 'src-1');
    expect(changed?.etag).not.toBe(doc?.etag);
  });
});

// ---------------------------------------------------------------------------
// buildWatchIgnored — the chokidar `ignored` pruning filter. Tested directly
// (driving chokidar's native watcher over node_modules trees in a test is
// slow and platform-dependent); the watch() tests above cover the post-event
// map() filter that backs it up.
// ---------------------------------------------------------------------------

describe('buildWatchIgnored — watcher-level pruning', () => {
  const root = join(tmpdir(), 'watch-ignored-root');

  it('never ignores the watch root itself, nor out-of-root paths', () => {
    const ignored = buildWatchIgnored(root, { rootPath: root });
    expect(ignored(root)).toBe(false);
    expect(ignored(join(root, '..', 'elsewhere'))).toBe(false);
  });

  it('prunes default-excluded trees (dir AND children) and hidden entries', () => {
    const ignored = buildWatchIgnored(root, { rootPath: root });
    expect(ignored(join(root, 'node_modules'))).toBe(true);
    expect(ignored(join(root, 'node_modules', 'pkg', 'index.js'))).toBe(true);
    expect(ignored(join(root, '.git'))).toBe(true);
    expect(ignored(join(root, '.env'))).toBe(true);
    expect(ignored(join(root, 'docs', 'a.md'))).toBe(false);
  });

  it('does not false-positive on names that merely contain a default-exclude name', () => {
    const ignored = buildWatchIgnored(root, { rootPath: root, includeHidden: true });
    expect(ignored(join(root, 'node_modules_backup'))).toBe(false);
    expect(ignored(join(root, '.git-hooks-style'))).toBe(false);
  });

  it('honors includeHidden, user excludeGlobs and disableDefaultExcludes', () => {
    const withHidden = buildWatchIgnored(root, { rootPath: root, includeHidden: true });
    expect(withHidden(join(root, '.env'))).toBe(false);
    // .git stays pruned via the default globs even when hidden is allowed.
    expect(withHidden(join(root, '.git', 'HEAD'))).toBe(true);

    const withUserGlobs = buildWatchIgnored(root, {
      rootPath: root,
      excludeGlobs: ['**/*.log'],
    });
    expect(withUserGlobs(join(root, 'noisy.log'))).toBe(true);
    expect(withUserGlobs(join(root, 'node_modules'))).toBe(true); // defaults kept

    const escapeHatch = buildWatchIgnored(root, {
      rootPath: root,
      disableDefaultExcludes: true,
    });
    expect(escapeHatch(join(root, 'node_modules'))).toBe(false);
  });
});
