import { useState, useEffect, useCallback, useRef } from 'react';
import type { Profile, AuditLogEntry } from '../types/schema.js';
import HelpTip from './HelpTip.js';

interface AuditLogViewerProps {
  profiles: Profile[];
}

const PAGE_SIZE = 50;

export default function AuditLogViewer({ profiles }: AuditLogViewerProps) {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);

  // Filters
  const [filterProfile, setFilterProfile] = useState<string>('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');

  // Pagination
  const [offset, setOffset] = useState(0);

  // Expanded rows
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Auto-refresh
  const [autoRefresh, setAutoRefresh] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchEntries = useCallback(async (currentOffset: number) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(currentOffset));
      if (filterProfile) params.set('profileName', filterProfile);
      if (filterDateFrom) params.set('dateFrom', filterDateFrom);
      if (filterDateTo) params.set('dateTo', filterDateTo);

      const res = await fetch(`/api/audit?${params.toString()}`);
      const data = await res.json();
      if (data.success !== false) {
        setEntries(data.entries ?? []);
        setTotalCount(data.total ?? data.entries?.length ?? 0);
      } else {
        setError(data.message || 'Failed to load audit log.');
      }
    } catch {
      setError('Network error loading audit log.');
    } finally {
      setLoading(false);
    }
  }, [filterProfile, filterDateFrom, filterDateTo]);

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
    return d.toLocaleString('en-US', {
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
        {/* Profile filter */}
        <div>
          <label className="flex items-center gap-1 text-xs text-gray-400 mb-1">
            Profile
            <HelpTip content="Filter entries by MCP server." position="top" size="xs" />
          </label>
          <select
            value={filterProfile}
            onChange={(e) => setFilterProfile(e.target.value)}
            className="px-3 py-2 rounded-lg bg-gray-800/80 border border-gray-700 text-gray-100 text-sm focus:outline-none focus:border-os-500 focus:ring-1 focus:ring-os-500/30 appearance-none pr-8"
            style={{
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 8px center',
            }}
          >
            <option value="">All profiles</option>
            {profiles.map((p) => (
              <option key={p.name} value={p.name}>{p.label}</option>
            ))}
          </select>
        </div>

        {/* Date from */}
        <div>
          <label className="flex items-center gap-1 text-xs text-gray-400 mb-1">
            From
            <HelpTip content="Show only entries from this date onward." position="top" size="xs" />
          </label>
          <input
            type="date"
            value={filterDateFrom}
            onChange={(e) => setFilterDateFrom(e.target.value)}
            className="px-3 py-2 rounded-lg bg-gray-800/80 border border-gray-700 text-gray-100 text-sm focus:outline-none focus:border-os-500 focus:ring-1 focus:ring-os-500/30"
          />
        </div>

        {/* Date to */}
        <div>
          <label className="flex items-center gap-1 text-xs text-gray-400 mb-1">
            To
            <HelpTip content="Show only entries up to and including this date." position="top" size="xs" />
          </label>
          <input
            type="date"
            value={filterDateTo}
            onChange={(e) => setFilterDateTo(e.target.value)}
            className="px-3 py-2 rounded-lg bg-gray-800/80 border border-gray-700 text-gray-100 text-sm focus:outline-none focus:border-os-500 focus:ring-1 focus:ring-os-500/30"
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
            Auto-refresh
            <HelpTip content="Automatically refreshes the log every 5 seconds." position="top" size="xs" />
          </span>
        </label>

        {/* Export buttons */}
        <button
          onClick={() => handleExport('json')}
          title="Télécharger toutes les entrées filtrées au format JSON."
          className="px-3 py-2 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:bg-gray-800 text-sm transition-colors"
        >
          Export JSON
        </button>
        <button
          onClick={() => handleExport('csv')}
          title="Télécharger toutes les entrées filtrées au format CSV (compatible Excel)."
          className="px-3 py-2 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:bg-gray-800 text-sm transition-colors"
        >
          Export CSV
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-950/30 border border-red-800/50 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="rounded-lg border border-gray-700 bg-gray-800/40 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-400 border-b border-gray-700">
              <th className="px-4 py-3 font-medium">
                <span className="flex items-center gap-1">Time <HelpTip content="Timestamp of the tool call." position="bottom" size="xs" /></span>
              </th>
              <th className="px-4 py-3 font-medium">
                <span className="flex items-center gap-1">Profile <HelpTip content="MCP server that handled the request." position="bottom" size="xs" /></span>
              </th>
              <th className="px-4 py-3 font-medium">
                <span className="flex items-center gap-1">Tool <HelpTip content="Name of the MCP tool that was called." position="bottom" size="xs" /></span>
              </th>
              <th className="px-4 py-3 font-medium">
                <span className="flex items-center gap-1">Result <HelpTip content="Execution outcome: success or error." position="bottom" size="xs" /></span>
              </th>
              <th className="px-4 py-3 font-medium">
                <span className="flex items-center gap-1">Duration <HelpTip content="Total execution time of the tool, in milliseconds or seconds." position="bottom" size="xs" /></span>
              </th>
              <th className="px-4 py-3 font-medium">
                <span className="flex items-center gap-1">Summary <HelpTip content="Short summary of the result or error returned." position="bottom" size="xs" /></span>
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && entries.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                  Loading audit log...
                </td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                  No audit log entries found.
                </td>
              </tr>
            ) : (
              entries.map((entry) => (
                <>
                  <tr
                    key={entry.id}
                    className="border-b border-gray-800 hover:bg-gray-800/60 cursor-pointer transition-colors"
                    onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                  >
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
                        title={entry.result === 'success' ? "L'outil a été exécuté sans erreur." : "L'outil a échoué. Cliquez sur la ligne pour voir les détails."}
                        className={`px-2 py-0.5 rounded-full text-xs ${
                          entry.result === 'success'
                            ? 'bg-green-500/20 text-green-400'
                            : 'bg-red-500/20 text-red-400'
                        }`}
                      >
                        {entry.result}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">
                      {formatDuration(entry.durationMs)}
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs max-w-xs truncate">
                      {entry.resultSummary ?? '-'}
                    </td>
                  </tr>
                  {expandedId === entry.id && (
                    <tr key={`${entry.id}-expanded`} className="border-b border-gray-800">
                      <td colSpan={6} className="px-4 py-3 bg-gray-900/50">
                        <div className="text-xs text-gray-400 mb-1">Tool Arguments:</div>
                        <pre className="p-3 rounded bg-gray-900 border border-gray-700 text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre-wrap">
                          {JSON.stringify(entry.toolArgs, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-500">
            Showing {offset + 1}-{Math.min(offset + PAGE_SIZE, totalCount)} of {totalCount} entries
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handlePageChange(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <span className="text-gray-400">
              Page {currentPage} of {totalPages}
            </span>
            <button
              onClick={() => handlePageChange(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= totalCount}
              className="px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
