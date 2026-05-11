// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RagJob, RagJobStatus } from '../types.js';
import {
  apiGet,
  ApiError,
  type RagJobListResponse,
  type RagSourceWithCounts,
} from './api.js';
import { formatRelativeTime } from './useActiveSyncJobs.js';

interface SyncHistoryPanelProps {
  /** Source list — used to populate the source filter dropdown and resolve names. */
  sources: RagSourceWithCounts[];
  /** Optional close handler — when set, a "← Retour" button is rendered. */
  onClose?: () => void;
}

/** UI status filter: synthetic "active" alias bundles pending + running. */
type StatusFilter = 'all' | 'active' | 'completed' | 'failed';

const POLL_INTERVAL_MS = 5000;
const HISTORY_LIMIT = 100;

/** Returns a human-readable French label for a job status. */
function statusLabel(status: RagJobStatus): string {
  switch (status) {
    case 'pending':
      return 'En attente';
    case 'running':
      return 'En cours';
    case 'completed':
      return 'Terminé';
    case 'failed':
      return 'Échec';
  }
}

/** Tailwind classes for the small status badge, matching IngestionStatusCard. */
function statusBadgeClasses(status: RagJobStatus): string {
  switch (status) {
    case 'pending':
      return 'bg-gray-700/40 text-gray-300';
    case 'running':
      return 'bg-os-700/30 text-os-300';
    case 'completed':
      return 'bg-green-950/40 text-green-400 border border-green-800/50';
    case 'failed':
      return 'bg-red-950/40 text-red-400 border border-red-800/50';
  }
}

/**
 * Format a duration in milliseconds as a compact French string.
 * Examples: "850 ms", "12 s", "3 min 42 s", "1 h 02 min".
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec} s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min} min ${sec.toString().padStart(2, '0')} s`;
  const h = Math.floor(min / 60);
  const remMin = min % 60;
  return `${h} h ${remMin.toString().padStart(2, '0')} min`;
}

/** Returns the job duration string, or "en cours" when still running. */
function jobDuration(job: RagJob): string {
  if (!job.finishedAt) return 'en cours';
  try {
    const ms = new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '—';
    return formatDuration(ms);
  } catch {
    return '—';
  }
}

/** Tries to format an ISO timestamp as a localized absolute time tooltip. */
function formatAbsolute(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('fr-CA', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** True iff at least one job is still pending or running. */
function hasActiveJob(jobs: RagJob[]): boolean {
  return jobs.some((j) => j.status === 'pending' || j.status === 'running');
}

/**
 * Filter a job list by source and status. The status filter applies the same
 * synthetic `active` alias as the backend (`pending` + `running`).
 */
function filterJobs(
  jobs: RagJob[],
  sourceId: string,
  status: StatusFilter,
): RagJob[] {
  return jobs.filter((j) => {
    if (sourceId !== '' && j.sourceId !== sourceId) return false;
    if (status === 'all') return true;
    if (status === 'active') return j.status === 'pending' || j.status === 'running';
    if (status === 'completed') return j.status === 'completed';
    if (status === 'failed') return j.status === 'failed';
    return true;
  });
}

/**
 * Full-page panel showing every recent sync job across every source. Filters
 * (source + status) are applied client-side after the initial fetch — the
 * backend always returns the most recent 100 jobs newest-first so the panel
 * never has to paginate. Auto-refresh kicks in only when at least one job is
 * active; once everything terminates the poll stops, saving network.
 */
export default function SyncHistoryPanel({ sources, onClose }: SyncHistoryPanelProps) {
  const [jobs, setJobs] = useState<RagJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [refreshing, setRefreshing] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  // Lookup table sourceId → name for the table column. Falls back to the raw id
  // when a job references a source that was deleted (rare but possible).
  const sourceNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sources) map.set(s.id, s.name);
    return map;
  }, [sources]);

  const fetchHistory = useCallback(
    async (silent: boolean): Promise<RagJob[]> => {
      if (!silent) setRefreshing(true);
      try {
        const data = await apiGet<RagJobListResponse>(
          `/api/rag/jobs?limit=${HISTORY_LIMIT}`,
        );
        if (cancelledRef.current) return [];
        const list = data.jobs ?? [];
        setJobs(list);
        setError(null);
        setLoading(false);
        return list;
      } catch (err) {
        if (cancelledRef.current) return [];
        const msg =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Erreur de chargement.';
        setError(msg);
        setLoading(false);
        return [];
      } finally {
        if (!silent) setRefreshing(false);
      }
    },
    [],
  );

  // Initial fetch + adaptive polling. Re-poll every POLL_INTERVAL_MS only
  // while there's an active job; once everything is terminal we stop, and a
  // manual refresh (or a re-mount) is required to restart.
  useEffect(() => {
    cancelledRef.current = false;

    const tick = async (): Promise<void> => {
      const list = await fetchHistory(true);
      if (cancelledRef.current) return;
      if (hasActiveJob(list)) {
        timerRef.current = setTimeout(() => void tick(), POLL_INTERVAL_MS);
      }
    };

    void tick();
    return () => {
      cancelledRef.current = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [fetchHistory]);

  const handleManualRefresh = useCallback(() => {
    // Restart the poll loop after a manual refresh — the previous loop may
    // have terminated because nothing was active, and the user may have just
    // triggered a sync from another tab.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    void (async () => {
      const list = await fetchHistory(false);
      if (cancelledRef.current) return;
      if (hasActiveJob(list)) {
        timerRef.current = setTimeout(() => void fetchHistory(true), POLL_INTERVAL_MS);
      }
    })();
  }, [fetchHistory]);

  const visibleJobs = useMemo(
    () => filterJobs(jobs, sourceFilter, statusFilter),
    [jobs, sourceFilter, statusFilter],
  );

  return (
    <div className="space-y-4">
      {/* Header: back button (optional) + title + manual refresh. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="px-2.5 py-1.5 rounded-lg text-sm text-gray-300 hover:bg-gray-700/40 transition-colors flex-shrink-0"
              aria-label="Retour à la liste des sources"
            >
              ← Retour
            </button>
          )}
          <div className="min-w-0">
            <h2 className="heading-md">Historique de sync</h2>
            <p className="text-sm text-gray-500 mt-1">
              Derniers {HISTORY_LIMIT} jobs de synchronisation, toutes sources confondues.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleManualRefresh}
          disabled={refreshing}
          className="px-3 py-1.5 rounded-lg text-sm bg-gray-700/40 hover:bg-gray-700/60 text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
        >
          {refreshing ? 'Actualisation…' : 'Actualiser'}
        </button>
      </div>

      {/* Filter bar */}
      <div className="card-primary p-3 flex flex-wrap items-center gap-3">
        <label className="text-xs text-gray-400 flex items-center gap-2">
          <span>Source</span>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="bg-gray-900/60 border border-white/5 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-os-500/40"
          >
            <option value="">Toutes les sources</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs text-gray-400 flex items-center gap-2">
          <span>Statut</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="bg-gray-900/60 border border-white/5 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-os-500/40"
          >
            <option value="all">Tous</option>
            <option value="active">Actif (en attente / en cours)</option>
            <option value="completed">Réussi</option>
            <option value="failed">Échec</option>
          </select>
        </label>

        <span className="text-xs text-gray-500 ml-auto">
          {visibleJobs.length} job{visibleJobs.length > 1 ? 's' : ''} affiché
          {visibleJobs.length > 1 ? 's' : ''} / {jobs.length}
        </span>
      </div>

      {error && (
        <div className="p-2.5 rounded-lg text-sm bg-red-950/30 border border-red-800/50 text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <div className="card-primary p-6 text-center text-sm text-gray-500 italic">
          Chargement de l'historique…
        </div>
      ) : visibleJobs.length === 0 ? (
        <div className="card-primary p-6 text-center text-sm text-gray-500 italic">
          {jobs.length === 0
            ? 'Aucun job de synchronisation enregistré.'
            : 'Aucun job ne correspond aux filtres sélectionnés.'}
        </div>
      ) : (
        <div className="card-primary overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-900/40 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Source</th>
                  <th className="text-left px-3 py-2 font-medium">Démarré</th>
                  <th className="text-left px-3 py-2 font-medium">Durée</th>
                  <th className="text-left px-3 py-2 font-medium">Statut</th>
                  <th className="text-left px-3 py-2 font-medium">Progression</th>
                  <th className="text-left px-3 py-2 font-medium">Erreur</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {visibleJobs.map((job) => {
                  const percent = Math.round(
                    Math.min(Math.max(job.progress, 0), 1) * 100,
                  );
                  const isActive = job.status === 'pending' || job.status === 'running';
                  const sourceName = sourceNameById.get(job.sourceId) ?? job.sourceId;
                  return (
                    <tr key={job.id} className="hover:bg-gray-900/30">
                      <td className="px-3 py-2 text-gray-200 truncate max-w-[200px]">
                        <span title={job.sourceId}>{sourceName}</span>
                      </td>
                      <td
                        className="px-3 py-2 text-gray-400 whitespace-nowrap"
                        title={formatAbsolute(job.startedAt)}
                      >
                        {formatRelativeTime(job.startedAt) ?? '—'}
                      </td>
                      <td
                        className="px-3 py-2 text-gray-400 whitespace-nowrap"
                        title={
                          job.finishedAt
                            ? `Terminé : ${formatAbsolute(job.finishedAt)}`
                            : 'Job en cours'
                        }
                      >
                        {jobDuration(job)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${statusBadgeClasses(job.status)}`}
                        >
                          {statusLabel(job.status)}
                        </span>
                      </td>
                      <td className="px-3 py-2 min-w-[180px]">
                        <div className="space-y-1">
                          {isActive ? (
                            <>
                              <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-os-500 transition-all duration-300"
                                  style={{ width: `${percent}%` }}
                                />
                              </div>
                              <div className="text-xs text-gray-500">
                                {job.processedDocuments} / {job.totalDocuments || '?'} · {percent}%
                              </div>
                            </>
                          ) : (
                            <div className="text-xs text-gray-400">
                              {job.processedDocuments} / {job.totalDocuments} documents
                              {job.skippedByEtag > 0 && (
                                <span className="text-gray-500">
                                  {' '}· {job.skippedByEtag} skipped (etag)
                                </span>
                              )}
                              {job.gcDeleted > 0 && (
                                <span className="text-gray-500">
                                  {' '}· {job.gcDeleted} GC
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs text-red-400 max-w-[260px]">
                        {job.error ? (
                          <span
                            className="block truncate"
                            title={job.error}
                          >
                            {job.error}
                          </span>
                        ) : (
                          <span className="text-gray-600">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
