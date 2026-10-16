import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl/react';
import { apiFetch, getCurrentTenant } from '../lib/api.js';
import { SETUP_REFRESH_EVENT } from './SetupChecklist.js';

/**
 * "Test MCP" button for an active profile. Calls the deterministic backend
 * probe (`POST /api/serve/mcp-probe`): connect, initialize, tools/list — no
 * LLM provider involved and no tool called. Stays available on a stopped
 * server so the probe can report it; a start or stop clears the last result.
 *
 * The run state and last result are shared per profile, so the MCP list card
 * and the MCP detail page show the same test (and the setup guide is told to
 * re-read the outcome the server kept).
 */

type ProbeErrorCategory = 'config' | 'auth' | 'unreachable' | 'timeout' | 'protocol' | 'backend';

interface ProbeError {
  category: ProbeErrorCategory;
  stage?: string;
  code?: string;
  message: string;
  action: string;
  detail?: string;
  httpStatus?: number;
}

type ProbeResult =
  | { success: true; tools: { name: string; description: string }[]; durationMs?: number }
  | { success: false; error: ProbeError };

const CATEGORIES: ProbeErrorCategory[] = [
  'config',
  'auth',
  'unreachable',
  'timeout',
  'protocol',
  'backend',
];

interface ProbeEntry {
  running: boolean;
  result: ProbeResult | null;
  /** Server state the result was obtained in — a start or stop makes it stale. */
  isActive: boolean;
}

const probes = new Map<string, ProbeEntry>();
const listeners = new Set<() => void>();

const probeKey = (profileName: string) => `${getCurrentTenant()}/${profileName}`;

function setEntry(key: string, entry: ProbeEntry | undefined) {
  if (entry) probes.set(key, entry);
  else probes.delete(key);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test helper: forget every shared probe state. */
export function resetMcpProbes() {
  probes.clear();
  listeners.forEach((listener) => listener());
}

function useMcpProbe(profileName: string, isActive: boolean) {
  const t = useTranslations('serveTunnel.servePanel.mcpProbe');
  const key = probeKey(profileName);
  const entry = useSyncExternalStore(subscribe, () => probes.get(key));

  // A result obtained before a start or stop no longer describes the server.
  const previousActive = useRef(isActive);
  useEffect(() => {
    if (previousActive.current !== isActive && !probes.get(key)?.running) setEntry(key, undefined);
    previousActive.current = isActive;
  }, [isActive, key]);

  const runProbe = useCallback(async () => {
    const finish = (result: ProbeResult) => setEntry(key, { running: false, result, isActive });
    setEntry(key, { running: true, result: null, isActive });
    let res: Response;
    try {
      res = await apiFetch('/api/serve/mcp-probe', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileName }),
      });
    } catch (err) {
      finish({
        success: false,
        error: {
          category: 'unreachable',
          message: t('networkError.message'),
          action: t('networkError.action'),
          detail: err instanceof Error ? err.message : String(err),
        },
      });
      return;
    }
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // Non-JSON body (proxy page, crash) — handled below.
    }
    const body = data as Partial<ProbeResult> | null;
    if (body?.success === true && Array.isArray(body.tools)) {
      finish({ success: true, tools: body.tools, durationMs: body.durationMs });
    } else if (
      body?.success === false &&
      body.error &&
      CATEGORIES.includes(body.error.category) &&
      typeof body.error.message === 'string'
    ) {
      // A stopped server is worded here, in the UI language.
      finish({
        success: false,
        error:
          body.error.code === 'server_stopped'
            ? {
                ...body.error,
                message: t('serverStopped.message'),
                action: t('serverStopped.action'),
              }
            : body.error,
      });
    } else {
      const fallback = (data as { error?: unknown; message?: unknown } | null) ?? {};
      const raw = typeof fallback.error === 'string' ? fallback.error : fallback.message;
      finish({
        success: false,
        error: {
          category: 'backend',
          message: t('unexpectedResponse.message', { status: res.status }),
          action: t('unexpectedResponse.action'),
          httpStatus: res.status,
          detail: typeof raw === 'string' ? raw : undefined,
        },
      });
    }
    // The server kept this outcome: let the setup guide (step 4) reflect it.
    window.dispatchEvent(new Event(SETUP_REFRESH_EVENT));
  }, [key, isActive, profileName, t]);

  return {
    running: entry?.running === true,
    result: entry && entry.isActive === isActive ? entry.result : null,
    runProbe,
  };
}

interface McpProbeProps {
  profileName: string;
  isActive: boolean;
}

/** The "Test MCP" button alone (MCP detail page header, next to Start/Stop). */
export function McpProbeButton({
  profileName,
  isActive,
  className,
}: McpProbeProps & { className?: string }) {
  const t = useTranslations('serveTunnel.servePanel.mcpProbe');
  const { running, runProbe } = useMcpProbe(profileName, isActive);
  return (
    <button
      onClick={runProbe}
      disabled={running}
      title={t('tooltip')}
      className={
        className ??
        'text-xs text-os-400 hover:text-os-300 transition-colors focus:outline-none focus:ring-1 focus:ring-os-500 rounded disabled:opacity-50'
      }
    >
      {running ? t('running') : t('button')}
    </button>
  );
}

/** The last "Test MCP" outcome of a profile: discovered tools, or the classified error. */
export function McpProbeResult({ profileName, isActive }: McpProbeProps) {
  const t = useTranslations('serveTunnel.servePanel.mcpProbe');
  const { result } = useMcpProbe(profileName, isActive);
  return (
    <>
      {result?.success === true && (
        <div
          role="status"
          data-testid="mcp-probe-result"
          className="mt-2 p-2 rounded-lg bg-green-950/30 border border-green-800/50 text-xs text-green-300 space-y-1"
        >
          <p className="font-medium">{t('success', { count: result.tools.length })}</p>
          {result.tools.length > 0 && (
            <p className="font-mono text-green-200/80 break-words">
              {result.tools.map((tool) => tool.name).join(', ')}
            </p>
          )}
          <p className="text-gray-400">{t('scope')}</p>
        </div>
      )}

      {result?.success === false && (
        <div
          role="alert"
          data-testid="mcp-probe-result"
          className="mt-2 p-2 rounded-lg bg-red-950/30 border border-red-800/50 text-xs text-red-300 space-y-1"
        >
          <p className="font-medium">{t(`categories.${result.error.category}`)}</p>
          <p>{result.error.message}</p>
          {result.error.action && (
            <p className="text-red-200">{t('action', { action: result.error.action })}</p>
          )}
          {(result.error.detail || result.error.stage || result.error.httpStatus) && (
            <details className="text-gray-400">
              <summary className="cursor-pointer">{t('technicalDetails')}</summary>
              <p className="font-mono break-words">
                {[
                  result.error.stage && `stage=${result.error.stage}`,
                  result.error.httpStatus && `http=${result.error.httpStatus}`,
                  result.error.detail,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </details>
          )}
        </div>
      )}
    </>
  );
}

/** Button and result together, as shown on the MCP list cards. */
export default function McpProbe({ profileName, isActive }: McpProbeProps) {
  return (
    <div className="mt-2" onClick={(e) => e.stopPropagation()}>
      <McpProbeButton profileName={profileName} isActive={isActive} />
      <McpProbeResult profileName={profileName} isActive={isActive} />
    </div>
  );
}
