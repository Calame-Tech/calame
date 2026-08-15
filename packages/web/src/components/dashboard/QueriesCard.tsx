// Activity chart card — area chart of audit entries per day (last 7 days)
// plus per-server bars (last 24h). There is no daily-series endpoint, so both
// are aggregated client-side from the recent-activity feed and labeled as
// activity rather than a full query-count metric.

import { useMemo, useState } from 'react';
import { activeDayCount, buildDailySeries, countByProfile24h } from './activity-stats.js';
import type { AuditLogEntry, Profile, ServeStatus } from '../../types/schema.js';

interface QueriesCardProps {
  recentActivity: AuditLogEntry[];
  profiles: Profile[];
  serveStatus: ServeStatus;
}

// Chart geometry (viewBox units).
const W = 640;
const H = 190;
const PT = 10;
const PB = 26;
const PL = 34;
const PR = 14;

/** Round the axis max up to a friendly step so gridline labels stay integer. */
function niceMax(rawMax: number): number {
  if (rawMax <= 4) return 4;
  const step = Math.pow(10, Math.floor(Math.log10(rawMax)));
  return Math.ceil(rawMax / step) * step;
}

export default function QueriesCard({ recentActivity, profiles, serveStatus }: QueriesCardProps) {
  const series = useMemo(() => buildDailySeries(recentActivity), [recentActivity]);
  const daysWithData = activeDayCount(series);
  const showChart = daysWithData >= 2;

  const [hover, setHover] = useState<number | null>(null);

  const max = niceMax(Math.max(...series.map((p) => p.count)));
  const x = (i: number) => PL + (i * (W - PL - PR)) / (series.length - 1);
  const y = (v: number) => PT + (1 - v / max) * (H - PT - PB);

  const linePath = 'M' + series.map((p, i) => `${x(i)},${y(p.count)}`).join(' L');
  const areaPath = `M${x(0)},${y(0)} L${series
    .map((p, i) => `${x(i)},${y(p.count)}`)
    .join(' L')} L${x(series.length - 1)},${y(0)} Z`;
  const gridValues = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * max));

  // Per-server bars, last 24h. Every profile gets a row; idle ones show a dash.
  const counts24h = useMemo(() => countByProfile24h(recentActivity), [recentActivity]);
  const barRows = useMemo(() => {
    const rows = profiles.map((p) => ({
      name: p.name,
      label: p.label || p.name,
      active: serveStatus.profileStatuses?.[p.name]?.active === true,
      count: counts24h[p.name] ?? 0,
    }));
    rows.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    return rows.slice(0, 6);
  }, [profiles, serveStatus.profileStatuses, counts24h]);
  const barMax = Math.max(1, ...barRows.map((r) => r.count));

  return (
    <div className="card-primary p-4 anim-rise-in" style={{ animationDelay: '120ms' }}>
      <h2 className="text-sm font-semibold text-gray-100">Activity</h2>
      <p className="font-mono-plex text-[11px] text-gray-500 mb-3">
        tool calls &middot; last 7 days &middot; all servers
      </p>

      {showChart ? (
        <div className="relative">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="block w-full h-[190px]"
            role="img"
            aria-label={`Activity per day over the last 7 days, up to ${max} tool calls`}
            onMouseMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              if (r.width === 0) return;
              const mx = ((e.clientX - r.left) * W) / r.width;
              let best = 0;
              let bd = Infinity;
              series.forEach((_, i) => {
                const d = Math.abs(x(i) - mx);
                if (d < bd) {
                  bd = d;
                  best = i;
                }
              });
              setHover(best);
            }}
            onMouseLeave={() => setHover(null)}
          >
            <defs>
              <linearGradient id="dash-area-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="rgb(var(--color-os-400))" stopOpacity="0.22" />
                <stop offset="1" stopColor="rgb(var(--color-os-400))" stopOpacity="0" />
              </linearGradient>
            </defs>
            <g className="anim-fade-in" style={{ animationDelay: '150ms' }}>
              {gridValues.map((v) => (
                <g key={v}>
                  <line
                    x1={PL}
                    x2={W - PR}
                    y1={y(v)}
                    y2={y(v)}
                    stroke="rgba(255,255,255,0.05)"
                    strokeWidth="1"
                  />
                  <text
                    x={PL - 6}
                    y={y(v) + 3}
                    textAnchor="end"
                    className="font-mono-plex"
                    fontSize="9.5"
                    fill="rgb(75 85 99)"
                  >
                    {v}
                  </text>
                </g>
              ))}
            </g>
            <path
              d={areaPath}
              fill="url(#dash-area-fill)"
              className="anim-fade-in"
              style={{ animationDelay: '750ms' }}
            />
            <path
              d={linePath}
              pathLength={100}
              fill="none"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              className="anim-line-draw"
              style={{ stroke: 'rgb(var(--color-os-400))', animationDelay: '200ms' }}
            />
            <circle
              cx={x(series.length - 1)}
              cy={y(series[series.length - 1].count)}
              r="3"
              className="anim-fade-in"
              style={{ fill: 'rgb(var(--color-os-300))', animationDelay: '1100ms' }}
            />
            {hover !== null && (
              <>
                <line
                  x1={x(hover)}
                  x2={x(hover)}
                  y1={PT}
                  y2={H - PB}
                  stroke="rgba(255,255,255,0.22)"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                />
                <circle
                  cx={x(hover)}
                  cy={y(series[hover].count)}
                  r="4.5"
                  style={{
                    fill: 'rgb(var(--color-os-300))',
                    stroke: 'rgb(3 7 18)',
                    strokeWidth: 2,
                  }}
                />
              </>
            )}
            <g className="anim-fade-in" style={{ animationDelay: '150ms' }}>
              {series.map((p, i) => (
                <text
                  key={p.label}
                  x={x(i)}
                  y={H - 8}
                  textAnchor="middle"
                  className="font-mono-plex"
                  fontSize="9.5"
                  fill="rgb(75 85 99)"
                >
                  {p.label}
                </text>
              ))}
            </g>
          </svg>
          {hover !== null && (
            <div
              className="absolute pointer-events-none -translate-x-1/2 -translate-y-[115%] bg-gray-900 border border-white/10 rounded-lg px-2.5 py-1.5 font-mono-plex text-[11px] text-gray-400 whitespace-nowrap z-10"
              style={{
                left: `${(x(hover) / W) * 100}%`,
                top: `${(y(series[hover].count) / H) * 100}%`,
              }}
            >
              <b className="text-gray-100 text-xs">{series[hover].count}</b> tool call
              {series[hover].count !== 1 ? 's' : ''} &middot; {series[hover].label}
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-gray-500 py-8 text-center">
          Not enough activity yet to chart — data appears once your servers have been used on at
          least two days.
        </p>
      )}

      {/* Per-server bars, last 24h */}
      {barRows.length > 0 && (
        <div className="mt-4 flex flex-col gap-2" aria-label="Activity by server, last 24 hours">
          <p className="font-mono-plex text-[11px] text-gray-500">by server &middot; last 24h</p>
          {barRows.map((row, i) => (
            <div
              key={row.name}
              className="grid grid-cols-[118px_1fr_52px] items-center gap-3 text-xs"
            >
              <span
                className={`truncate ${row.active || row.count > 0 ? 'text-gray-400' : 'text-gray-600'}`}
              >
                {row.label}
              </span>
              <div className="relative h-3.5">
                {row.count > 0 && (
                  <div
                    className="absolute inset-0 rounded-r anim-grow-x"
                    tabIndex={0}
                    title={`${row.count} tool call${row.count !== 1 ? 's' : ''} · 24h`}
                    style={{
                      background: 'rgb(var(--color-os-500))',
                      transform: `scaleX(${row.count / barMax})`,
                      animationDelay: `${550 + i * 100}ms`,
                    }}
                  />
                )}
              </div>
              <span className="font-mono-plex text-[11px] text-gray-400 text-right tabular-nums">
                {row.count > 0 ? row.count : '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
