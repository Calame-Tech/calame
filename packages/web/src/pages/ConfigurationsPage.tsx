// Configurations (data profiles) list page. Two views: List (cards, with
// inline creation and per-card source chips + "mounted by" line) and Graph
// (ConfigGraphView — sources → configurations → servers lineage).

import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Button, EmptyState, Breadcrumb, SegmentedControl } from '../components/ui/index.js';
import HelpTip from '../components/HelpTip.js';
import ConfigGraphView from '../components/ConfigGraphView.js';
import {
  getConfigurationTableNames,
  getConfigurationTableOptions,
  getConfigurationColumnMasking,
} from '../lib/configuration-accessors.js';
import type { Configuration, NamedConnection, Profile, ServeStatus } from '../types/schema.js';
import type { View } from '../router/index.js';

interface ConfigurationsPageProps {
  setView: Dispatch<SetStateAction<View>>;
  configurations: Configuration[];
  setConfigurations: Dispatch<SetStateAction<Configuration[]>>;
  handleConfigurationSave: (config: Configuration) => Promise<boolean>;
  handleConfigurationDelete: (name: string) => Promise<void>;
  connections: NamedConnection[];
  profiles: Profile[];
  serveStatus: ServeStatus;
}

type ConfigViewMode = 'list' | 'graph';

const SOURCE_DOT_COLORS: Record<string, string> = {
  postgresql: '#748FFC',
  mysql: '#FDBA74',
  sqlite: '#6EE7B7',
  document: '#E5E7EB',
  api: '#C084FC',
  mcp: '#E0A45E',
  unknown: '#6B7280',
};

export default function ConfigurationsPage({
  setView,
  configurations,
  setConfigurations,
  handleConfigurationSave,
  handleConfigurationDelete,
  connections,
  profiles,
  serveStatus,
}: ConfigurationsPageProps) {
  const [mode, setMode] = useState<ConfigViewMode>('list');

  return (
    <div className="max-w-7xl mx-auto">
      <Breadcrumb
        className="mb-4"
        items={[
          { label: 'Dashboard', onClick: () => setView({ page: 'dashboard' }) },
          { label: 'Data Configurations' },
        ]}
      />
      <ConfigurationListView
        configurations={configurations}
        connections={connections}
        profiles={profiles}
        serveStatus={serveStatus}
        mode={mode}
        onModeChange={setMode}
        onSelect={(name) => setView({ page: 'config-detail', configName: name })}
        onCreate={(name, label) => {
          const newConfig: Configuration = {
            name,
            label,
          };
          // Add to local state immediately so detail view can find it
          setConfigurations((prev) => [...prev, newConfig]);
          handleConfigurationSave(newConfig);
          setView({ page: 'config-detail', configName: name });
        }}
        onDelete={handleConfigurationDelete}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Configuration List View
// ---------------------------------------------------------------------------

interface ConfigurationListViewProps {
  configurations: Configuration[];
  connections: NamedConnection[];
  profiles: Profile[];
  serveStatus: ServeStatus;
  mode: ConfigViewMode;
  onModeChange: (mode: ConfigViewMode) => void;
  onSelect: (name: string) => void;
  onCreate: (name: string, label: string) => void;
  onDelete: (name: string) => void;
}

function ConfigurationListView({
  configurations,
  connections,
  profiles,
  serveStatus,
  mode,
  onModeChange,
  onSelect,
  onCreate,
  onDelete,
}: ConfigurationListViewProps) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newLabel, setNewLabel] = useState('');

  const handleCreate = () => {
    const slug = newName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-');
    if (!slug) return;
    onCreate(slug, newLabel.trim() || slug);
    setCreating(false);
    setNewName('');
    setNewLabel('');
  };

  const connByName = new Map(connections.map((c) => [c.name, c]));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-baseline gap-3 min-w-0">
          <h2 className="heading-md">Data Configurations</h2>
          <span className="font-mono-plex text-[11px] text-gray-500 whitespace-nowrap">
            {connections.length} source{connections.length !== 1 ? 's' : ''} &middot;{' '}
            {configurations.length} configuration{configurations.length !== 1 ? 's' : ''} &middot;{' '}
            {profiles.length} server{profiles.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-2.5">
          <Button variant="primary" onClick={() => setCreating(true)}>
            + New Data Configuration
          </Button>
          <HelpTip
            content="Create a new Data Configuration to define which tables and columns to expose"
            position="bottom"
          />
          <SegmentedControl<ConfigViewMode>
            ariaLabel="Configurations view"
            options={[
              { value: 'list', label: 'List' },
              { value: 'graph', label: 'Graph', description: 'Trace how sources flow to servers' },
            ]}
            value={mode}
            onChange={onModeChange}
          />
        </div>
      </div>

      <p className="text-sm text-gray-500 mb-4">
        {mode === 'list' ? (
          <>Switch to Graph to trace how sources flow to servers.</>
        ) : (
          <>
            Drag nodes to rearrange. Hover to trace a complete data path,{' '}
            <b className="text-gray-400 font-medium">click to pin it</b>.
          </>
        )}
      </p>

      {creating && (
        <div className="card-primary p-4 mb-4 ring-1 ring-os-500/20">
          <div className="flex gap-3">
            <input
              type="text"
              placeholder="Configuration name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="input-editorial flex-1 text-sm"
            />
            <input
              type="text"
              placeholder="Display name"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              className="input-editorial flex-1 text-sm"
            />
            <Button variant="primary" onClick={handleCreate} disabled={!newName.trim()}>
              Create
            </Button>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {mode === 'graph' ? (
        <div className="card-primary overflow-hidden">
          <ConfigGraphView
            connections={connections}
            configurations={configurations}
            profiles={profiles}
            serveStatus={serveStatus}
          />
        </div>
      ) : configurations.length === 0 && !creating ? (
        <EmptyState
          title="No Data Configurations"
          description="Create one to define which tables to expose."
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {configurations.map((cfg) => {
            const tableCount = getConfigurationTableNames(cfg).length;
            const writeTableCount = Object.values(getConfigurationTableOptions(cfg)).filter((o) =>
              o.enabledTools?.includes('write'),
            ).length;
            const maskedColumnCount = Object.values(getConfigurationColumnMasking(cfg)).reduce(
              (sum, cols) =>
                sum + Object.values(cols).filter((m) => m.maskingMode !== 'none').length,
              0,
            );
            const mountedBy = profiles.filter((p) => p.configurations?.includes(cfg.name));
            return (
              <div
                key={cfg.name}
                className="group card-interactive p-4 cursor-pointer flex flex-col"
                onClick={() => onSelect(cfg.name)}
              >
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-display text-lg text-gray-100 group-hover:text-os-400 transition-all duration-200">
                    {cfg.label}
                  </h3>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Delete configuration "${cfg.label}"?`)) {
                        onDelete(cfg.name);
                      }
                    }}
                    title="Delete this Data Configuration"
                    className="opacity-0 group-hover:opacity-100 p-1 text-gray-500 hover:text-rose-400 transition-all duration-200"
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
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                  </button>
                </div>
                {/* Per-source chips with a type-colored dot */}
                {(cfg.sources ?? []).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {(cfg.sources ?? []).map((sid) => {
                      const conn = connByName.get(sid);
                      const kind = conn?.databaseType ?? cfg.scopes?.[sid]?.kind ?? 'unknown';
                      return (
                        <span
                          key={sid}
                          className="inline-flex items-center gap-1.5 font-mono-plex text-[11px] text-gray-400 bg-white/[0.04] border border-white/5 rounded px-2 py-0.5"
                        >
                          <span
                            className="w-[7px] h-[7px] rounded-full inline-block flex-shrink-0"
                            style={{
                              background: SOURCE_DOT_COLORS[kind] ?? SOURCE_DOT_COLORS.unknown,
                            }}
                            aria-hidden="true"
                          />
                          {conn?.label || sid}
                        </span>
                      );
                    })}
                  </div>
                )}
                <div className="flex gap-3 text-sm text-gray-500">
                  <span>
                    {(cfg.sources ?? []).length} source{(cfg.sources ?? []).length !== 1 ? 's' : ''}
                  </span>
                  <span>&middot;</span>
                  <span>
                    {tableCount} table{tableCount !== 1 ? 's' : ''}
                  </span>
                </div>
                {(writeTableCount > 0 || maskedColumnCount > 0) && (
                  <div className="flex gap-3 text-xs mt-1.5">
                    {writeTableCount > 0 && (
                      <span
                        className="text-amber-400"
                        title={`Write tool enabled on ${writeTableCount} table(s)`}
                      >
                        &#9999; write on {writeTableCount} table{writeTableCount !== 1 ? 's' : ''}
                      </span>
                    )}
                    {maskedColumnCount > 0 && (
                      <span
                        className="text-gray-400"
                        title={`${maskedColumnCount} column(s) masked`}
                      >
                        &#128737; {maskedColumnCount} masked column
                        {maskedColumnCount !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                )}
                {cfg.name !== cfg.label && (
                  <p className="font-mono-plex text-[10px] text-gray-600 uppercase tracking-widest mt-2">
                    {cfg.name}
                  </p>
                )}
                {/* Mounted-by footer */}
                <div className="mt-auto">
                  <div className="hairline mt-2.5 pt-2.5 text-xs text-gray-500">
                    {mountedBy.length > 0 ? (
                      <>
                        Mounted by{' '}
                        {mountedBy.map((p, i) => {
                          const active = serveStatus.profileStatuses?.[p.name]?.active === true;
                          return (
                            <span key={p.name}>
                              {i > 0 && ' · '}
                              <b className="text-gray-400 font-semibold">{p.label || p.name}</b>
                              {!active && <span className="text-gray-600"> (stopped)</span>}
                            </span>
                          );
                        })}
                      </>
                    ) : (
                      <span className="italic text-gray-600">Not mounted by any server</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
