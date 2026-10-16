// Knowledge-base source readiness. A source row only proves the source is
// *registered*; it is *ready* (searchable by an MCP) once its latest sync job
// completed. A failed latest sync must never be presented as "connected".

import { useEffect, useState } from 'react';
import { apiFetch } from './api.js';

export type RagSourceState = 'ready' | 'syncing' | 'failed' | 'not-synced';

export interface RagSourceReadiness {
  id: string;
  name: string;
  state: RagSourceState;
  /** Error reported by the latest failed sync job, if any. */
  error: string | null;
}

interface RagSourceRow {
  id: string;
  name: string;
}

interface RagJobRow {
  sourceId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error: string | null;
}

/**
 * Derives each source's state from its latest sync job. `jobs` must be ordered
 * newest first, as returned by GET /api/rag/jobs.
 */
export function computeRagReadiness(
  sources: RagSourceRow[],
  jobs: RagJobRow[],
): RagSourceReadiness[] {
  const latest = new Map<string, RagJobRow>();
  for (const job of jobs) if (!latest.has(job.sourceId)) latest.set(job.sourceId, job);
  return sources.map((s) => {
    const job = latest.get(s.id);
    const state: RagSourceState = !job
      ? 'not-synced'
      : job.status === 'completed'
        ? 'ready'
        : job.status === 'failed'
          ? 'failed'
          : 'syncing';
    return {
      id: s.id,
      name: s.name,
      state,
      error: state === 'failed' ? (job?.error ?? null) : null,
    };
  });
}

/** Throws when either endpoint fails, so callers never mistake an error for "no source". */
export async function fetchRagReadiness(): Promise<RagSourceReadiness[]> {
  const [sourcesRes, jobsRes] = await Promise.all([
    apiFetch('/api/rag/sources', { credentials: 'include' }),
    apiFetch('/api/rag/jobs?limit=200', { credentials: 'include' }),
  ]);
  if (!sourcesRes.ok || !jobsRes.ok) throw new Error('knowledge-base sources unavailable');
  const sources = ((await sourcesRes.json()) as { sources?: RagSourceRow[] }).sources ?? [];
  const jobs = ((await jobsRes.json()) as { jobs?: RagJobRow[] }).jobs ?? [];
  return computeRagReadiness(sources, jobs);
}

/** Knowledge-base sources with their readiness; empty while RAG is disabled. */
export function useRagReadiness(ragEnabled: boolean, refreshKey = 0): RagSourceReadiness[] {
  const [readiness, setReadiness] = useState<RagSourceReadiness[]>([]);
  useEffect(() => {
    if (!ragEnabled) return;
    let cancelled = false;
    fetchRagReadiness()
      .then((r) => {
        if (!cancelled) setReadiness(r);
      })
      .catch(() => {
        // Display-only probe: the checklist reports load errors itself.
      });
    return () => {
      cancelled = true;
    };
  }, [ragEnabled, refreshKey]);
  return readiness;
}
