import { useState, useEffect } from 'react';

interface PreviewColumn {
  name: string;
  type: string;
  visible: boolean;
  masking?: string;
}

interface PreviewTable {
  name: string;
  enabledTools: string[];
  rowCount: number;
  columns: PreviewColumn[];
  sampleRow?: Record<string, unknown>;
}

interface PreviewData {
  tables: PreviewTable[];
}

interface ProfilePreviewProps {
  profileName: string;
  onClose: () => void;
}

export default function ProfilePreview({ profileName, onClose }: ProfilePreviewProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PreviewData | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch(`/api/profiles/${encodeURIComponent(profileName)}/preview`, {
          method: 'POST',
          credentials: 'include',
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const msg = (body as { message?: string }).message || `Error ${res.status}`;
          throw new Error(msg);
        }
        const body = await res.json();
        const preview = (body as { preview?: PreviewData }).preview ?? (body as PreviewData);
        setData(preview);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setError((err as Error).message || 'Failed to load preview.');
      } finally {
        setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [profileName]);

  const totalColumns = data?.tables.reduce((acc, t) => acc + t.columns.length, 0) ?? 0;
  const maskedColumns =
    data?.tables.reduce(
      (acc, t) => acc + t.columns.filter((c) => !c.visible || !!c.masking).length,
      0,
    ) ?? 0;

  // Close on backdrop click
  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  // Close on Escape key
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Profile preview: ${profileName}`}
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      onClick={handleBackdropClick}
    >
      <div className="bg-gray-800 rounded-xl border border-gray-700 max-w-4xl w-full max-h-[80vh] overflow-y-auto p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-gray-100">
            Profile Preview:{' '}
            <span className="text-os-400 font-mono">{profileName}</span>
          </h2>
          <button
            onClick={onClose}
            aria-label="Close preview"
            className="p-1.5 rounded-lg text-gray-500 hover:text-gray-200 hover:bg-gray-700/60 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-os-500"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Loading state */}
        {loading && (
          <div className="flex items-center justify-center py-16 text-gray-400">
            <svg className="animate-spin h-6 w-6 mr-3 text-os-500" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            Loading preview...
          </div>
        )}

        {/* Error state */}
        {!loading && error && (
          <div className="rounded-lg bg-red-950/30 border border-red-800/50 p-4 text-red-400 text-sm">
            <p className="font-medium mb-1">Failed to load preview</p>
            <p className="text-red-500">{error}</p>
          </div>
        )}

        {/* Results */}
        {!loading && data && (
          <>
            {/* Summary */}
            <div className="mb-6 flex items-center gap-4 text-sm text-gray-400">
              <span>
                <span className="text-gray-200 font-medium">{data.tables.length}</span> table
                {data.tables.length !== 1 ? 's' : ''}
              </span>
              <span className="text-gray-600">•</span>
              <span>
                <span className="text-gray-200 font-medium">{totalColumns}</span> column
                {totalColumns !== 1 ? 's' : ''}
              </span>
              <span className="text-gray-600">•</span>
              <span>
                <span className="text-yellow-400 font-medium">{maskedColumns}</span> masked
              </span>
            </div>

            {data.tables.length === 0 && (
              <p className="text-gray-500 text-sm text-center py-8">
                No tables found in this profile.
              </p>
            )}

            {/* Table cards */}
            {data.tables.map((table) => (
              <div
                key={table.name}
                className="mb-6 rounded-lg border border-gray-700 bg-gray-800/60 p-4"
              >
                {/* Table header */}
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold text-gray-100">{table.name}</h3>
                  <div className="flex flex-wrap gap-2">
                    {table.enabledTools.map((tool) => (
                      <span
                        key={tool}
                        className="px-2 py-0.5 rounded text-xs bg-os-700/30 text-os-300 font-mono"
                      >
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Row count */}
                <p className="text-xs text-gray-500 mb-3">
                  {table.rowCount.toLocaleString()} row{table.rowCount !== 1 ? 's' : ''}
                </p>

                {/* Columns table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" aria-label={`Columns of table ${table.name}`}>
                    <thead>
                      <tr className="text-gray-500 text-xs border-b border-gray-700">
                        <th className="text-left pb-2 pr-4 font-medium">Column</th>
                        <th className="text-left pb-2 pr-4 font-medium">Type</th>
                        <th className="text-left pb-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {table.columns.map((col) => (
                        <tr key={col.name} className="border-b border-gray-700/40 last:border-0">
                          <td className="py-1.5 pr-4 text-gray-200 font-mono text-xs">
                            {col.name}
                          </td>
                          <td className="py-1.5 pr-4 text-gray-500 text-xs font-mono">
                            {col.type}
                          </td>
                          <td className="py-1.5">
                            {!col.visible ? (
                              <span className="text-red-400 text-xs">Hidden</span>
                            ) : col.masking ? (
                              <span className="text-yellow-400 text-xs">{col.masking}</span>
                            ) : (
                              <span className="text-green-400 text-xs">Visible</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Sample row */}
                {table.sampleRow && (
                  <div className="mt-3">
                    <p className="text-xs text-gray-500 mb-1">
                      Sample row (with masking applied):
                    </p>
                    <pre className="text-xs bg-gray-900/60 rounded p-2 overflow-x-auto text-gray-300 leading-relaxed">
                      {JSON.stringify(table.sampleRow, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
