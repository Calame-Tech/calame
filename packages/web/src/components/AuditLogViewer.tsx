import { Fragment, useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'use-intl/react';
import { apiFetch } from '../lib/api.js';
import type { Profile, AuditLogEntry } from '../types/schema.js';
import HelpTip from './HelpTip.js';
import { useLocale } from '../i18n/I18nProvider.js';

interface AuditLogViewerProps {
  profiles: Profile[];
}

const PAGE_SIZE = 50;

export default function AuditLogViewer({ profiles }: AuditLogViewerProps) {
  const t = useTranslations('auditLog.viewer');
  const { locale } = useLocale();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);

  // Filters
  // When the viewer is scoped to a single MCP server, default the filter to
  // that profile so the log doesn't show entries from every other server.
  const [filterProfile, setFilterProfile] = useState<string>(
    profiles.length === 1 ? profiles[0].name : '',
  );
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');

  // Pagination
  const [offset, setOffset] = useState(0);

  // Expanded rows
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Auto-refresh
  const [autoRefresh, setAutoRefresh] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchEntries = useCallback(
    async (currentOffset: number) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        params.set('limit', String(PAGE_SIZE));
        params.set('offset', String(currentOffset));
        if (filterProfile) params.set('profileName', filterProfile);
        if (filterDateFrom) params.set('dateFrom', filterDateFrom);
        if (filterDateTo) params.set('dateTo', filterDateTo);

        const res = await apiFetch(`/api/audit?${params.toString()}`);
        const data = await res.json();
        if (data.success !== false) {
          setEntries(data.entries ?? []);
          setTotalCount(data.total ?? data.entries?.length ?? 0);
        } else {
          setError(data.message || t('errors.loadFailed'));
        }
      } catch {
        setError(t('errors.networkError'));
      } finally {
        setLoading(false);
      }
    },
    [filterProfile, filterDateFrom, filterDateTo, t],
  );

  useEffect(() => {
    setOffset(0);
    fetchEntries(0);
  }, [fetchEntries]);

  // Auto-refresh polling
  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(() => {
        fetchEntries(offset);
      }, 5000);
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoRefresh, offset, fetchEntries]);

  const handlePageChange = (newOffset: number) => {
    setOffset(newOffset);
    fetchEntries(newOffset);
  };

  const handleExport = (format: 'json' | 'csv') => {
    const params = new URLSearchParams();
    params.set('format', format);
    if (filterProfile) params.set('profileName', filterProfile);
    if (filterDateFrom) params.set('dateFrom', filterDateFrom);
    if (filterDateTo) params.set('dateTo', filterDateTo);
    window.open(`/api/audit/export?${params.toString()}`, '_blank');
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="space-y-4">
      {/* Filters bar */}
      <div className="flex flex-wrap items-end gap-3">
        {/* Profile filter — hidden when scoped to a single MCP server, since
            there is nothing meaningful to filter between. */}
        {profiles.length > 1 && (
          <div>
            <label className="flex items-center gap-1 text-xs text-gray-400 mb-1">
              {t('filters.mcpServerLabel')}
              <HelpTip content={t('filters.mcpServerHelp')} position="top" size="xs" />
            </label>
            <select
              value={filterProfile}
              onChange={(e) => setFilterProfile(e.target.value)}
              className="input-editorial text-sm appearance-none pr-8"
              style={{
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'right 8px center',
              }}
            >
              <option value="">{t('filters.allServers')}</option>
              {profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Date from */}
        <div>
          <label className="flex items-center gap-1 text-xs text-gray-400 mb-1">
            {t('filters.fromLabel')}
            <HelpTip content={t('filters.fromHelp')} position="top" size="xs" />
          </label>
          <input
            type="date"
            value={filterDateFrom}
            onChange={(e) => setFilterDateFrom(e.target.value)}
            className="input-editorial text-sm"
          />
        </div>

        {/* Date to */}
        <div>
          <label className="flex items-center gap-1 text-xs text-gray-400 mb-1">
            {t('filters.toLabel')}
            <HelpTip content={t('filters.toHelp')} position="top" size="xs" />
          </label>
          <input
            type="date"
            value={filterDateTo}
            onChange={(e) => setFilterDateTo(e.target.value)}
            className="input-editorial text-sm"
          />
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Auto-refresh toggle */}
        <label className="flex items-center gap-2 cursor-pointer">
          <div
            className={`relative w-9 h-5 rounded-full transition-colors duration-200 ${
              autoRefresh ? 'bg-os-600' : 'bg-gray-700'
            }`}
            onClick={() => setAutoRefresh(!autoRefresh)}
          >
            <div
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${
                autoRefresh ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </div>
          <span className="flex items-center gap-1 text-xs text-gray-400">
            {t('autoRefresh.label')}
            <HelpTip content={t('autoRefresh.help')} position="top" size="xs" />
          </span>
        </label>

        {/* Export buttons */}
        <button
          onClick={() => handleExport('json')}
          title={t('export.jsonTooltip')}
          className="px-3 py-2 rounded-lg border border-white/10 text-gray-400 hover:text-gray-200 hover:bg-gray-800 text-sm transition-colors"
        >
          {t('export.jsonButton')}
        </button>
        <button
          onClick={() => handleExport('csv')}
          title={t('export.csvTooltip')}
          className="px-3 py-2 rounded-lg border border-white/10 text-gray-400 hover:text-gray-200 hover:bg-gray-800 text-sm transition-colors"
        >
          {t('export.csvButton')}
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-950/30 border border-red-800/50 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="card-solid overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-400 border-b border-white/5">
              <th className="w-8 px-2 py-3" />
              <th className="px-4 py-3 font-medium">
                <span className="flex items-center gap-1">
                  {t('table.colTime')}{' '}
                  <HelpTip content={t('table.colTimeTooltip')} position="bottom" size="xs" />
                </span>
              </th>
              <th className="px-4 py-3 font-medium">
                <span className="flex items-center gap-1">
                  {t('table.colServer')}{' '}
                  <HelpTip content={t('table.colServerTooltip')} position="bottom" size="xs" />
                </span>
              </th>
              <th className="px-4 py-3 font-medium">
                <span className="flex items-center gap-1">
                  {t('table.colTool')}{' '}
                  <HelpTip content={t('table.colToolTooltip')} position="bottom" size="xs" />
                </span>
              </th>
              <th className="px-4 py-3 font-medium">
                <span className="flex items-center gap-1">
                  {t('table.colResult')}{' '}
                  <HelpTip content={t('table.colResultTooltip')} position="bottom" size="xs" />
                </span>
              </th>
              <th className="px-4 py-3 font-medium">
                <span className="flex items-center gap-1">
                  {t('table.colDuration')}{' '}
                  <HelpTip content={t('table.colDurationTooltip')} position="bottom" size="xs" />
                </span>
              </th>
              <th className="px-4 py-3 font-medium">
                <span className="flex items-center gap-1">
                  {t('table.colSummary')}{' '}
                  <HelpTip content={t('table.colSummaryTooltip')} position="bottom" size="xs" />
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && entries.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                  {t('table.loading')}
                </td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                  {t('table.empty')}
                </td>
              </tr>
            ) : (
              entries.map((entry) => {
                const isExpandable = Boolean(entry.resultData);
                const isExpanded = expandedId === entry.id;

                const prettyResultData = (() => {
                  if (!entry.resultData) return null;
                  try {
                    return JSON.stringify(JSON.parse(entry.resultData), null, 2);
                  } catch {
                    return entry.resultData;
                  }
                })();

                return (
                  <Fragment key={entry.id}>
                    <tr
                      className={`border-b border-white/5 transition-colors ${
                        isExpandable ? 'hover:bg-gray-800/40 cursor-pointer' : ''
                      }`}
                      onClick={
                        isExpandable ? () => setExpandedId(isExpanded ? null : entry.id) : undefined
                      }
                    >
                      <td className="w-8 px-2 py-3 text-center text-gray-500">
                        {isExpandable && (
                          <span className="text-xs select-none" aria-hidden="true">
                            {isExpanded ? '▼' : '▶'}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-300 whitespace-nowrap">
                        {formatTime(entry.timestamp)}
                      </td>
                      <td className="px-4 py-3 text-gray-300">
                        <span className="font-mono text-xs">{entry.profileName}</span>
                      </td>
                      <td className="px-4 py-3 text-gray-200 font-mono text-xs">
                        {entry.toolName}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          title={
                            entry.result === 'success'
                              ? t('table.resultSuccessTooltip')
                              : t('table.resultErrorTooltip')
                          }
                          className={`px-2 py-0.5 rounded-full text-xs ${
                            entry.result === 'success'
                              ? 'bg-green-500/20 text-green-400'
                              : 'bg-red-500/20 text-red-400'
                          }`}
                        >
                          {entry.result === 'success'
                            ? t('table.resultSuccess')
                            : t('table.resultError')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">
                        {formatDuration(entry.durationMs)}
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs max-w-xs truncate">
                        {entry.resultSummary ?? '-'}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${entry.id}-expanded`} className="border-b border-white/5">
                        <td colSpan={7} className="px-4 py-3 bg-gray-900/50">
                          <div className="space-y-3">
                            <div>
                              <div className="text-xs text-gray-400 mb-1">
                                {t('expanded.toolArguments')}
                              </div>
                              <pre className="p-3 rounded bg-gray-900 border border-gray-700 text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre">
                                {JSON.stringify(entry.toolArgs, null, 2)}
                              </pre>
                            </div>
                            {prettyResultData !== null && (
                              <div>
                                <div className="text-xs text-gray-400 mb-1">
                                  {t('expanded.rawResult')}
                                </div>
                                <pre className="p-3 rounded bg-gray-900 border border-gray-700 text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre">
                                  {prettyResultData}
                                </pre>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-500">
            {t('pagination.showing', {
              from: offset + 1,
              to: Math.min(offset + PAGE_SIZE, totalCount),
              total: totalCount,
            })}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handlePageChange(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="px-3 py-1.5 rounded-lg border border-white/10 text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {t('pagination.previous')}
            </button>
            <span className="text-gray-400">
              {t('pagination.pageOf', { current: currentPage, total: totalPages })}
            </span>
            <button
              onClick={() => handlePageChange(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= totalCount}
              className="px-3 py-1.5 rounded-lg border border-white/10 text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {t('pagination.next')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
