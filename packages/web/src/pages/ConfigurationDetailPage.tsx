// Configuration (data profile) detail page (Phase 3 #14). The page wrapper is
// the `view.page === 'config-detail'` branch of App.tsx and the
// ConfigurationDetailView component below was moved verbatim from App.tsx.

import { useState, useMemo, lazy, Suspense } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Button, EmptyState, Eyebrow, Breadcrumb } from '../components/ui/index.js';
import HelpTip from '../components/HelpTip.js';
import SchemaExplorer from '../components/SchemaExplorer.js';
import ConfigPanel from '../components/ConfigPanel.js';
import { setsToArrays, arraysToSets } from '../lib/profiles.js';
import {
  getConfigurationSelectedTables,
  getConfigurationTableOptions,
  getConfigurationColumnMasking,
} from '../lib/configuration-accessors.js';
import type {
  DatabaseSchema,
  Config,
  Configuration,
  PiiDetection,
  ColumnMasking,
  GlobalMaskingRule,
  NamedConnection,
  ScopeSelection,
} from '../types/schema.js';
import type { View } from '../router/index.js';
import { useSession } from '../context/SessionContext.js';

/**
 * Lazy-loaded RagAccessSelector from the ee package. Only loaded when the user
 * navigates to the "Knowledge Bases" section of an MCP detail view.
 */
const RagAccessSelector = lazy(() =>
  import('@calame-ee/rag-core/web')
    .then((m) => ({ default: m.RagAccessSelector }))
    .catch(() => ({
      default: function RagAccessSelectorUnavailable() {
        return (
          <div className="p-6 text-sm text-gray-400 text-center">
            Les fonctionnalités RAG ne sont pas disponibles sur cette instance.
          </div>
        );
      },
    })),
);

interface ConfigurationDetailPageProps {
  view: Extract<View, { page: 'config-detail' }>;
  setView: Dispatch<SetStateAction<View>>;
  configurations: Configuration[];
  connections: NamedConnection[];
  connectionSchemas: Record<string, DatabaseSchema>;
  piiDetections: Record<string, Record<string, PiiDetection>> | null;
  scanning: boolean;
  globalMaskingRules: GlobalMaskingRule[];
  handleScanPii: () => void;
  handleConfigurationSave: (config: Configuration) => Promise<boolean>;
  handleConfigurationDelete: (name: string) => Promise<void>;
  handleSchemaLoaded: (connectionName: string, schema: DatabaseSchema) => void;
  handlePiiOverride: (
    tableName: string,
    columnName: string,
    detection: PiiDetection | null,
  ) => void;
  handleGlobalMaskingRulesChange: (rules: GlobalMaskingRule[]) => void;
}

export default function ConfigurationDetailPage({
  view,
  setView,
  configurations,
  connections,
  connectionSchemas,
  piiDetections,
  scanning,
  globalMaskingRules,
  handleScanPii,
  handleConfigurationSave,
  handleConfigurationDelete,
  handleSchemaLoaded,
  handlePiiOverride,
  handleGlobalMaskingRulesChange,
}: ConfigurationDetailPageProps) {
  const { ragEnabled } = useSession();

  return (
    <div className="max-w-7xl mx-auto">
      <Breadcrumb
        className="mb-4"
        items={[
          { label: 'Dashboard', onClick: () => setView({ page: 'dashboard' }) },
          ...(view.backTo?.page === 'mcp-detail'
            ? [
                { label: 'MCP Servers', onClick: () => setView({ page: 'mcp-list' }) },
                { label: 'Server', onClick: () => setView(view.backTo!) },
              ]
            : [
                {
                  label: 'Data Profiles',
                  onClick: () => setView({ page: 'configurations' }),
                },
              ]),
          {
            label: configurations.find((c) => c.name === view.configName)?.label ?? view.configName,
          },
        ]}
      />
      <ConfigurationDetailView
        configName={view.configName}
        configurations={configurations}
        connections={connections}
        connectionSchemas={connectionSchemas}
        piiDetections={piiDetections}
        scanning={scanning}
        globalMaskingRules={globalMaskingRules}
        onScanPii={handleScanPii}
        onSave={handleConfigurationSave}
        onDelete={handleConfigurationDelete}
        onAfterDelete={() => setView({ page: 'configurations' })}
        onSchemaLoaded={handleSchemaLoaded}
        onPiiOverride={handlePiiOverride}
        onGlobalMaskingRulesChange={handleGlobalMaskingRulesChange}
        onNavigateToConnections={() => setView({ page: 'connections', backTo: view })}
        onNavigateToEditConnection={(c: string) =>
          setView({ page: 'connections', backTo: view, editConnectionName: c })
        }
        ragEnabled={ragEnabled}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Configuration Detail View
// ---------------------------------------------------------------------------

interface ConfigurationDetailViewProps {
  configName: string;
  configurations: Configuration[];
  connections: NamedConnection[];
  connectionSchemas: Record<string, DatabaseSchema>;
  piiDetections: Record<string, Record<string, PiiDetection>> | null;
  scanning: boolean;
  globalMaskingRules: GlobalMaskingRule[];
  onScanPii: () => void;
  onSave: (config: Configuration) => Promise<boolean>;
  onDelete: (name: string) => void;
  onAfterDelete: () => void;
  onSchemaLoaded: (connectionName: string, schema: DatabaseSchema) => void;
  onPiiOverride: (tableName: string, columnName: string, detection: PiiDetection | null) => void;
  onGlobalMaskingRulesChange: (rules: GlobalMaskingRule[]) => void;
  onNavigateToConnections?: () => void;
  onNavigateToEditConnection?: (connName: string) => void;
  /** Whether the RAG runtime is available on this instance. Controls visibility of the Knowledge tab. */
  ragEnabled?: boolean;
}

function ConfigurationDetailView({
  configName,
  configurations,
  connections,
  connectionSchemas,
  piiDetections,
  scanning,
  globalMaskingRules,
  onScanPii,
  onSave,
  onDelete,
  onAfterDelete,
  onSchemaLoaded,
  onPiiOverride,
  onGlobalMaskingRulesChange,
  onNavigateToConnections,
  onNavigateToEditConnection,
  ragEnabled = false,
}: ConfigurationDetailViewProps) {
  const config = configurations.find((c) => c.name === configName);

  // Local editing state
  const [label, setLabel] = useState(config?.label ?? configName);
  const [selectedConns, setSelectedConns] = useState<Set<string>>(new Set(config?.sources ?? []));
  const [localSelectedTables, setLocalSelectedTables] = useState<Record<string, Set<string>>>(
    config ? arraysToSets(getConfigurationSelectedTables(config)) : {},
  );
  const [localTableOptions, setLocalTableOptions] = useState<
    Record<string, import('../types/schema.js').TableToolOptions>
  >(config ? getConfigurationTableOptions(config) : {});
  const [localColumnMasking, setLocalColumnMasking] = useState<
    Record<string, Record<string, ColumnMasking>>
  >(config ? getConfigurationColumnMasking(config) : {});
  const [editingLabel, setEditingLabel] = useState(false);
  const [loadingSchemas, setLoadingSchemas] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Tab switcher: 'databases' mirrors the existing UI, 'knowledge' mounts RagAccessSelector.
  const [activeConfigTab, setActiveConfigTab] = useState<'databases' | 'knowledge'>('databases');

  const availableConnectionNames = connections.map((c) => c.name);

  // Schema derived from selected connections
  const configSchema = useMemo<DatabaseSchema>(() => {
    const tables = [...selectedConns].flatMap((cn) => connectionSchemas[cn]?.tables ?? []);
    const relations = [...selectedConns].flatMap((cn) => connectionSchemas[cn]?.relations ?? []);
    return { tables, relations };
  }, [selectedConns, connectionSchemas]);

  const handleToggleConnection = async (connName: string) => {
    const next = new Set(selectedConns);
    if (next.has(connName)) {
      next.delete(connName);
      // Remove tables belonging to this connection from selection
      const connSchema = connectionSchemas[connName];
      if (connSchema) {
        const connTableNames = new Set(connSchema.tables.map((t) => t.name));
        setLocalSelectedTables((prev) => {
          const cleaned: Record<string, Set<string>> = {};
          for (const [tableName, cols] of Object.entries(prev)) {
            if (!connTableNames.has(tableName)) {
              cleaned[tableName] = cols;
            }
          }
          return cleaned;
        });
        setLocalColumnMasking((prev) => {
          const cleaned: Record<string, Record<string, ColumnMasking>> = {};
          for (const [tableName, masking] of Object.entries(prev)) {
            if (!connTableNames.has(tableName)) {
              cleaned[tableName] = masking;
            }
          }
          return cleaned;
        });
      }
    } else {
      next.add(connName);
      // Load schema if needed
      if (!connectionSchemas[connName]) {
        setLoadingSchemas(true);
        try {
          const res = await fetch(`/api/schema/${encodeURIComponent(connName)}`);
          const data = await res.json();
          const schema = data.schema ?? data;
          if (schema.tables) {
            onSchemaLoaded(connName, schema as DatabaseSchema);
          }
        } catch {
          // Schema fetch failed
        }
        setLoadingSchemas(false);
      }
    }
    setSelectedConns(next);
  };

  const [saveError, setSaveError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // RAG scope helpers — extract document-kind entries from the current config.
  // These are preserved verbatim when the Databases tab is saved, and updated
  // by RagAccessSelector when the Knowledge tab is saved.
  // ---------------------------------------------------------------------------

  /**
   * Returns a Record of only the `kind: 'document'` scopes in the config.
   * Used to seed RagAccessSelector with the existing document scopes.
   */
  const configDocumentScopes = useMemo<Record<string, ScopeSelection>>(() => {
    if (!config?.scopes) return {};
    const result: Record<string, ScopeSelection> = {};
    for (const [id, scope] of Object.entries(config.scopes)) {
      if (scope.kind === 'document') result[id] = scope;
    }
    return result;
  }, [config]);

  /**
   * Returns the list of sourceIds whose scope kind is 'document'.
   * Used to seed RagAccessSelector#initialSources.
   */
  const configDocumentSources = useMemo<string[]>(() => {
    if (!config?.sources || !config?.scopes) return [];
    return config.sources.filter(
      (id) => config.scopes !== undefined && config.scopes[id]?.kind === 'document',
    );
  }, [config]);

  /**
   * Returns the non-document (relational) scopes and sources from the config.
   * Preserved when saving from the Knowledge tab so relational settings aren't lost.
   */
  const configRelationalScopes = useMemo<Record<string, ScopeSelection>>(() => {
    if (!config?.scopes) return {};
    const result: Record<string, ScopeSelection> = {};
    for (const [id, scope] of Object.entries(config.scopes)) {
      if (scope.kind !== 'document') result[id] = scope;
    }
    return result;
  }, [config]);

  const configRelationalSources = useMemo<string[]>(() => {
    if (!config?.sources || !config?.scopes) return [];
    return config.sources.filter(
      (id) => config.scopes === undefined || config.scopes[id]?.kind !== 'document',
    );
  }, [config]);

  const handleSave = async () => {
    setSaveError(null);

    // Only keep tables that belong to currently selected connections
    // and that have at least one column selected
    const validTableNames = new Set(configSchema.tables.map((t) => t.name));
    const cleanedTables: Record<string, string[]> = {};
    for (const [tableName, cols] of Object.entries(setsToArrays(localSelectedTables))) {
      if (validTableNames.has(tableName) && cols.length > 0) {
        cleanedTables[tableName] = cols;
      }
    }

    // Also clean tableOptions and columnMasking to remove orphaned tables
    const cleanedTableOptions: Record<string, import('../types/schema.js').TableToolOptions> = {};
    for (const [tableName, opts] of Object.entries(localTableOptions)) {
      if (cleanedTables[tableName]) {
        cleanedTableOptions[tableName] = opts;
      }
    }
    const cleanedColumnMasking: Record<string, Record<string, ColumnMasking>> = {};
    for (const [tableName, masking] of Object.entries(localColumnMasking)) {
      if (cleanedTables[tableName]) {
        cleanedColumnMasking[tableName] = masking;
      }
    }

    // Build the Phase 5 unified shape. Each selected connection becomes a
    // relational scope carrying the cleaned tables/options/masking. When
    // multiple connections are selected they all share the same selection for
    // now (per-source differentiation can be added later via RagAccessSelector).
    //
    // Critical: PRESERVE any document-kind sources/scopes already on the
    // config. This save runs from the Databases tab but the top-level Save
    // button is visible on the Knowledge tab too — without the merge below
    // a click here would discard every RAG selection configured via
    // RagAccessSelector.
    //
    // Also critical: `selectedConns` is seeded from `config.sources` which can
    // contain non-DB source ids (e.g. a RAG nanoid that found its way in via
    // an earlier save). Filtering to actual DB connection names is what stops
    // the relational loop from overwriting `scopes[ragSourceId]` with
    // `kind: 'relational'` — which would clobber the document scope we just
    // spread above.
    const validConnNames = new Set(connections.map((c) => c.name));
    const relationalSources = [...selectedConns].filter((id) => validConnNames.has(id));

    const sourcesArray = [...relationalSources, ...configDocumentSources];
    const scopes: Record<string, import('../types/schema.js').ScopeSelection> = {
      ...configDocumentScopes,
    };
    for (const sourceId of relationalSources) {
      scopes[sourceId] = {
        kind: 'relational',
        selectedTables: cleanedTables,
        tableOptions: cleanedTableOptions,
        columnMasking: cleanedColumnMasking,
      };
    }
    const configToSave: Configuration = {
      name: configName,
      label,
      sources: sourcesArray,
      scopes,
    };
    const success = await onSave(configToSave);
    if (success) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      setSaveError('Save failed — check console for details.');
      setTimeout(() => setSaveError(null), 5000);
    }
  };

  const handleLocalConfigChange = (newConfig: Config) => {
    setLocalTableOptions(newConfig.tableOptions ?? {});
  };

  // Wrap global masking rules change to also apply to local column masking
  const handleLocalGlobalMaskingRulesChange = (rules: GlobalMaskingRule[]) => {
    onGlobalMaskingRulesChange(rules);
    if (!piiDetections) return;
    setLocalColumnMasking((prev) => {
      const updated = { ...prev };
      for (const [tableName, colDetections] of Object.entries(piiDetections)) {
        const tableMasking = { ...(updated[tableName] ?? {}) };
        for (const [colName, detection] of Object.entries(colDetections)) {
          const matchingRule = rules.find((r) => r.piiCategory === detection.category);
          if (matchingRule) {
            tableMasking[colName] = {
              piiDetected: detection,
              maskingMode: matchingRule.defaultMode,
              truncateOptions: matchingRule.truncateOptions,
              replaceValue: matchingRule.replaceValue,
            };
          }
        }
        updated[tableName] = tableMasking;
      }
      return updated;
    });
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/configurations/${encodeURIComponent(configName)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success) {
        onDelete(configName);
        onAfterDelete();
      }
    } catch {
      // silently fail
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  if (!config && configName) {
    return <EmptyState title={`Configuration "${configName}" not found.`} className="py-10" />;
  }

  const tableCount = Object.keys(localSelectedTables).length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="card-primary p-4">
        <div className="flex items-center justify-between">
          <div>
            {editingLabel ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setEditingLabel(false);
                    if (e.key === 'Escape') setEditingLabel(false);
                  }}
                  autoFocus
                  className="input-editorial text-lg font-semibold border-os-500"
                />
                <Button variant="ghost" size="sm" onClick={() => setEditingLabel(false)}>
                  OK
                </Button>
              </div>
            ) : (
              <h2
                className="text-lg font-semibold text-gray-100 cursor-pointer hover:text-os-400 transition-all duration-200 group flex items-center gap-1.5"
                onClick={() => setEditingLabel(true)}
              >
                {label}
                <svg
                  className="inline-block w-3.5 h-3.5 ml-2 text-gray-600 group-hover:text-os-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z"
                  />
                </svg>
                {configName !== label && (
                  <span className="ml-2 font-mono-plex text-[10px] text-gray-600 uppercase tracking-widest font-normal">
                    {configName}
                  </span>
                )}
                <HelpTip content="Click to rename this data profile" position="right" size="xs" />
              </h2>
            )}
            <p className="text-sm text-gray-500 mt-1">
              {[...selectedConns].length} connection{[...selectedConns].length !== 1 ? 's' : ''}{' '}
              &middot; {tableCount} table{tableCount !== 1 ? 's' : ''}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {saveError && <span className="text-sm text-rose-400">{saveError}</span>}
            <Button
              onClick={handleSave}
              variant={saved ? 'ghost' : saveError ? 'ghost' : 'primary'}
              className={
                saved
                  ? 'bg-emerald-700/30 text-emerald-400 hover:bg-emerald-700/30'
                  : saveError
                    ? 'bg-rose-700/30 text-rose-400 hover:bg-rose-700/30'
                    : ''
              }
            >
              {saved ? 'Saved!' : saveError ? 'Error' : 'Save'}
            </Button>
            {confirmDelete ? (
              <div className="flex items-center gap-1">
                <span className="text-xs text-gray-400 mr-1">Are you sure?</span>
                <Button variant="danger" size="sm" onClick={handleDelete} disabled={deleting}>
                  {deleting ? 'Deleting...' : 'Yes, delete'}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                title="Supprimer ce profil de données"
                className="p-2 text-gray-500 hover:text-rose-400 transition-all duration-200 rounded-lg hover:bg-rose-500/10"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Tab switcher — Databases / Knowledge */}
      <div className="border-b border-gray-700">
        <div className="flex gap-0">
          {(
            [
              { id: 'databases', label: 'Databases', disabled: false },
              { id: 'knowledge', label: 'Knowledge bases', disabled: !ragEnabled },
            ] as const
          ).map((tab) => {
            const isActive = activeConfigTab === tab.id;
            if (tab.disabled) {
              return (
                <button
                  key={tab.id}
                  type="button"
                  disabled
                  aria-disabled="true"
                  title="Les bases de connaissance RAG ne sont pas disponibles sur cette instance."
                  className="px-5 py-3 text-sm font-medium border-b-2 border-transparent text-gray-600 cursor-not-allowed opacity-50"
                >
                  {tab.label}
                </button>
              );
            }
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveConfigTab(tab.id)}
                aria-current={isActive ? 'true' : undefined}
                className={[
                  'px-5 py-3 text-sm font-medium border-b-2 transition-all duration-200',
                  isActive
                    ? 'border-os-500 text-os-400'
                    : 'border-transparent text-gray-500 hover:text-gray-300 hover:border-gray-600',
                ].join(' ')}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* --- DATABASES TAB --- */}
      {activeConfigTab === 'databases' && (
        <>
          {/* Connections selection */}
          <div className="card-primary p-4">
            <div className="mb-3">
              <Eyebrow>Databases</Eyebrow>
            </div>
            {availableConnectionNames.length === 0 ? (
              <div className="text-center py-4">
                <p className="text-sm text-gray-500 mb-3">No databases connected yet.</p>
                {onNavigateToConnections && (
                  <Button variant="primary" onClick={onNavigateToConnections}>
                    + Add a Database
                  </Button>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  {availableConnectionNames.map((connName) => {
                    const isSelected = selectedConns.has(connName);
                    const conn = connections.find((c) => c.name === connName);
                    const hasSchema = !!connectionSchemas[connName];
                    return (
                      <div key={connName} className="flex items-center gap-1">
                        <button
                          onClick={() => handleToggleConnection(connName)}
                          disabled={loadingSchemas}
                          className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-all duration-200 disabled:opacity-50 ${
                            isSelected
                              ? 'border-os-600/60 bg-os-700/20 text-os-400'
                              : 'border-gray-700 bg-gray-900/40 text-gray-500 hover:border-gray-600 hover:text-gray-300'
                          }`}
                        >
                          <div
                            className={`w-2 h-2 rounded-full ${isSelected ? 'bg-os-400' : 'bg-gray-600'}`}
                          />
                          {conn?.label ?? connName}
                          {hasSchema && (
                            <span className="text-xs text-gray-500">
                              ({connectionSchemas[connName].tables.length} tables)
                            </span>
                          )}
                        </button>
                        {onNavigateToEditConnection && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onNavigateToEditConnection(connName);
                            }}
                            title="Modifier les paramètres de cette connexion"
                            className="p-0.5 text-gray-500 hover:text-os-400 transition-colors"
                          >
                            <svg
                              className="w-3.5 h-3.5"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2}
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z"
                              />
                            </svg>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                {onNavigateToConnections && (
                  <button
                    onClick={() => onNavigateToConnections()}
                    className="text-xs text-os-400 hover:text-os-300 transition-colors mt-2 inline-flex items-center gap-1"
                  >
                    Manage databases &rarr;
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Tables & Columns selection — single unified view */}
          {configSchema.tables.length > 0 && (
            <div className="card-primary p-4">
              <SchemaExplorer
                schema={configSchema}
                selectedTables={localSelectedTables}
                onSelectionChange={setLocalSelectedTables}
                piiDetections={piiDetections}
                onScanPii={onScanPii}
                scanning={scanning}
                connectionSchemas={Object.fromEntries(
                  [...selectedConns]
                    .filter((cn) => connectionSchemas[cn])
                    .map((cn) => [cn, connectionSchemas[cn]]),
                )}
                connectionLabels={Object.fromEntries(
                  connections.map((c) => [c.name, c.label || c.name]),
                )}
              />
            </div>
          )}

          {/* Advanced: Table Options & Masking */}
          {Object.keys(localSelectedTables).length > 0 && (
            <div className="card-primary p-4">
              <div className="mb-3">
                <Eyebrow>Advanced: Table Options &amp; Masking</Eyebrow>
              </div>
              <ConfigPanel
                config={{
                  serverName: '',
                  transport: 'streamable-http',
                  clientTarget: 'claude-desktop',
                  outputDir: '',
                  tableOptions: localTableOptions,
                }}
                onConfigChange={handleLocalConfigChange}
                schema={configSchema}
                selectedTables={localSelectedTables}
                piiDetections={piiDetections}
                columnMasking={localColumnMasking}
                onColumnMaskingChange={setLocalColumnMasking}
                globalMaskingRules={globalMaskingRules}
                onGlobalMaskingRulesChange={handleLocalGlobalMaskingRulesChange}
                onPiiOverride={onPiiOverride}
              />
            </div>
          )}
        </>
      )}

      {/* --- KNOWLEDGE TAB --- */}
      {activeConfigTab === 'knowledge' && ragEnabled && (
        <div className="card-primary">
          {/*
           * NOTE: `profileName` below is intentionally `configName` — RagAccessSelector
           * uses this value only as an identifier label and as part of the default POST
           * URL (which we override via `saveEndpoint`). A future refactor should rename
           * the prop to `entityName` on the component side.
           */}
          <Suspense
            fallback={
              <div className="p-6 text-sm text-gray-500 italic flex items-center gap-2">
                <svg
                  className="w-3 h-3 animate-spin"
                  fill="none"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
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
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                Chargement…
              </div>
            }
          >
            <RagAccessSelector
              profileName={configName}
              initialScopes={configDocumentScopes}
              initialSources={configDocumentSources}
              saveEndpoint="/api/configurations"
              saveBodyTransform={({ sources, scopes }) => ({
                // Merge relational sources/scopes back in so the Databases tab settings
                // are not overwritten when saving from the Knowledge tab.
                name: configName,
                label,
                sources: [...configRelationalSources, ...sources],
                scopes: { ...configRelationalScopes, ...scopes },
              })}
              onSaved={(newScopes, newSources) => {
                // Reflect the merged update in local configurations state so the UI
                // stays consistent without a full page refresh.
                onSave({
                  name: configName,
                  label,
                  sources: [...configRelationalSources, ...newSources],
                  scopes: {
                    ...configRelationalScopes,
                    ...newScopes,
                  },
                });
              }}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}
