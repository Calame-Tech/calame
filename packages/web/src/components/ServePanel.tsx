import { useState, useCallback, useMemo } from 'react';
import { apiFetch, getCurrentTenant } from '../lib/api.js';
import type { AuthMode, Config, Profile, ServeStatus } from '../types/schema.js';
import { getProfileTableNames, getProfileRelationalSources } from '../lib/profile-accessors.js';
import { buildMcpPath } from '../lib/mcp-url.js';
import { slugifyProfileName } from '../lib/profiles.js';
import ChatPanel from './ChatPanel.js';
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
  onSelectProfile: (name: string) => void;
  onCreateProfile?: (name: string, label: string) => void;
  onDeleteProfile?: (index: number) => void;
  onPreviewProfile?: (name: string) => void;
}

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
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [confirmDeleteProfile, setConfirmDeleteProfile] = useState<string | null>(null);
  const [togglingProfile, setTogglingProfile] = useState<string | null>(null);
  const [stoppingAll, setStoppingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
                  setCreateError(null);
                }}
                placeholder="MCP name..."
                autoFocus
                className="input-editorial w-full text-sm"
              />
              {newName && <p className="text-xs text-gray-500 font-mono">{newName}</p>}
              {createError && <p className="text-xs text-red-400">{createError}</p>}
            </div>
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => {
                  if (!onCreateProfile || !newLabel.trim() || !newName.trim()) return;
                  if (profiles.some((p) => p.name === newName)) {
                    setCreateError(`A profile named "${newName}" already exists.`);
                    return;
                  }
                  onCreateProfile(newName, newLabel);
                  setShowCreateForm(false);
                  setNewLabel('');
                  setNewName('');
                  setCreateError(null);
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
                  setCreateError(null);
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
          // Tenant-qualified path for non-default workspaces so external MCP
          // clients (which cannot inject X-Tenant-Id) reach the right tenant.
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
              onClick={() => onSelectProfile(profile.name)}
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

      {/* Chat — the write-approval queue previously tabbed alongside this has
          been promoted to its own top-level page (sidebar "Govern" section). */}
      <div>
        <ChatPanel
          selectedTables={selectedTables}
          activeProfiles={Object.entries(serveStatus.profileStatuses ?? {})
            .filter(([, s]) => s.active)
            .map(([name]) => name)}
        />
      </div>
    </div>
  );
}
