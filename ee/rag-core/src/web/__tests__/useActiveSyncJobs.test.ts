// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect } from 'vitest';
import { buildJobMap } from '../useActiveSyncJobs.js';
import type { RagJob } from '../../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<RagJob> & { id: string; sourceId: string; status: RagJob['status'] }): RagJob {
  return {
    progress: 1,
    totalDocuments: 0,
    processedDocuments: 0,
    skippedByEtag: 0,
    gcDeleted: 0,
    tokensEmbedded: 0,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildJobMap — core badge logic
// ---------------------------------------------------------------------------

describe('buildJobMap', () => {
  const SOURCE_A = 'source-a';
  const SOURCE_B = 'source-b';

  it('returns null for both activeJob and lastFailedJob when there are no jobs', () => {
    const map = buildJobMap([SOURCE_A], []);
    expect(map.get(SOURCE_A)).toEqual({ activeJob: null, lastFailedJob: null });
  });

  it('sets lastFailedJob when the only terminal job is failed', () => {
    const failedJob = makeJob({ id: 'j1', sourceId: SOURCE_A, status: 'failed', error: 'oops' });
    const map = buildJobMap([SOURCE_A], [failedJob]);
    expect(map.get(SOURCE_A)?.lastFailedJob?.id).toBe('j1');
    expect(map.get(SOURCE_A)?.activeJob).toBeNull();
  });

  it('returns lastFailedJob=null when the only terminal job is completed', () => {
    const completedJob = makeJob({ id: 'j1', sourceId: SOURCE_A, status: 'completed', finishedAt: new Date().toISOString() });
    const map = buildJobMap([SOURCE_A], [completedJob]);
    expect(map.get(SOURCE_A)?.lastFailedJob).toBeNull();
    expect(map.get(SOURCE_A)?.activeJob).toBeNull();
  });

  it('returns lastFailedJob=null when a failed job is followed by a more recent completed job (newest-first order)', () => {
    // The API returns jobs newest-first. A completed job placed before a failed
    // job in the array means the completed job is MORE recent.
    const newerCompleted = makeJob({ id: 'j2', sourceId: SOURCE_A, status: 'completed', finishedAt: new Date().toISOString() });
    const olderFailed = makeJob({ id: 'j1', sourceId: SOURCE_A, status: 'failed', error: 'orphaned (server restart)' });
    // newest-first: completed (j2) comes first, failed (j1) comes second
    const map = buildJobMap([SOURCE_A], [newerCompleted, olderFailed]);
    expect(map.get(SOURCE_A)?.lastFailedJob).toBeNull();
  });

  it('returns lastFailedJob when a completed job is older than the most recent failed job (newest-first order)', () => {
    // newest-first: failed (j2) comes first, completed (j1) comes second
    const newerFailed = makeJob({ id: 'j2', sourceId: SOURCE_A, status: 'failed', error: 'timeout' });
    const olderCompleted = makeJob({ id: 'j1', sourceId: SOURCE_A, status: 'completed', finishedAt: new Date().toISOString() });
    const map = buildJobMap([SOURCE_A], [newerFailed, olderCompleted]);
    expect(map.get(SOURCE_A)?.lastFailedJob?.id).toBe('j2');
  });

  it('sets activeJob when there is a running job, regardless of past failures', () => {
    const running = makeJob({ id: 'j3', sourceId: SOURCE_A, status: 'running' });
    const olderFailed = makeJob({ id: 'j1', sourceId: SOURCE_A, status: 'failed', error: 'oops' });
    // newest-first: running first, then failed
    const map = buildJobMap([SOURCE_A], [running, olderFailed]);
    expect(map.get(SOURCE_A)?.activeJob?.id).toBe('j3');
  });

  it('sets activeJob when there is a pending job', () => {
    const pending = makeJob({ id: 'j4', sourceId: SOURCE_A, status: 'pending' });
    const map = buildJobMap([SOURCE_A], [pending]);
    expect(map.get(SOURCE_A)?.activeJob?.id).toBe('j4');
    expect(map.get(SOURCE_A)?.lastFailedJob).toBeNull();
  });

  it('does not bleed jobs across sources', () => {
    const failedA = makeJob({ id: 'jA', sourceId: SOURCE_A, status: 'failed', error: 'oops' });
    const completedB = makeJob({ id: 'jB', sourceId: SOURCE_B, status: 'completed', finishedAt: new Date().toISOString() });
    const map = buildJobMap([SOURCE_A, SOURCE_B], [failedA, completedB]);
    // SOURCE_A: last terminal is failed → badge red
    expect(map.get(SOURCE_A)?.lastFailedJob?.id).toBe('jA');
    // SOURCE_B: last terminal is completed → badge green
    expect(map.get(SOURCE_B)?.lastFailedJob).toBeNull();
  });

  it('returns an entry for every requested source, even those with no jobs', () => {
    const map = buildJobMap([SOURCE_A, SOURCE_B], []);
    expect(map.has(SOURCE_A)).toBe(true);
    expect(map.has(SOURCE_B)).toBe(true);
  });
});
