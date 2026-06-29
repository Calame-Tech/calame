// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';

import { PollScheduler, type PollAuditEntry } from '../poll-scheduler.js';
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
  pollingIntervalSeconds?: number | null;
}

function insertSource(db: BetterSqlite3Database, opts: InsertSourceOpts): void {
  db.prepare(
    `INSERT INTO rag_sources
		 (id, name, type, config_encrypted, embedding_setting_name, embedding_model_version,
		  embedding_dimensions, polling_interval_seconds, created_at, updated_at)
		 VALUES (?, ?, 'local', '{}', 'test-embedding', 'mock-1', 16, ?, ?, ?)`,
  ).run(
    opts.id,
    `source-${opts.id}`,
    opts.pollingIntervalSeconds ?? null,
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PollScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() with zero polled sources registers no timer', () => {
    const db = makeDb();
    // Source without polling — should NOT be scheduled.
    insertSource(db, { id: 's1', pollingIntervalSeconds: null });

    const triggerSync = vi.fn(() => 'job-1');
    const scheduler = new PollScheduler({ db, triggerSync });
    scheduler.start();

    expect(scheduler.active()).toEqual([]);
    // Advance well past any plausible interval — no timer should fire.
    vi.advanceTimersByTime(86_400_000);
    expect(triggerSync).not.toHaveBeenCalled();

    scheduler.stop();
  });

  it('start() registers a timer for every source with non-null polling', () => {
    const db = makeDb();
    insertSource(db, { id: 's1', pollingIntervalSeconds: 60 });
    insertSource(db, { id: 's2', pollingIntervalSeconds: 300 });
    // One non-polled source must be ignored.
    insertSource(db, { id: 's3', pollingIntervalSeconds: null });

    const triggerSync = vi.fn(() => 'job-x');
    const scheduler = new PollScheduler({ db, triggerSync });
    scheduler.start();

    expect(new Set(scheduler.active())).toEqual(new Set(['s1', 's2']));

    scheduler.stop();
  });

  it('upsert() schedules a tick that calls triggerSync after intervalSeconds', () => {
    const db = makeDb();
    const triggerSync = vi.fn(() => 'job-1');
    const audits: PollAuditEntry[] = [];
    const scheduler = new PollScheduler({
      db,
      triggerSync,
      onAudit: (e) => audits.push(e),
    });

    scheduler.upsert('s1', 60);
    expect(scheduler.active()).toEqual(['s1']);
    // First fire is N seconds AFTER registration — not immediate.
    expect(triggerSync).not.toHaveBeenCalled();

    // 59 seconds: not yet.
    vi.advanceTimersByTime(59_000);
    expect(triggerSync).not.toHaveBeenCalled();

    // Cross the 60s boundary → exactly one tick fires.
    vi.advanceTimersByTime(1_000);
    expect(triggerSync).toHaveBeenCalledTimes(1);
    expect(triggerSync).toHaveBeenCalledWith('s1');
    expect(audits.at(-1)).toMatchObject({
      type: 'rag.sync.poll.triggered',
      payload: { sourceId: 's1', jobId: 'job-1' },
    });

    // Another full interval → another tick. Confirms setInterval (not
    // setTimeout) is used.
    vi.advanceTimersByTime(60_000);
    expect(triggerSync).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it('upsert(id, null) removes an existing timer; no further ticks', () => {
    const db = makeDb();
    const triggerSync = vi.fn(() => 'job-1');
    const scheduler = new PollScheduler({ db, triggerSync });

    scheduler.upsert('s1', 60);
    expect(scheduler.active()).toEqual(['s1']);

    scheduler.upsert('s1', null);
    expect(scheduler.active()).toEqual([]);

    // Even after a long advance, no tick fires for s1.
    vi.advanceTimersByTime(3_600_000);
    expect(triggerSync).not.toHaveBeenCalled();

    scheduler.stop();
  });

  it('triggerSync returning null emits poll.skipped audit; timer keeps firing', () => {
    const db = makeDb();
    // Simulate "queue rejected because already running": triggerSync returns
    // null on the first tick, then succeeds on the second.
    const triggerSync = vi
      .fn<(sid: string) => string | null>()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce('job-2');
    const audits: PollAuditEntry[] = [];
    const scheduler = new PollScheduler({
      db,
      triggerSync,
      onAudit: (e) => audits.push(e),
    });

    scheduler.upsert('s1', 60);

    // First tick: skipped.
    vi.advanceTimersByTime(60_000);
    expect(triggerSync).toHaveBeenCalledTimes(1);
    expect(audits.at(-1)).toMatchObject({
      type: 'rag.sync.poll.skipped',
      payload: { sourceId: 's1', reason: 'sync-already-active' },
    });
    // Timer is still active.
    expect(scheduler.active()).toEqual(['s1']);

    // Second tick: succeeded.
    vi.advanceTimersByTime(60_000);
    expect(triggerSync).toHaveBeenCalledTimes(2);
    expect(audits.at(-1)).toMatchObject({
      type: 'rag.sync.poll.triggered',
      payload: { sourceId: 's1', jobId: 'job-2' },
    });

    scheduler.stop();
  });

  it('remove() evicts the timer; no tick fires afterwards', () => {
    const db = makeDb();
    const triggerSync = vi.fn(() => 'job-1');
    const scheduler = new PollScheduler({ db, triggerSync });

    scheduler.upsert('s1', 60);
    scheduler.remove('s1');
    expect(scheduler.active()).toEqual([]);

    vi.advanceTimersByTime(120_000);
    expect(triggerSync).not.toHaveBeenCalled();

    // remove() on an unknown source must be a no-op (idempotent).
    expect(() => scheduler.remove('does-not-exist')).not.toThrow();

    scheduler.stop();
  });

  it('upsert() replaces the existing timer rather than mutating it', () => {
    const db = makeDb();
    const triggerSync = vi.fn(() => 'job-1');
    const scheduler = new PollScheduler({ db, triggerSync });

    // Initial 60s interval.
    scheduler.upsert('s1', 60);
    // 30 seconds in, change to 120s. The new timer's first fire should be
    // 120s from THIS call, not 60s from the original registration.
    vi.advanceTimersByTime(30_000);
    scheduler.upsert('s1', 120);

    // 30s after the second upsert: still 90s elapsed, no tick (would have
    // fired at 60s under the original schedule, but we replaced the timer).
    vi.advanceTimersByTime(30_000);
    expect(triggerSync).not.toHaveBeenCalled();

    // 120s after the second upsert: first tick of the new schedule.
    vi.advanceTimersByTime(90_000);
    expect(triggerSync).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it('triggerSync throwing does not crash the scheduler; emits poll.failed audit', () => {
    const db = makeDb();
    const triggerSync = vi.fn(() => {
      throw new Error('boom');
    });
    const audits: PollAuditEntry[] = [];
    const scheduler = new PollScheduler({
      db,
      triggerSync,
      onAudit: (e) => audits.push(e),
    });

    scheduler.upsert('s1', 60);
    vi.advanceTimersByTime(60_000);

    expect(triggerSync).toHaveBeenCalledTimes(1);
    expect(audits.at(-1)).toMatchObject({
      type: 'rag.sync.poll.failed',
      payload: { sourceId: 's1', error: 'boom' },
    });

    // The timer is still alive — a future tick can still succeed.
    expect(scheduler.active()).toEqual(['s1']);

    scheduler.stop();
  });

  it('start() is a no-op when the polling_interval_seconds column is missing', () => {
    // Simulate a pre-v4 DB by dropping the column. (We re-create the table
    // without it, since SQLite has no DROP COLUMN before 3.35.)
    const db = new Database(':memory:');
    // Run baseline through v3 only — but we can't easily target that without
    // patching. Easier: drop the column manually after migrations.
    runRagMigrations({ raw: db });
    // Rebuild rag_sources without polling_interval_seconds.
    db.exec(`
			CREATE TABLE rag_sources_old AS SELECT id, name, type, config_encrypted,
				embedding_setting_name, embedding_model_version, embedding_dimensions,
				created_at, updated_at, last_sync_at FROM rag_sources;
			DROP TABLE rag_sources;
			ALTER TABLE rag_sources_old RENAME TO rag_sources;
		`);

    const triggerSync = vi.fn(() => 'job-1');
    const scheduler = new PollScheduler({ db, triggerSync });

    // Must not throw even though the column is missing.
    expect(() => scheduler.start()).not.toThrow();
    expect(scheduler.active()).toEqual([]);

    scheduler.stop();
  });

  it('stop() is idempotent and clears all timers', () => {
    const db = makeDb();
    const triggerSync = vi.fn(() => 'job-1');
    const scheduler = new PollScheduler({ db, triggerSync });

    scheduler.upsert('s1', 60);
    scheduler.upsert('s2', 120);
    expect(scheduler.active()).toHaveLength(2);

    scheduler.stop();
    expect(scheduler.active()).toEqual([]);

    // Calling again must not throw.
    expect(() => scheduler.stop()).not.toThrow();

    // After stop(), advancing time fires no ticks.
    vi.advanceTimersByTime(3_600_000);
    expect(triggerSync).not.toHaveBeenCalled();
  });
});
