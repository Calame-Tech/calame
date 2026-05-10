import React, { useState, useEffect, Suspense } from 'react';
import type { NamedConnection, DatabaseSchema } from '../types/schema.js';
import ConnectionManager from './ConnectionManager.js';
import AddSourceModal from './AddSourceModal.js';

export type SourcesTab = 'databases' | 'knowledge';

export interface SourcesPageProps {
  /** Current tab to display */
  currentTab: SourcesTab;
  /** Called when the user switches tabs */
  onTabChange: (tab: SourcesTab) => void;
  /** Open the "Add source" modal (or navigate directly) */
  onAddSource?: () => void;

  // --- ConnectionManager passthrough props ---
  connections: NamedConnection[];
  onConnectionsChange: (connections: NamedConnection[]) => void;
  onSchemaLoaded: (connectionName: string, schema: DatabaseSchema) => void;
  editConnectionName?: string;

  // --- RAG capability ---
  ragEnabled: boolean;
  ragDisabledReason?: string | null;
  /**
   * Lazy-loaded KnowledgeBaseManager component from the EE package.
   * Must be passed as a React.ComponentType so that SourcesPage never
   * directly imports @calame-ee/* (BUSL package).
   */
  KnowledgeBaseManagerComponent: React.ComponentType;
}

/** Fetch count of RAG sources so the KB tab badge stays accurate */
async function fetchRagSourceCount(): Promise<number> {
  try {
    const res = await fetch('/api/rag/sources', { credentials: 'include' });
    if (!res.ok) return 0;
    const data = (await res.json()) as { sources?: unknown[] };
    return data.sources?.length ?? 0;
  } catch {
    return 0;
  }
}

export default function SourcesPage({
  currentTab,
  onTabChange,
  onAddSource,
  connections,
  onConnectionsChange,
  onSchemaLoaded,
  editConnectionName,
  ragEnabled,
  ragDisabledReason,
  KnowledgeBaseManagerComponent,
}: SourcesPageProps) {
  const [showAddModal, setShowAddModal] = useState(false);
  const [ragSourceCount, setRagSourceCount] = useState(0);

  // Fetch RAG source count when the component mounts and when ragEnabled changes.
  useEffect(() => {
    if (!ragEnabled) return;
    fetchRagSourceCount().then(setRagSourceCount);
  }, [ragEnabled]);

  const handleAddSourceSelect = (kind: 'databases' | 'knowledge') => {
    setShowAddModal(false);
    onTabChange(kind);
  };

  const handleAddButtonClick = () => {
    if (onAddSource) {
      onAddSource();
    } else {
      setShowAddModal(true);
    }
  };

  const kbDisabledTitle =
    ragDisabledReason ?? 'Knowledge base features are unavailable on this instance';

  const tabs: { id: SourcesTab; label: string; count: number; disabled: boolean }[] = [
    {
      id: 'databases',
      label: 'Databases',
      count: connections.length,
      disabled: false,
    },
    {
      id: 'knowledge',
      label: 'Knowledge bases',
      count: ragEnabled ? ragSourceCount : 0,
      disabled: !ragEnabled,
    },
  ];

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="heading-md">Sources</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Manage database connections and knowledge bases used by your MCP servers.
          </p>
        </div>
        <button
          type="button"
          onClick={handleAddButtonClick}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-os-600 text-white text-sm font-medium hover:bg-os-500 transition-colors focus:outline-none focus:ring-2 focus:ring-os-500 focus:ring-offset-2 focus:ring-offset-gray-950"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            className="w-4 h-4"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add source
        </button>
      </div>

      {/* Tab bar — matches the McpDetailView section tabs style */}
      <div className="border-b border-gray-700">
        <div className="flex gap-0">
          {tabs.map((tab) => {
            const isActive = currentTab === tab.id;

            if (tab.disabled) {
              return (
                <button
                  key={tab.id}
                  type="button"
                  disabled
                  title={kbDisabledTitle}
                  aria-disabled="true"
                  className="px-5 py-3 text-sm font-medium border-b-2 border-transparent text-gray-600 cursor-not-allowed opacity-50 inline-flex items-center gap-1.5"
                >
                  {tab.label}
                  <span
                    className="ml-1 px-1.5 py-0.5 rounded-full bg-gray-800 text-gray-600 text-[10px] font-mono"
                    aria-label={`${tab.count} items`}
                  >
                    {tab.count}
                  </span>
                  <span
                    className="text-gray-600 text-[10px] leading-none"
                    aria-hidden="true"
                  >
                    ⓘ
                  </span>
                </button>
              );
            }

            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onTabChange(tab.id)}
                aria-current={isActive ? 'true' : undefined}
                className={[
                  'px-5 py-3 text-sm font-medium border-b-2 transition-all duration-200 inline-flex items-center gap-1.5',
                  isActive
                    ? 'border-os-500 text-os-400'
                    : 'border-transparent text-gray-500 hover:text-gray-300 hover:border-gray-600',
                ].join(' ')}
              >
                {tab.label}
                <span
                  className={[
                    'ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-mono',
                    isActive
                      ? 'bg-os-500/20 text-os-400'
                      : 'bg-gray-800 text-gray-500',
                  ].join(' ')}
                  aria-label={`${tab.count} items`}
                >
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab content */}
      <div className="mt-2">
        {currentTab === 'databases' && (
          <ConnectionManager
            connections={connections}
            onConnectionsChange={onConnectionsChange}
            onSchemaLoaded={onSchemaLoaded}
            editConnectionName={editConnectionName}
          />
        )}

        {currentTab === 'knowledge' && (
          ragEnabled ? (
            <Suspense
              fallback={
                <div className="text-sm text-gray-500 italic py-8 text-center">
                  Loading knowledge bases…
                </div>
              }
            >
              <KnowledgeBaseManagerComponent />
            </Suspense>
          ) : (
            /* Explanatory card when RAG is unavailable */
            <div className="card-primary p-8 text-center max-w-lg mx-auto mt-4">
              <div className="flex justify-center mb-4">
                <span className="text-gray-600">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                    className="w-10 h-10"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25"
                    />
                  </svg>
                </span>
              </div>
              <h3 className="text-sm font-semibold text-gray-300 mb-2">
                Knowledge bases unavailable
              </h3>
              <p className="text-sm text-gray-500">
                {ragDisabledReason ??
                  'The RAG (Retrieval-Augmented Generation) feature is not available on this instance.'}
              </p>
            </div>
          )
        )}
      </div>

      {/* Add source modal — rendered at page level as a fallback when no external handler */}
      {!onAddSource && (
        <AddSourceModal
          isOpen={showAddModal}
          onClose={() => setShowAddModal(false)}
          onSelect={handleAddSourceSelect}
          ragEnabled={ragEnabled}
          ragDisabledReason={ragDisabledReason}
        />
      )}
    </div>
  );
}
