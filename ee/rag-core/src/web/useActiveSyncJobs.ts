// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RagJob } from '../types.js';
import { apiGet, type RagJobListResponse } from './api.js';

export interface SourceJobInfo {
  /** The currently active (pending or running) job for this source, or null. */
  activeJob: RagJob | null;
  /** The most recent failed job for this source, or null. */
  lastFailedJob: RagJob | null;
}

export interface UseActiveSyncJobsResult {
  jobMap: Map<string, SourceJobInfo>;
  /**
   * Force an immediate re-poll. Callers should invoke this right after firing
   * an action that creates or transitions a job (e.g. POST /sync), so the UI
   * picks up the new `pending`/`running` row without waiting for the next
   * scheduled tick — and crucially without needing to remount the component.
   */
  triggerPoll: () => void;
}

/**
 * Polls `/api/rag/jobs` globally every `pollIntervalMs` milliseconds and
 * returns a Map keyed by sourceId with active and last-failed job info.
 *
 * The poll stops when no active jobs remain. Call `triggerPoll()` after
 * actions that create new jobs (e.g. manual Re-sync) to restart polling
 * immediately instead of waiting for a remount.
 *
 * @param sourceIds - list of source IDs to track; stable reference preferred.
 * @param pollIntervalMs - polling cadence in ms (default 5000).
 */
export function useActiveSyncJobs(
  sourceIds: string[],
  pollIntervalMs = 5000,
): UseActiveSyncJobsResult {
  const [jobMap, setJobMap] = useState<Map<string, SourceJobInfo>>(new Map());

  // Keep a ref to latest sourceIds so the interval callback stays current
  // without being recreated on every render.
  const sourceIdsRef = useRef<string[]>(sourceIds);
  useEffect(() => {
    sourceIdsRef.current = sourceIds;
  }, [sourceIds]);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  const buildMap = useCallback((jobs: RagJob[]): Map<string, SourceJobInfo> => {
    const ids = sourceIdsRef.current;
    const map = new Map<string, SourceJobInfo>();
    for (const id of ids) {
      // Jobs for this source, newest first (API already returns newest-first).
      const sourceJobs = jobs.filter((j) => j.sourceId === id);
      const activeJob =
        sourceJobs.find((j) => j.status === 'pending' || j.status === 'running') ?? null;
      const lastFailedJob =
        sourceJobs.find((j) => j.status === 'failed') ?? null;
      map.set(id, { activeJob, lastFailedJob });
    }
    return map;
  }, []);

  const fetchJobs = useCallback(async (): Promise<void> => {
    try {
      // Narrow the poll to the only two job classes the badge cares about:
      // - active (pending+running): drives the "in progress" indicator
      // - failed: drives the "last failed" badge
      // This cuts the response from ~50 rows (the previous default LIMIT)
      // to typically <10 even on a busy install. `limit=100` is generous
      // for both classes combined and never truncates active jobs in
      // practice.
      const data = await apiGet<RagJobListResponse>(
        '/api/rag/jobs?status=active,failed&limit=100',
      );
      if (cancelledRef.current) return;

      const jobs = data.jobs ?? [];
      const map = buildMap(jobs);
      setJobMap(map);

      // Keep polling only if there are active jobs so we can detect completion.
      const hasActive = jobs.some((j) => j.status === 'pending' || j.status === 'running');
      if (hasActive) {
        timerRef.current = setTimeout(() => void fetchJobs(), pollIntervalMs);
      }
      // If nothing active, the effect will restart the poll next time the
      // component calls `triggerPoll` (e.g. after a Re-sync button click).
    } catch {
      if (cancelledRef.current) return;
      // On transient failure, retry once after the interval.
      timerRef.current = setTimeout(() => void fetchJobs(), pollIntervalMs);
    }
  }, [buildMap, pollIntervalMs]);

  useEffect(() => {
    cancelledRef.current = false;
    void fetchJobs();
    return () => {
      cancelledRef.current = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [fetchJobs]);

  // Re-arm the poll loop on demand. Clears any pending timer first so we don't
  // double-poll if the loop was still scheduled.
  const triggerPoll = useCallback((): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    void fetchJobs();
  }, [fetchJobs]);

  return { jobMap, triggerPoll };
}

/**
 * Formats an ISO timestamp as a human-readable relative time in French.
 * Returns null when the value is falsy.
 *
 * Examples: "il y a 3 min", "il y a 2 h", "il y a 5 j"
 */
export function formatRelativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    const diffMs = Date.now() - new Date(iso).getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return 'il y a quelques secondes';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `il y a ${diffMin} min`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `il y a ${diffH} h`;
    const diffD = Math.floor(diffH / 24);
    return `il y a ${diffD} j`;
  } catch {
    return null;
  }
}

/**
 * Returns true when the last sync was more than 24 hours ago.
 */
export function isSyncStale(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const diffMs = Date.now() - new Date(iso).getTime();
  return diffMs > 24 * 60 * 60 * 1000;
}
