// Guided first-run path in four steps: 1. connect data, 2. create a data
// profile that contains it, 3. create an MCP attached to that profile,
// 4. connect / test the MCP from a client. Shown as a floating card on every
// page until the first MCP is used; each step reflects server-side resources
// (see lib/setup-progress.ts) and links to the existing screen that performs
// it — this component never creates anything itself.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl/react';
import { apiFetch } from '../lib/api.js';
import {
  computeSetupProgress,
  mcpProfileNames,
  SETUP_STEPS,
  type DataProfileSummary,
  type SavedProfileSummary,
  type SetupStepId,
  type SetupProgress,
  type SetupStepStatus,
} from '../lib/setup-progress.js';
import { fetchRagReadiness, type RagSourceReadiness } from '../lib/rag-source-readiness.js';
import type { AuditLogEntry } from '../types/schema.js';
import type { View } from '../router/index.js';

/**
 * Set once a client call has been observed, so an installation that already
 * works never shows the guide (nor queries for it) again.
 */
export const SETUP_CHECKLIST_HIDDEN_KEY = 'calame.setupChecklist.hidden';
/** Set while the user has folded the card; a button reopens it. */
export const SETUP_CHECKLIST_COLLAPSED_KEY = 'calame.setupChecklist.collapsed';

/** Window event asking the guide to re-check the server (e.g. a source list refresh). */
export const SETUP_REFRESH_EVENT = 'calame:setup-refresh';

/** Upper bound on per-MCP audit lookups — first runs have one or two MCPs. */
const MAX_PROFILES_CHECKED = 10;

/**
 * Below this width the expanded card would cover page actions (e.g. "+ New
 * source" on a ~750 px desktop window): it starts folded as a compact pill.
 */
const NARROW_WINDOW_QUERY = '(max-width: 1023px)';

function narrowWindowQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(NARROW_WINDOW_QUERY) : null;
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    if (value) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    // Storage unavailable (private mode…): the state just lasts for this session.
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
  /** Any change (by identity) forces a reload, e.g. a navigation or a save. */
  refreshKey?: unknown;
}

/** Last "Test MCP" outcome of a profile, as kept by the server (GET /api/serve/mcp-probe/last). */
export type LastMcpProbe =
  | { success: true; at: string; toolCount?: number }
  | { success: false; at: string; error: { category: string; code?: string } };

const PROBE_REASONS = ['config', 'auth', 'unreachable', 'timeout', 'protocol', 'backend'];

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | {
      status: 'ready';
      dataProfiles: DataProfileSummary[];
      profiles: SavedProfileSummary[];
      audit: AuditLogEntry[];
      ragSources: RagSourceReadiness[];
      probes: Record<string, LastMcpProbe>;
    };

async function fetchJson<T>(url: string): Promise<T> {
  const res = await apiFetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('setup resources unavailable');
  return (await res.json()) as T;
}

/**
 * Data profiles and saved MCPs, plus at most one successful audited call per
 * MCP attached to a data profile with data — a targeted lookup (`result=success&limit=1`) instead of pulling the
 * whole recent audit log on every refresh.
 */
async function fetchSetupResources(ragEnabled: boolean): Promise<{
  dataProfiles: DataProfileSummary[];
  profiles: SavedProfileSummary[];
  audit: AuditLogEntry[];
  ragSources: RagSourceReadiness[];
  probes: Record<string, LastMcpProbe>;
}> {
  const ragSourcesPromise = ragEnabled ? fetchRagReadiness() : Promise.resolve([]);
  // Informative only: the guide still loads if the probe results are unavailable.
  const probesPromise = fetchJson<{ results?: Record<string, LastMcpProbe> }>(
    '/api/serve/mcp-probe/last',
  ).then(
    (data) => data.results ?? {},
    () => ({}),
  );
  const [configurationsData, profilesData] = await Promise.all([
    // Indexed by data profile name, like the profiles below (see useAppData).
    fetchJson<{
      configurations?: Record<string, Omit<DataProfileSummary, 'name'>>;
    }>('/api/configurations'),
    fetchJson<{
      found?: boolean;
      profiles?: Record<string, Omit<SavedProfileSummary, 'name'>>;
    }>('/api/profiles/load'),
  ]);
  const dataProfiles = Object.entries(configurationsData.configurations ?? {}).map(([name, c]) => ({
    name,
    sources: c.sources,
  }));
  const profiles = Object.entries(profilesData.found ? (profilesData.profiles ?? {}) : {}).map(
    ([name, p]) => ({ name, configurations: p.configurations, sources: p.sources }),
  );
  const mcpNames = mcpProfileNames(profiles, dataProfiles).slice(0, MAX_PROFILES_CHECKED);
  const auditPages = await Promise.all(
    mcpNames.map((name) =>
      fetchJson<{ entries?: AuditLogEntry[] }>(
        `/api/audit?profileName=${encodeURIComponent(name)}&result=success&limit=1&offset=0`,
      ),
    ),
  );
  return {
    dataProfiles,
    profiles,
    audit: auditPages.flatMap((page) => page.entries ?? []),
    ragSources: await ragSourcesPromise,
    probes: await probesPromise,
  };
}

export default function SetupChecklist({
  sourceCount,
  ragEnabled = false,
  onNavigate,
  refreshKey = 0,
}: SetupChecklistProps) {
  const t = useTranslations('onboarding.checklist');
  const [hidden, setHidden] = useState(() => readFlag(SETUP_CHECKLIST_HIDDEN_KEY));
  const [narrow, setNarrow] = useState(() => narrowWindowQuery()?.matches === true);
  const [collapsed, setCollapsed] = useState(
    () => readFlag(SETUP_CHECKLIST_COLLAPSED_KEY) || narrowWindowQuery()?.matches === true,
  );
  // Height of the floating card or pill, reserved at the bottom of the page
  // so the last commands of a page can always be scrolled clear of it.
  const [reservedHeight, setReservedHeight] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);
  const floatingRef = useCallback((el: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) {
      setReservedHeight(0);
      return;
    }
    const measure = () => setReservedHeight(el.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === 'function') {
      observerRef.current = new ResizeObserver(measure);
      observerRef.current.observe(el);
    }
  }, []);
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

  // Fold (without remembering it) when the window becomes narrow, so the card
  // never ends up over the page's commands; the pill still reopens it.
  useEffect(() => {
    const query = narrowWindowQuery();
    if (!query) return;
    const onChange = () => {
      setNarrow(query.matches);
      if (query.matches) setCollapsed(true);
    };
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);

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
    window.addEventListener(SETUP_REFRESH_EVENT, onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(SETUP_REFRESH_EVENT, onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [hidden, load]);

  const progress: SetupProgress | null =
    state.status === 'ready'
      ? computeSetupProgress({
          sourceCount,
          ragSources: state.ragSources,
          dataProfiles: state.dataProfiles,
          savedProfiles: state.profiles,
          auditEntries: state.audit,
        })
      : null;

  // The loop is complete once a client has used the first MCP: the guide
  // disappears for good.
  const allDone = progress?.allDone ?? false;
  useEffect(() => {
    if (!allDone) return;
    writeFlag(SETUP_CHECKLIST_HIDDEN_KEY, true);
    setHidden(true);
  }, [allDone]);

  const setFolded = (value: boolean) => {
    writeFlag(SETUP_CHECKLIST_COLLAPSED_KEY, value);
    setCollapsed(value);
  };

  // On a narrow window, a step action leads to a page whose commands the open
  // card would cover: fold it back to the pill (without remembering it).
  const navigate = (view: View) => {
    if (narrow) setCollapsed(true);
    onNavigate(view);
  };

  // Nothing is shown before the first answer, so an installation that already
  // has a used MCP never flashes the guide.
  if (hidden || allDone || state.status === 'idle') return null;

  // A saved source that is not indexed must not read as "connected": name it
  // (failed sync first) and point to it instead of to "Add data".
  const pendingSource =
    progress && progress.source !== 'done'
      ? (progress.failedSources[0] ?? progress.notReadySources[0] ?? null)
      : null;

  // Step 4 stays open until a client call is audited, but reflects the latest
  // "Test MCP" run on an attached MCP: verified connection, or why it failed.
  const lastProbe =
    progress?.client === 'current' && state.status === 'ready'
      ? mcpProfileNames(state.profiles, state.dataProfiles)
          .map((name) => state.probes[name])
          .filter((probe): probe is LastMcpProbe => Boolean(probe?.at))
          .sort((a, b) => b.at.localeCompare(a.at))[0]
      : undefined;
  const clientHint = !lastProbe
    ? t('client.hint')
    : lastProbe.success
      ? typeof lastProbe.toolCount === 'number'
        ? t('client.probeVerifiedTools', { count: lastProbe.toolCount })
        : t('client.probeVerified')
      : t('client.probeFailed', {
          reason: t(
            `client.probeReasons.${
              lastProbe.error.code === 'server_stopped'
                ? 'serverStopped'
                : PROBE_REASONS.includes(lastProbe.error.category)
                  ? lastProbe.error.category
                  : 'backend'
            }`,
          ),
        });

  const steps: Record<SetupStepId, Omit<SetupStepProps, 'index' | 'status'>> | null = progress
    ? {
        source: {
          title: t('source.title'),
          hint:
            progress.source === 'done'
              ? t('source.done')
              : pendingSource
                ? t(pendingSource.state === 'failed' ? 'source.syncFailed' : 'source.notReady', {
                    name: pendingSource.name,
                  })
                : t('source.hint'),
          alert: progress.source !== 'done' && progress.failedSources.length > 0,
          actionLabel: pendingSource ? t('source.openSource') : t('source.action'),
          onAction: () =>
            navigate(pendingSource ? { page: 'sources', tab: 'knowledge' } : { page: 'sources' }),
        },
        dataProfile: {
          title: t('dataProfile.title'),
          hint:
            progress.dataProfile === 'done'
              ? t('dataProfile.done')
              : progress.dataProfile === 'current'
                ? t('dataProfile.hint')
                : t('dataProfile.blocked'),
          actionLabel:
            progress.dataProfile === 'done' ? t('dataProfile.openAction') : t('dataProfile.action'),
          onAction: () =>
            progress.dataProfile === 'done' && progress.dataProfileName
              ? navigate({ page: 'config-detail', configName: progress.dataProfileName })
              : navigate({ page: 'configurations' }),
        },
        mcp: {
          title: t('mcp.title'),
          hint:
            progress.mcp === 'done'
              ? t('mcp.done')
              : progress.mcp === 'current'
                ? t('mcp.hint')
                : t('mcp.blocked'),
          actionLabel: progress.mcp === 'done' ? t('mcp.openAction') : t('mcp.action'),
          onAction: () =>
            progress.mcp === 'done' && progress.mcpName
              ? navigate({ page: 'mcp-detail', profileName: progress.mcpName })
              : navigate({ page: 'mcp-list' }),
        },
        client: {
          title: t('client.title'),
          hint:
            progress.client === 'done'
              ? t('client.done')
              : progress.client === 'current'
                ? clientHint
                : t('client.blocked'),
          alert: lastProbe?.success === false,
          actionLabel: t('client.action'),
          onAction: progress.mcpName
            ? () =>
                navigate({
                  page: 'mcp-detail',
                  profileName: progress.mcpName as string,
                  activeSection: 'connect',
                })
            : undefined,
          secondaryActionLabel: progress.client === 'current' ? t('client.recheck') : undefined,
          onSecondaryAction: () => void load(),
        },
      }
    : null;

  const spacer = (
    <div
      aria-hidden="true"
      data-testid="setup-checklist-spacer"
      style={{ height: reservedHeight ? reservedHeight + 24 : 0 }}
    />
  );

  if (collapsed) {
    return (
      <>
        {spacer}
        <button
          ref={floatingRef}
          type="button"
          onClick={() => setFolded(false)}
          aria-label={t('showAriaLabel')}
          className="fixed bottom-4 right-4 z-40 max-w-[calc(100vw-2rem)] rounded-full bg-os-600 hover:bg-os-500 text-white text-xs font-semibold px-4 py-2 shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-os-300 flex items-center gap-2"
        >
          <span className="flex-none">
            {progress
              ? t('reopen', { done: progress.doneCount, total: SETUP_STEPS.length })
              : t('title')}
          </span>
          {progress && steps && progress.currentStep && (
            <span className="min-w-0 truncate font-normal" data-testid="setup-pill-step">
              {steps[progress.currentStep].title}
            </span>
          )}
        </button>
      </>
    );
  }

  return (
    <>
      {spacer}
      <section
        ref={floatingRef}
        className="fixed bottom-4 right-4 z-40 w-[22rem] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] overflow-y-auto card-primary p-4 shadow-2xl"
        aria-labelledby="setup-checklist-title"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="setup-checklist-title" className="text-sm font-semibold text-gray-100">
            {t('title')}
          </h2>
          <button
            type="button"
            onClick={() => setFolded(true)}
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

        {progress && steps && progress.currentStep && (
          <p className="text-xs text-gray-300 mb-3" data-testid="setup-current-step">
            {t('currentStep', { step: steps[progress.currentStep].title })}
            {progress.nextStep && (
              <>
                <br />
                <span className="text-gray-500">
                  {t('nextStep', { step: steps[progress.nextStep].title })}
                </span>
              </>
            )}
          </p>
        )}

        {progress && steps && (
          <ol className="space-y-2">
            {SETUP_STEPS.map((id, i) => (
              <SetupStep key={id} index={i + 1} status={progress[id]} {...steps[id]} />
            ))}
          </ol>
        )}
      </section>
    </>
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
        {((onAction && status !== 'todo') || (secondaryActionLabel && onSecondaryAction)) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {onAction && status !== 'todo' && (
              <button
                type="button"
                onClick={onAction}
                className={`text-[11px] font-semibold rounded-md px-2.5 py-1 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-os-500/40 ${
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
                className="text-[11px] text-os-300 hover:underline rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-os-500/40"
              >
                {secondaryActionLabel}
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
