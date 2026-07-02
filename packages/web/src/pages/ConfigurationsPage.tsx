// Configurations (data profiles) list page (Phase 3 #14). The page wrapper is
// the `view.page === 'configurations'` branch of App.tsx and the
// ConfigurationListView component below was moved verbatim from App.tsx.

import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Button, EmptyState, Breadcrumb } from '../components/ui/index.js';
import HelpTip from '../components/HelpTip.js';
import { getConfigurationTableNames } from '../lib/configuration-accessors.js';
import type { Configuration } from '../types/schema.js';
import type { View } from '../router/index.js';

interface ConfigurationsPageProps {
  setView: Dispatch<SetStateAction<View>>;
  configurations: Configuration[];
  setConfigurations: Dispatch<SetStateAction<Configuration[]>>;
  handleConfigurationSave: (config: Configuration) => Promise<boolean>;
  handleConfigurationDelete: (name: string) => Promise<void>;
}

export default function ConfigurationsPage({
  setView,
  configurations,
  setConfigurations,
  handleConfigurationSave,
  handleConfigurationDelete,
}: ConfigurationsPageProps) {
  return (
    <div className="max-w-7xl mx-auto">
      <Breadcrumb
        className="mb-4"
        items={[
          { label: 'Dashboard', onClick: () => setView({ page: 'dashboard' }) },
          { label: 'Data Profiles' },
        ]}
      />
      <ConfigurationListView
        configurations={configurations}
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
  onSelect: (name: string) => void;
  onCreate: (name: string, label: string) => void;
  onDelete: (name: string) => void;
}

function ConfigurationListView({
  configurations,
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

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="heading-md">Data Profiles</h2>
        <div className="flex items-center gap-1.5">
          <Button variant="primary" onClick={() => setCreating(true)}>
            + New Data Profile
          </Button>
          <HelpTip
            content="Create a new data profile to define which tables and columns to expose"
            position="bottom"
          />
        </div>
      </div>

      {creating && (
        <div className="card-primary p-4 mb-4 ring-1 ring-os-500/20">
          <div className="flex gap-3">
            <input
              type="text"
              placeholder="Profile name"
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

      {configurations.length === 0 && !creating ? (
        <EmptyState
          title="No data profiles"
          description="Create one to define which tables to expose."
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {configurations.map((cfg) => {
            const tableCount = getConfigurationTableNames(cfg).length;
            return (
              <div
                key={cfg.name}
                className="group card-interactive p-4 cursor-pointer"
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
                    title="Supprimer ce profil de données"
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
                <div className="flex gap-3 text-sm text-gray-500">
                  <span>
                    {(cfg.sources ?? []).length} source{(cfg.sources ?? []).length !== 1 ? 's' : ''}
                  </span>
                  <span>&middot;</span>
                  <span>
                    {tableCount} table{tableCount !== 1 ? 's' : ''}
                  </span>
                </div>
                {cfg.name !== cfg.label && (
                  <p className="font-mono-plex text-[10px] text-gray-600 uppercase tracking-widest mt-2">
                    {cfg.name}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
