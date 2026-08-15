// Unit tests for the dashboard activity aggregation. The bucketing must be
// calendar-day based (date-key mapping), not `today - i * 24h` millisecond
// arithmetic — the latter breaks across DST transitions where a local day is
// 23 or 25 hours long. Since the host timezone can't be mocked cheaply here,
// these tests pin the mapping property that DST breaks: every local calendar
// day in the window maps to exactly one bucket, keyed by its local date, with
// midnight-edge entries landing on their own day.

import { describe, it, expect } from 'vitest';
import {
  buildDailySeries,
  activeDayCount,
  countByProfile24h,
  buildProfileSparkSeries,
} from '../activity-stats.js';
import type { AuditLogEntry } from '../../../types/schema.js';

let seq = 0;
function entry(timestamp: Date, profileName = 'default'): AuditLogEntry {
  return {
    id: `e${seq++}`,
    timestamp: timestamp.toISOString(),
    profileName,
    toolName: 'query_users',
    toolArgs: {},
    result: 'success',
    durationMs: 5,
  };
}

/** Local date `daysAgo` days before `now`, at the given local time. */
function localDay(now: number, daysAgo: number, h = 12, m = 0): Date {
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d;
}

// Fixed local reference instant: 2026-08-15 12:00 local time.
const NOW = new Date(2026, 7, 15, 12, 0, 0).getTime();

describe('buildDailySeries', () => {
  it('returns 7 calendar-day buckets ending today', () => {
    const series = buildDailySeries([], NOW);
    expect(series).toHaveLength(7);
    expect(series[6].label.endsWith('15')).toBe(true);
    expect(series[0].label.endsWith('9')).toBe(true);
    expect(series.every((p) => p.count === 0)).toBe(true);
  });

  it('maps each local calendar day of the window to its own bucket', () => {
    // One entry just after each local midnight of the window — the exact
    // pattern that fixed-24h arithmetic mis-buckets across DST transitions.
    const entries = Array.from({ length: 7 }, (_, i) => entry(localDay(NOW, i, 0, 5)));
    const series = buildDailySeries(entries, NOW);
    expect(series.map((p) => p.count)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it('buckets by local calendar day, keeping midnight edges on their day', () => {
    const entries = [
      entry(localDay(NOW, 2, 0, 30)), // day -2, just after midnight
      entry(localDay(NOW, 2, 23, 30)), // day -2, just before next midnight
      entry(localDay(NOW, 6, 23, 59)), // oldest included day, last minute
    ];
    const series = buildDailySeries(entries, NOW);
    expect(series[4].count).toBe(2);
    expect(series[0].count).toBe(1);
  });

  it('ignores entries outside the 7-day window and invalid timestamps', () => {
    const entries = [
      entry(localDay(NOW, 7, 12, 0)), // 7 days ago — out of window
      entry(localDay(NOW, -1, 12, 0)), // tomorrow — out of window
      { ...entry(localDay(NOW, 0)), timestamp: 'not-a-date' },
    ];
    const series = buildDailySeries(entries, NOW);
    expect(series.every((p) => p.count === 0)).toBe(true);
  });
});

describe('activeDayCount', () => {
  it('counts only days with at least one entry', () => {
    const series = buildDailySeries([entry(localDay(NOW, 0)), entry(localDay(NOW, 3))], NOW);
    expect(activeDayCount(series)).toBe(2);
  });
});

describe('countByProfile24h', () => {
  it('counts per profile within the last 24 hours only', () => {
    const entries = [
      entry(new Date(NOW - 2 * 3600 * 1000), 'sales'),
      entry(new Date(NOW - 23 * 3600 * 1000), 'sales'),
      entry(new Date(NOW - 25 * 3600 * 1000), 'sales'), // too old
      entry(new Date(NOW - 3600 * 1000), 'support'),
    ];
    expect(countByProfile24h(entries, NOW)).toEqual({ sales: 2, support: 1 });
  });
});

describe('buildProfileSparkSeries', () => {
  it('builds a per-profile 7-day series', () => {
    const entries = [
      entry(localDay(NOW, 0), 'sales'),
      entry(localDay(NOW, 0), 'support'),
      entry(localDay(NOW, 6), 'sales'),
    ];
    expect(buildProfileSparkSeries(entries, 'sales', NOW)).toEqual([1, 0, 0, 0, 0, 0, 1]);
    expect(buildProfileSparkSeries(entries, 'support', NOW)).toEqual([0, 0, 0, 0, 0, 0, 1]);
  });
});
