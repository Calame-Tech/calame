// Guided first-run path in three steps: 1. connect a source, 2. create the
// MCP, 3. use it from a client. Each step reflects server-side resources (see
// lib/setup-progress.ts) and links to the existing screen that performs it —
// this component never creates anything itself.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl/react';
import { apiFetch } from '../lib/api.js';
import {
  computeSetupProgress,
  mcpProfileNames,
  type SavedProfileSummary,
  type SetupProgress,
  type SetupStepStatus,
} from '../lib/setup-progress.js';
import { fetchRagReadiness, type RagSourceReadiness } from '../lib/rag-source-readiness.js';
import type { AuditLogEntry } from '../types/schema.js';
import type { View } from '../router/index.js';

/**
 * Set once the user hides the guide or a client call has been observed, so an
 * installation that already works never shows it (nor queries for it) again.
 */
export const SETUP_CHECKLIST_HIDDEN_KEY = 'calame.setupChecklist.hidden';

/** Upper bound on per-MCP audit lookups — first runs have one or two MCPs. */
const MAX_PROFILES_CHECKED = 10;

function isHidden(): boolean {
  try {
    return localStorage.getItem(SETUP_CHECKLIST_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

function persistHidden(): void {
  try {
    localStorage.setItem(SETUP_CHECKLIST_HIDDEN_KEY, '1');
  } catch {
    // Storage unavailable (private mode…): the guide just hides for this session.
  }
}

interface SetupChecklistProps {
  /** Database connections, as already loaded by the page. */
  sourceCount: number;
  /**
   * When set, knowledge-base sources are fetched with their sync state: only
   * an indexed one completes step 1 (a failed sync is reported, not hidden).
   */
  ragEnabled?: boolean;
  onNavigate: (view: View) => void;
  /** Bump to force a reload (e.g. the session `dataVersion`). */
  refreshKey?: number;
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | {
      status: 'ready';
      profiles: SavedProfileSummary[];
      audit: AuditLogEntry[];
      ragSources: RagSourceReadiness[];
    };

async function fetchJson<T>(url: string): Promise<T> {
  const res = await apiFetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('setup resources unavailable');
  return (await res.json()) as T;
}

/**
 * Saved profiles, plus at most one successful audited call per MCP that has
 * data — a targeted lookup (`result=success&limit=1`) instead of pulling the
 * whole recent audit log on every refresh.
 */
async function fetchSetupResources(ragEnabled: boolean): Promise<{
  profiles: SavedProfileSummary[];
  audit: AuditLogEntry[];
  ragSources: RagSourceReadiness[];
}> {
  const ragSourcesPromise = ragEnabled ? fetchRagReadiness() : Promise.resolve([]);
  const profilesData = await fetchJson<{
    found?: boolean;
    profiles?: Record<string, Omit<SavedProfileSummary, 'name'>>;
  }>('/api/profiles/load');
  const profiles = Object.entries(profilesData.found ? (profilesData.profiles ?? {}) : {}).map(
    ([name, p]) => ({ name, configurations: p.configurations, sources: p.sources }),
  );
  const mcpNames = mcpProfileNames(profiles).slice(0, MAX_PROFILES_CHECKED);
  const auditPages = await Promise.all(
    mcpNames.map((name) =>
      fetchJson<{ entries?: AuditLogEntry[] }>(
        `/api/audit?profileName=${encodeURIComponent(name)}&result=success&limit=1&offset=0`,
      ),
    ),
  );
  return {
    profiles,
    audit: auditPages.flatMap((page) => page.entries ?? []),
    ragSources: await ragSourcesPromise,
  };
}

export default function SetupChecklist({
  sourceCount,
  ragEnabled = false,
  onNavigate,
  refreshKey = 0,
}: SetupChecklistProps) {
  const t = useTranslations('onboarding.checklist');
  const [hidden, setHidden] = useState(isHidden);
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  // Only the latest request may update the state: a slow response must not
  // overwrite a newer one (e.g. a refresh triggered by a new source).
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    try {
      const data = await fetchSetupResources(ragEnabled);
      if (requestId === requestIdRef.current) setState({ status: 'ready', ...data });
    } catch {
      if (requestId === requestIdRef.current) setState({ status: 'error' });
    }
  }, [ragEnabled]);

  // Invalidate in-flight requests on unmount.
  useEffect(() => () => void ++requestIdRef.current, []);

  useEffect(() => {
    if (hidden) return;
    void load();
  }, [hidden, load, sourceCount, refreshKey]);

  // No timer: re-check when the user comes back to Calame (typically after
  // trying the MCP from their AI client) or asks for it explicitly.
  useEffect(() => {
    if (hidden) return;
    const onFocus = () => {
      if (document.visibilityState !== 'hidden') void load();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [hidden, load]);

  const progress: SetupProgress | null =
    state.status === 'ready'
      ? computeSetupProgress({
          sourceCount,
          ragSources: state.ragSources,
          savedProfiles: state.profiles,
          auditEntries: state.audit,
        })
      : null;

  // A saved source that is not indexed must not read as "connected": name it
  // (failed sync first) and point to it instead of to "Add a source".
  const pendingSource =
    progress && progress.source !== 'done'
      ? (progress.failedSources[0] ?? progress.notReadySources[0] ?? null)
      : null;
  const sourceHint =
    progress?.source === 'done'
      ? t('source.done')
      : pendingSource
        ? t(pendingSource.state === 'failed' ? 'source.syncFailed' : 'source.notReady', {
            name: pendingSource.name,
          })
        : t('source.hint');

  const allDone = progress?.allDone ?? false;
  useEffect(() => {
    if (!allDone) return;
    persistHidden();
    setHidden(true);
  }, [allDone]);

  const hide = () => {
    persistHidden();
    setHidden(true);
  };

  // Nothing is shown before the first answer, so an installation that already
  // has a used MCP never flashes the guide.
  if (hidden || allDone || state.status === 'idle') return null;

  return (
    <section className="card-primary p-4" aria-labelledby="setup-checklist-title">
      <div className="flex items-start justify-between gap-3">
        <h2 id="setup-checklist-title" className="text-sm font-semibold text-gray-100">
          {t('title')}
        </h2>
        <button
          type="button"
          onClick={hide}
          aria-label={t('hideAriaLabel')}
          className="flex-none text-[11px] text-gray-500 hover:text-gray-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-os-500/40 rounded"
        >
          {t('hide')}
        </button>
      </div>
      <p className="text-xs text-gray-500 mb-3">{t('description')}</p>

      {state.status === 'loading' && (
        <p role="status" className="text-sm text-gray-500">
          {t('loading')}
        </p>
      )}

      {state.status === 'error' && (
        <div role="alert" className="flex items-center gap-3 text-sm text-red-400">
          <span>{t('loadError')}</span>
          <button
            type="button"
            onClick={() => {
              setState({ status: 'loading' });
              void load();
            }}
            className="text-xs text-os-300 hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-os-500/40 rounded"
          >
            {t('retry')}
          </button>
        </div>
      )}

      {progress && (
        <ol className="space-y-2">
          <SetupStep
            index={1}
            status={progress.source}
            title={t('source.title')}
            hint={sourceHint}
            alert={progress.source !== 'done' && progress.failedSources.length > 0}
            actionLabel={pendingSource ? t('source.openSource') : t('source.action')}
            onAction={() =>
              onNavigate(
                pendingSource ? { page: 'sources', tab: 'knowledge' } : { page: 'sources' },
              )
            }
          />
          <SetupStep
            index={2}
            status={progress.mcp}
            title={t('mcp.title')}
            hint={progress.mcp === 'done' ? t('mcp.done') : t('mcp.hint')}
            actionLabel={progress.mcp === 'done' ? t('mcp.openAction') : t('mcp.action')}
            onAction={() =>
              progress.mcp === 'done' && progress.mcpName
                ? onNavigate({ page: 'mcp-detail', profileName: progress.mcpName })
                : onNavigate({ page: 'mcp-list' })
            }
          />
          <SetupStep
            index={3}
            status={progress.client}
            title={t('client.title')}
            hint={
              progress.client === 'done'
                ? t('client.done')
                : progress.client === 'current'
                  ? t('client.hint')
                  : t('client.blocked')
            }
            actionLabel={t('client.action')}
            onAction={
              progress.mcpName
                ? () =>
                    onNavigate({
                      page: 'mcp-detail',
                      profileName: progress.mcpName as string,
                      activeSection: 'connect',
                    })
                : undefined
            }
            secondaryActionLabel={progress.client === 'current' ? t('client.recheck') : undefined}
            onSecondaryAction={() => void load()}
          />
        </ol>
      )}
    </section>
  );
}

interface SetupStepProps {
  index: number;
  status: SetupStepStatus;
  title: string;
  hint: string;
  /** Renders the hint as an error (e.g. a failed source sync). */
  alert?: boolean;
  actionLabel: string;
  /** Omitted when the step cannot be started yet. */
  onAction?: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
}

function SetupStep({
  index,
  status,
  title,
  hint,
  alert = false,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
}: SetupStepProps) {
  const t = useTranslations('onboarding.checklist');
  return (
    <li
      className="flex items-start gap-3"
      aria-current={status === 'current' ? 'step' : undefined}
      data-status={status}
    >
      <span
        className={`flex-none w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold ${
          status === 'done'
            ? 'bg-emerald-500/15 text-emerald-300'
            : status === 'current'
              ? 'bg-os-500/20 text-os-300 ring-1 ring-os-500/40'
              : 'bg-gray-800 text-gray-500'
        }`}
        aria-hidden="true"
      >
        {status === 'done' ? '✓' : index}
      </span>
      <div className="flex-1 min-w-0">
        <p className={`text-sm ${status === 'todo' ? 'text-gray-500' : 'text-gray-200'}`}>
          {title} <span className="sr-only">— {t(`status.${status}`)}</span>
        </p>
        <p
          className={`text-xs ${alert ? 'text-red-400' : 'text-gray-500'}`}
          role={alert ? 'alert' : undefined}
        >
          {hint}
        </p>
      </div>
      {onAction && status !== 'todo' && (
        <button
          type="button"
          onClick={onAction}
          className={`flex-none text-[11px] font-semibold rounded-md px-2.5 py-1 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-os-500/40 ${
            status === 'current'
              ? 'bg-os-600 hover:bg-os-500 text-white'
              : 'text-os-300 bg-os-500/10 hover:bg-os-500/20'
          }`}
        >
          {actionLabel}
        </button>
      )}
      {secondaryActionLabel && onSecondaryAction && (
        <button
          type="button"
          onClick={onSecondaryAction}
          className="flex-none text-[11px] text-os-300 hover:underline rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-os-500/40"
        >
          {secondaryActionLabel}
        </button>
      )}
    </li>
  );
}
