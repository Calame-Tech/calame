import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../lib/api.js';
import type { PendingWriteQuery } from '../types/schema.js';

interface PendingQueriesProps {
  onPendingCountChange?: (count: number) => void;
}

type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected';

export default function PendingQueries({ onPendingCountChange }: PendingQueriesProps) {
  const [entries, setEntries] = useState<PendingWriteQuery[]>([]);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchEntries = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      params.set('limit', '50');
      params.set('offset', '0');

      const res = await fetch(`/api/write-queue?${params}`);
      const data = await res.json();
      if (data.success !== false) {
        setEntries(data.entries ?? []);
        setTotal(data.total ?? 0);
      }
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  const fetchPendingCount = useCallback(async () => {
    try {
      const res = await apiFetch('/api/write-queue/count');
      const data = await res.json();
      if (data.success !== false && onPendingCountChange) {
        onPendingCountChange(data.pending ?? 0);
      }
    } catch {
      // Silently fail
    }
  }, [onPendingCountChange]);

  useEffect(() => {
    fetchEntries();
    fetchPendingCount();
  }, [fetchEntries, fetchPendingCount]);

  // Auto-refresh every 5 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      fetchEntries();
      fetchPendingCount();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchEntries, fetchPendingCount]);

  const handleApprove = async (id: string) => {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/write-queue/${id}/approve`, { method: 'POST' });
      const data = await res.json();
      if (data.success !== false) {
        await fetchEntries();
        await fetchPendingCount();
      }
    } catch {
      // Silently fail
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async (id: string) => {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/write-queue/${id}/reject`, { method: 'POST' });
      const data = await res.json();
      if (data.success !== false) {
        await fetchEntries();
        await fetchPendingCount();
      }
    } catch {
      // Silently fail
    } finally {
      setActionLoading(null);
    }
  };

  const statusBadge = (status: PendingWriteQuery['status']) => {
    const statusInfo: Record<PendingWriteQuery['status'], { classes: string; tooltip: string }> = {
      pending: {
        classes: 'bg-yellow-600/20 text-yellow-400',
        tooltip: 'En attente de validation par un administrateur.',
      },
      approved: {
        classes: 'bg-green-600/20 text-green-400',
        tooltip: 'Requête approuvée et exécutée en base de données.',
      },
      rejected: {
        classes: 'bg-red-600/20 text-red-400',
        tooltip: 'Requête rejetée — elle ne sera pas exécutée.',
      },
    };
    const info = statusInfo[status];
    return (
      <span
        title={info.tooltip}
        className={`px-2 py-0.5 rounded-full text-xs font-medium ${info.classes}`}
      >
        {status}
      </span>
    );
  };

  const operationBadge = (op: PendingWriteQuery['operation']) => {
    const opInfo: Record<PendingWriteQuery['operation'], { classes: string; tooltip: string }> = {
      insert: {
        classes: 'bg-blue-600/20 text-blue-400',
        tooltip: 'Opération INSERT — ajoute de nouvelles lignes dans la table.',
      },
      update: {
        classes: 'bg-amber-600/20 text-amber-400',
        tooltip: 'Opération UPDATE — modifie des lignes existantes dans la table.',
      },
      delete: {
        classes: 'bg-red-600/20 text-red-400',
        tooltip:
          'Opération DELETE — supprime des lignes de la table. Irréversible sans sauvegarde.',
      },
    };
    const info = opInfo[op];
    return (
      <span
        title={info.tooltip}
        className={`px-2 py-0.5 rounded-full text-xs font-medium uppercase ${info.classes}`}
      >
        {op}
      </span>
    );
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString();
  };

  const filters: { value: StatusFilter; label: string }[] = [
    { value: 'pending', label: 'Pending' },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'all', label: 'All' },
  ];

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          {filters.map((f) => (
            <button
              key={f.value}
              onClick={() => setStatusFilter(f.value)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                statusFilter === f.value
                  ? 'bg-os-700 text-white'
                  : 'bg-gray-800/60 text-gray-400 hover:bg-gray-700/60 hover:text-gray-300'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="text-sm text-gray-500">
          {total} {statusFilter === 'all' ? 'total' : statusFilter}{' '}
          {total === 1 ? 'query' : 'queries'}
        </span>
      </div>

      {/* Entries */}
      {loading && entries.length === 0 ? (
        <div className="text-center text-gray-500 py-8">Loading...</div>
      ) : entries.length === 0 ? (
        <div className="card-primary p-8 text-center text-gray-500">
          No {statusFilter === 'all' ? '' : statusFilter} write queries.
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <div key={entry.id} className="card-primary p-4">
              {/* Header row */}
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  {operationBadge(entry.operation)}
                  {statusBadge(entry.status)}
                  <span className="text-sm font-mono text-os-400 shrink-0">{entry.tableName}</span>
                  <span className="text-sm text-gray-400 truncate">{entry.description}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-gray-500">{formatTime(entry.timestamp)}</span>
                  <span className="text-xs text-gray-600 font-mono">{entry.profileName}</span>
                  {entry.status === 'pending' && (
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleApprove(entry.id)}
                        disabled={actionLoading === entry.id}
                        title="Approuver et exécuter immédiatement cette requête en base de données."
                        className="px-3 py-1.5 rounded-lg bg-green-600/20 text-green-400 hover:bg-green-600/30 text-sm font-medium transition-all duration-200 disabled:opacity-50"
                      >
                        {actionLoading === entry.id ? '...' : 'Approve'}
                      </button>
                      <button
                        onClick={() => handleReject(entry.id)}
                        disabled={actionLoading === entry.id}
                        title="Rejeter cette requête — elle ne sera pas exécutée et sera marquée comme rejetée."
                        className="px-3 py-1.5 rounded-lg bg-red-600/20 text-red-400 hover:bg-red-600/30 text-sm font-medium transition-all duration-200 disabled:opacity-50"
                      >
                        {actionLoading === entry.id ? '...' : 'Reject'}
                      </button>
                    </div>
                  )}
                  <button
                    onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                    title={
                      expandedId === entry.id
                        ? 'Masquer le SQL et les paramètres de cette requête.'
                        : 'Afficher le SQL complet et les paramètres de cette requête.'
                    }
                    className="text-gray-500 hover:text-gray-300 text-sm transition-colors"
                  >
                    {expandedId === entry.id ? 'Hide' : 'Details'}
                  </button>
                </div>
              </div>

              {/* Expanded details */}
              {expandedId === entry.id && (
                <div className="mt-3 pt-3 border-t border-white/5 space-y-2">
                  <div>
                    <span className="text-xs text-gray-500">SQL:</span>
                    <pre className="mt-1 p-2 rounded bg-gray-900 border border-gray-700 text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre-wrap">
                      {entry.sql}
                    </pre>
                  </div>
                  {entry.params && entry.params.length > 0 && (
                    <div>
                      <span className="text-xs text-gray-500">Parameters:</span>
                      <pre className="mt-1 p-2 rounded bg-gray-900 border border-gray-700 text-xs text-gray-300 font-mono overflow-x-auto">
                        {JSON.stringify(entry.params, null, 2)}
                      </pre>
                    </div>
                  )}
                  {entry.approvedAt && (
                    <p className="text-xs text-gray-500">
                      Approved at: {formatTime(entry.approvedAt)}
                    </p>
                  )}
                  {entry.executionResult && (
                    <div>
                      <span className="text-xs text-green-500">Execution result:</span>
                      <pre className="mt-1 p-2 rounded bg-gray-900 border border-gray-700 text-xs text-green-300 font-mono overflow-x-auto">
                        {entry.executionResult}
                      </pre>
                    </div>
                  )}
                  {entry.executionError && (
                    <div>
                      <span className="text-xs text-red-500">Execution error:</span>
                      <pre className="mt-1 p-2 rounded bg-gray-900 border border-gray-700 text-xs text-red-300 font-mono overflow-x-auto">
                        {entry.executionError}
                      </pre>
                    </div>
                  )}
                  <p className="text-xs text-gray-600 font-mono">ID: {entry.id}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
