// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  apiDelete,
  apiGet,
  apiPost,
  ApiError,
  type RagSourceListResponse,
  type RagSourcePublic,
  type RagSourceWithCounts,
} from './api.js';
import SourceForm, { type AiSettingOption } from './SourceForm.js';
import FolderTreeView from './FolderTreeView.js';
import DocumentUploader from './DocumentUploader.js';
import IngestionStatusCard from './IngestionStatusCard.js';
import SyncHistoryPanel from './SyncHistoryPanel.js';
import EmbeddingUsageCard from './EmbeddingUsageCard.js';
import {
  useActiveSyncJobs,
  formatRelativeTime,
  isSyncStale,
  type SourceJobInfo,
} from './useActiveSyncJobs.js';

interface KnowledgeBaseManagerProps {
  onClose?: () => void;
}

function formatDate(value?: string): string {
  if (!value) return 'Jamais';
  try {
    return new Date(value).toLocaleString('fr-CA', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

/**
 * Returns a human-readable label for the auto-sync mode of a source.
 * Examples: "Watch live", "Watch + polling 5 min", "Polling 60 min", "Manuel uniquement"
 */
function syncModeLabel(source: RagSourcePublic): string {
  const isLocal = source.type === 'local';
  const polling = source.pollingIntervalSeconds;

  if (isLocal && polling) {
    const minutes = Math.round(polling / 60);
    return `Watch + polling ${minutes} min`;
  }
  if (isLocal) {
    return 'Watch live';
  }
  if (polling) {
    const minutes = Math.round(polling / 60);
    return `Polling ${minutes} min`;
  }
  return 'Manuel uniquement';
}

interface SyncStatusBadgeProps {
  source: RagSourceWithCounts;
  jobInfo: SourceJobInfo | undefined;
}

/**
 * Small inline badge rendering the sync status of a source.
 * Covers: syncing, never synced, OK <1h, OK <24h, OK >24h, last failed.
 */
function SyncStatusBadge({ source, jobInfo }: SyncStatusBadgeProps) {
  const activeJob = jobInfo?.activeJob ?? null;
  const lastFailedJob = jobInfo?.lastFailedJob ?? null;

  // Sync in progress (optimistic: active job OR syncingId)
  if (activeJob) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs text-blue-400"
        aria-label="Synchronisation en cours"
      >
        <span className="inline-block w-2 h-2 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
        Synchronisation en cours…
      </span>
    );
  }

  // Last job failed (and no active job)
  if (lastFailedJob) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs text-red-400"
        title={lastFailedJob.error ?? 'Erreur inconnue'}
        aria-label={`Échec de la dernière sync : ${lastFailedJob.error ?? 'Erreur inconnue'}`}
      >
        <span className="inline-block w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
        Échec de la dernière sync
      </span>
    );
  }

  // Never synced
  if (!source.lastSyncAt) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs text-gray-500"
        aria-label="Jamais synchronisé"
      >
        <span className="inline-block w-2 h-2 rounded-full bg-gray-600 flex-shrink-0" />
        Jamais synchronisé
      </span>
    );
  }

  // Synced — determine staleness
  const relative = formatRelativeTime(source.lastSyncAt);
  const stale = isSyncStale(source.lastSyncAt);

  if (stale) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs text-yellow-500"
        aria-label={`Synchronisé ${relative ?? ''}`}
      >
        <span className="inline-block w-2 h-2 rounded-full bg-yellow-500 flex-shrink-0" />
        Synchronisé {relative}
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-green-500"
      aria-label={`Synchronisé ${relative ?? ''}`}
    >
      <span className="inline-block w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
      Synchronisé {relative}
    </span>
  );
}

/** Small "Refresh" SVG icon. */
function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className={`w-3 h-3 flex-shrink-0 ${spinning ? 'animate-spin' : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

/**
 * §12 Q7 — 7-day retention window for soft-deleted sources. Mirrors the
 * `retentionDays` argument passed to `runSoftDeleteCleanup` at boot. Kept
 * client-side as a UI affordance only; the server is the source of truth.
 */
const RETENTION_DAYS = 7;

/**
 * Compute how many days remain before the source is hard-deleted by the
 * cleanup cron. Negative values mean the source is past retention and will be
 * collected on the next server boot (or already has been — the UI just hasn't
 * refreshed yet). Returns null when `deletedAt` is missing or unparsable.
 */
function daysUntilHardDelete(deletedAt: string | null): number | null {
  if (deletedAt === null) return null;
  const deletedMs = Date.parse(deletedAt);
  if (Number.isNaN(deletedMs)) return null;
  const elapsedMs = Date.now() - deletedMs;
  const elapsedDays = elapsedMs / (24 * 60 * 60 * 1000);
  return Math.max(0, Math.ceil(RETENTION_DAYS - elapsedDays));
}

export default function KnowledgeBaseManager({ onClose }: KnowledgeBaseManagerProps) {
  const [sources, setSources] = useState<RagSourceWithCounts[]>([]);
  const [aiSettings, setAiSettings] = useState<AiSettingOption[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  // When true, the main view is replaced by the global sync history panel.
  // We toggle in-place (no modal) because the panel is a full content view —
  // consistent with how SourceForm is rendered above the source list.
  const [showHistory, setShowHistory] = useState(false);
  // §12 Q7 — when 'deleted', the main view is replaced by the "Recently
  // deleted" panel. Restoring a source flips us back to 'sources'. Refresh
  // pulls a different endpoint based on the active view.
  const [view, setView] = useState<'sources' | 'deleted'>('sources');
  const [deletedSources, setDeletedSources] = useState<RagSourcePublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  // Track per-source "requesting sync" state independently from active jobs.
  const [resyncingIds, setResyncingIds] = useState<Set<string>>(new Set());
  // Optimistic active IDs: sourceIds where we just triggered a sync but the
  // poll hasn't returned yet, so the badge should show "in progress" immediately.
  const [optimisticActiveIds, setOptimisticActiveIds] = useState<Set<string>>(new Set());

  const refreshSources = useCallback(async (): Promise<void> => {
    try {
      const data = await apiGet<RagSourceListResponse>('/api/rag/sources');
      setSources(data.sources ?? []);
      setError(null);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Erreur de chargement.';
      setError(message);
    }
  }, []);

  /**
   * Pull the list of soft-deleted sources. Kept separate from
   * `refreshSources` so the two views can refresh independently — switching
   * to "Recently deleted" only fetches when needed, and the count badge in
   * the header reuses this state.
   */
  const refreshDeletedSources = useCallback(async (): Promise<void> => {
    try {
      const data = await apiGet<{ sources: RagSourcePublic[] }>(
        '/api/rag/sources?filter=deleted',
      );
      setDeletedSources(data.sources ?? []);
    } catch (err) {
      // Failure here is not fatal — the count badge just stays at the
      // last known value. The "Recently deleted" view surfaces the
      // error through its own state when the user navigates to it.
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Erreur de chargement.';
      if (view === 'deleted') {
        setError(message);
      }
    }
  }, [view]);

  const refreshAiSettings = useCallback(async (): Promise<void> => {
    try {
      const data = await apiGet<{ success?: boolean; settings?: AiSettingOption[] }>(
        '/api/ai-settings',
      );
      if (data.success && Array.isArray(data.settings)) {
        setAiSettings(data.settings);
      }
    } catch {
      // Soft fail — the SourceForm will show an explanatory message.
    }
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      await Promise.all([
        refreshSources(),
        refreshAiSettings(),
        refreshDeletedSources(),
      ]);
      setLoading(false);
    })();
  }, [refreshSources, refreshAiSettings, refreshDeletedSources]);

  // Stable list of source IDs passed to the polling hook.
  const sourceIds = useMemo(() => sources.map((s) => s.id), [sources]);
  const jobMap = useActiveSyncJobs(sourceIds);

  const selectedSource = sources.find((s) => s.id === selectedSourceId) ?? null;

  const handleCreated = (source: RagSourcePublic) => {
    setShowCreateForm(false);
    setSelectedSourceId(source.id);
    setActionMessage(`Source "${source.name}" enregistrée.`);
    setTimeout(() => setActionMessage(null), 3000);
    void refreshSources();
  };

  // Clear a specific action message ref so concurrent toasts don't clobber each other.
  const actionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showAction = useCallback((msg: string) => {
    setActionMessage(msg);
    if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
    actionTimerRef.current = setTimeout(() => setActionMessage(null), 3000);
  }, []);

  /**
   * Re-sync a single source. Sends POST /api/rag/sources/:id/sync and manages
   * optimistic UI state so the badge flips immediately.
   */
  const handleResync = useCallback(
    async (source: RagSourcePublic) => {
      setResyncingIds((prev) => new Set([...prev, source.id]));
      // Optimistic: show "in progress" badge right away.
      setOptimisticActiveIds((prev) => new Set([...prev, source.id]));
      setError(null);
      try {
        await apiPost(`/api/rag/sources/${encodeURIComponent(source.id)}/sync`);
        showAction(`Sync lancée pour "${source.name}".`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // Already queued — the badge will reflect this from the poll.
          showAction(`Sync déjà en cours pour "${source.name}".`);
        } else {
          const message =
            err instanceof ApiError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'Échec de la synchronisation.';
          setError(message);
          // Revert optimistic state on real failure.
          setOptimisticActiveIds((prev) => {
            const next = new Set(prev);
            next.delete(source.id);
            return next;
          });
        }
      } finally {
        setResyncingIds((prev) => {
          const next = new Set(prev);
          next.delete(source.id);
          return next;
        });
      }
    },
    [showAction],
  );

  const handleDelete = async (source: RagSourcePublic) => {
    if (
      !window.confirm(
        `Supprimer la source "${source.name}" ? ` +
          `Elle sera déplacée vers la corbeille et conservée ${RETENTION_DAYS} jours avant suppression définitive.`,
      )
    ) {
      return;
    }
    try {
      await apiDelete(`/api/rag/sources/${encodeURIComponent(source.id)}`);
      if (selectedSourceId === source.id) setSelectedSourceId(null);
      showAction(
        `Source "${source.name}" déplacée vers la corbeille (récupérable ${RETENTION_DAYS} jours).`,
      );
      await Promise.all([refreshSources(), refreshDeletedSources()]);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Échec de la suppression.';
      setError(message);
    }
  };

  /**
   * Restore a soft-deleted source within the retention window. The server
   * re-registers the poll timer / watch handle for us; we just refresh the
   * UI lists and flip back to the main view when the trash is empty.
   */
  const handleRestore = async (source: RagSourcePublic) => {
    setError(null);
    try {
      await apiPost(`/api/rag/sources/${encodeURIComponent(source.id)}/restore`);
      showAction(`Source "${source.name}" restaurée.`);
      await Promise.all([refreshSources(), refreshDeletedSources()]);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Échec de la restauration.';
      setError(message);
    }
  };

  /**
   * Permanent (hard) delete. Bypasses the retention window — the source and
   * every dependent row are dropped immediately. We require a stricter
   * confirmation because the action is irreversible.
   */
  const handlePermanentDelete = async (source: RagSourcePublic) => {
    if (
      !window.confirm(
        `Supprimer DÉFINITIVEMENT la source "${source.name}" ? ` +
          `Cette action est IRRÉVERSIBLE — tous les documents, dossiers, chunks et historiques de sync seront perdus.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      await apiDelete(`/api/rag/sources/${encodeURIComponent(source.id)}/permanent`);
      showAction(`Source "${source.name}" supprimée définitivement.`);
      await Promise.all([refreshSources(), refreshDeletedSources()]);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Échec de la suppression définitive.';
      setError(message);
    }
  };

  // When the history panel is open we render it as a full replacement view —
  // the header / source list / detail panel are all suppressed. The panel
  // provides its own "← Retour" affordance that flips `showHistory` back.
  if (showHistory) {
    return (
      <SyncHistoryPanel
        sources={sources}
        onClose={() => setShowHistory(false)}
      />
    );
  }

  // §12 Q7 — "Recently deleted" view. Same full-replacement pattern as the
  // history panel: own header, own back affordance. Listed in the order
  // returned by the API (most recently soft-deleted first — see
  // `ORDER BY deleted_at DESC` in the route).
  if (view === 'deleted') {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="heading-md">Corbeille</h2>
            <p className="text-sm text-gray-500 mt-1">
              Sources supprimées au cours des {RETENTION_DAYS} derniers jours. Au-delà, elles
              sont définitivement effacées par le cron au prochain démarrage du serveur.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setView('sources');
              setError(null);
            }}
            className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-gray-200 transition-colors"
          >
            ← Retour
          </button>
        </div>

        {actionMessage && (
          <div className="p-2.5 rounded-lg text-sm bg-green-950/30 border border-green-800/50 text-green-400">
            {actionMessage}
          </div>
        )}
        {error && (
          <div className="p-2.5 rounded-lg text-sm bg-red-950/30 border border-red-800/50 text-red-400">
            {error}
          </div>
        )}

        {deletedSources.length === 0 ? (
          <div className="text-sm text-gray-500 italic px-3 py-6 text-center border border-dashed border-white/5 rounded-lg">
            Aucune source dans la corbeille.
          </div>
        ) : (
          <div className="space-y-2">
            {deletedSources.map((source) => {
              const remaining = daysUntilHardDelete(source.deletedAt);
              const remainingLabel =
                remaining === null
                  ? '—'
                  : remaining <= 0
                    ? 'expire à la prochaine maintenance'
                    : `${remaining} jour${remaining > 1 ? 's' : ''} restant${remaining > 1 ? 's' : ''}`;
              const urgent = remaining !== null && remaining <= 1;
              return (
                <div
                  key={source.id}
                  className="p-3 rounded-lg border border-white/5 bg-gray-900/40"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-gray-200 truncate">
                          {source.name}
                        </span>
                        <span className="text-xs text-gray-500">·</span>
                        <span className="text-xs text-gray-500">{source.type}</span>
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        Supprimée {formatDate(source.deletedAt ?? undefined)}
                      </div>
                      <div
                        className={`text-xs mt-0.5 ${
                          urgent ? 'text-yellow-500' : 'text-gray-500'
                        }`}
                      >
                        {remainingLabel}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-3">
                    <button
                      type="button"
                      onClick={() => void handleRestore(source)}
                      className="px-2 py-1 rounded text-xs bg-os-700 hover:bg-os-600 text-white"
                    >
                      Restaurer
                    </button>
                    <button
                      type="button"
                      onClick={() => void handlePermanentDelete(source)}
                      className="px-2 py-1 rounded text-xs text-red-400 hover:bg-red-950/40 ml-auto"
                    >
                      Supprimer définitivement
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="heading-md">Bases de connaissance</h2>
          <p className="text-sm text-gray-500 mt-1">
            Configurez les sources documentaires qui alimentent le RAG.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setView('deleted');
              setError(null);
              void refreshDeletedSources();
            }}
            disabled={deletedSources.length === 0}
            className="px-3 py-1.5 rounded-lg text-sm bg-gray-700/40 hover:bg-gray-700/60 text-gray-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={`${deletedSources.length} source(s) dans la corbeille — restaurables pendant ${RETENTION_DAYS} jours`}
          >
            Corbeille ({deletedSources.length})
          </button>
          <button
            type="button"
            onClick={() => setShowHistory(true)}
            className="px-3 py-1.5 rounded-lg text-sm bg-gray-700/40 hover:bg-gray-700/60 text-gray-200 transition-colors"
            title="Voir l'historique complet des synchronisations"
          >
            Historique de sync
          </button>
          <button
            type="button"
            onClick={() => setShowCreateForm((v) => !v)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200 shadow-md shadow-os-900/20 ${
              showCreateForm
                ? 'bg-gray-700/40 hover:bg-gray-700/60 text-gray-300'
                : 'bg-os-700 hover:bg-os-600 text-white'
            }`}
          >
            {showCreateForm ? 'Annuler' : '+ Nouvelle source'}
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-gray-200 transition-colors"
            >
              Fermer
            </button>
          )}
        </div>
      </div>

      {actionMessage && (
        <div className="p-2.5 rounded-lg text-sm bg-green-950/30 border border-green-800/50 text-green-400">
          {actionMessage}
        </div>
      )}
      {error && (
        <div className="p-2.5 rounded-lg text-sm bg-red-950/30 border border-red-800/50 text-red-400">
          {error}
        </div>
      )}

      {showCreateForm && (
        <SourceForm
          aiSettings={aiSettings}
          onSave={handleCreated}
          onCancel={() => setShowCreateForm(false)}
        />
      )}

      {/* Cost tracker — surfaces token consumption + estimated USD spend
          from the embedding provider. Sits above the source list so it
          stays visible at the top of the page; the component polls every
          30s on its own. */}
      <EmbeddingUsageCard />

      {/* Two-column layout: source list (left) and details (right). */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4 items-start">
        {/* Source list */}
        <div className="space-y-2">
          {loading && (
            <p className="text-sm text-gray-500 italic">Chargement des sources…</p>
          )}
          {!loading && sources.length === 0 && !showCreateForm && (
            <div className="text-sm text-gray-500 italic px-3 py-6 text-center border border-dashed border-white/5 rounded-lg">
              Aucune source. Cliquez sur{' '}
              <span className="text-os-400">+ Nouvelle source</span> pour en créer une.
            </div>
          )}
          {sources.map((source) => {
            const isSelected = source.id === selectedSourceId;
            const jobInfo = jobMap.get(source.id);
            // Merge poll data with optimistic state.
            const mergedJobInfo: SourceJobInfo = {
              activeJob: jobInfo?.activeJob ?? (optimisticActiveIds.has(source.id) ? ({
                id: 'optimistic',
                sourceId: source.id,
                status: 'pending',
                progress: 0,
                totalDocuments: 0,
                processedDocuments: 0,
                skippedByEtag: 0,
                gcDeleted: 0,
                tokensEmbedded: 0,
                error: null,
                startedAt: new Date().toISOString(),
                finishedAt: null,
              } satisfies import('../types.js').RagJob) : null),
              lastFailedJob: jobInfo?.lastFailedJob ?? null,
            };
            const isResyncing = resyncingIds.has(source.id);
            const isSyncDisabled = isResyncing || mergedJobInfo.activeJob !== null;

            return (
              <div
                key={source.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedSourceId(source.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedSourceId(source.id);
                  }
                }}
                className={`p-3 rounded-lg border bg-gray-900/40 transition-colors cursor-pointer hover:border-white/10 focus:outline-none focus:ring-2 focus:ring-os-500/40 ${
                  isSelected ? 'border-os-600/40' : 'border-white/5'
                }`}
              >
                {/* Row 1: name + type */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-200 truncate">
                        {source.name}
                      </span>
                      <span className="text-xs text-gray-500">·</span>
                      <span className="text-xs text-gray-500">{source.type}</span>
                      {source.configError && (
                        <span
                          className="text-xs bg-red-900/40 text-red-400 px-1.5 py-0.5 rounded border border-red-800/40"
                          title={source.configError}
                        >
                          Configuration illisible
                        </span>
                      )}
                    </div>

                    {/* Local source path */}
                    {source.type === 'local' && source.config && !source.configError && (
                      <div className="text-xs text-gray-600 mt-0.5 font-mono-plex truncate">
                        {typeof source.config.rootPath === 'string'
                          ? `Dossier : ${source.config.rootPath}`
                          : null}
                      </div>
                    )}

                    {/* Document / folder counts */}
                    <div className="text-xs text-gray-500 mt-0.5">
                      {source.documentCount} document
                      {source.documentCount > 1 ? 's' : ''} ·{' '}
                      {source.folderCount} dossier
                      {source.folderCount > 1 ? 's' : ''}
                    </div>
                  </div>
                </div>

                {/* Row 2: sync status badge + mode label */}
                <div className="flex items-center gap-3 mt-2 flex-wrap">
                  <SyncStatusBadge source={source} jobInfo={mergedJobInfo} />
                  <span
                    className="text-xs text-gray-600 border border-white/5 bg-gray-800/40 px-1.5 py-0.5 rounded"
                    title="Mode de synchronisation automatique"
                  >
                    {syncModeLabel(source)}
                  </span>
                </div>

                {/* Row 3: action buttons */}
                <div className="flex items-center gap-2 mt-3">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedSourceId(source.id);
                    }}
                    className="px-2 py-1 rounded text-xs text-gray-300 hover:bg-gray-700/40"
                  >
                    Ouvrir
                  </button>

                  {/* Re-sync button */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleResync(source);
                    }}
                    disabled={isSyncDisabled}
                    aria-label={`Re-synchroniser la source ${source.name}`}
                    title={
                      mergedJobInfo.activeJob
                        ? 'Synchronisation déjà en cours'
                        : 'Lancer une synchronisation manuelle'
                    }
                    className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs text-os-300 hover:bg-os-700/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <RefreshIcon spinning={isResyncing} />
                    Re-sync
                  </button>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDelete(source);
                    }}
                    className="px-2 py-1 rounded text-xs text-red-400 hover:bg-red-950/40 ml-auto"
                  >
                    Supprimer
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Detail panel */}
        <div className="space-y-4">
          {selectedSource ? (
            <>
              {/* Detail header: name + sync mode */}
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-gray-200">{selectedSource.name}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {syncModeLabel(selectedSource)} ·{' '}
                    Dernière sync : {formatDate(selectedSource.lastSyncAt)}
                  </p>
                </div>
                <SyncStatusBadge
                  source={selectedSource}
                  jobInfo={jobMap.get(selectedSource.id)}
                />
              </div>

              <FolderTreeView source={selectedSource} />
              {selectedSource.type === 'local' && (
                <div className="card-primary p-4 space-y-2">
                  <h3 className="eyebrow">Téléverser des fichiers</h3>
                  <DocumentUploader
                    source={selectedSource}
                    onUploaded={() => void refreshSources()}
                  />
                </div>
              )}
              <IngestionStatusCard sourceId={selectedSource.id} />
            </>
          ) : (
            <div className="card-primary p-6 text-center text-sm text-gray-500 italic">
              Sélectionnez une source à gauche pour explorer son contenu.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
