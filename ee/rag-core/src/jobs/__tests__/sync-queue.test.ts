// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';

import { SyncQueue, recoverOrphanedJobs } from '../sync-queue.js';
import { runRagMigrations } from '../../storage/schema.js';

describe('SyncQueue', () => {
  it('enqueue + drain runs every job in FIFO order, one at a time', async () => {
    const order: string[] = [];
    // Track simultaneity: increment on entry, decrement on exit, the max
    // observed value MUST be 1 (concurrency = 1).
    let inflight = 0;
    let maxInflight = 0;

    const queue = new SyncQueue({
      runJob: async (sourceId, jobId) => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        order.push(`start:${sourceId}:${jobId}`);
        // Yield to allow any racing call a chance to interleave.
        await new Promise((r) => setImmediate(r));
        order.push(`end:${sourceId}:${jobId}`);
        inflight--;
      },
    });

    expect(queue.enqueue('s1', 'j1')).toBe(true);
    expect(queue.enqueue('s2', 'j2')).toBe(true);
    expect(queue.enqueue('s3', 'j3')).toBe(true);

    await queue.drain();

    expect(maxInflight).toBe(1);
    expect(order).toEqual([
      'start:s1:j1',
      'end:s1:j1',
      'start:s2:j2',
      'end:s2:j2',
      'start:s3:j3',
      'end:s3:j3',
    ]);
    expect(queue.size()).toBe(0);
    expect(queue.isRunning('s1')).toBe(false);
  });

  it('enqueue twice with the same sourceId: the second call returns false', async () => {
    const runJob = vi.fn(async () => {
      await new Promise((r) => setImmediate(r));
    });
    const queue = new SyncQueue({ runJob });

    expect(queue.enqueue('s1', 'j1')).toBe(true);
    // Second enqueue while the first is still in the queue (or running):
    // must return false without invoking runJob a second time.
    expect(queue.enqueue('s1', 'j2')).toBe(false);

    await queue.drain();
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(runJob).toHaveBeenCalledWith('s1', 'j1');

    // After drain, the queue is empty and the source is no longer running
    // so a fresh enqueue must succeed.
    expect(queue.enqueue('s1', 'j3')).toBe(true);
    await queue.drain();
    expect(runJob).toHaveBeenCalledTimes(2);
    expect(runJob).toHaveBeenLastCalledWith('s1', 'j3');
  });

  it('runJob throwing does not crash the worker; the next job still runs', async () => {
    const seen: string[] = [];
    const onError = vi.fn();
    const queue = new SyncQueue({
      runJob: async (sourceId, jobId) => {
        seen.push(`${sourceId}:${jobId}`);
        if (sourceId === 's-bad') {
          throw new Error('boom');
        }
      },
      onError,
    });

    queue.enqueue('s-bad', 'j1');
    queue.enqueue('s-good', 'j2');

    await queue.drain();

    expect(seen).toEqual(['s-bad:j1', 's-good:j2']);
    expect(onError).toHaveBeenCalledTimes(1);
    const [sid, jid, err] = onError.mock.calls[0]!;
    expect(sid).toBe('s-bad');
    expect(jid).toBe('j1');
    expect((err as Error).message).toBe('boom');
  });

  it('isRunning reflects the currently-executing source, then clears after the job finishes', async () => {
    let release: (() => void) | null = null;
    const queue = new SyncQueue({
      runJob: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });

    queue.enqueue('s1', 'j1');
    // Yield so the worker has a chance to start the job.
    await new Promise((r) => setImmediate(r));
    expect(queue.isRunning('s1')).toBe(true);

    // While running, a duplicate enqueue must be rejected.
    expect(queue.enqueue('s1', 'j2')).toBe(false);

    (release as unknown as () => void)();
    await queue.drain();
    expect(queue.isRunning('s1')).toBe(false);
  });
});

describe('recoverOrphanedJobs', () => {
  it('returns 0 when there are no pending or running jobs', () => {
    const db = new Database(':memory:');
    runRagMigrations({ raw: db });

    const changed = recoverOrphanedJobs(db);
    expect(changed).toBe(0);
  });
});
