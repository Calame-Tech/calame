// Client-side aggregation of the recent-activity feed (AuditLogEntry[]) into
// the small series the dashboard charts render. There is no daily-series
// endpoint — these numbers are computed from the audit entries the dashboard
// already receives, so they honestly reflect "recent activity", not a full
// query-count metric.

import type { AuditLogEntry } from '../../types/schema.js';

export interface DayPoint {
  /** Short label, e.g. "Fri 8". */
  label: string;
  /** Number of audit entries whose timestamp falls on that day. */
  count: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Local-calendar-day key for an instant. Bucketing by key (rather than by
 * `today - i * 24h` millisecond arithmetic) keeps the series correct across
 * DST transitions, where a calendar day is not 24 hours long.
 */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Buckets audit entries into the last 7 calendar days (oldest first, today
 * last). Entries older than the window are ignored. Days are stepped with
 * `setDate` so DST-length days (23h/25h) still map to exactly one bucket.
 */
export function buildDailySeries(entries: AuditLogEntry[], now = Date.now()): DayPoint[] {
  const series: DayPoint[] = [];
  const indexByKey = new Map<string, number>();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    indexByKey.set(dayKey(d), series.length);
    series.push({ label: `${WEEKDAYS[d.getDay()]} ${d.getDate()}`, count: 0 });
  }
  for (const entry of entries) {
    const t = new Date(entry.timestamp);
    if (Number.isNaN(t.getTime())) continue;
    const idx = indexByKey.get(dayKey(t));
    if (idx !== undefined) series[idx].count += 1;
  }
  return series;
}

/** Number of days in the series that saw at least one entry. */
export function activeDayCount(series: DayPoint[]): number {
  return series.filter((p) => p.count > 0).length;
}

/** Entry counts per profile name, restricted to the last 24 hours. */
export function countByProfile24h(
  entries: AuditLogEntry[],
  now = Date.now(),
): Record<string, number> {
  const cutoff = now - 24 * 3600 * 1000;
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const t = new Date(entry.timestamp).getTime();
    if (Number.isNaN(t) || t < cutoff || t > now + 60_000) continue;
    counts[entry.profileName] = (counts[entry.profileName] ?? 0) + 1;
  }
  return counts;
}

/**
 * Per-profile 7-day daily counts (oldest first) used for the trend sparklines
 * in the servers table.
 */
export function buildProfileSparkSeries(
  entries: AuditLogEntry[],
  profileName: string,
  now = Date.now(),
): number[] {
  const series = buildDailySeries(
    entries.filter((e) => e.profileName === profileName),
    now,
  );
  return series.map((p) => p.count);
}

/** Human "time ago" formatting shared by the feed and the status ribbon. */
export function timeAgo(timestamp: string, now = Date.now()): string {
  const time = new Date(timestamp);
  const diffMs = now - time.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  return time.toLocaleDateString();
}
