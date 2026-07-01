// Dashboard page (Phase 3 #14). JSX moved verbatim from the
// `view.page === 'dashboard'` branch of App.tsx.

import type { Dispatch, SetStateAction } from 'react';
import { Button, PageHeader, Eyebrow, KpiCard } from '../components/ui/index.js';
import HelpTip from '../components/HelpTip.js';
import { getConfigurationTableNames } from '../lib/configuration-accessors.js';
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
  hasActiveMcp: boolean;
  connectedCount: number;
  totalConnCount: number;
  hasConnections: boolean;
}

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
  hasActiveMcp,
  connectedCount,
  totalConnCount,
  hasConnections,
}: DashboardPageProps) {
  const { setShowOnboarding } = useSession();

  return (
    <div className="relative space-y-4">
      {/* Fixed background blobs */}
      <div className="fixed inset-0 -z-10 pointer-events-none overflow-hidden" aria-hidden="true">
        <div className="absolute -top-40 -left-40 w-[500px] h-[500px] bg-os-900/20 rounded-full blur-3xl" />
        <div className="absolute top-1/3 -right-40 w-[400px] h-[400px] bg-indigo-900/15 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 left-1/3 w-[450px] h-[450px] bg-os-800/10 rounded-full blur-3xl" />
      </div>

      {/* Page header */}
      <PageHeader
        title="Dashboard"
        description="Overview of your MCP servers, connections, and activity."
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

      {/* Status ribbon */}
      <div
        className="card-primary rounded-full px-4 py-2 flex flex-wrap items-center gap-3 animate-fade-in-up"
        style={{ animationDelay: '0ms' }}
      >
        <Eyebrow live>
          {activeMcpCount} server{activeMcpCount !== 1 ? 's' : ''} running
        </Eyebrow>
        <span className="eyebrow text-gray-700">·</span>
        <Eyebrow>
          {connectedCount} database{connectedCount !== 1 ? 's' : ''} connected
        </Eyebrow>
        <span className="eyebrow text-gray-700">·</span>
        <Eyebrow>
          {profiles.length} profile{profiles.length !== 1 ? 's' : ''}
        </Eyebrow>
        {recentActivity.length > 0 &&
          (() => {
            const last = recentActivity[0];
            const diffMs = Date.now() - new Date(last.timestamp).getTime();
            const diffMin = Math.floor(diffMs / 60000);
            const diffHour = Math.floor(diffMs / 3600000);
            const ago =
              diffMin < 1 ? 'just now' : diffMin < 60 ? `${diffMin}m ago` : `${diffHour}h ago`;
            return (
              <>
                <span className="eyebrow text-gray-700">·</span>
                <Eyebrow>last activity {ago}</Eyebrow>
              </>
            );
          })()}
      </div>

      {/* Resources grid: MCP Servers / Data Profiles / Databases */}
      <div
        className="grid grid-cols-1 md:grid-cols-3 gap-4 animate-fade-in-up"
        style={{ animationDelay: '80ms' }}
      >
        {/* MCP Servers */}
        <KpiCard
          accent="indigo"
          onClick={() => setView({ page: 'mcp-list' })}
          eyebrow={
            <Eyebrow dotColor={hasActiveMcp ? 'bg-emerald-400' : 'bg-gray-600'}>
              MCP SERVERS
              <HelpTip
                content="Start, stop and manage your MCP servers exposed to AI clients"
                position="bottom"
              />
            </Eyebrow>
          }
          value={
            <>
              <span className="text-3xl">{activeMcpCount}</span>
              <span className="text-lg text-gray-500">/{totalMcpCount}</span>
            </>
          }
          footer={
            <div className="space-y-0 max-h-40 overflow-y-auto">
              {profiles.slice(0, 4).map((p) => {
                const pStatus = serveStatus.profileStatuses?.[p.name];
                const pActive = pStatus?.active === true;
                return (
                  <button
                    key={p.name}
                    onClick={() => setView({ page: 'mcp-detail', profileName: p.name })}
                    className="w-full flex items-center justify-between px-2 py-1 rounded-md hover:bg-white/[0.02] transition-all duration-200 text-left"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div
                        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${pActive ? 'bg-emerald-400' : 'bg-gray-600'}`}
                      />
                      <span className="font-mono-plex text-xs text-gray-300 truncate">
                        {p.label || p.name}
                      </span>
                    </div>
                    <span
                      className={`font-mono-plex text-[10px] px-2 py-0.5 rounded-full flex-shrink-0 ${pActive ? 'bg-emerald-400/10 text-emerald-400 ring-1 ring-emerald-400/20' : 'bg-white/5 text-gray-600'}`}
                    >
                      {pActive ? 'ON' : 'OFF'}
                    </span>
                  </button>
                );
              })}
              {profiles.length === 0 && (
                <p className="text-[10px] text-gray-600 text-center py-2 eyebrow">No servers</p>
              )}
              <button
                onClick={() => setView({ page: 'mcp-list' })}
                className="mt-1 w-full text-left"
              >
                <span className="eyebrow-accent hover:text-os-300 transition-colors">
                  View all &rarr;
                </span>
              </button>
            </div>
          }
        />

        {/* Data Profiles */}
        <KpiCard
          accent="blue"
          onClick={() => setView({ page: 'configurations' })}
          eyebrow={
            <Eyebrow dotColor={configurations.length > 0 ? 'bg-blue-400' : 'bg-gray-600'}>
              DATA PROFILES
              <HelpTip
                content="Configure which tables and columns from your databases are exposed to AI clients"
                position="bottom"
              />
            </Eyebrow>
          }
          value={<span className="text-3xl">{configurations.length}</span>}
          footer={
            <div className="space-y-0 max-h-40 overflow-y-auto">
              {configurations.slice(0, 4).map((cfg) => {
                const tCount = getConfigurationTableNames(cfg).length;
                return (
                  <button
                    key={cfg.name}
                    onClick={() => setView({ page: 'config-detail', configName: cfg.name })}
                    className="w-full flex items-center justify-between px-2 py-1 rounded-md hover:bg-white/[0.02] transition-all duration-200 text-left"
                  >
                    <span className="font-mono-plex text-xs text-gray-300 truncate">
                      {cfg.label}
                    </span>
                    <span className="font-mono-plex text-[10px] text-gray-500 flex-shrink-0">
                      {tCount} table{tCount !== 1 ? 's' : ''}
                    </span>
                  </button>
                );
              })}
              {configurations.length === 0 && (
                <p className="text-[10px] text-gray-600 text-center py-2 eyebrow">No profiles</p>
              )}
              <button
                onClick={() => setView({ page: 'configurations' })}
                className="mt-1 w-full text-left"
              >
                <span className="eyebrow-accent hover:text-os-300 transition-colors">
                  View all &rarr;
                </span>
              </button>
            </div>
          }
        />

        {/* Databases */}
        <KpiCard
          accent="emerald"
          onClick={() => setView({ page: 'connections' })}
          eyebrow={
            <Eyebrow dotColor={hasConnections ? 'bg-emerald-400' : 'bg-gray-600'}>
              DATABASES
              <HelpTip
                content="Manage connections to PostgreSQL, MySQL or SQLite databases"
                position="bottom"
              />
            </Eyebrow>
          }
          value={
            <>
              <span className="text-3xl">{connectedCount}</span>
              <span className="text-lg text-gray-500">/{totalConnCount}</span>
            </>
          }
          footer={
            <div className="space-y-0 max-h-40 overflow-y-auto">
              {connections.slice(0, 4).map((conn) => {
                const hasSchema = !!connectionSchemas[conn.name];
                return (
                  <div key={conn.name} className="flex items-center justify-between px-2 py-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <div
                        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${hasSchema ? 'bg-emerald-400' : 'bg-gray-600'}`}
                        title={hasSchema ? 'Connected and schema loaded' : 'Not connected'}
                      />
                      <span className="font-mono-plex text-xs text-gray-300 truncate">
                        {conn.label || conn.name}
                      </span>
                    </div>
                    <span
                      className={`font-mono-plex text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${
                        conn.databaseType === 'postgresql'
                          ? 'text-blue-300 bg-blue-500/10'
                          : conn.databaseType === 'mysql'
                            ? 'text-orange-300 bg-orange-500/10'
                            : 'text-emerald-300 bg-emerald-500/10'
                      }`}
                    >
                      {conn.databaseType === 'postgresql'
                        ? 'PG'
                        : conn.databaseType === 'mysql'
                          ? 'MySQL'
                          : 'SQLite'}
                    </span>
                  </div>
                );
              })}
              {connections.length === 0 && (
                <p className="text-[10px] text-gray-600 text-center py-2 eyebrow">No databases</p>
              )}
              <button
                onClick={() => setView({ page: 'connections' })}
                className="mt-1 w-full text-left"
              >
                <span className="eyebrow-accent hover:text-os-300 transition-colors">
                  View all &rarr;
                </span>
              </button>
            </div>
          }
        />
      </div>

      {/* Governance tiles: Users / Settings / Metrics */}
      <div
        className="grid grid-cols-1 md:grid-cols-3 gap-3 animate-fade-in-up"
        style={{ animationDelay: '160ms' }}
      >
        {[
          {
            label: 'USERS',
            description: 'Manage user accounts and permissions',
            dot: 'bg-purple-500',
            page: 'users' as const,
          },
          {
            label: 'SETTINGS',
            description: 'AI provider, SMTP and SSO/OIDC',
            dot: 'bg-amber-500',
            page: 'settings' as const,
          },
          {
            label: 'METRICS',
            description: 'Usage analytics and performance',
            dot: 'bg-cyan-500',
            page: 'metrics' as const,
          },
        ].map((tile) => (
          <button
            key={tile.page}
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

      {/* Recent Activity */}
      {recentActivity.length > 0 && (
        <div
          className="card-primary overflow-hidden animate-fade-in-up"
          style={{ animationDelay: '240ms' }}
        >
          <div className="flex items-center justify-between px-4 py-2 hairline-b">
            <Eyebrow accent live>
              RECENT ACTIVITY
            </Eyebrow>
            <Eyebrow>{recentActivity.length} events</Eyebrow>
          </div>
          <div>
            {recentActivity.slice(0, 8).map((entry) => {
              const time = new Date(entry.timestamp);
              const diffMs = Date.now() - time.getTime();
              const diffMin = Math.floor(diffMs / 60000);
              const diffHour = Math.floor(diffMs / 3600000);
              const timeAgo =
                diffMin < 1
                  ? 'just now'
                  : diffMin < 60
                    ? `${diffMin}m ago`
                    : diffHour < 24
                      ? `${diffHour}h ago`
                      : time.toLocaleDateString();

              return (
                <div
                  key={entry.id}
                  className="px-4 py-1.5 border-b border-white/5 last:border-0 flex items-center gap-3"
                >
                  <span
                    className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${
                      entry.result === 'success' ? 'bg-emerald-400' : 'bg-rose-400'
                    }`}
                    title={entry.result === 'success' ? 'Success' : 'Error'}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono-plex text-sm text-gray-200 truncate">
                        {entry.toolName}
                      </span>
                      <span className="font-mono-plex text-[10px] px-2 py-0.5 rounded-full bg-os-500/10 text-os-300 ring-1 ring-os-500/20 flex-shrink-0">
                        {entry.profileName}
                      </span>
                    </div>
                    {entry.resultSummary && (
                      <p className="text-xs text-gray-500 truncate mt-0.5">{entry.resultSummary}</p>
                    )}
                  </div>
                  <span className="font-mono-plex text-xs text-gray-600 flex-shrink-0 whitespace-nowrap">
                    {timeAgo}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
