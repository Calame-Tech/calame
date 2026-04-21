import { useState, useEffect, useCallback } from 'react';
import type { MetricsSummary, PoolStats } from '../types/schema.js';
import HelpTip from './HelpTip.js';

type Period = '24h' | '7d' | '30d';

/** Returns a Tailwind text color class based on response time in ms */
function responseTimeColor(ms: number): string {
  if (ms < 100) return 'text-green-400';
  if (ms <= 500) return 'text-yellow-400';
  return 'text-red-400';
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

/** Simple SVG vertical bar chart — no external library */
function BarChart({ bars }: { bars: Array<{ label: string; count: number }> }) {
  if (bars.length === 0) {
    return <p className="text-gray-500 text-sm text-center py-6">No data for this period.</p>;
  }

  const maxCount = Math.max(...bars.map((b) => b.count), 1);
  const chartHeight = 120;
  const barWidth = Math.max(8, Math.min(32, Math.floor(560 / bars.length) - 4));
  const gap = 4;
  const svgWidth = bars.length * (barWidth + gap);

  return (
    <div className="overflow-x-auto">
      <svg
        width={svgWidth}
        height={chartHeight + 28}
        aria-label="Requests over time bar chart"
        role="img"
      >
        {bars.map((bar, i) => {
          const barH = Math.max(2, Math.round((bar.count / maxCount) * chartHeight));
          const x = i * (barWidth + gap);
          const y = chartHeight - barH;
          return (
            <g key={bar.label}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barH}
                fill="#7c5bf2"
                opacity={0.8}
                rx={2}
              >
                <title>{`${bar.label}: ${bar.count} requests`}</title>
              </rect>
              {bars.length <= 24 && (
                <text
                  x={x + barWidth / 2}
                  y={chartHeight + 16}
                  textAnchor="middle"
                  fontSize={9}
                  fill="#6b7280"
                >
                  {bar.label.slice(-5)}
                </text>
              )}
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
  color = 'bg-os-600',
}: {
  label: string;
  count: number;
  max: number;
  color?: string;
}) {
  const pct = max > 0 ? Math.max(2, Math.round((count / max) * 100)) : 2;
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="w-40 text-xs text-gray-300 truncate shrink-0" title={label}>
        {label}
      </span>
      <div className="flex-1 bg-gray-700 rounded-full h-2 overflow-hidden">
        <div
          className={`h-2 rounded-full ${color}`}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={count}
          aria-valuemax={max}
          aria-label={`${label}: ${count}`}
        />
      </div>
      <span className="text-xs text-gray-400 w-10 text-right shrink-0">{count}</span>
    </div>
  );
}

/** Pool stats progress bars */
function PoolStatBar({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-400 w-16 shrink-0">{label}</span>
      <div className="flex-1 bg-gray-700 rounded-full h-1.5 overflow-hidden">
        <div
          className={`h-1.5 rounded-full ${color}`}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={value}
          aria-valuemax={total}
          aria-label={`${label}: ${value}`}
        />
      </div>
      <span className="text-xs text-gray-500 w-8 text-right shrink-0">{value}</span>
    </div>
  );
}

export default function MetricsDashboard() {
  const [period, setPeriod] = useState<Period>('24h');
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [poolStats, setPoolStats] = useState<PoolStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchMetrics = useCallback(async () => {
    try {
      const [metricsRes, poolRes] = await Promise.all([
        fetch(`/api/metrics/summary?period=${period}`, { credentials: 'include' }),
        fetch('/api/metrics/pool', { credentials: 'include' }),
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

  const bars = metrics ? aggregateByTime(metrics.requestsByHour) : [];
  const maxToolCount = metrics ? Math.max(...metrics.topTools.map((t) => t.count), 1) : 1;
  const maxTokenCount = metrics ? Math.max(...metrics.topTokens.map((t) => t.count), 1) : 1;

  const totalRequests = metrics
    ? metrics.errorRate.reduce((sum, r) => sum + r.count, 0)
    : 0;
  const errorCount = metrics
    ? (metrics.errorRate.find((r) => r.result === 'error')?.count ?? 0)
    : 0;
  const successCount = totalRequests - errorCount;
  const errorPct = totalRequests > 0 ? ((errorCount / totalRequests) * 100).toFixed(1) : '0.0';
  const successPct = totalRequests > 0 ? ((successCount / totalRequests) * 100).toFixed(1) : '0.0';

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header + period selector */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-100">Metrics</h2>
          <p className="text-sm text-gray-500 mt-0.5">Usage analytics and performance data</p>
        </div>
        <div className="flex items-center gap-1 bg-gray-800/60 rounded-lg p-1" role="group" aria-label="Time period">
          {(
            [
              { value: '24h' as Period, label: '24h', description: 'Afficher les métriques des dernières 24 heures.' },
              { value: '7d' as Period, label: '7d', description: 'Afficher les métriques des 7 derniers jours.' },
              { value: '30d' as Period, label: '30d', description: 'Afficher les métriques des 30 derniers jours.' },
            ] as const
          ).map(({ value, label, description }) => (
            <button
              key={value}
              onClick={() => setPeriod(value)}
              title={description}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-all duration-150 ${
                period === value
                  ? 'bg-os-700 text-white shadow'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/50'
              }`}
              aria-pressed={period === value}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-yellow-700/50 bg-yellow-900/20 p-4 text-yellow-300 text-sm">
          {error}
        </div>
      )}

      {loading && !metrics ? (
        <div className="flex items-center justify-center py-16 text-gray-400 text-sm">
          <svg className="w-5 h-5 animate-spin mr-2" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading metrics...
        </div>
      ) : (
        <>
          {/* Row 1: Requests over time */}
          <div className="rounded-xl border border-gray-700 bg-gray-800/40 p-6">
            <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
              Requests Over Time
            </h3>
            <BarChart bars={bars} />
            {bars.length > 0 && (
              <p className="text-xs text-gray-600 mt-2 text-right">
                {bars.reduce((s, b) => s + b.count, 0)} total requests
              </p>
            )}
          </div>

          {/* Row 2: 3-column grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Error rate */}
            <div className="rounded-xl border border-gray-700 bg-gray-800/40 p-6">
              <h3 className="flex items-center gap-1 text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
                Success vs Errors
                <HelpTip content="Répartition entre les appels d'outils réussis et ceux ayant échoué sur la période sélectionnée." position="top" maxWidth={280} size="xs" />
              </h3>
              {totalRequests === 0 ? (
                <p className="text-gray-500 text-sm text-center py-4">No requests recorded.</p>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-green-500 inline-block" aria-hidden="true" />
                      <span className="text-sm text-gray-300">Success</span>
                    </div>
                    <div className="text-right">
                      <span className="text-green-400 font-semibold">{successPct}%</span>
                      <span className="text-gray-500 text-xs ml-2">{successCount}</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block" aria-hidden="true" />
                      <span className="text-sm text-gray-300">Error</span>
                    </div>
                    <div className="text-right">
                      <span className="text-red-400 font-semibold">{errorPct}%</span>
                      <span className="text-gray-500 text-xs ml-2">{errorCount}</span>
                    </div>
                  </div>
                  {/* Visual split bar */}
                  <div className="h-2 rounded-full bg-gray-700 overflow-hidden flex mt-2">
                    <div
                      className="h-full bg-green-500"
                      style={{ width: `${successPct}%` }}
                      aria-hidden="true"
                    />
                    <div
                      className="h-full bg-red-500"
                      style={{ width: `${errorPct}%` }}
                      aria-hidden="true"
                    />
                  </div>
                  <p className="text-xs text-gray-600 text-right">{totalRequests} total</p>
                </div>
              )}
            </div>

            {/* Top tools */}
            <div className="rounded-xl border border-gray-700 bg-gray-800/40 p-6">
              <h3 className="flex items-center gap-1 text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
                Top Tools
                <HelpTip content="Les outils MCP les plus appelés sur la période sélectionnée, classés par nombre d'appels." position="top" maxWidth={280} size="xs" />
              </h3>
              {!metrics || metrics.topTools.length === 0 ? (
                <p className="text-gray-500 text-sm text-center py-4">No tool usage recorded.</p>
              ) : (
                <div className="space-y-1">
                  {metrics.topTools.slice(0, 10).map((t) => (
                    <HorizontalBar
                      key={t.toolName}
                      label={t.toolName}
                      count={t.count}
                      max={maxToolCount}
                      color="bg-os-600"
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Top tokens */}
            <div className="rounded-xl border border-gray-700 bg-gray-800/40 p-6">
              <h3 className="flex items-center gap-1 text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
                Top Tokens
                <HelpTip content="Les tokens d'authentification les plus actifs, classés par nombre de requêtes effectuées." position="top" maxWidth={280} size="xs" />
              </h3>
              {!metrics || metrics.topTokens.length === 0 ? (
                <p className="text-gray-500 text-sm text-center py-4">No token activity recorded.</p>
              ) : (
                <div className="space-y-1">
                  {metrics.topTokens.slice(0, 10).map((t, i) => (
                    <div key={t.tokenLabel} className="flex items-center gap-3 py-1">
                      <span className="text-xs text-gray-600 w-5 shrink-0 text-right">{i + 1}.</span>
                      <HorizontalBar
                        label={t.tokenLabel}
                        count={t.count}
                        max={maxTokenCount}
                        color="bg-purple-600"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Row 3: Avg response time per profile */}
          <div className="rounded-xl border border-gray-700 bg-gray-800/40 p-6">
            <h3 className="flex items-center gap-1 text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
              Average Response Time by Profile
              <HelpTip content="Temps de réponse moyen par serveur MCP. Vert < 100 ms, jaune 100-500 ms, rouge > 500 ms." position="top" maxWidth={300} size="xs" />
            </h3>
            {!metrics || metrics.avgResponseTime.length === 0 ? (
              <p className="text-gray-500 text-sm text-center py-4">No response time data available.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" aria-label="Average response time per profile">
                  <thead>
                    <tr className="text-left border-b border-gray-700">
                      <th className="pb-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Profile
                      </th>
                      <th className="pb-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-wider text-right">
                        Avg Response
                      </th>
                      <th className="pb-2 text-xs font-medium text-gray-500 uppercase tracking-wider text-right">
                        Requests
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700/50">
                    {metrics.avgResponseTime.map((row) => (
                      <tr key={row.profileName}>
                        <td className="py-2.5 pr-4 text-gray-300 font-mono text-xs">
                          {row.profileName}
                        </td>
                        <td className={`py-2.5 pr-4 text-right font-semibold ${responseTimeColor(row.avgMs)}`}>
                          {Math.round(row.avgMs)} ms
                        </td>
                        <td className="py-2.5 text-right text-gray-500 text-xs">{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-xs text-gray-600 mt-3">
                  Color: <span className="text-green-400">green</span> &lt; 100 ms |{' '}
                  <span className="text-yellow-400">yellow</span> 100-500 ms |{' '}
                  <span className="text-red-400">red</span> &gt; 500 ms
                </p>
              </div>
            )}
          </div>

          {/* Row 4: Pool stats */}
          {poolStats.length > 0 && (
            <div className="rounded-xl border border-gray-700 bg-gray-800/40 p-6">
              <h3 className="flex items-center gap-1 text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
                Connection Pool Stats
                <HelpTip content="État en temps réel des pools de connexions à la base de données : connexions actives, inactives et en attente." position="top" maxWidth={320} size="xs" />
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                {poolStats.map((pool) => (
                  <div
                    key={pool.connectionName}
                    className="rounded-lg border border-gray-700/50 bg-gray-800/60 p-4 space-y-2"
                  >
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-sm font-medium text-gray-200 truncate">
                        {pool.connectionName}
                      </span>
                      <span className="text-xs text-gray-500 shrink-0 ml-2">
                        total: {pool.stats.total}
                      </span>
                    </div>
                    <div title="Connexions actuellement utilisées pour traiter des requêtes.">
                      <PoolStatBar
                        label="Active"
                        value={pool.stats.active}
                        total={pool.stats.total || 1}
                        color="bg-green-500"
                      />
                    </div>
                    <div title="Connexions ouvertes disponibles, prêtes à être réutilisées.">
                      <PoolStatBar
                        label="Idle"
                        value={pool.stats.idle}
                        total={pool.stats.total || 1}
                        color="bg-blue-500"
                      />
                    </div>
                    <div title="Requêtes en attente d'une connexion disponible. Un nombre élevé indique une saturation du pool.">
                      <PoolStatBar
                        label="Waiting"
                        value={pool.stats.waiting}
                        total={pool.stats.total || 1}
                        color="bg-yellow-500"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
