import { useState, useCallback, useMemo } from 'react';
import { apiFetch, getCurrentTenant } from '../lib/api.js';
import type { AuthMode, Config, Profile, ServeStatus } from '../types/schema.js';
import {
  getProfileTableNames,
  getProfileRelationalSources,
  getProfileSelectedTables,
  getProfileTableOptions,
  getProfileColumnMasking,
} from '../lib/profile-accessors.js';
import { buildMcpPath } from '../lib/mcp-url.js';
import { slugifyProfileName } from '../lib/profiles.js';
import ChatPanel from './ChatPanel.js';
import TokenManager from './TokenManager.js';
import AuditLogViewer from './AuditLogViewer.js';
import PendingQueries from './PendingQueries.js';
import HelpTip from './HelpTip.js';

const AUTH_MODE_STYLES: Record<AuthMode, string> = {
  open: 'bg-yellow-700/20 text-yellow-400 border border-yellow-600/30',
  token: 'bg-blue-700/20 text-blue-400 border border-blue-600/30',
  calame: 'bg-os-700/20 text-os-400 border border-os-600/30',
  sso: 'bg-purple-700/20 text-purple-400 border border-purple-600/30',
  oauth: 'bg-green-700/20 text-green-400 border border-green-600/30',
  external: 'bg-orange-700/20 text-orange-400 border border-orange-600/30',
};

const AUTH_MODE_LABELS: Record<AuthMode, string> = {
  open: 'Open',
  token: 'API Key',
  calame: 'Calame',
  sso: 'SSO',
  oauth: 'OAuth',
  external: 'External',
};

const AUTH_MODE_DESCRIPTIONS: Record<AuthMode, string> = {
  open: 'Open access without authentication — use in development only.',
  token: 'Authentication via API key (Bearer token).',
  calame: 'Authentication via Calame (requires a Calame account).',
  sso: 'SSO authentication via your enterprise identity provider.',
  oauth: 'OAuth 2.0 authentication with the standard authorization flow.',
  external: 'Authentication handled by an external proxy or service.',
};

interface ServePanelProps {
  config: Config;
  selectedTables: Record<string, Set<string>>;
  profiles: Profile[];
  /** Serve status managed by App-level poller — avoids a second independent poll */
  serveStatus: ServeStatus;
  /** Called after start/stop actions so App-level poller can refresh immediately */
  onServeAction?: () => void;
  onSelectProfile?: (name: string) => void;
  onBack?: () => void;
  onCreateProfile?: (name: string, label: string) => void;
  onDeleteProfile?: (index: number) => void;
  onPreviewProfile?: (name: string) => void;
}

type DashboardTab = 'chat' | 'pending';

export default function ServePanel({
  config,
  selectedTables,
  profiles,
  serveStatus,
  onServeAction,
  onSelectProfile,
  onCreateProfile,
  onDeleteProfile,
  onPreviewProfile,
}: ServePanelProps) {
  const [selectedProfile, setSelectedProfile] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DashboardTab>('chat');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newName, setNewName] = useState('');
  const [confirmDeleteProfile, setConfirmDeleteProfile] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [togglingProfile, setTogglingProfile] = useState<string | null>(null);
  const [stoppingAll, setStoppingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedEndpoint, setCopiedEndpoint] = useState(false);
  const [copiedChatLink, setCopiedChatLink] = useState<string | null>(null);

  // Use profiles from props as source of truth (backend status only adds metadata, not new profiles)
  const allProfiles = useMemo(() => {
    return [...profiles];
  }, [profiles]);

  // Count active profiles
  const activeCount = useMemo(() => {
    return allProfiles.filter((p) => serveStatus.profileStatuses?.[p.name]?.active === true).length;
  }, [allProfiles, serveStatus.profileStatuses]);

  const hasAnyActive = activeCount > 0;

  // Start a single profile
  const handleStartProfile = useCallback(
    async (profileName: string) => {
      setTogglingProfile(profileName);
      setError(null);
      try {
        const res = await apiFetch('/api/serve/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            serverName: config.serverName,
            profiles: [profileName],
          }),
        });
        const data = await res.json();
        if (data.success === false) {
          setError(data.message || `Failed to start profile "${profileName}".`);
        } else {
          // Trigger an immediate status refresh in App.tsx instead of polling locally
          onServeAction?.();
        }
      } catch {
        setError(`Network error starting profile "${profileName}".`);
      } finally {
        setTogglingProfile(null);
      }
    },
    [onServeAction, config.serverName],
  );

  // Stop a single profile
  const handleStopProfile = useCallback(
    async (profileName: string) => {
      setTogglingProfile(profileName);
      setError(null);
      try {
        const res = await apiFetch('/api/serve/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profiles: [profileName] }),
        });
        const data = await res.json();
        if (data.success === false) {
          setError(data.message || `Failed to stop profile "${profileName}".`);
        } else {
          onServeAction?.();
        }
      } catch {
        setError(`Network error stopping profile "${profileName}".`);
      } finally {
        setTogglingProfile(null);
      }
    },
    [onServeAction],
  );

  // Stop all profiles
  const handleStopAll = useCallback(async () => {
    setStoppingAll(true);
    setError(null);
    try {
      const res = await apiFetch('/api/serve/stop', { method: 'POST' });
      const data = await res.json();
      if (data.success === false) {
        setError(data.message || 'Failed to stop all servers.');
      } else {
        onServeAction?.();
      }
    } catch {
      setError('Network error stopping servers.');
    } finally {
      setStoppingAll(false);
    }
  }, [onServeAction]);

  // Copy endpoint to clipboard
  const handleCopyEndpoint = useCallback((endpoint: string) => {
    navigator.clipboard.writeText(endpoint).then(() => {
      setCopiedEndpoint(true);
      setTimeout(() => setCopiedEndpoint(false), 2000);
    });
  }, []);

  // Get the currently selected profile object
  const detailProfile = useMemo(() => {
    if (!selectedProfile) return null;
    return allProfiles.find((p) => p.name === selectedProfile) ?? null;
  }, [selectedProfile, allProfiles]);

  // Dashboard tabs
  const dashboardTabs: { id: DashboardTab; label: string; badge?: number }[] = [
    { id: 'chat', label: 'Chat' },
    { id: 'pending', label: 'Pending', badge: pendingCount > 0 ? pendingCount : undefined },
  ];

  // --- DETAIL VIEW ---
  if (selectedProfile && detailProfile) {
    const profileStatus = serveStatus.profileStatuses?.[detailProfile.name];
    const isActive = profileStatus?.active === true;
    // Build the MCP endpoint path on the client so non-default workspaces
    // surface the tenant-qualified shape (/mcp/<tenant>/<profile>). The
    // backend's `profileStatus.endpoint` is left as a default-tenant string
    // and is only used as a fallback for the default workspace.
    const tenant = getCurrentTenant();
    const basePath =
      tenant === 'default'
        ? (profileStatus?.endpoint ?? `/mcp/${detailProfile.name}`)
        : buildMcpPath(detailProfile.name, tenant);
    const endpoint = `${window.location.origin}${basePath}`;
    const tableCount = getProfileTableNames(detailProfile).length;

    return (
      <div className="space-y-4">
        {/* Back button */}
        <button
          onClick={() => setSelectedProfile(null)}
          className="text-sm text-os-400 hover:text-os-300 transition-all duration-200 flex items-center gap-1"
        >
          <span>&larr;</span> Back to dashboard
        </button>

        {/* Header */}
        <div className="card-primary p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className={`w-2 h-2 rounded-full ${
                  isActive ? 'bg-green-500 shadow-lg shadow-green-500/30' : 'bg-gray-600'
                }`}
              />
              <div>
                <h2 className="heading-md">
                  {detailProfile.name}
                  {detailProfile.label && detailProfile.label !== detailProfile.name && (
                    <span className="ml-2 text-sm font-normal text-gray-500">
                      {detailProfile.label}
                    </span>
                  )}
                </h2>
                <p className="text-sm text-gray-500">
                  {isActive ? 'Active' : 'Inactive'} &middot; {tableCount} table
                  {tableCount !== 1 ? 's' : ''}
                </p>
                {getProfileRelationalSources(detailProfile).length > 0 && (
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className="text-xs text-gray-500">Connections:</span>
                    {getProfileRelationalSources(detailProfile).map((conn) => (
                      <span
                        key={conn}
                        className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-os-700/20 text-os-400 border border-os-600/30"
                      >
                        {conn}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() =>
                  isActive
                    ? handleStopProfile(detailProfile.name)
                    : handleStartProfile(detailProfile.name)
                }
                disabled={togglingProfile === detailProfile.name}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 disabled:opacity-50 ${
                  isActive
                    ? 'bg-red-600/20 text-red-400 hover:bg-red-600/30'
                    : 'bg-os-700/30 text-os-400 hover:bg-os-700/50'
                }`}
              >
                {togglingProfile === detailProfile.name ? (
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
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
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                ) : isActive ? (
                  'Stop'
                ) : (
                  'Start'
                )}
              </button>
              <HelpTip
                content={
                  isActive
                    ? 'Arrêter le serveur MCP pour ce profil. Les clients connectés seront déconnectés.'
                    : 'Démarrer le serveur MCP pour ce profil et le rendre accessible aux clients.'
                }
                position="left"
                size="sm"
              />
            </div>
          </div>

          {/* Endpoint URL (copiable) */}
          <div className="mt-3">
            <p className="eyebrow mb-1">Endpoint</p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleCopyEndpoint(endpoint)}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-900/60 border border-white/10 hover:border-os-600 transition-all duration-200 group"
              >
                <code className="text-sm text-os-400 font-mono">{endpoint}</code>
                <span className="text-xs text-gray-500 group-hover:text-os-400 transition-all duration-200">
                  {copiedEndpoint ? 'Copied!' : 'Copy'}
                </span>
              </button>
              <HelpTip
                content="Click to copy the MCP server SSE URL to use in your clients (Claude Desktop, Cursor, etc.)"
                position="bottom"
                maxWidth={300}
                size="xs"
              />
            </div>
          </div>

          {error && (
            <div className="mt-3 p-3 rounded-lg bg-red-950/30 border border-red-800/50 text-red-400 text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Tables section */}
        <div className="card-primary p-4">
          <h3 className="eyebrow mb-3">Tables</h3>
          {tableCount === 0 ? (
            <p className="text-sm text-gray-500">No tables selected.</p>
          ) : (
            <div className="space-y-2">
              {Object.entries(getProfileSelectedTables(detailProfile)).map(([table, columns]) => (
                <div key={table} className="card-nested px-4 py-3">
                  <p className="text-sm font-medium text-gray-200">{table}</p>
                  <p className="text-xs text-gray-500 mt-1">
                    {columns.length} column{columns.length !== 1 ? 's' : ''}: {columns.join(', ')}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Tools section */}
        <div className="card-primary p-4">
          <h3 className="eyebrow mb-3">Tools</h3>
          {tableCount === 0 ? (
            <p className="text-sm text-gray-500">No tables selected.</p>
          ) : (
            <div className="space-y-2">
              {Object.keys(getProfileSelectedTables(detailProfile)).map((table) => {
                const opts = getProfileTableOptions(detailProfile)[table];
                const tools = opts?.enabledTools ?? ['describe', 'aggregate', 'query'];
                return (
                  <div
                    key={table}
                    className="flex items-center justify-between card-nested px-4 py-3"
                  >
                    <p className="text-sm font-medium text-gray-200">{table}</p>
                    <div className="flex gap-2">
                      {tools.map((tool) => (
                        <span
                          key={tool}
                          className="px-2 py-0.5 rounded-full text-xs font-medium bg-os-700/30 text-os-400"
                        >
                          {tool}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Configuration section */}
        <div className="card-primary p-4">
          <h3 className="eyebrow mb-3">Profile</h3>
          <div className="space-y-3">
            {/* Table options summary */}
            {Object.keys(getProfileTableOptions(detailProfile)).length > 0 ? (
              <div>
                <p className="text-xs text-gray-500 mb-1">Table Options</p>
                <div className="space-y-2">
                  {Object.entries(getProfileTableOptions(detailProfile)).map(([table, opts]) => (
                    <div key={table} className="card-nested px-4 py-3">
                      <p className="text-sm font-medium text-gray-200">{table}</p>
                      <div className="mt-1 text-xs text-gray-500 space-y-0.5">
                        <p>Max limit: {opts.maxLimit}</p>
                        {opts.filterableColumns.length > 0 && (
                          <p>Filterable: {opts.filterableColumns.join(', ')}</p>
                        )}
                        {opts.groupableColumns.length > 0 && (
                          <p>Groupable: {opts.groupableColumns.join(', ')}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-500">Default table options (no overrides).</p>
            )}

            {/* Column masking summary */}
            {Object.keys(getProfileColumnMasking(detailProfile)).length > 0 ? (
              <div>
                <p className="text-xs text-gray-500 mb-1 mt-3">Column Masking</p>
                <div className="space-y-2">
                  {Object.entries(getProfileColumnMasking(detailProfile)).map(
                    ([table, columns]) => (
                      <div key={table} className="card-nested px-4 py-3">
                        <p className="text-sm font-medium text-gray-200">{table}</p>
                        <div className="mt-1 text-xs text-gray-500 space-y-0.5">
                          {Object.entries(columns).map(([col, masking]) => (
                            <p key={col}>
                              {col}: <span className="text-os-400">{masking.maskingMode}</span>
                              {masking.piiDetected && (
                                <span className="ml-1 text-yellow-500">
                                  ({masking.piiDetected.category}, {masking.piiDetected.confidence})
                                </span>
                              )}
                            </p>
                          ))}
                        </div>
                      </div>
                    ),
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-500">No column masking configured.</p>
            )}
          </div>
        </div>

        {/* Tokens section (filtered for this profile) */}
        <div className="card-primary p-4">
          <h3 className="eyebrow mb-3">Tokens</h3>
          <TokenManager profiles={[detailProfile]} port={serveStatus.port} />
        </div>

        {/* Audit section (filtered for this profile) */}
        <div className="card-primary p-4">
          <h3 className="eyebrow mb-3">Audit Log</h3>
          <AuditLogViewer profiles={[detailProfile]} />
        </div>
      </div>
    );
  }

  // --- DASHBOARD VIEW ---
  return (
    <div className="space-y-4">
      {/* Summary card */}
      <div className="card-primary p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`w-2 h-2 rounded-full ${
                hasAnyActive ? 'bg-green-500 shadow-lg shadow-green-500/30' : 'bg-gray-600'
              }`}
            />
            <div>
              <h2 className="heading-md">MCP Servers</h2>
              <p className="text-sm text-gray-500">
                {activeCount}/{allProfiles.length} active
              </p>
            </div>
          </div>
          {hasAnyActive && (
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleStopAll}
                disabled={stoppingAll}
                className="px-4 py-2 rounded-lg bg-red-600/20 text-red-400 hover:bg-red-600/30 text-sm font-medium transition-all duration-200 disabled:opacity-50"
              >
                {stoppingAll ? 'Stopping...' : 'Stop All'}
              </button>
              <HelpTip
                content="Stop all currently active MCP servers at once."
                position="left"
                size="sm"
              />
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-950/30 border border-red-800/50 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Profile cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* "+" card to create a new MCP profile */}
        {showCreateForm ? (
          <div className="rounded-xl border-2 border-os-600/40 bg-gray-900/40 p-4 min-h-[140px] flex flex-col justify-between">
            <div className="space-y-3">
              <input
                type="text"
                value={newLabel}
                onChange={(e) => {
                  setNewLabel(e.target.value);
                  setNewName(slugifyProfileName(e.target.value));
                }}
                placeholder="MCP name..."
                autoFocus
                className="input-editorial w-full text-sm"
              />
              {newName && <p className="text-xs text-gray-500 font-mono">{newName}</p>}
            </div>
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => {
                  if (onCreateProfile && newLabel.trim() && newName.trim()) {
                    onCreateProfile(newName, newLabel);
                    setShowCreateForm(false);
                    setNewLabel('');
                    setNewName('');
                  }
                }}
                disabled={!newLabel.trim() || !newName.trim()}
                className="px-3 py-1.5 rounded-lg bg-os-700 hover:bg-os-600 text-white text-xs font-medium transition-all duration-200 disabled:opacity-50"
              >
                Create
              </button>
              <button
                onClick={() => {
                  setShowCreateForm(false);
                  setNewLabel('');
                  setNewName('');
                }}
                className="px-3 py-1.5 rounded-lg text-gray-400 hover:text-gray-200 text-xs font-medium transition-all duration-200"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowCreateForm(true)}
            className="rounded-xl border-2 border-dashed border-white/10 bg-gray-800/20 p-6 flex flex-col items-center justify-center gap-2 hover:border-os-500 hover:bg-gray-800/40 transition-all duration-200 text-gray-500 hover:text-os-400 min-h-[140px]"
          >
            <span className="text-3xl font-light">+</span>
            <span className="text-sm font-medium">New MCP Server</span>
          </button>
        )}

        {/* Profile cards */}
        {allProfiles.map((profile) => {
          const profileStatus = serveStatus.profileStatuses?.[profile.name];
          const isActive = profileStatus?.active === true;
          // Tenant-qualified path for non-default workspaces (same logic as
          // the detail view above — see comment there for the rationale).
          const tenant = getCurrentTenant();
          const basePath =
            tenant === 'default'
              ? (profileStatus?.endpoint ?? `/mcp/${profile.name}`)
              : buildMcpPath(profile.name, tenant);
          const endpoint = `${window.location.origin}${basePath}`;
          const tableCount = getProfileTableNames(profile).length;
          const profileSources = getProfileRelationalSources(profile);

          const profileIdx = profiles.findIndex((p) => p.name === profile.name);

          return (
            <div
              key={profile.name}
              className="relative card-interactive p-4 cursor-pointer flex flex-col justify-between min-h-[140px]"
              onClick={() =>
                onSelectProfile ? onSelectProfile(profile.name) : setSelectedProfile(profile.name)
              }
            >
              {/* Delete button */}
              {confirmDeleteProfile === profile.name ? (
                <div
                  className="absolute top-2 right-2 flex items-center gap-1 z-10"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={() => {
                      if (onDeleteProfile && profileIdx >= 0) onDeleteProfile(profileIdx);
                      setConfirmDeleteProfile(null);
                    }}
                    className="px-2 py-0.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-all duration-200"
                  >
                    Yes
                  </button>
                  <button
                    onClick={() => setConfirmDeleteProfile(null)}
                    className="px-2 py-0.5 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition-all duration-200"
                  >
                    No
                  </button>
                </div>
              ) : (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDeleteProfile(profile.name);
                  }}
                  title={`Supprimer ce serveur MCP et sa configuration`}
                  className="absolute top-2 right-2 p-1 text-gray-500 hover:text-red-400 transition-all duration-200 rounded hover:bg-red-500/10 z-10"
                  aria-label={`Supprimer le profil ${profile.label || profile.name}`}
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

              <div>
                <div className="flex items-center gap-2 mb-2 pr-8">
                  <div
                    className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      isActive ? 'bg-green-500 shadow-lg shadow-green-500/30' : 'bg-gray-600'
                    }`}
                  />
                  <p className="text-sm font-semibold text-gray-100 truncate">
                    {profile.label || profile.name}
                  </p>
                  <span
                    className={`flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${AUTH_MODE_STYLES[profile.authMode ?? 'token']}`}
                    aria-label={`Auth mode: ${AUTH_MODE_LABELS[profile.authMode ?? 'token']}`}
                    title={`Mode d'authentification : ${AUTH_MODE_DESCRIPTIONS[profile.authMode ?? 'token']}`}
                  >
                    {AUTH_MODE_LABELS[profile.authMode ?? 'token']}
                  </span>
                  <span
                    className={`flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      (profile.responseMode ?? 'friendly') === 'raw'
                        ? 'bg-orange-700/20 text-orange-400 border border-orange-600/30'
                        : 'bg-green-700/20 text-green-400 border border-green-600/30'
                    }`}
                    aria-label={`Mode de réponse : ${(profile.responseMode ?? 'friendly') === 'raw' ? 'Technique' : 'Naturel'}`}
                    title={
                      (profile.responseMode ?? 'friendly') === 'raw'
                        ? 'Mode Technique : les noms de tables et colonnes sont visibles dans les réponses'
                        : 'Mode Naturel : les réponses sont formulées en langage courant'
                    }
                  >
                    {(profile.responseMode ?? 'friendly') === 'raw' ? 'Technique' : 'Naturel'}
                  </span>
                </div>
                {profile.label && profile.label !== profile.name && (
                  <p className="text-xs text-gray-500 mb-2 font-mono truncate">{profile.name}</p>
                )}
                <p className="text-xs text-gray-500 font-mono truncate mb-1">{endpoint}</p>
                <p className="text-xs text-gray-500">
                  {tableCount} table{tableCount !== 1 ? 's' : ''}
                </p>
                {profileSources.length > 0 && (
                  <p className="text-xs text-gray-600 mt-0.5 truncate">
                    {profileSources.join(', ')}
                  </p>
                )}

                {/* Chat link — only shown when profile is active */}
                {isActive && (
                  <div
                    className="mt-2 flex items-center gap-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="text-xs text-gray-500 flex-shrink-0">Chat:</span>
                    <code className="text-xs text-os-400 bg-gray-800/50 px-2 py-0.5 rounded font-mono truncate min-w-0">
                      {window.location.origin}/chat/{encodeURIComponent(profile.name)}
                    </code>
                    <button
                      onClick={() => {
                        const chatUrl = `${window.location.origin}/chat/${encodeURIComponent(profile.name)}`;
                        navigator.clipboard.writeText(chatUrl).then(() => {
                          setCopiedChatLink(profile.name);
                          setTimeout(() => setCopiedChatLink(null), 2000);
                        });
                      }}
                      aria-label={`Copy chat link for ${profile.label || profile.name}`}
                      title="Copier le lien de chat partageable pour ce profil (accessible sans interface Calame)"
                      className="flex-shrink-0 text-xs text-gray-500 hover:text-gray-300 transition-colors focus:outline-none focus:ring-1 focus:ring-os-500 rounded"
                    >
                      {copiedChatLink === profile.name ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                )}
              </div>

              <div className="mt-3 flex items-center justify-between">
                {/* Preview button */}
                {onPreviewProfile && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onPreviewProfile(profile.name);
                    }}
                    title="Prévisualiser la configuration de ce profil sans le démarrer"
                    className="text-xs text-os-400 hover:text-os-300 transition-colors focus:outline-none focus:ring-1 focus:ring-os-500 rounded"
                    aria-label={`Preview profile ${profile.label || profile.name}`}
                  >
                    Preview
                  </button>
                )}
                {!onPreviewProfile && <span />}
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isActive) {
                        handleStopProfile(profile.name);
                      } else {
                        handleStartProfile(profile.name);
                      }
                    }}
                    disabled={togglingProfile === profile.name}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 disabled:opacity-50 ${
                      isActive
                        ? 'bg-red-600/20 text-red-400 hover:bg-red-600/30'
                        : 'bg-os-700/30 text-os-400 hover:bg-os-700/50'
                    }`}
                  >
                    {togglingProfile === profile.name ? (
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
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
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                        />
                      </svg>
                    ) : isActive ? (
                      'Stop'
                    ) : (
                      'Start'
                    )}
                  </button>
                  <HelpTip
                    content={
                      isActive
                        ? 'Arrêter le serveur MCP pour ce profil'
                        : 'Démarrer le serveur MCP pour ce profil'
                    }
                    position="top"
                    size="xs"
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Dashboard tabs: Chat + Pending */}
      <div className="border-b border-white/5">
        <div className="flex gap-0">
          {dashboardTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-5 py-3 text-sm font-medium border-b-2 transition-all duration-200 flex items-center gap-2 ${
                activeTab === tab.id
                  ? 'border-os-500 text-os-400'
                  : 'border-transparent text-gray-500 hover:text-gray-300 hover:border-gray-600'
              }`}
            >
              {tab.label}
              {tab.badge !== undefined && (
                <span className="px-1.5 py-0.5 rounded-full text-xs font-medium bg-yellow-600/20 text-yellow-400 min-w-[1.25rem] text-center">
                  {tab.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div>
        {activeTab === 'chat' && (
          <ChatPanel
            selectedTables={selectedTables}
            activeProfiles={Object.entries(serveStatus.profileStatuses ?? {})
              .filter(([, s]) => s.active)
              .map(([name]) => name)}
          />
        )}
        {activeTab === 'pending' && <PendingQueries onPendingCountChange={setPendingCount} />}
      </div>
    </div>
  );
}
