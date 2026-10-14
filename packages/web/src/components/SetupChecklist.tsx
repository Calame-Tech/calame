// Guided first-run path in three steps: 1. connect a source, 2. create the
// MCP, 3. use it from a client. Each step reflects server-side resources (see
// lib/setup-progress.ts) and links to the existing screen that performs it —
// this component never creates anything itself.

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'use-intl/react';
import { apiFetch } from '../lib/api.js';
import {
  computeSetupProgress,
  type SavedProfileSummary,
  type SetupProgress,
  type SetupStepStatus,
} from '../lib/setup-progress.js';
import type { AuditLogEntry } from '../types/schema.js';
import type { View } from '../router/index.js';

/** Same cadence as the dashboard's recent-activity poller. */
const POLL_INTERVAL_MS = 15_000;

interface SetupChecklistProps {
  /** Database connections + knowledge-base sources, as already loaded by the page. */
  sourceCount: number;
  onNavigate: (view: View) => void;
  /** Bump to force a reload (e.g. the session `dataVersion`). */
  refreshKey?: number;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; profiles: SavedProfileSummary[]; audit: AuditLogEntry[] };

async function fetchSetupResources(): Promise<{
  profiles: SavedProfileSummary[];
  audit: AuditLogEntry[];
}> {
  const [profilesRes, auditRes] = await Promise.all([
    apiFetch('/api/profiles/load', { credentials: 'include' }),
    apiFetch('/api/audit?limit=100&offset=0', { credentials: 'include' }),
  ]);
  if (!profilesRes.ok || !auditRes.ok) throw new Error('setup resources unavailable');
  const profilesData = (await profilesRes.json()) as {
    found?: boolean;
    profiles?: Record<string, Omit<SavedProfileSummary, 'name'>>;
  };
  const auditData = (await auditRes.json()) as { entries?: AuditLogEntry[] };
  const profiles = Object.entries(profilesData.found ? (profilesData.profiles ?? {}) : {}).map(
    ([name, p]) => ({ name, configurations: p.configurations, sources: p.sources }),
  );
  return { profiles, audit: auditData.entries ?? [] };
}

export default function SetupChecklist({
  sourceCount,
  onNavigate,
  refreshKey = 0,
}: SetupChecklistProps) {
  const t = useTranslations('onboarding.checklist');
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const load = useCallback(async () => {
    try {
      const data = await fetchSetupResources();
      setState({ status: 'ready', ...data });
    } catch {
      setState({ status: 'error' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, sourceCount, refreshKey]);

  const progress: SetupProgress | null =
    state.status === 'ready'
      ? computeSetupProgress({
          sourceCount,
          savedProfiles: state.profiles,
          auditEntries: state.audit,
        })
      : null;

  // Keep polling until a client call shows up in the audit log.
  const allDone = progress?.allDone ?? false;
  useEffect(() => {
    if (allDone) return;
    const interval = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [allDone, load]);

  if (allDone) return null;

  return (
    <section className="card-primary p-4" aria-labelledby="setup-checklist-title">
      <h2 id="setup-checklist-title" className="text-sm font-semibold text-gray-100">
        {t('title')}
      </h2>
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
            hint={progress.source === 'done' ? t('source.done') : t('source.hint')}
            actionLabel={t('source.action')}
            onAction={() => onNavigate({ page: 'sources' })}
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
  actionLabel: string;
  /** Omitted when the step cannot be started yet. */
  onAction?: () => void;
}

function SetupStep({ index, status, title, hint, actionLabel, onAction }: SetupStepProps) {
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
        <p className="text-xs text-gray-500">{hint}</p>
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
    </li>
  );
}
