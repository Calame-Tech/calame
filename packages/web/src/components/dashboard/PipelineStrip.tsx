// Pipeline strip — "the system in one line": Sources → Data Configurations →
// MCP Servers. Each stage is a clickable card navigating to its page, with an
// item list in the footer that keeps the per-item drill-down the old KPI cards
// offered (servers → mcp-detail, configs → config-detail, connections with
// schema dot + engine badge).

import type { Dispatch, ReactNode, SetStateAction } from 'react';
import HelpTip from '../HelpTip.js';
import {
  getConfigurationTableNames,
  getConfigurationColumnMasking,
  getConfigurationTableOptions,
} from '../../lib/configuration-accessors.js';
import type {
  Configuration,
  DatabaseSchema,
  NamedConnection,
  Profile,
  ServeStatus,
} from '../../types/schema.js';
import type { View } from '../../router/index.js';

interface PipelineStripProps {
  setView: Dispatch<SetStateAction<View>>;
  connections: NamedConnection[];
  connectionSchemas: Record<string, DatabaseSchema>;
  configurations: Configuration[];
  profiles: Profile[];
  serveStatus: ServeStatus;
  connectedCount: number;
  ragSourceCount: number;
  activeMcpCount: number;
  totalMcpCount: number;
}

const ENGINE_BADGE: Record<NamedConnection['databaseType'], { label: string; classes: string }> = {
  postgresql: { label: 'PG', classes: 'text-blue-300 bg-blue-500/10' },
  mysql: { label: 'MySQL', classes: 'text-orange-300 bg-orange-500/10' },
  sqlite: { label: 'SQLite', classes: 'text-emerald-300 bg-emerald-500/10' },
};

function FlowArrow() {
  return (
    <span className="hidden md:flex items-center justify-center text-gray-600" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path
          d="M3 8h9M9 4.5L12.5 8 9 11.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

interface StageCardProps {
  eyebrow: ReactNode;
  value: ReactNode;
  sub: ReactNode;
  footer: ReactNode;
  onClick: () => void;
  delayMs: number;
}

function StageCard({ eyebrow, value, sub, footer, onClick, delayMs }: StageCardProps) {
  return (
    <div
      className="card-interactive overflow-hidden flex flex-col anim-rise-in"
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left px-4 pt-3.5 pb-2.5 rounded-t-2xl hover:bg-white/[0.015] focus:outline-none focus-visible:ring-2 focus-visible:ring-os-500/40 transition-colors duration-200 cursor-pointer"
      >
        <div className="eyebrow mb-1">{eyebrow}</div>
        <div className="font-display font-light text-3xl leading-tight tracking-tight text-gray-100 tabular-nums">
          {value}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-500">{sub}</div>
      </button>
      <div className="hairline px-2 py-1.5 mt-auto">{footer}</div>
    </div>
  );
}

function ViewAllLink({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="mt-0.5 w-full text-left px-2">
      <span className="eyebrow-accent hover:text-os-300 transition-colors">View all &rarr;</span>
    </button>
  );
}

export default function PipelineStrip({
  setView,
  connections,
  connectionSchemas,
  configurations,
  profiles,
  serveStatus,
  connectedCount,
  ragSourceCount,
  activeMcpCount,
  totalMcpCount,
}: PipelineStripProps) {
  const sourceCount = connections.length + ragSourceCount;
  const maskedConfigCount = configurations.filter((cfg) =>
    Object.values(getConfigurationColumnMasking(cfg)).some((cols) =>
      Object.values(cols).some((m) => m.maskingMode !== 'none'),
    ),
  ).length;
  const writeConfigCount = configurations.filter((cfg) =>
    Object.values(getConfigurationTableOptions(cfg)).some((o) => o.enabledTools?.includes('write')),
  ).length;

  return (
    <div className="grid grid-cols-1 md:grid-cols-[1fr_34px_1fr_34px_1fr] gap-2 md:gap-0 items-stretch">
      {/* Stage 1 — Sources (SQL connections + knowledge bases) */}
      <StageCard
        delayMs={0}
        onClick={() => setView({ page: 'connections' })}
        eyebrow={
          <span className="inline-flex items-center gap-1.5">
            SOURCES
            <HelpTip
              content="Manage sources connecting to PostgreSQL, MySQL or SQLite databases and knowledge bases"
              position="bottom"
            />
          </span>
        }
        value={sourceCount}
        sub={
          <>
            <span className={connectedCount > 0 ? 'text-emerald-400' : ''}>
              {connectedCount} connected
            </span>
            {ragSourceCount > 0 && (
              <span>
                {ragSourceCount} knowledge base{ragSourceCount !== 1 ? 's' : ''}
              </span>
            )}
          </>
        }
        footer={
          <div className="space-y-0 max-h-32 overflow-y-auto">
            {connections.slice(0, 4).map((conn) => {
              const hasSchema = !!connectionSchemas[conn.name];
              const badge = ENGINE_BADGE[conn.databaseType];
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
                    className={`font-mono-plex text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${badge.classes}`}
                  >
                    {badge.label}
                  </span>
                </div>
              );
            })}
            {connections.length === 0 && (
              <p className="text-[10px] text-gray-600 text-center py-2 eyebrow">No sources yet</p>
            )}
            <ViewAllLink onClick={() => setView({ page: 'connections' })} />
          </div>
        }
      />

      <FlowArrow />

      {/* Stage 2 — Data Configurations */}
      <StageCard
        delayMs={70}
        onClick={() => setView({ page: 'configurations' })}
        eyebrow={
          <span className="inline-flex items-center gap-1.5">
            DATA CONFIGURATIONS
            <HelpTip
              content="Configure which tables and columns from your databases are exposed to AI clients"
              position="bottom"
            />
          </span>
        }
        value={configurations.length}
        sub={
          <>
            {maskedConfigCount > 0 && <span>{maskedConfigCount} with PII masking</span>}
            {writeConfigCount > 0 && <span>{writeConfigCount} with write access</span>}
            {maskedConfigCount === 0 && writeConfigCount === 0 && <span>read-only exposure</span>}
          </>
        }
        footer={
          <div className="space-y-0 max-h-32 overflow-y-auto">
            {configurations.slice(0, 4).map((cfg) => {
              const tCount = getConfigurationTableNames(cfg).length;
              return (
                <button
                  key={cfg.name}
                  type="button"
                  onClick={() => setView({ page: 'config-detail', configName: cfg.name })}
                  className="w-full flex items-center justify-between px-2 py-1 rounded-md hover:bg-white/[0.02] transition-colors duration-200 text-left"
                >
                  <span className="font-mono-plex text-xs text-gray-300 truncate">{cfg.label}</span>
                  <span className="font-mono-plex text-[10px] text-gray-500 flex-shrink-0">
                    {tCount} table{tCount !== 1 ? 's' : ''}
                  </span>
                </button>
              );
            })}
            {configurations.length === 0 && (
              <p className="text-[10px] text-gray-600 text-center py-2 eyebrow">
                No Data Configurations
              </p>
            )}
            <ViewAllLink onClick={() => setView({ page: 'configurations' })} />
          </div>
        }
      />

      <FlowArrow />

      {/* Stage 3 — MCP Servers */}
      <StageCard
        delayMs={140}
        onClick={() => setView({ page: 'mcp-list' })}
        eyebrow={
          <span className="inline-flex items-center gap-1.5">
            MCP SERVERS
            <HelpTip
              content="Start, stop and manage your MCP servers exposed to AI clients"
              position="bottom"
            />
          </span>
        }
        value={
          <>
            {totalMcpCount}{' '}
            <span className="text-base text-gray-500 font-normal tracking-normal">
              &middot; {activeMcpCount} active
            </span>
          </>
        }
        sub={
          <span className={activeMcpCount > 0 ? 'text-emerald-400' : ''}>
            {activeMcpCount > 0 ? `serving on port ${serveStatus.port}` : 'no server running'}
          </span>
        }
        footer={
          <div className="space-y-0 max-h-32 overflow-y-auto">
            {profiles.slice(0, 4).map((p) => {
              const pActive = serveStatus.profileStatuses?.[p.name]?.active === true;
              const pillClasses = pActive
                ? 'bg-emerald-400/10 text-emerald-400 ring-1 ring-emerald-400/20'
                : 'bg-white/5 text-gray-400';
              return (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => setView({ page: 'mcp-detail', profileName: p.name })}
                  className="w-full flex items-center justify-between px-2 py-1 rounded-md hover:bg-white/[0.02] transition-colors duration-200 text-left"
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
                    className={`font-mono-plex text-[10px] px-2 py-0.5 rounded-full flex-shrink-0 ${pillClasses}`}
                  >
                    {pActive ? 'ON' : 'OFF'}
                  </span>
                </button>
              );
            })}
            {profiles.length === 0 && (
              <p className="text-[10px] text-gray-600 text-center py-2 eyebrow">No servers</p>
            )}
            <ViewAllLink onClick={() => setView({ page: 'mcp-list' })} />
          </div>
        }
      />
    </div>
  );
}
