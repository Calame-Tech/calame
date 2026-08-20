import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../lib/api.js';
import type { MetricsSummary, PoolStats } from '../types/schema.js';
import HelpTip from './HelpTip.js';
import { Eyebrow } from './ui/Eyebrow.js';
import { SegmentedControl } from './ui/SegmentedControl.js';
import { KpiCard } from './ui/KpiCard.js';
import { AnimatedNumber, useAnimatedNumber, prefersReducedMotion } from './ui/AnimatedNumber.js';

type Period = '24h' | '7d' | '30d';

/** Returns a Tailwind text color class based on response time in ms */
function responseTimeColor(ms: number): string {
  if (ms < 100) return 'text-emerald-400';
  if (ms <= 500) return 'text-amber-400';
  return 'text-rose-400';
}

/** Returns a stroke color for pool utilization rings */
function poolUtilizationColor(active: number, total: number): string {
  if (total === 0) return '#6b7280';
  const ratio = active / total;
  if (ratio > 0.95) return '#fb7185'; // rose-400
  if (ratio > 0.8) return '#fbbf24'; // amber-400
  return '#34d399'; // emerald-400
}

/**
 * True once the initial paint has settled — gates one-time entrance reveals
 * (donut arcs drawing in, mini-bars growing in) so they animate from a
 * hidden state on mount instead of appearing already-formed, joining the
 * same construction sequence the bar chart and sparklines already play.
 * Skips straight to revealed under prefers-reduced-motion.
 */
function useMountReveal(): boolean {
  const [revealed, setRevealed] = useState(() => prefersReducedMotion());
  useEffect(() => {
    if (revealed) return undefined;
    let timeoutId: number;
    const rafId = requestAnimationFrame(() => {
      timeoutId = window.setTimeout(() => setRevealed(true), 20);
    });
    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(timeoutId);
    };
  }, []);
  return revealed;
}

/** Aggregates requestsByHour into a per-bucket total for the bar chart */
function aggregateByTime(
  data: MetricsSummary['requestsByHour'],
): Array<{ label: string; count: number }> {
  const buckets: Record<string, number> = {};
  for (const row of data) {
    buckets[row.hour] = (buckets[row.hour] ?? 0) + row.count;
  }
  return Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, count]) => ({ label, count }));
}

/** SVG vertical bar chart with gradient fills, hover state, and Y-axis gridlines */
function BarChart({ bars }: { bars: Array<{ label: string; count: number }> }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (bars.length === 0) {
    return <p className="text-gray-500 text-sm text-center py-6">No data for this period.</p>;
  }

  const maxCount = Math.max(...bars.map((b) => b.count), 1);
  const chartHeight = 140;
  const labelHeight = 28;
  const yAxisWidth = 36;
  const barWidth = Math.max(8, Math.min(32, Math.floor(560 / bars.length) - 4));
  const gap = 4;
  const svgWidth = yAxisWidth + bars.length * (barWidth + gap);
  const svgHeight = chartHeight + labelHeight;

  // Y-axis gridlines at 0%, 25%, 50%, 75%, 100%
  const gridLines = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="overflow-x-auto">
      <svg width={svgWidth} height={svgHeight} aria-label="Requests over time bar chart" role="img">
        <defs>
          <linearGradient id="bar-gradient" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="#4c6ef5" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#748ffc" stopOpacity="1" />
          </linearGradient>
        </defs>

        {/* Y-axis gridlines */}
        {gridLines.map((ratio) => {
          const y = chartHeight - Math.round(ratio * chartHeight);
          const label = ratio === 0 ? '0' : Math.round(ratio * maxCount).toString();
          return (
            <g key={ratio}>
              <line
                x1={yAxisWidth}
                y1={y}
                x2={svgWidth}
                y2={y}
                stroke="rgba(255,255,255,0.05)"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              <text
                x={yAxisWidth - 4}
                y={y + 3}
                textAnchor="end"
                fontSize={9}
                fill="#4b5563"
                fontFamily="'IBM Plex Mono', monospace"
              >
                {label}
              </text>
            </g>
          );
        })}

        {/* Baseline */}
        <line
          x1={yAxisWidth}
          y1={chartHeight}
          x2={svgWidth}
          y2={chartHeight}
          stroke="rgba(255,255,255,0.10)"
          strokeWidth="1"
        />

        {/* Bars */}
        {bars.map((bar, i) => {
          const barH = Math.max(2, Math.round((bar.count / maxCount) * chartHeight));
          const x = yAxisWidth + i * (barWidth + gap);
          const y = chartHeight - barH;
          const isHovered = hoverIndex === i;
          const opacity = hoverIndex === null ? 0.85 : isHovered ? 1 : 0.35;
          const tooltipY = Math.max(2, y - 24);
          return (
            <g
              key={bar.label}
              onMouseEnter={() => setHoverIndex(i)}
              onMouseLeave={() => setHoverIndex(null)}
              style={{ cursor: 'default' }}
            >
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barH}
                fill="url(#bar-gradient)"
                opacity={opacity}
                rx={2}
                className="anim-grow-y"
                style={{
                  transition: 'opacity 150ms ease',
                  transformBox: 'fill-box',
                  animationDelay: `${Math.min(i * 12, 400)}ms`,
                }}
              />
              {/* Hover tooltip — always mounted, opacity-toggled so it fades
                  instead of snapping in/out (immediate-feedback band: ~120ms). */}
              <g
                style={{
                  opacity: isHovered ? 1 : 0,
                  transform: isHovered ? 'translateY(0)' : 'translateY(2px)',
                  transition: 'opacity 120ms ease, transform 120ms ease',
                  pointerEvents: 'none',
                }}
              >
                <rect
                  x={x + barWidth / 2 - 22}
                  y={tooltipY}
                  width={44}
                  height={18}
                  rx={4}
                  fill="rgba(15,15,20,0.92)"
                  stroke="rgba(255,255,255,0.08)"
                  strokeWidth="1"
                />
                <text
                  x={x + barWidth / 2}
                  y={Math.max(14, y - 11)}
                  textAnchor="middle"
                  fontSize={9}
                  fill="#a5b4fc"
                  fontFamily="'IBM Plex Mono', monospace"
                >
                  {bar.count}
                </text>
              </g>
              {/* X-axis label */}
              {bars.length <= 24 && (
                <text
                  x={x + barWidth / 2}
                  y={chartHeight + 16}
                  textAnchor="middle"
                  fontSize={9}
                  fill="#374151"
                  fontFamily="'IBM Plex Mono', monospace"
                >
                  {bar.label.slice(-5)}
                </text>
              )}
              <title>{`${bar.label}: ${bar.count} requests`}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Horizontal bar row for top tools / tokens */
function HorizontalBar({
  label,
  count,
  max,
  rank,
  gradientId,
  revealed,
  delayMs = 0,
  large = false,
}: {
  label: string;
  count: number;
  max: number;
  rank?: number;
  gradientId: string;
  revealed: boolean;
  delayMs?: number;
  large?: boolean;
}) {
  const pct = max > 0 ? Math.max(2, Math.round((count / max) * 100)) : 2;
  const total = max;
  const countPct = total > 0 ? ((count / total) * 100).toFixed(0) : '0';
  return (
    <div
      className={`flex items-center gap-3 -mx-2 px-2 rounded-lg transition-colors hover:bg-white/[0.04] ${
        large ? 'py-3' : 'py-1.5'
      }`}
    >
      {rank !== undefined && (
        <span
          className={`font-mono-plex text-os-400/60 shrink-0 text-right ${
            large ? 'text-sm w-6' : 'text-xs w-5'
          }`}
        >
          {rank}.
        </span>
      )}
      <span
        className={`text-gray-200 font-medium truncate shrink-0 ${
          large ? 'w-auto flex-1 text-base' : 'w-36 text-sm'
        }`}
        title={label}
      >
        {label}
      </span>
      <div
        className={`bg-white/5 rounded-full overflow-hidden ${large ? 'h-2 flex-[2]' : 'flex-1 h-1.5'}`}
      >
        <div
          className={`h-full w-full origin-left rounded-full ${gradientId}`}
          style={{
            transform: `scaleX(${revealed ? pct / 100 : 0})`,
            transition: `transform 600ms cubic-bezier(0.16, 1, 0.3, 1) ${delayMs}ms`,
          }}
          role="progressbar"
          aria-valuenow={count}
          aria-valuemax={max}
          aria-label={`${label}: ${count}`}
        />
      </div>
      <div className={`text-right shrink-0 ${large ? 'w-20' : 'w-16'}`}>
        <span className={`font-mono-plex text-gray-300 ${large ? 'text-lg' : 'text-sm'}`}>
          <AnimatedNumber value={count} />
        </span>
        <p className="font-mono-plex text-[10px] text-gray-600">{countPct}%</p>
      </div>
    </div>
  );
}

/**
 * Ranked list of HorizontalBars with a staggered grow-in on mount. When the
 * list is sparse (1-2 entries) it renders a "large" variant and centers
 * vertically instead of clumping at the top — the card is grid-stretched to
 * match its taller siblings, and a short list left top-anchored there just
 * reads as broken/empty rather than intentional.
 */
function RankedList({
  items,
  max,
  gradientId,
  emptyLabel,
}: {
  items: Array<{ key: string; label: string; count: number }>;
  max: number;
  gradientId: string;
  emptyLabel: string;
}) {
  const revealed = useMountReveal();

  if (items.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-gray-600 text-sm text-center py-4">{emptyLabel}</p>
      </div>
    );
  }

  const sparse = items.length <= 2;
  return (
    <div
      className={
        sparse
          ? 'flex-1 flex flex-col justify-center gap-1'
          : 'flex-1 space-y-0.5 max-h-64 overflow-y-auto pr-1'
      }
    >
      {items.map((item, i) => (
        <HorizontalBar
          key={item.key}
          label={item.label}
          count={item.count}
          max={max}
          rank={i + 1}
          gradientId={gradientId}
          revealed={revealed}
          delayMs={Math.min(i * 50, 250)}
          large={sparse}
        />
      ))}
    </div>
  );
}

/** SVG donut for success vs errors */
function DonutChart({
  successPct,
  errorPct,
  successCount,
  errorCount,
}: {
  successPct: string;
  errorPct: string;
  successCount: number;
  errorCount: number;
}) {
  const size = 148;
  const cx = size / 2;
  const cy = size / 2;
  const r = 54;
  const strokeWidth = 18;
  const circumference = 2 * Math.PI * r;

  const successRatio = parseFloat(successPct) / 100;
  const errorRatio = parseFloat(errorPct) / 100;

  const successDash = successRatio * circumference;
  const errorDash = errorRatio * circumference;
  // Start from top (rotate -90deg)
  const errorOffset = circumference - successDash;

  // Draws the ring in from empty on mount, then ticks alongside the arc's
  // own CSS transition (below) on every later value change.
  const revealed = useMountReveal();
  const drawnSuccessDash = revealed ? successDash : 0;
  const drawnErrorDash = revealed ? errorDash : 0;

  // Ticks alongside the arc's own CSS transition (above) instead of
  // snapping straight to the new percentage.
  const animatedSuccessPct = useAnimatedNumber(successRatio * 100, 700);

  return (
    <div className="flex flex-col items-center gap-5">
      <div className="relative">
        <svg
          width={size}
          height={size}
          aria-label={`Success ${successPct}%, Error ${errorPct}%`}
          role="img"
        >
          {/* Track */}
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="rgba(255,255,255,0.04)"
            strokeWidth={strokeWidth}
          />
          {/* Error arc */}
          {errorRatio > 0 && (
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke="#fb7185"
              strokeWidth={strokeWidth}
              strokeDasharray={`${drawnErrorDash} ${circumference - drawnErrorDash}`}
              strokeDashoffset={-errorOffset + circumference / 4}
              strokeLinecap="round"
              transform={`rotate(-90 ${cx} ${cy})`}
              style={{
                transition:
                  'stroke-dasharray 700ms cubic-bezier(0.16, 1, 0.3, 1), stroke-dashoffset 700ms cubic-bezier(0.16, 1, 0.3, 1)',
              }}
            />
          )}
          {/* Success arc */}
          {successRatio > 0 && (
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke="#34d399"
              strokeWidth={strokeWidth}
              strokeDasharray={`${drawnSuccessDash} ${circumference - drawnSuccessDash}`}
              strokeDashoffset={circumference / 4}
              strokeLinecap="round"
              style={{
                transition:
                  'stroke-dasharray 700ms cubic-bezier(0.16, 1, 0.3, 1), stroke-dashoffset 700ms cubic-bezier(0.16, 1, 0.3, 1)',
              }}
              transform={`rotate(-90 ${cx} ${cy})`}
            />
          )}
          {/* Center label */}
          <text
            x={cx}
            y={cy - 5}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={30}
            fontWeight={300}
            fill="white"
            fontFamily="'IBM Plex Sans', system-ui, sans-serif"
          >
            {animatedSuccessPct.toFixed(0)}%
          </text>
          <text
            x={cx}
            y={cy + 17}
            textAnchor="middle"
            fontSize={9}
            letterSpacing={1.5}
            fill="#6b7280"
            fontFamily="'IBM Plex Mono', monospace"
          >
            SUCCESS
          </text>
        </svg>
      </div>
      <div className="space-y-1 w-full">
        <div className="flex items-center justify-between text-sm rounded-lg -mx-2 px-2 py-1.5 transition-colors hover:bg-white/[0.04]">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" aria-hidden="true" />
            <span className="text-gray-300 text-xs">Success</span>
          </div>
          <div className="text-right">
            <span className="text-emerald-400 font-mono-plex text-xs font-medium">
              {successPct}%
            </span>
            <span className="text-gray-600 font-mono-plex text-[10px] ml-2">{successCount}</span>
          </div>
        </div>
        <div className="flex items-center justify-between text-sm rounded-lg -mx-2 px-2 py-1.5 transition-colors hover:bg-white/[0.04]">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-rose-400 inline-block" aria-hidden="true" />
            <span className="text-gray-300 text-xs">Error</span>
          </div>
          <div className="text-right">
            <span className="text-rose-400 font-mono-plex text-xs font-medium">{errorPct}%</span>
            <span className="text-gray-600 font-mono-plex text-[10px] ml-2">{errorCount}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** SVG pool utilization ring (circular progress) */
function PoolRing({ active, total }: { active: number; total: number }) {
  const size = 56;
  const cx = size / 2;
  const cy = size / 2;
  const r = 22;
  const strokeWidth = 6;
  const circumference = 2 * Math.PI * r;
  const ratio = total > 0 ? Math.min(active / total, 1) : 0;
  const dash = ratio * circumference;
  const color = poolUtilizationColor(active, total);
  const animatedPct = useAnimatedNumber(total > 0 ? ratio * 100 : 0, 600);

  return (
    <svg width={size} height={size} aria-label={`${active} active of ${total} total`} role="img">
      {/* Track */}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke="rgba(255,255,255,0.06)"
        strokeWidth={strokeWidth}
      />
      {/* Progress */}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray={`${dash} ${circumference - dash}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${cx} ${cy})`}
        style={{ transition: 'stroke-dasharray 600ms ease' }}
      />
      {/* Center text */}
      <text
        x={cx}
        y={cy + 1}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={11}
        fontWeight={400}
        fill="white"
        fontFamily="'IBM Plex Mono', monospace"
      >
        {Math.round(animatedPct)}%
      </text>
    </svg>
  );
}

/** Pool stats progress bar (inner) */
function PoolStatBar({
  label,
  value,
  total,
  color,
  dotColor,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
  dotColor: string;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} aria-hidden="true" />
      <span className="font-mono-plex text-[10px] text-gray-500 w-14 shrink-0">{label}</span>
      <div className="flex-1 bg-white/5 rounded-full h-[3px] overflow-hidden">
        <div
          className={`h-[3px] w-full origin-left rounded-full ${color}`}
          style={{
            transform: `scaleX(${pct / 100})`,
            transition: 'transform 600ms cubic-bezier(0.16, 1, 0.3, 1)',
          }}
          role="progressbar"
          aria-valuenow={value}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-label={`${label}: ${value}`}
        />
      </div>
      <span className="font-mono-plex text-[10px] text-gray-500 w-6 text-right shrink-0">
        {value}
      </span>
    </div>
  );
}

/** Formats a timestamp into "Updated Xs ago" */
function formatUpdatedAgo(ts: number | null): string {
  if (ts === null) return '';
  const diffMs = Date.now() - ts;
  const diffS = Math.round(diffMs / 1000);
  if (diffS < 60) return `Updated ${diffS}s ago`;
  const diffMin = Math.round(diffS / 60);
  return `Updated ${diffMin}min ago`;
}

export default function MetricsDashboard() {
  const [period, setPeriod] = useState<Period>('24h');
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [poolStats, setPoolStats] = useState<PoolStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [updatedLabel, setUpdatedLabel] = useState('');

  const fetchMetrics = useCallback(async () => {
    try {
      const [metricsRes, poolRes] = await Promise.all([
        apiFetch(`/api/metrics/summary?period=${period}`, { credentials: 'include' }),
        apiFetch('/api/metrics/pool', { credentials: 'include' }),
      ]);

      if (metricsRes.ok) {
        const data = await metricsRes.json();
        if (data.success !== false) {
          setMetrics(data as MetricsSummary);
        }
      }

      if (poolRes.ok) {
        const data = await poolRes.json();
        if (Array.isArray(data)) {
          setPoolStats(data as PoolStats[]);
        } else if (data.pools && Array.isArray(data.pools)) {
          setPoolStats(data.pools as PoolStats[]);
        }
      }

      setError('');
      setLastUpdated(Date.now());
    } catch {
      setError('Failed to load metrics. The metrics endpoint may not be available yet.');
    } finally {
      setLoading(false);
    }
  }, [period]);

  // Initial fetch + refetch when period changes
  useEffect(() => {
    setLoading(true);
    fetchMetrics();
  }, [fetchMetrics]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      fetchMetrics();
    }, 30_000);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  // Tick "updated X ago" label every 5s
  useEffect(() => {
    const tick = () => setUpdatedLabel(formatUpdatedAgo(lastUpdated));
    tick();
    const iv = setInterval(tick, 5_000);
    return () => clearInterval(iv);
  }, [lastUpdated]);

  const bars = metrics ? aggregateByTime(metrics.requestsByHour) : [];
  const maxToolCount = metrics ? Math.max(...metrics.topTools.map((t) => t.count), 1) : 1;
  const maxTokenCount = metrics ? Math.max(...metrics.topTokens.map((t) => t.count), 1) : 1;

  const totalRequests = metrics ? metrics.errorRate.reduce((sum, r) => sum + r.count, 0) : 0;
  const errorCount = metrics
    ? (metrics.errorRate.find((r) => r.result === 'error')?.count ?? 0)
    : 0;
  const successCount = totalRequests - errorCount;
  const errorPct = totalRequests > 0 ? ((errorCount / totalRequests) * 100).toFixed(1) : '0.0';
  const successPct = totalRequests > 0 ? ((successCount / totalRequests) * 100).toFixed(1) : '0.0';

  // Average response time (weighted by count)
  const avgResponseMs = (() => {
    if (!metrics || metrics.avgResponseTime.length === 0) return null;
    const totalCount = metrics.avgResponseTime.reduce((s, r) => s + r.count, 0);
    if (totalCount === 0) return null;
    const weighted = metrics.avgResponseTime.reduce((s, r) => s + r.avgMs * r.count, 0);
    return Math.round(weighted / totalCount);
  })();

  const activePools = poolStats.filter((p) => p.stats.active > 0).length;
  const idlePools = poolStats.filter((p) => p.stats.active === 0).length;

  // Sparkline from requestsByHour (last 12 buckets)
  const sparklineData = (() => {
    if (!metrics || metrics.requestsByHour.length === 0) return [];
    const sorted = [...metrics.requestsByHour].sort((a, b) => a.hour.localeCompare(b.hour));
    return sorted.slice(-12).map((r) => r.count);
  })();

  const sparklineMax = sparklineData.length > 0 ? Math.max(...sparklineData, 1) : 1;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 hairline-b pb-6 animate-fade-in-up">
        <div className="flex items-center gap-2">
          <Eyebrow accent>ANALYTICS</Eyebrow>
          <span className="eyebrow text-gray-700">·</span>
          <Eyebrow live>LIVE</Eyebrow>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {updatedLabel && (
            <span className="font-mono-plex text-[10px] text-gray-600 hidden sm:block">
              {updatedLabel}
            </span>
          )}
          <SegmentedControl<Period>
            options={[
              { value: '24h', label: '24h', description: 'Last 24 hours' },
              { value: '7d', label: '7d', description: 'Last 7 days' },
              { value: '30d', label: '30d', description: 'Last 30 days' },
            ]}
            value={period}
            onChange={setPeriod}
            ariaLabel="Time period"
          />
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-amber-700/30 bg-amber-900/10 p-4 text-amber-300 text-sm font-mono-plex animate-fade-in-up">
          {error}
        </div>
      )}

      {loading && !metrics ? (
        <div className="flex items-center justify-center py-16 text-gray-500 text-sm gap-2">
          <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          <span className="font-mono-plex text-xs tracking-widest">Loading metrics...</span>
        </div>
      ) : (
        <>
          {/* Row 0: KPI grid */}
          <div
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-fade-in-up"
            style={{ animationDelay: '80ms' }}
          >
            <KpiCard
              accent="indigo"
              eyebrow="Total Requests"
              value={<AnimatedNumber value={totalRequests} />}
              hint="over selected period"
              decoration={
                sparklineData.length > 1 ? (
                  <svg
                    width="60"
                    height="28"
                    viewBox={`0 0 ${sparklineData.length * 10} 28`}
                    preserveAspectRatio="none"
                    aria-hidden="true"
                    className="opacity-60 shrink-0"
                  >
                    <polyline
                      points={sparklineData
                        .map((v, i) => `${i * 10},${28 - (v / sparklineMax) * 24}`)
                        .join(' ')}
                      fill="none"
                      stroke="#748ffc"
                      strokeWidth="1.5"
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      pathLength={100}
                      className="anim-line-draw"
                    />
                  </svg>
                ) : undefined
              }
            />

            <KpiCard
              accent="emerald"
              eyebrow="Success Rate"
              value={
                <span
                  className={
                    parseFloat(successPct) >= 95
                      ? 'text-emerald-400'
                      : parseFloat(successPct) >= 80
                        ? 'text-amber-400'
                        : 'text-rose-400'
                  }
                >
                  <AnimatedNumber value={parseFloat(successPct)} format={(n) => n.toFixed(1)} />%
                </span>
              }
              hint={`${successCount.toLocaleString()} successful calls`}
            />

            <KpiCard
              accent="amber"
              eyebrow="Avg Response"
              value={
                avgResponseMs !== null ? (
                  <span className={responseTimeColor(avgResponseMs)}>
                    <AnimatedNumber value={avgResponseMs} />
                    <span className="font-mono-plex text-lg text-gray-500 ml-1">ms</span>
                  </span>
                ) : (
                  <span className="text-gray-600 text-2xl">—</span>
                )
              }
              hint={avgResponseMs !== null ? 'weighted across all profiles' : 'No data'}
            />

            <KpiCard
              accent="blue"
              eyebrow="Active Pools"
              value={poolStats.length}
              hint={`${activePools} active / ${idlePools} idle`}
            />
          </div>

          {/* Row 1: Requests over time */}
          <div className="card-primary p-6 animate-fade-in-up" style={{ animationDelay: '160ms' }}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="flex items-center gap-2 font-display font-light text-2xl text-gray-100">
                Requests over time
                <HelpTip
                  content="Total number of MCP tool calls aggregated by hour over the selected period."
                  position="top"
                  maxWidth={280}
                  size="xs"
                />
              </h3>
              {bars.length > 0 && (
                <span className="font-mono-plex text-[10px] text-gray-600">
                  {bars.reduce((s, b) => s + b.count, 0).toLocaleString()} total
                </span>
              )}
            </div>
            <BarChart bars={bars} />
          </div>

          {/* Row 2: 3-column grid */}
          <div
            className="grid grid-cols-1 md:grid-cols-3 gap-5 animate-fade-in-up"
            style={{ animationDelay: '240ms' }}
          >
            {/* Success vs Errors */}
            <div className="card-primary p-6 flex flex-col">
              <h3 className="flex items-center gap-2 font-mono-plex uppercase tracking-widest text-[10px] text-gray-500 mb-5">
                Success vs Errors
                <HelpTip
                  content="Breakdown of successful vs. failed tool calls over the selected period."
                  position="top"
                  maxWidth={280}
                  size="xs"
                />
              </h3>
              <div className="flex-1 flex items-center justify-center">
                {totalRequests === 0 ? (
                  <p className="text-gray-600 text-sm text-center py-4">No requests recorded.</p>
                ) : (
                  <DonutChart
                    successPct={successPct}
                    errorPct={errorPct}
                    successCount={successCount}
                    errorCount={errorCount}
                  />
                )}
              </div>
            </div>

            {/* Top Tools */}
            <div className="card-primary p-6 flex flex-col">
              <h3 className="flex items-center gap-2 font-mono-plex uppercase tracking-widest text-[10px] text-gray-500 mb-5">
                Top Tools
                <HelpTip
                  content="Most frequently called MCP tools over the selected period, ranked by call count."
                  position="top"
                  maxWidth={280}
                  size="xs"
                />
              </h3>
              <RankedList
                items={(metrics?.topTools ?? []).map((t) => ({
                  key: t.toolName,
                  label: t.toolName,
                  count: t.count,
                }))}
                max={maxToolCount}
                gradientId="bg-gradient-to-r from-os-600 to-os-400"
                emptyLabel="No tool usage recorded."
              />
            </div>

            {/* Top API Keys */}
            <div className="card-primary p-6 flex flex-col">
              <h3 className="flex items-center gap-2 font-mono-plex uppercase tracking-widest text-[10px] text-gray-500 mb-5">
                Top API Keys
                <HelpTip
                  content="Most active API keys, ranked by number of requests made."
                  position="top"
                  maxWidth={280}
                  size="xs"
                />
              </h3>
              <RankedList
                items={(metrics?.topTokens ?? []).map((t) => ({
                  key: t.tokenLabel,
                  label: t.tokenLabel,
                  count: t.count,
                }))}
                max={maxTokenCount}
                gradientId="bg-gradient-to-r from-fuchsia-600 to-pink-500"
                emptyLabel="No API key activity recorded."
              />
            </div>
          </div>

          {/* Row 3: Avg response time by profile */}
          <div className="card-primary p-6 animate-fade-in-up" style={{ animationDelay: '320ms' }}>
            <h3 className="flex items-center gap-2 font-mono-plex uppercase tracking-widest text-[10px] text-gray-500 mb-5">
              Average Response Time by MCP Server
              <HelpTip
                content="Average response time per MCP server. Green < 100 ms, yellow 100–500 ms, red > 500 ms."
                position="top"
                maxWidth={300}
                size="xs"
              />
            </h3>
            {!metrics || metrics.avgResponseTime.length === 0 ? (
              <p className="text-gray-600 text-sm text-center py-4">
                No response time data available.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full" aria-label="Average response time per MCP server">
                  <thead>
                    <tr className="border-b border-white/5">
                      <th className="pb-3 pr-6 text-left font-mono-plex uppercase tracking-widest text-[10px] text-gray-500">
                        MCP Server
                      </th>
                      <th className="pb-3 pr-6 text-right font-mono-plex uppercase tracking-widest text-[10px] text-gray-500">
                        Avg Response
                      </th>
                      <th className="pb-3 text-right font-mono-plex uppercase tracking-widest text-[10px] text-gray-500">
                        Requests
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.03]">
                    {metrics.avgResponseTime.map((row) => {
                      const maxAvgMs = Math.max(...metrics.avgResponseTime.map((r) => r.avgMs), 1);
                      const barWidthPct = Math.min((row.avgMs / maxAvgMs) * 100, 100);
                      const barColor =
                        row.avgMs < 100
                          ? 'bg-emerald-400'
                          : row.avgMs <= 500
                            ? 'bg-amber-400'
                            : 'bg-rose-400';
                      return (
                        <tr
                          key={row.profileName}
                          className="hover:bg-os-500/[0.02] transition-colors"
                        >
                          <td className="py-4 pr-6">
                            <span className="font-display text-lg text-gray-200">
                              {row.profileName}
                            </span>
                          </td>
                          <td className="py-4 pr-6 text-right">
                            <div className="flex flex-col items-end gap-1">
                              <div>
                                <span
                                  className={`font-display text-2xl ${responseTimeColor(row.avgMs)}`}
                                >
                                  <AnimatedNumber value={row.avgMs} />
                                </span>
                                <span className="font-mono-plex text-xs text-gray-500 ml-1">
                                  ms
                                </span>
                              </div>
                              <div className="w-20 h-[3px] bg-white/5 rounded-full overflow-hidden">
                                <div
                                  className={`h-[3px] w-full origin-left rounded-full ${barColor}`}
                                  style={{
                                    transform: `scaleX(${barWidthPct / 100})`,
                                    transition: 'transform 600ms cubic-bezier(0.16, 1, 0.3, 1)',
                                  }}
                                  aria-hidden="true"
                                />
                              </div>
                            </div>
                          </td>
                          <td className="py-4 text-right">
                            <span className="font-mono-plex text-xs bg-white/5 px-2 py-0.5 rounded-full text-gray-400">
                              <AnimatedNumber value={row.count} />
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Row 4: Connection Pool Stats */}
          {poolStats.length > 0 && (
            <div
              className="card-primary p-6 animate-fade-in-up"
              style={{ animationDelay: '400ms' }}
            >
              <h3 className="flex items-center gap-2 font-mono-plex uppercase tracking-widest text-[10px] text-gray-500 mb-5">
                Connection Pool Stats
                <HelpTip
                  content="Real-time state of database connection pools: active, idle, and waiting connections."
                  position="top"
                  maxWidth={320}
                  size="xs"
                />
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {poolStats.map((pool) => {
                  const isSaturated = pool.stats.waiting > 0;
                  return (
                    <div
                      key={pool.connectionName}
                      className={`rounded-xl border bg-gray-900/60 p-5 space-y-3 transition-all duration-300 ${
                        isSaturated
                          ? 'border-amber-500/30 ring-2 ring-amber-500/40 animate-pulse'
                          : 'border-white/[0.03] hover:ring-1 hover:ring-os-500/20'
                      }`}
                    >
                      <div className="flex items-center gap-4">
                        <PoolRing active={pool.stats.active} total={pool.stats.total} />
                        <div className="min-w-0">
                          <p className="font-display text-xl text-gray-100 truncate">
                            {pool.connectionName}
                          </p>
                          <p className="font-mono-plex text-[10px] text-gray-500 mt-0.5">
                            {pool.stats.total} total connections
                          </p>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <div title="Connections currently processing requests.">
                          <PoolStatBar
                            label="Active"
                            value={pool.stats.active}
                            total={pool.stats.total || 1}
                            color="bg-emerald-400"
                            dotColor="bg-emerald-400"
                          />
                        </div>
                        <div title="Open connections available for reuse.">
                          <PoolStatBar
                            label="Idle"
                            value={pool.stats.idle}
                            total={pool.stats.total || 1}
                            color="bg-blue-400"
                            dotColor="bg-blue-400"
                          />
                        </div>
                        <div title="Requests waiting for a connection. High values indicate pool saturation.">
                          <PoolStatBar
                            label="Waiting"
                            value={pool.stats.waiting}
                            total={pool.stats.total || 1}
                            color="bg-amber-400"
                            dotColor="bg-amber-400"
                          />
                        </div>
                      </div>
                      {isSaturated && (
                        <p className="font-mono-plex text-[10px] uppercase tracking-wider text-amber-400/80 border-t border-amber-500/20 pt-2">
                          Pool saturated — {pool.stats.waiting} waiting
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
