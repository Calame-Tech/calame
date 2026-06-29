// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';

import { WatchManager, type WatchAuditEntry, type WatchableConnector } from '../watch-manager.js';
import { runRagMigrations } from '../../storage/schema.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function makeDb(): BetterSqlite3Database {
  const db = new Database(':memory:');
  runRagMigrations({ raw: db });
  return db;
}

interface InsertSourceOpts {
  id: string;
  type?: string;
  configJson?: string;
}

function insertSource(db: BetterSqlite3Database, opts: InsertSourceOpts): void {
  db.prepare(
    `INSERT INTO rag_sources
		 (id, name, type, config_encrypted, embedding_setting_name, embedding_model_version,
		  embedding_dimensions, polling_interval_seconds, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'test-embedding', 'mock-1', 16, NULL, ?, ?)`,
  ).run(
    opts.id,
    `source-${opts.id}`,
    opts.type ?? 'local',
    opts.configJson ?? JSON.stringify({ rootPath: '/tmp/x' }),
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
  );
}

/**
 * Build a fake `WatchableConnector` whose `watch` method captures the
 * `onChange` callback so the test can drive synthetic events into it via
 * `emit()`. Mimics the behavior of `LocalFolderConnector.watch` without
 * touching the filesystem.
 */
interface FakeConnector extends WatchableConnector {
  emit(sourceId: string, type: 'created' | 'updated' | 'deleted', documentId: string): void;
  closes: number;
  registrations: string[];
}

function makeFakeConnector(): FakeConnector {
  const handlers = new Map<
    string,
    (event: { type: 'created' | 'updated' | 'deleted'; documentId: string }) => void
  >();
  let closes = 0;
  const registrations: string[] = [];
  const conn: FakeConnector = {
    type: 'local',
    closes: 0,
    registrations,
    watch(_config, sourceId, onChange) {
      handlers.set(sourceId, onChange);
      registrations.push(sourceId);
      return () => {
        handlers.delete(sourceId);
        closes++;
        conn.closes = closes;
      };
    },
    emit(sourceId, type, documentId) {
      const handler = handlers.get(sourceId);
      if (!handler) {
        throw new Error(`no handler registered for ${sourceId}`);
      }
      handler({ type, documentId });
    },
  };
  return conn;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WatchManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() with zero local sources registers no watcher', () => {
    const db = makeDb();
    // Insert a non-local source — it must NOT be watched.
    insertSource(db, { id: 's1', type: 's3' });

    const connector = makeFakeConnector();
    const triggerSync = vi.fn(() => 'job-1');
    const manager = new WatchManager({
      db,
      resolveConnector: () => connector,
      decryptConfig: (s) => s,
      triggerSync,
    });

    manager.start();
    expect(manager.active()).toEqual([]);
    expect(connector.registrations).toEqual([]);

    manager.stop();
  });

  it('start() registers a watcher for every local source', () => {
    const db = makeDb();
    insertSource(db, { id: 's1', type: 'local' });
    insertSource(db, { id: 's2', type: 'local' });
    // Non-local must be skipped.
    insertSource(db, { id: 's3', type: 's3' });

    const connector = makeFakeConnector();
    const manager = new WatchManager({
      db,
      resolveConnector: () => connector,
      decryptConfig: (s) => s,
      triggerSync: () => 'job-x',
    });
    manager.start();

    expect(new Set(manager.active())).toEqual(new Set(['s1', 's2']));
    // Each local source registered exactly once.
    expect(connector.registrations.sort()).toEqual(['s1', 's2']);

    manager.stop();
  });

  it('upsert() + single event triggers sync after debounceMs', () => {
    const db = makeDb();
    const connector = makeFakeConnector();
    const triggerSync = vi.fn(() => 'job-1');
    const audits: WatchAuditEntry[] = [];
    const manager = new WatchManager({
      db,
      resolveConnector: () => connector,
      decryptConfig: (s) => s,
      triggerSync,
      debounceMs: 5000,
      onAudit: (e) => audits.push(e),
    });

    manager.upsert({
      id: 's1',
      type: 'local',
      configEncrypted: JSON.stringify({ rootPath: '/tmp/x' }),
    });
    expect(manager.active()).toEqual(['s1']);

    connector.emit('s1', 'created', 'doc-1');
    // Sync MUST NOT fire synchronously — debounce window first.
    expect(triggerSync).not.toHaveBeenCalled();

    // 4_999ms: still inside window.
    vi.advanceTimersByTime(4_999);
    expect(triggerSync).not.toHaveBeenCalled();

    // Cross 5_000ms boundary → exactly one sync fires.
    vi.advanceTimersByTime(1);
    expect(triggerSync).toHaveBeenCalledTimes(1);
    expect(triggerSync).toHaveBeenCalledWith('s1');
    expect(audits.find((a) => a.type === 'rag.sync.watch.triggered')).toMatchObject({
      payload: { sourceId: 's1', jobId: 'job-1' },
    });

    manager.stop();
  });

  it('5 events in rapid succession coalesce into a single sync trigger', () => {
    const db = makeDb();
    const connector = makeFakeConnector();
    const triggerSync = vi.fn(() => 'job-1');
    const manager = new WatchManager({
      db,
      resolveConnector: () => connector,
      decryptConfig: (s) => s,
      triggerSync,
      debounceMs: 5000,
    });

    manager.upsert({
      id: 's1',
      type: 'local',
      configEncrypted: JSON.stringify({ rootPath: '/tmp/x' }),
    });

    // Fire 5 events spaced 1s apart. Each one resets the debounce window.
    for (let i = 0; i < 5; i++) {
      connector.emit('s1', 'updated', `doc-${i}`);
      vi.advanceTimersByTime(1_000);
    }
    // 5s elapsed across 5 events. The last reset was at t=4s, so the timer
    // won't fire until t=4+5=9s. At t=5s → no call yet.
    expect(triggerSync).not.toHaveBeenCalled();

    // Advance another 4s (total 9s). Last event was at t=4s → debounce fires
    // at t=9s.
    vi.advanceTimersByTime(4_000);
    expect(triggerSync).toHaveBeenCalledTimes(1);

    // No further calls even after a long quiet period.
    vi.advanceTimersByTime(60_000);
    expect(triggerSync).toHaveBeenCalledTimes(1);

    manager.stop();
  });

  it('triggerSync returning null emits watch.skipped audit', () => {
    const db = makeDb();
    const connector = makeFakeConnector();
    const triggerSync = vi.fn(() => null as string | null);
    const audits: WatchAuditEntry[] = [];
    const manager = new WatchManager({
      db,
      resolveConnector: () => connector,
      decryptConfig: (s) => s,
      triggerSync,
      debounceMs: 5000,
      onAudit: (e) => audits.push(e),
    });

    manager.upsert({
      id: 's1',
      type: 'local',
      configEncrypted: JSON.stringify({ rootPath: '/tmp/x' }),
    });
    connector.emit('s1', 'created', 'doc-1');
    vi.advanceTimersByTime(5_000);

    expect(triggerSync).toHaveBeenCalledTimes(1);
    expect(audits.find((a) => a.type === 'rag.sync.watch.skipped')).toMatchObject({
      payload: { sourceId: 's1', reason: 'sync-already-active' },
    });
    expect(audits.find((a) => a.type === 'rag.sync.watch.triggered')).toBeUndefined();

    manager.stop();
  });

  it('remove() cancels the pending debounce timer — no sync triggers', () => {
    const db = makeDb();
    const connector = makeFakeConnector();
    const triggerSync = vi.fn(() => 'job-1');
    const manager = new WatchManager({
      db,
      resolveConnector: () => connector,
      decryptConfig: (s) => s,
      triggerSync,
      debounceMs: 5000,
    });

    manager.upsert({
      id: 's1',
      type: 'local',
      configEncrypted: JSON.stringify({ rootPath: '/tmp/x' }),
    });
    connector.emit('s1', 'created', 'doc-1');
    // Mid-window: still pending.
    vi.advanceTimersByTime(2_000);

    // Remove BEFORE the debounce fires.
    manager.remove('s1');
    expect(manager.active()).toEqual([]);
    // closer was called.
    expect(connector.closes).toBe(1);

    // Advance well past what would have been the firing time. No sync.
    vi.advanceTimersByTime(60_000);
    expect(triggerSync).not.toHaveBeenCalled();

    manager.stop();
  });

  it('upsert() replaces an existing watcher (closes old one)', () => {
    const db = makeDb();
    const connector = makeFakeConnector();
    const manager = new WatchManager({
      db,
      resolveConnector: () => connector,
      decryptConfig: (s) => s,
      triggerSync: () => 'job-1',
    });

    manager.upsert({
      id: 's1',
      type: 'local',
      configEncrypted: JSON.stringify({ rootPath: '/tmp/a' }),
    });
    expect(connector.closes).toBe(0);

    // Re-upsert — old watcher must be closed.
    manager.upsert({
      id: 's1',
      type: 'local',
      configEncrypted: JSON.stringify({ rootPath: '/tmp/b' }),
    });
    expect(connector.closes).toBe(1);
    expect(manager.active()).toEqual(['s1']);

    manager.stop();
  });

  it('upsert() with non-local type removes any existing watcher and no-ops', () => {
    const db = makeDb();
    const connector = makeFakeConnector();
    const audits: WatchAuditEntry[] = [];
    const manager = new WatchManager({
      db,
      resolveConnector: () => connector,
      decryptConfig: (s) => s,
      triggerSync: () => 'job-1',
      onAudit: (e) => audits.push(e),
    });

    // First register as local …
    manager.upsert({
      id: 's1',
      type: 'local',
      configEncrypted: JSON.stringify({ rootPath: '/tmp/a' }),
    });
    expect(manager.active()).toEqual(['s1']);

    // … then PATCH to a non-local type. Watcher must be torn down.
    audits.length = 0;
    manager.upsert({
      id: 's1',
      type: 's3',
      configEncrypted: JSON.stringify({}),
    });
    expect(manager.active()).toEqual([]);
    expect(connector.closes).toBe(1);
    // No "unsupported" audit — we silently no-op for non-local types.
    expect(audits.find((a) => a.type === 'rag.watch.upsert.unsupported')).toBeUndefined();

    manager.stop();
  });

  it('upsert() with malformed config emits failed audit and does not register', () => {
    const db = makeDb();
    const connector = makeFakeConnector();
    const audits: WatchAuditEntry[] = [];
    const manager = new WatchManager({
      db,
      resolveConnector: () => connector,
      decryptConfig: (s) => s,
      triggerSync: () => 'job-1',
      onAudit: (e) => audits.push(e),
    });

    manager.upsert({
      id: 's1',
      type: 'local',
      configEncrypted: 'not-json',
    });

    expect(manager.active()).toEqual([]);
    expect(audits.find((a) => a.type === 'rag.watch.upsert.failed')).toBeDefined();

    manager.stop();
  });

  it('stop() closes every watcher and clears every pending debounce', () => {
    const db = makeDb();
    const connector = makeFakeConnector();
    const triggerSync = vi.fn(() => 'job-1');
    const manager = new WatchManager({
      db,
      resolveConnector: () => connector,
      decryptConfig: (s) => s,
      triggerSync,
    });

    manager.upsert({
      id: 's1',
      type: 'local',
      configEncrypted: JSON.stringify({ rootPath: '/tmp/a' }),
    });
    manager.upsert({
      id: 's2',
      type: 'local',
      configEncrypted: JSON.stringify({ rootPath: '/tmp/b' }),
    });
    // Schedule pending flushes for both.
    connector.emit('s1', 'created', 'd1');
    connector.emit('s2', 'created', 'd2');

    manager.stop();
    expect(manager.active()).toEqual([]);
    expect(connector.closes).toBe(2);

    // Pending debounces must have been cleared — even after a long advance,
    // triggerSync is never called.
    vi.advanceTimersByTime(60_000);
    expect(triggerSync).not.toHaveBeenCalled();

    // Idempotent — stop() again must not throw.
    expect(() => manager.stop()).not.toThrow();
  });

  it('start() is tolerant when rag_sources table is missing', () => {
    // Simulate a pre-Phase-1 DB.
    const db = new Database(':memory:');
    const connector = makeFakeConnector();
    const audits: WatchAuditEntry[] = [];
    const manager = new WatchManager({
      db,
      resolveConnector: () => connector,
      decryptConfig: (s) => s,
      triggerSync: () => 'job-1',
      onAudit: (e) => audits.push(e),
    });

    expect(() => manager.start()).not.toThrow();
    expect(manager.active()).toEqual([]);
    expect(audits.find((a) => a.type === 'rag.watch.start.failed')).toBeDefined();

    manager.stop();
  });

  it('resolveConnector returning null emits unavailable audit', () => {
    const db = makeDb();
    const audits: WatchAuditEntry[] = [];
    const manager = new WatchManager({
      db,
      resolveConnector: () => null,
      decryptConfig: (s) => s,
      triggerSync: () => 'job-1',
      onAudit: (e) => audits.push(e),
    });

    manager.upsert({
      id: 's1',
      type: 'local',
      configEncrypted: JSON.stringify({ rootPath: '/tmp/a' }),
    });

    expect(manager.active()).toEqual([]);
    expect(audits.find((a) => a.type === 'rag.watch.upsert.unavailable')).toMatchObject({
      payload: { sourceId: 's1', type: 'local' },
    });

    manager.stop();
  });
});
