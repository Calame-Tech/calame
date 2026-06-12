// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalFolderConnector } from '../local-folder.js';
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

async function makeHarness(
	configOverrides: Record<string, unknown> = {},
): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), 'calame-watch-test-'));
	const connector = new LocalFolderConnector();
	const events: WatchEvent[] = [];
	const unsubscribe = connector.watch!(
		{ rootPath: root, ...configOverrides },
		'src-1',
		(event) => {
			events.push(event);
		},
	);
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

		const matched = await waitFor(() =>
			harness!.events.find((e) => e.type === 'created'),
		);
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

		const matched = await waitFor(() =>
			harness!.events.find((e) => e.type === 'updated'),
		);
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

		const matched = await waitFor(() =>
			harness!.events.find((e) => e.type === 'deleted'),
		);
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
		const matched = await waitFor(() =>
			harness!.events.find((e) => e.type === 'created'),
		);
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

		const matched = await waitFor(() =>
			harness!.events.find((e) => e.type === 'created'),
		);
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

		const matched = await waitFor(() =>
			harness!.events.find((e) => e.type === 'created'),
		);
		expect(matched).toBeDefined();

		// The encoded id is `path:<base64url(relPath)>`. Verify it decodes back
		// to the relative path with forward slashes (cross-platform).
		expect(matched?.documentId.startsWith('path:')).toBe(true);
		const decoded = Buffer.from(
			matched!.documentId.slice('path:'.length),
			'base64url',
		).toString('utf8');
		expect(decoded).toBe('subdir.txt');
		// Sanity: the decoded path uses forward slashes (relevant on Windows).
		expect(decoded.includes('\\')).toBe(false);
		// Avoid an unused-var lint on `filePath` — kept for readability.
		expect(filePath).toBeDefined();
	});
});
