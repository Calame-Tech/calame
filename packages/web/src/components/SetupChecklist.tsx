// Guided first-run path in four steps: 1. connect data, 2. create a data
// profile that contains it, 3. create an MCP attached to that profile,
// 4. connect / test the MCP from a client. Shown on every page and always part
// of the page layout (never over it): expanded, a column on the right of a wide
// window or a block above the content of a narrow one; folded, a pill above
// the content. Once a client has used the first MCP it shows a success state
// until the user closes it. Each step reflects server-side resources
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
 * Set only when the user closes the success state (4/4): from then on the
 * guide is neither shown nor queried again.
 */
export const SETUP_CHECKLIST_DISMISSED_KEY = 'calame.setupChecklist.dismissed';
/**
 * Former flag, written automatically as soon as a client call was observed —
 * before the user could ever see the success state. It is ignored (and
 * cleared on close) so those installations get the success state once.
 */
export const SETUP_CHECKLIST_LEGACY_HIDDEN_KEY = 'calame.setupChecklist.hidden';
/** Set while the user has folded the card; a button reopens it. */
export const SETUP_CHECKLIST_COLLAPSED_KEY = 'calame.setupChecklist.collapsed';

/** Window event asking the guide to re-check the server (e.g. a source list refresh). */
export const SETUP_REFRESH_EVENT = 'calame:setup-refresh';

/** Upper bound on per-MCP audit lookups — first runs have one or two MCPs. */
const MAX_PROFILES_CHECKED = 10;

/**
 * While step 4 waits for a first client call, the guide re-checks the server
 * on its own — bounded, so a forgotten tab does not poll forever (focus and
 * "Check again" still work afterwards).
 */
export const SETUP_POLL_INTERVAL_MS = 10_000;
export const SETUP_POLL_MAX_ATTEMPTS = 60;

/**
 * Below this width the content is too narrow to give up a column: the expanded
 * guide becomes a block above the content, and it starts folded as a pill.
 */
const NARROW_WINDOW_QUERY = '(max-width: 899px)';

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
  /**
   * Called with where the guide sits in the page layout, so the page lays its
   * content beside ('column') or below ('top') it; 'none' when nothing shows.
   */
  onLayoutChange?: (layout: SetupGuideLayout) => void;
}

export type SetupGuideLayout = 'none' | 'top' | 'column';

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
  onLayoutChange,
}: SetupChecklistProps) {
  const t = useTranslations('onboarding.checklist');
  const [hidden, setHidden] = useState(() => readFlag(SETUP_CHECKLIST_DISMISSED_KEY));
  const [narrow, setNarrow] = useState(() => narrowWindowQuery()?.matches === true);
  const [collapsed, setCollapsed] = useState(
    () => readFlag(SETUP_CHECKLIST_COLLAPSED_KEY) || narrowWindowQuery()?.matches === true,
  );
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  // Only the latest request may update the state: a slow response must not
  // overwrite a newer one (e.g. a refresh triggered by a new source).
  const requestIdRef = useRef(0);
  // Requests in flight: a periodic check is skipped while one is pending.
  const inFlightRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    inFlightRef.current += 1;
    try {
      const data = await fetchSetupResources(ragEnabled);
      if (requestId === requestIdRef.current) setState({ status: 'ready', ...data });
    } catch {
      if (requestId === requestIdRef.current) setState({ status: 'error' });
    } finally {
      inFlightRef.current -= 1;
    }
  }, [ragEnabled]);

  // Fold (without remembering it) when the window becomes narrow, so the block
  // does not push the page down; the pill still reopens it.
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

  // Re-check when the user comes back to Calame (typically after trying the
  // MCP from their AI client), after an action that changes a step (see
  // SETUP_REFRESH_EVENT) or when asked explicitly.
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
  // shows a success state until the user closes it.
  const allDone = progress?.allDone ?? false;

  // Step 4 completes on a call made from another application: poll (bounded,
  // never overlapping a pending request, paused while the tab is hidden) until
  // it is observed.
  const waitingForClient = !hidden && progress?.client === 'current';
  useEffect(() => {
    if (!waitingForClient) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden' || inFlightRef.current > 0) return;
      attempts += 1;
      if (attempts >= SETUP_POLL_MAX_ATTEMPTS) window.clearInterval(timer);
      void load();
    }, SETUP_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [waitingForClient, load]);

  // Only an explicit close hides the guide for good.
  const dismiss = () => {
    writeFlag(SETUP_CHECKLIST_DISMISSED_KEY, true);
    writeFlag(SETUP_CHECKLIST_LEGACY_HIDDEN_KEY, false);
    setHidden(true);
  };

  const setFolded = (value: boolean) => {
    writeFlag(SETUP_CHECKLIST_COLLAPSED_KEY, value);
    setCollapsed(value);
  };

  // On a narrow window, a step action leads to a page that the open block
  // would push down: fold it back to the pill (without remembering it).
  const navigate = (view: View) => {
    if (narrow) setCollapsed(true);
    onNavigate(view);
  };

  // Wide window, expanded: a column beside the content (which loses that
  // width); otherwise the pill or the block sits above the content.
  const visible = !hidden && state.status !== 'idle';
  const docked = visible && !collapsed && !narrow;
  const layout: SetupGuideLayout = !visible ? 'none' : docked ? 'column' : 'top';
  useEffect(() => {
    onLayoutChange?.(layout);
  }, [layout, onLayoutChange]);
  useEffect(() => () => onLayoutChange?.('none'), [onLayoutChange]);

  // Nothing is shown before the first answer, so an installation that already
  // has a used MCP never flashes the guide.
  if (hidden || state.status === 'idle') return null;

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

  // Below the fixed mobile menu button, aligned with the page padding.
  const topBlockClass = 'flex-none px-6 md:px-8 pt-16 md:pt-6';

  if (collapsed) {
    return (
      <div data-testid="setup-checklist-pill-row" className={`${topBlockClass} flex justify-end`}>
        <button
          type="button"
          onClick={() => setFolded(false)}
          aria-label={t('showAriaLabel')}
          className="max-w-full rounded-full bg-os-600 hover:bg-os-500 text-white text-xs font-semibold px-4 py-2 shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-os-300 flex items-center gap-2"
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
          {allDone && (
            <span className="min-w-0 truncate font-normal" data-testid="setup-pill-step">
              {t('success.pill')}
            </span>
          )}
        </button>
      </div>
    );
  }

  const panel = (
    <section
      data-testid="setup-checklist-panel"
      data-layout={layout}
      className={
        docked
          ? // A column of the layout, viewport-high with its own scroll: the
            // content beside it is narrower, never covered.
            'flex-none w-[22rem] self-start sticky top-0 h-screen overflow-y-auto bg-gray-950 border-l border-gray-800 p-4'
          : 'card-primary p-4'
      }
      aria-labelledby="setup-checklist-title"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id="setup-checklist-title" className="text-sm font-semibold text-gray-100">
          {allDone
            ? t('reopen', { done: SETUP_STEPS.length, total: SETUP_STEPS.length })
            : t('title')}
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
      {allDone && progress ? (
        <div data-testid="setup-success" className="mt-2 space-y-3">
          <div role="status" className="space-y-1">
            <p className="text-sm font-semibold text-emerald-300">{t('success.congrats')}</p>
            <p className="text-xs text-gray-300">✓ {t('client.done')}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1.5">{t('success.next')}</p>
            <div className="flex flex-wrap items-center gap-2">
              {progress.mcpName && (
                <button
                  type="button"
                  onClick={() =>
                    navigate({ page: 'mcp-detail', profileName: progress.mcpName as string })
                  }
                  className="text-[11px] font-semibold rounded-md px-2.5 py-1 text-os-300 bg-os-500/10 hover:bg-os-500/20 focus:outline-none focus-visible:ring-1 focus-visible:ring-os-500/40"
                >
                  {t('success.openMcp')}
                </button>
              )}
              <button
                type="button"
                onClick={() => navigate({ page: 'audit-log' })}
                className="text-[11px] font-semibold rounded-md px-2.5 py-1 text-os-300 bg-os-500/10 hover:bg-os-500/20 focus:outline-none focus-visible:ring-1 focus-visible:ring-os-500/40"
              >
                {t('success.auditLog')}
              </button>
              <button
                type="button"
                onClick={() => navigate({ page: 'sources' })}
                className="text-[11px] font-semibold rounded-md px-2.5 py-1 text-os-300 bg-os-500/10 hover:bg-os-500/20 focus:outline-none focus-visible:ring-1 focus-visible:ring-os-500/40"
              >
                {t('success.addData')}
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-gray-800 pt-3">
            <span className="text-[11px] text-gray-500">{t('success.closeHint')}</span>
            <button
              type="button"
              onClick={dismiss}
              className="flex-none text-[11px] font-semibold rounded-md px-2.5 py-1 bg-os-600 hover:bg-os-500 text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-os-500/40"
            >
              {t('success.close')}
            </button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-gray-500 mb-3">{t('description')}</p>
      )}

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

      {progress && steps && !allDone && (
        <ol className="space-y-2">
          {SETUP_STEPS.map((id, i) => (
            <SetupStep key={id} index={i + 1} status={progress[id]} {...steps[id]} />
          ))}
        </ol>
      )}
    </section>
  );

  // Narrow window: a block above the content, which it pushes down.
  return docked ? panel : <div className={topBlockClass}>{panel}</div>;
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
