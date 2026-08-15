// Dashboard page — pipeline-first redesign. The page reads as the system in
// one line (Sources → Data Configurations → MCP Servers), followed by the
// activity charts, the governance column (needs attention / PII / feed) and
// the servers table. Chart data is aggregated client-side from the
// recent-activity feed (no daily-series endpoint exists).

import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Button, PageHeader } from '../components/ui/index.js';
import PipelineStrip from '../components/dashboard/PipelineStrip.js';
import QueriesCard from '../components/dashboard/QueriesCard.js';
import ServersTable from '../components/dashboard/ServersTable.js';
import { timeAgo } from '../components/dashboard/activity-stats.js';
import { getConfigurationColumnMasking } from '../lib/configuration-accessors.js';
import { apiFetch } from '../lib/api.js';
import type {
  DatabaseSchema,
  Configuration,
  Profile,
  NamedConnection,
  ServeStatus,
  AuditLogEntry,
} from '../types/schema.js';
import type { View } from '../router/index.js';
import { useSession } from '../context/SessionContext.js';

interface DashboardPageProps {
  setView: Dispatch<SetStateAction<View>>;
  profiles: Profile[];
  configurations: Configuration[];
  connections: NamedConnection[];
  connectionSchemas: Record<string, DatabaseSchema>;
  serveStatus: ServeStatus;
  recentActivity: AuditLogEntry[];
  activeMcpCount: number;
  totalMcpCount: number;
  connectedCount: number;
  pendingWriteCount: number;
}

const QUICK_NAV = [
  {
    label: 'USERS',
    description: 'Manage user accounts and permissions',
    dot: 'bg-purple-500',
    page: 'users' as const,
  },
  {
    label: 'SETTINGS',
    description: 'AI, email, SSO, branding & notifications',
    dot: 'bg-amber-500',
    page: 'settings' as const,
  },
  {
    label: 'METRICS',
    description: 'Usage analytics and performance',
    dot: 'bg-cyan-500',
    page: 'metrics' as const,
  },
];

export default function DashboardPage({
  setView,
  profiles,
  configurations,
  connections,
  connectionSchemas,
  serveStatus,
  recentActivity,
  activeMcpCount,
  totalMcpCount,
  connectedCount,
  pendingWriteCount,
}: DashboardPageProps) {
  const { setShowOnboarding, ragEnabled } = useSession();

  // Knowledge-base sources count — SQL connections arrive via props, RAG
  // sources only exist behind /api/rag/sources (EE capability). Fetched here
  // so the "Sources" pipeline stage counts both kinds.
  const [ragSourceCount, setRagSourceCount] = useState(0);
  useEffect(() => {
    if (!ragEnabled) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/rag/sources', { credentials: 'include' });
        if (!res.ok) return;
        const data = (await res.json()) as { sources?: unknown[] };
        if (!cancelled) setRagSourceCount(data.sources?.length ?? 0);
      } catch {
        // capability probe only — ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ragEnabled]);

  // PII protection numbers — no masked-fields runtime metric exists, so show
  // what the configurations actually declare: masked columns across configs.
  const maskedColumnsPerConfig = configurations.map((cfg) =>
    Object.values(getConfigurationColumnMasking(cfg)).reduce(
      (sum, cols) => sum + Object.values(cols).filter((m) => m.maskingMode !== 'none').length,
      0,
    ),
  );
  const totalMaskedColumns = maskedColumnsPerConfig.reduce((a, b) => a + b, 0);
  const configsWithMasking = maskedColumnsPerConfig.filter((n) => n > 0).length;
  const maskingShare = configurations.length > 0 ? configsWithMasking / configurations.length : 0;

  const attentionCount = pendingWriteCount > 0 ? 1 : 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Dashboard"
        description="Overview of your MCP servers, sources, and activity."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setShowOnboarding(true)}>
              Get started
            </Button>
            <Button variant="primary" onClick={() => setView({ page: 'mcp-list' })}>
              New MCP server
            </Button>
          </div>
        }
      />

      {/* The system in one line — the pipeline is the structure of the page */}
      <PipelineStrip
        setView={setView}
        connections={connections}
        connectionSchemas={connectionSchemas}
        configurations={configurations}
        profiles={profiles}
        serveStatus={serveStatus}
        connectedCount={connectedCount}
        ragSourceCount={ragSourceCount}
        activeMcpCount={activeMcpCount}
        totalMcpCount={totalMcpCount}
      />

      {/* Main grid: charts + servers on the left, governance column right */}
      <div className="grid grid-cols-1 md:grid-cols-[1.7fr_1fr] gap-4 items-start">
        <div className="space-y-4 min-w-0">
          <QueriesCard
            recentActivity={recentActivity}
            profiles={profiles}
            serveStatus={serveStatus}
          />
          <ServersTable
            setView={setView}
            profiles={profiles}
            serveStatus={serveStatus}
            recentActivity={recentActivity}
          />
        </div>

        <div className="space-y-4 min-w-0">
          {/* Needs attention */}
          <div
            className={`card-primary p-4 anim-rise-in ${attentionCount > 0 ? 'border-amber-700/30' : ''}`}
            style={{ animationDelay: '160ms' }}
          >
            <h2 className="text-sm font-semibold text-gray-100">Needs attention</h2>
            <p className="font-mono-plex text-[11px] text-gray-500 mb-2">
              {attentionCount} item{attentionCount !== 1 ? 's' : ''}
            </p>
            {pendingWriteCount > 0 ? (
              <div className="flex items-start gap-2.5 py-1 text-sm">
                <span
                  className="flex-none w-[18px] h-[18px] rounded-md bg-rose-400/10 flex items-center justify-center mt-0.5"
                  aria-hidden="true"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path
                      d="M5 1v5M5 8.6v.4"
                      stroke="rgb(251 113 133)"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
                <p className="text-amber-300 leading-snug">
                  {pendingWriteCount} write request{pendingWriteCount !== 1 ? 's' : ''} awaiting
                  your approval
                </p>
                <button
                  type="button"
                  onClick={() => setView({ page: 'pending-writes' })}
                  className="ml-auto flex-none font-semibold text-[11px] text-os-300 bg-os-500/10 hover:bg-os-500/20 rounded-md px-2.5 py-1 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-os-500/40"
                >
                  Review
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 py-1 text-sm text-gray-500">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
                All clear — nothing needs your attention.
              </div>
            )}
          </div>

          {/* PII protection */}
          <div className="card-primary p-4 anim-rise-in" style={{ animationDelay: '220ms' }}>
            <h2 className="text-sm font-semibold text-gray-100">PII protection</h2>
            <p className="font-mono-plex text-[11px] text-gray-500 mb-2">column masking</p>
            {configurations.length > 0 ? (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-display font-light text-4xl tracking-tight text-gray-100 tabular-nums">
                    {totalMaskedColumns}
                  </span>
                  <span className="text-xs text-gray-500 text-right leading-relaxed">
                    masked column{totalMaskedColumns !== 1 ? 's' : ''} across
                    <br />
                    {configsWithMasking} of {configurations.length} configuration
                    {configurations.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <div
                  className="mt-2.5 h-1 rounded-sm bg-white/5 overflow-hidden"
                  role="img"
                  aria-label={`${configsWithMasking} of ${configurations.length} configurations use masking`}
                >
                  <div
                    className="h-full rounded-sm bg-purple-400 anim-grow-x"
                    style={{ transform: `scaleX(${maskingShare})`, animationDelay: '900ms' }}
                  />
                </div>
              </>
            ) : (
              <p className="text-sm text-gray-500">
                No Data Configurations yet — masking is set per configuration.
              </p>
            )}
          </div>

          {/* Recent activity */}
          {recentActivity.length > 0 && (
            <div className="card-primary p-4 anim-rise-in" style={{ animationDelay: '280ms' }}>
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-semibold text-gray-100">Recent activity</h2>
                <span className="font-mono-plex text-[11px] text-gray-500">
                  {recentActivity.length} events
                </span>
              </div>
              <p className="font-mono-plex text-[11px] text-gray-500 mb-1.5">audit log</p>
              <div>
                {recentActivity.slice(0, 8).map((entry) => (
                  <div
                    key={entry.id}
                    className="py-1.5 border-b border-white/5 last:border-0 flex items-center gap-2.5"
                  >
                    <span
                      className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${
                        entry.result === 'success' ? 'bg-emerald-400' : 'bg-rose-400'
                      }`}
                      title={entry.result === 'success' ? 'Success' : 'Error'}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono-plex text-xs text-gray-200 truncate">
                          {entry.toolName}
                        </span>
                        <span className="font-mono-plex text-[10px] px-2 py-0.5 rounded-full bg-os-500/10 text-os-300 ring-1 ring-os-500/20 flex-shrink-0">
                          {entry.profileName}
                        </span>
                      </div>
                      {entry.resultSummary && (
                        <p className="text-xs text-gray-500 truncate mt-0.5">
                          {entry.resultSummary}
                        </p>
                      )}
                    </div>
                    <span className="font-mono-plex text-[11px] text-gray-600 flex-shrink-0 whitespace-nowrap">
                      {timeAgo(entry.timestamp)}
                    </span>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setView({ page: 'audit-log' })}
                className="mt-2 text-xs text-os-300 hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-os-500/40 rounded"
              >
                Open audit log
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Quick nav: Users / Settings / Metrics */}
      <div
        className="grid grid-cols-1 md:grid-cols-3 gap-3 anim-rise-in"
        style={{ animationDelay: '320ms' }}
      >
        {QUICK_NAV.map((tile) => (
          <button
            key={tile.page}
            type="button"
            onClick={() => setView({ page: tile.page })}
            className="card-interactive group p-3 flex items-center gap-3 text-left"
          >
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${tile.dot}`} aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <div className="eyebrow mb-0.5">{tile.label}</div>
              <p className="text-xs text-gray-400 truncate">{tile.description}</p>
            </div>
            <span className="font-mono-plex text-sm text-gray-600 group-hover:text-os-400 transition-colors flex-shrink-0">
              &rarr;
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
