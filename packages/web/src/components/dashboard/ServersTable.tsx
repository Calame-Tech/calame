// Servers table — status, auth mode, 24h activity and a 7-day trend sparkline
// per MCP server. Rows navigate to the server detail page.

import { useMemo } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { EmptyState } from '../ui/index.js';
import { buildProfileSparkSeries, countByProfile24h } from './activity-stats.js';
import type { AuditLogEntry, Profile, ServeStatus } from '../../types/schema.js';
import type { View } from '../../router/index.js';

interface ServersTableProps {
  setView: Dispatch<SetStateAction<View>>;
  profiles: Profile[];
  serveStatus: ServeStatus;
  recentActivity: AuditLogEntry[];
}

const SPARK_W = 90;
const SPARK_H = 22;

/** Map a 7-day count series onto a 90×22 sparkline path. */
function sparkPath(series: number[]): { d: string; flat: boolean } {
  const max = Math.max(...series);
  if (max === 0) return { d: `M2 17 L${SPARK_W - 2} 17`, flat: true };
  const step = (SPARK_W - 4) / (series.length - 1);
  const points = series.map((v, i) => {
    const px = 2 + i * step;
    const py = 4 + (1 - v / max) * (SPARK_H - 8);
    return `${px.toFixed(1)} ${py.toFixed(1)}`;
  });
  return { d: 'M' + points.join(' L'), flat: false };
}

export default function ServersTable({
  setView,
  profiles,
  serveStatus,
  recentActivity,
}: ServersTableProps) {
  const counts24h = useMemo(() => countByProfile24h(recentActivity), [recentActivity]);

  return (
    <div className="card-primary p-4 anim-rise-in" style={{ animationDelay: '200ms' }}>
      <h2 className="text-sm font-semibold text-gray-100">Servers</h2>
      <p className="font-mono-plex text-[11px] text-gray-500 mb-3">
        status &middot; activity 24h &middot; trend 7d
      </p>

      {profiles.length === 0 ? (
        <EmptyState
          title="No MCP servers"
          description="Create a server to expose your data configurations to AI clients."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {['Server', 'Status', 'Auth', 'Activity 24h', 'Trend'].map((h, i) => (
                  <th
                    key={h}
                    className={`font-mono-plex text-[10px] uppercase tracking-widest text-gray-600 font-semibold px-2.5 py-1.5 border-b border-white/5 ${i === 3 ? 'text-right' : 'text-left'}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {profiles.map((p, rowIdx) => {
                const active = serveStatus.profileStatuses?.[p.name]?.active === true;
                const count = counts24h[p.name] ?? 0;
                const spark = sparkPath(buildProfileSparkSeries(recentActivity, p.name));
                return (
                  <tr
                    key={p.name}
                    className="cursor-pointer hover:bg-white/[0.025] transition-colors duration-150"
                    onClick={() => setView({ page: 'mcp-detail', profileName: p.name })}
                  >
                    <td className="px-2.5 py-2 border-b border-white/[0.035] text-gray-200">
                      <button
                        type="button"
                        className="text-left hover:text-os-300 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-os-500/40 rounded"
                        onClick={(e) => {
                          e.stopPropagation();
                          setView({ page: 'mcp-detail', profileName: p.name });
                        }}
                      >
                        {p.label || p.name}
                      </button>
                    </td>
                    <td className="px-2.5 py-2 border-b border-white/[0.035]">
                      <span
                        className={`font-mono-plex text-[10px] font-semibold tracking-wider px-2 py-0.5 rounded-full ${
                          active
                            ? 'bg-emerald-400/10 text-emerald-400 ring-1 ring-emerald-400/20'
                            : 'bg-white/5 text-gray-400'
                        }`}
                      >
                        {active ? 'ACTIVE' : 'STOPPED'}
                      </span>
                    </td>
                    <td className="px-2.5 py-2 border-b border-white/[0.035] font-mono-plex text-xs text-gray-400">
                      {p.authMode ?? 'open'}
                    </td>
                    <td className="px-2.5 py-2 border-b border-white/[0.035] font-mono-plex text-xs text-gray-300 text-right tabular-nums">
                      {count}
                    </td>
                    <td className="px-2.5 py-2 border-b border-white/[0.035]">
                      <svg
                        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
                        className="w-[90px] h-[22px]"
                        aria-hidden="true"
                      >
                        <path
                          d={spark.d}
                          pathLength={100}
                          fill="none"
                          strokeWidth="1.6"
                          className="anim-line-draw"
                          style={{
                            stroke: spark.flat ? 'rgb(75 85 99)' : 'rgb(var(--color-os-400))',
                            animationDuration: '0.7s',
                            animationDelay: `${700 + rowIdx * 100}ms`,
                          }}
                        />
                      </svg>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
