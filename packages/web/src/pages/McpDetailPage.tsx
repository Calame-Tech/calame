// MCP server detail page (Phase 3 #14). The page wrapper is the
// `view.page === 'mcp-detail'` branch of App.tsx; the McpDetailView component,
// its lazy EE sections and the Token/Users/Audit lazy wrappers below were all
// moved verbatim from App.tsx.

import { useState, useMemo, useEffect, lazy, Suspense } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { apiFetch, getCurrentTenant } from '../lib/api.js';
import { buildMcpPath } from '../lib/mcp-url.js';
import { Breadcrumb } from '../components/ui/index.js';
import HelpTip from '../components/HelpTip.js';
import AiSettingsAssignment from '../components/AiSettingsAssignment.js';
import TokenManager from '../components/TokenManager.js';
import AuditLogViewer from '../components/AuditLogViewer.js';
import McpUsers from '../components/McpUsers.js';
import { persistProfiles, buildProfilesData } from '../lib/profiles.js';
import {
  getConfigurationTableNames,
  getConfigurationSelectedTables,
} from '../lib/configuration-accessors.js';
import type {
  Config,
  Configuration,
  Profile,
  ServeStatus,
  AuthMode,
  OAuthConfig,
  ExternalAuthConfig,
  DataScopeRule,
} from '../types/schema.js';
import type { View } from '../router/index.js';

const ProfileSsoNotice = lazy(() =>
  import('@calame-ee/sso/web')
    .then((m) => ({ default: m.ProfileSsoNotice }))
    .catch(() => ({
      // Informational banner — disappear silently when SSO is absent.
      // Return a Fragment (not `null`) so the type matches React.lazy's expected
      // `ComponentType<{}>` shape (() => JSX.Element, not () => null).
      default: function ProfileSsoNoticeUnavailable() {
        return <></>;
      },
    })),
);

const DataScopingSection = lazy(() =>
  import('@calame-ee/sso/web')
    .then((m) => ({ default: m.DataScopingSection }))
    .catch(() => ({
      default: function DataScopingSectionUnavailable() {
        return (
          <div className="p-6 text-sm text-gray-400 text-center">
            Les fonctionnalités de scoping ne sont pas disponibles sur cette instance.
          </div>
        );
      },
    })),
);

interface McpDetailPageProps {
  view: Extract<View, { page: 'mcp-detail' }>;
  setView: Dispatch<SetStateAction<View>>;
  profiles: Profile[];
  setProfiles: Dispatch<SetStateAction<Profile[]>>;
  serveStatus: ServeStatus;
  configWithProfileOptions: Config;
  configurations: Configuration[];
  setConfigurations: Dispatch<SetStateAction<Configuration[]>>;
  activeProfileIndex: number;
  setActiveProfileIndex: (index: number) => void;
  handleProfileDelete: (index: number) => Promise<void>;
  handleConfigurationSave: (config: Configuration) => Promise<boolean>;
}

export default function McpDetailPage({
  view,
  setView,
  profiles,
  setProfiles,
  serveStatus,
  configWithProfileOptions,
  configurations,
  setConfigurations,
  activeProfileIndex,
  setActiveProfileIndex,
  handleProfileDelete,
  handleConfigurationSave,
}: McpDetailPageProps) {
  return (
    <div className="max-w-7xl mx-auto">
      <Breadcrumb
        className="mb-4"
        items={[
          { label: 'Dashboard', onClick: () => setView({ page: 'dashboard' }) },
          { label: 'MCP Servers', onClick: () => setView({ page: 'mcp-list' }) },
          {
            label: profiles.find((p) => p.name === view.profileName)?.label ?? view.profileName,
          },
        ]}
      />
      <McpDetailView
        profileName={view.profileName}
        profiles={profiles}
        serveStatus={serveStatus}
        config={configWithProfileOptions}
        initialActiveSection={view.activeSection}
        configurations={configurations}
        onProfilesChange={setProfiles}
        activeProfileIndex={activeProfileIndex}
        onActiveProfileIndexChange={setActiveProfileIndex}
        onNavigateToAiSettings={() =>
          setView({
            page: 'settings',
            initialTab: 'ai',
            backTo: { page: 'mcp-detail', profileName: view.profileName },
          })
        }
        onNavigateToConfig={(configName) => {
          if (!configName) {
            const slug = `config-${Date.now()}`;
            const newConfig: Configuration = {
              name: slug,
              label: 'New Configuration',
            };
            setConfigurations((prev) => [...prev, newConfig]);
            handleConfigurationSave(newConfig);
            setView({
              page: 'config-detail',
              configName: slug,
              backTo: { page: 'mcp-detail', profileName: view.profileName },
            });
          } else {
            setView({
              page: 'config-detail',
              configName,
              backTo: { page: 'mcp-detail', profileName: view.profileName },
            });
          }
        }}
        onDeleteProfile={handleProfileDelete}
        onNavigateBack={() => setView({ page: 'mcp-list' })}
        onNavigateToUser={(userId) =>
          setView({
            page: 'users',
            selectedUserId: userId,
            backTo: {
              page: 'mcp-detail',
              profileName: view.profileName,
              activeSection: 'users',
            },
          })
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// MCP Detail / Config view — shown when clicking an MCP card
// ---------------------------------------------------------------------------

interface McpDetailViewProps {
  profileName: string;
  profiles: Profile[];
  serveStatus: ServeStatus;
  config: Config;
  configurations: Configuration[];
  onProfilesChange: React.Dispatch<React.SetStateAction<Profile[]>>;
  activeProfileIndex: number;
  onActiveProfileIndexChange: (index: number) => void;
  onNavigateToConfig: (configName: string) => void;
  onDeleteProfile: (index: number) => void;
  onNavigateBack: () => void;
  onNavigateToUser: (userId: string) => void;
  onNavigateToAiSettings: () => void;
  initialActiveSection?: string;
}

function McpDetailView({
  profileName,
  profiles,
  serveStatus,
  config,
  onProfilesChange,
  activeProfileIndex,
  onActiveProfileIndexChange,
  configurations,
  onNavigateToConfig,
  onNavigateToAiSettings,
  onDeleteProfile,
  onNavigateBack,
  onNavigateToUser,
  initialActiveSection,
}: McpDetailViewProps) {
  const [togglingProfile, setTogglingProfile] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedEndpoint, setCopiedEndpoint] = useState(false);
  const [activeSection, setActiveSection] = useState<
    'tables' | 'config' | 'tokens' | 'audit' | 'users' | 'scoping'
  >(
    (initialActiveSection as 'tables' | 'config' | 'tokens' | 'audit' | 'users' | 'scoping') ??
      'tables',
  );

  const [editingLabel, setEditingLabel] = useState(false);
  const [editLabel, setEditLabel] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [togglingResponseMode, setTogglingResponseMode] = useState(false);
  const [responseModeError, setResponseModeError] = useState<string | null>(null);

  // Find the profile by name
  const profileIndex = profiles.findIndex((p) => p.name === profileName);
  const profile = profileIndex >= 0 ? profiles[profileIndex] : null;

  // Auth mode handlers — persist to backend on each change
  const handleAuthModeChange = (mode: AuthMode) => {
    if (profileIndex < 0) return;
    onProfilesChange((prev) => {
      const updated = [...prev];
      updated[profileIndex] = { ...updated[profileIndex], authMode: mode };
      persistProfiles(buildProfilesData(updated)).catch(() => {});
      return updated;
    });
  };

  const handleOAuthConfigChange = (partial: Partial<OAuthConfig>) => {
    if (profileIndex < 0) return;
    onProfilesChange((prev) => {
      const updated = [...prev];
      const current = updated[profileIndex];
      const existingOauth: OAuthConfig = current.oauthConfig ?? {
        provider: 'github',
        clientId: '',
        clientSecret: '',
      };
      updated[profileIndex] = {
        ...current,
        oauthConfig: { ...existingOauth, ...partial },
      };
      persistProfiles(buildProfilesData(updated)).catch(() => {});
      return updated;
    });
  };

  const handleExternalAuthConfigChange = (partial: Partial<ExternalAuthConfig>) => {
    if (profileIndex < 0) return;
    onProfilesChange((prev) => {
      const updated = [...prev];
      const current = updated[profileIndex];
      const existingExternal: ExternalAuthConfig = current.externalAuthConfig ?? {
        validationUrl: '',
      };
      updated[profileIndex] = {
        ...current,
        externalAuthConfig: { ...existingExternal, ...partial },
      };
      persistProfiles(buildProfilesData(updated)).catch(() => {});
      return updated;
    });
  };

  const handleAiSettingNamesChange = (aiSettingNames: string[]) => {
    if (profileIndex < 0) return;
    onProfilesChange((prev) => {
      const updated = [...prev];
      updated[profileIndex] = { ...updated[profileIndex], aiSettingNames };
      persistProfiles(buildProfilesData(updated)).catch(() => {});
      return updated;
    });
  };

  const handleScopeRulesChange = (dataScopeRules: DataScopeRule[], sharedTables: string[]) => {
    if (profileIndex < 0) return;
    onProfilesChange((prev) => {
      const updated = [...prev];
      updated[profileIndex] = { ...updated[profileIndex], dataScopeRules, sharedTables };
      persistProfiles(buildProfilesData(updated)).catch(() => {});
      return updated;
    });
  };

  // Ensure active profile index matches the detail view profile
  useEffect(() => {
    if (profileIndex >= 0 && profileIndex !== activeProfileIndex) {
      onActiveProfileIndexChange(profileIndex);
    }
  }, [profileIndex, activeProfileIndex, onActiveProfileIndexChange]);

  if (!profile) {
    return (
      <div className="text-center text-gray-500 py-12">
        <p>Profile &quot;{profileName}&quot; not found.</p>
      </div>
    );
  }

  const profileStatus = serveStatus.profileStatuses?.[profile.name];
  const isActive = profileStatus?.active === true;
  // Tenant-qualified path when the current workspace is non-default — the
  // backend's `profileStatus.endpoint` is a default-tenant string so we
  // override it here for other workspaces (matches ServePanel.tsx).
  const _tenant = getCurrentTenant();
  const basePath =
    _tenant === 'default'
      ? (profileStatus?.endpoint ?? `/mcp/${profile.name}`)
      : buildMcpPath(profile.name, _tenant);
  const endpoint = `${window.location.origin}${basePath}`;

  // Count effective tables from configurations
  const profileConfigurations = profile.configurations ?? [];
  const effectiveTableCount = useMemo(() => {
    const tables = new Set<string>();
    for (const cfgName of profileConfigurations) {
      const cfg = configurations.find((c) => c.name === cfgName);
      if (cfg) {
        for (const t of getConfigurationTableNames(cfg)) tables.add(t);
      }
    }
    return tables.size;
  }, [profileConfigurations, configurations]);

  /** Save all profiles to backend before starting, so new profiles are known */
  const saveProfiles = async () => {
    await persistProfiles(buildProfilesData(profiles));
  };

  const handleStartProfile = async () => {
    setTogglingProfile(true);
    setError(null);
    try {
      // Save profiles first so the backend knows about new profiles
      await saveProfiles();

      const res = await apiFetch('/api/serve/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverName: config.serverName,
          profiles: [profile.name],
        }),
      });
      const data = await res.json();
      if (data.success === false) {
        setError(data.message || `Failed to start profile "${profile.name}".`);
      }
    } catch {
      setError(`Network error starting profile "${profile.name}".`);
    } finally {
      setTogglingProfile(false);
    }
  };

  const handleStopProfile = async () => {
    setTogglingProfile(true);
    setError(null);
    try {
      const res = await apiFetch('/api/serve/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profiles: [profile.name] }),
      });
      const data = await res.json();
      if (data.success === false) {
        setError(data.message || `Failed to stop profile "${profile.name}".`);
      }
    } catch {
      setError(`Network error stopping profile "${profile.name}".`);
    } finally {
      setTogglingProfile(false);
    }
  };

  const handleCopyEndpoint = () => {
    navigator.clipboard.writeText(endpoint).then(() => {
      setCopiedEndpoint(true);
      setTimeout(() => setCopiedEndpoint(false), 2000);
    });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await apiFetch('/api/serve/refresh', { method: 'POST' });
      const data = await res.json();
      if (data.success === false) {
        setError(data.message || 'Failed to refresh.');
      }
    } catch {
      setError('Network error refreshing.');
    } finally {
      setRefreshing(false);
    }
  };

  const handleToggleConfiguration = (configName: string) => {
    onProfilesChange((prev) => {
      const updated = [...prev];
      const p = { ...updated[profileIndex] };
      const current = p.configurations ?? [];
      if (current.includes(configName)) {
        p.configurations = current.filter((c) => c !== configName);
      } else {
        p.configurations = [...current, configName];
      }
      updated[profileIndex] = p;

      // Persist to backend and refresh active MCP servers
      persistProfiles(buildProfilesData(updated))
        .then(() => apiFetch('/api/serve/refresh', { method: 'POST' }))
        .catch(() => {});

      return updated;
    });
  };

  // Response mode toggle
  const currentResponseMode = profile?.responseMode ?? 'friendly';
  const isRawMode = currentResponseMode === 'raw';

  const handleToggleResponseMode = async () => {
    if (profileIndex < 0) return;
    setTogglingResponseMode(true);
    setResponseModeError(null);
    const newMode = isRawMode ? 'friendly' : 'raw';
    try {
      const res = await apiFetch(`/api/profiles/${encodeURIComponent(profileName)}/response-mode`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mode: newMode }),
      });
      if (!res.ok) throw new Error('Failed to update response mode');
      onProfilesChange((prev) => {
        const updated = [...prev];
        updated[profileIndex] = { ...updated[profileIndex], responseMode: newMode };
        return updated;
      });
    } catch {
      setResponseModeError('Erreur lors du changement de mode');
    } finally {
      setTogglingResponseMode(false);
    }
  };

  // Lazy-import detail sub-components
  const sectionTabs: { id: typeof activeSection; label: string; tooltip: string }[] = [
    {
      id: 'tables',
      label: 'Exposed Data',
      tooltip: 'Gérer les profils de données et les tables accessibles via ce serveur MCP',
    },
    {
      id: 'users',
      label: 'Users',
      tooltip: 'Voir et gérer les utilisateurs ayant accès à ce serveur MCP',
    },
    {
      id: 'tokens',
      label: 'API Keys',
      tooltip: "Créer et révoquer des clés API pour l'authentification programmatique",
    },
    {
      id: 'scoping',
      label: 'Data Scoping',
      tooltip: "Configurer l'isolation des données par utilisateur (row-level)",
    },
    {
      id: 'audit',
      label: 'Audit Log',
      tooltip: "Consulter l'historique des requêtes et des accès à ce serveur",
    },
  ];

  return (
    <div className="space-y-4">
      {/* Header card */}
      <div className="card-primary p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`w-3 h-3 rounded-full ${
                isActive ? 'bg-green-500 shadow-lg shadow-green-500/30' : 'bg-gray-600'
              }`}
              title={isActive ? "Serveur MCP en cours d'exécution" : 'Serveur MCP arrêté'}
            />
            <div>
              {editingLabel ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && editLabel.trim()) {
                        onProfilesChange((prev) => {
                          const updated = [...prev];
                          updated[profileIndex] = {
                            ...updated[profileIndex],
                            label: editLabel.trim(),
                          };
                          return updated;
                        });
                        setEditingLabel(false);
                      }
                      if (e.key === 'Escape') setEditingLabel(false);
                    }}
                    autoFocus
                    className="px-2 py-1 rounded-lg bg-gray-900/60 border border-os-500 text-gray-100 text-lg font-semibold focus:outline-none focus:ring-1 focus:ring-os-500/30"
                  />
                  <button
                    onClick={() => {
                      if (editLabel.trim()) {
                        onProfilesChange((prev) => {
                          const updated = [...prev];
                          updated[profileIndex] = {
                            ...updated[profileIndex],
                            label: editLabel.trim(),
                          };
                          return updated;
                        });
                      }
                      setEditingLabel(false);
                    }}
                    className="text-xs text-os-400 hover:text-os-300"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditingLabel(false)}
                    className="text-xs text-gray-500 hover:text-gray-300"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <h2
                  className="text-lg font-semibold text-gray-100 cursor-pointer hover:text-os-400 transition-all duration-200 group flex items-center gap-1.5"
                  onClick={() => {
                    setEditLabel(profile.label || profile.name);
                    setEditingLabel(true);
                  }}
                >
                  {profile.label || profile.name}
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
                  {profile.name !== profile.label && (
                    <span className="ml-2 text-sm font-normal text-gray-500 font-mono">
                      {profile.name}
                    </span>
                  )}
                  <HelpTip
                    content="Cliquer pour renommer ce serveur MCP"
                    position="right"
                    size="xs"
                  />
                </h2>
              )}
              <p className="text-sm text-gray-500 mt-1">
                {isActive ? 'Active' : 'Inactive'} &middot; {profileConfigurations.length} profile
                {profileConfigurations.length !== 1 ? 's' : ''} &middot; {effectiveTableCount} table
                {effectiveTableCount !== 1 ? 's' : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isActive && (
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                title="Recharger la configuration sans redémarrer le serveur"
                className="px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 disabled:opacity-50 bg-gray-700/30 text-gray-300 hover:bg-gray-700/50"
              >
                {refreshing ? (
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
                ) : (
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                )}
              </button>
            )}
            <button
              onClick={() => (isActive ? handleStopProfile() : handleStartProfile())}
              disabled={togglingProfile}
              title={isActive ? 'Arrêter ce serveur MCP' : 'Démarrer ce serveur MCP'}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 disabled:opacity-50 ${
                isActive
                  ? 'bg-red-600/20 text-red-400 hover:bg-red-600/30'
                  : 'bg-os-700/30 text-os-400 hover:bg-os-700/50'
              }`}
            >
              {togglingProfile ? (
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
            {confirmDelete ? (
              <div className="flex items-center gap-1">
                <span className="text-xs text-gray-400 mr-1">Supprimer ?</span>
                <button
                  onClick={() => {
                    if (profileIndex >= 0) {
                      onDeleteProfile(profileIndex);
                      onNavigateBack();
                    }
                    setConfirmDelete(false);
                  }}
                  className="px-2 py-1.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-all duration-200"
                >
                  Oui
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="px-2 py-1.5 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition-all duration-200"
                >
                  Non
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                title="Supprimer ce serveur MCP"
                className="p-2 text-gray-500 hover:text-red-400 transition-all duration-200 rounded-lg hover:bg-red-500/10"
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

        {/* Endpoint + Chat URLs (copiable, side by side) */}
        <div className="mt-3 flex flex-wrap gap-4">
          <div>
            <p className="text-xs text-gray-500 mb-1 flex items-center gap-1">
              Endpoint
              <HelpTip
                content="MCP endpoint URL to configure in Claude Desktop, Cursor or VS Code"
                position="bottom"
                size="xs"
              />
            </p>
            <button
              onClick={handleCopyEndpoint}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-900/60 border border-gray-700 hover:border-os-600 transition-all duration-200 group"
            >
              <code className="text-sm text-os-400 font-mono">{endpoint}</code>
              <span className="text-xs text-gray-500 group-hover:text-os-400 transition-all duration-200">
                {copiedEndpoint ? 'Copied!' : 'Copy'}
              </span>
            </button>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1 flex items-center gap-1">
              Chat
              <HelpTip
                content="Lien partageable vers l'interface de chat pour vos utilisateurs finaux"
                position="bottom"
                size="xs"
              />
            </p>
            <button
              onClick={() => {
                const chatUrl = `${window.location.origin}/chat/${encodeURIComponent(profile.name)}`;
                navigator.clipboard.writeText(chatUrl).then(() => {
                  setCopiedEndpoint(true);
                  setTimeout(() => setCopiedEndpoint(false), 2000);
                });
              }}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-900/60 border border-gray-700 hover:border-os-600 transition-all duration-200 group"
            >
              <code className="text-sm text-os-400 font-mono">
                {window.location.origin}/chat/{encodeURIComponent(profile.name)}
              </code>
              <span className="text-xs text-gray-500 group-hover:text-os-400 transition-all duration-200">
                Copy
              </span>
            </button>
          </div>
        </div>

        {/* Response mode */}
        <div className="mt-4 flex items-center justify-between pt-3 border-t border-gray-700/50">
          <div>
            <span className="text-xs text-gray-400">Mode de réponse</span>
            {responseModeError && (
              <p className="text-xs text-red-400 mt-0.5">{responseModeError}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`text-xs font-medium ${isRawMode ? 'text-orange-400' : 'text-green-400'}`}
            >
              {togglingResponseMode ? '...' : isRawMode ? 'Technique' : 'Naturel'}
            </span>
            <button
              role="switch"
              aria-checked={isRawMode}
              aria-label="Basculer le mode de réponse"
              onClick={handleToggleResponseMode}
              disabled={togglingResponseMode}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-os-500 focus:ring-offset-2 focus:ring-offset-gray-900 disabled:opacity-50 ${
                isRawMode ? 'bg-orange-500' : 'bg-green-600'
              }`}
            >
              <span
                className={`inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${
                  isRawMode ? 'translate-x-5' : 'translate-x-1'
                }`}
              />
            </button>
            <HelpTip
              content="En mode Naturel, les reponses sont formulees en langage courant sans termes techniques. En mode Technique, les noms de tables et colonnes de la base de donnees sont visibles."
              position="left"
              size="xs"
            />
          </div>
        </div>

        {/* Chat authentication mode selector */}
        <div className="mt-4">
          <label className="block text-xs text-gray-500 mb-2">Chat Authentication</label>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {(
              [
                {
                  value: 'token',
                  label: 'API Key',
                  desc: 'Calame API key',
                  tooltip:
                    "Les utilisateurs s'authentifient avec une clé API générée par Calame. Idéal pour l'accès programmatique.",
                },
                {
                  value: 'calame',
                  label: 'Calame',
                  desc: 'User account',
                  tooltip: 'Les utilisateurs se connectent avec leur email et mot de passe Calame.',
                },
                {
                  value: 'sso',
                  label: 'SSO',
                  desc: 'OIDC provider',
                  tooltip:
                    "Authentification via votre SSO d'entreprise (Azure AD, Okta, Keycloak). À configurer dans les Paramètres.",
                },
                {
                  value: 'oauth',
                  label: 'OAuth',
                  desc: 'GitHub, Google...',
                  tooltip:
                    'Les utilisateurs se connectent via GitHub, Google, GitLab ou un fournisseur OAuth personnalisé.',
                },
                {
                  value: 'external',
                  label: 'External',
                  desc: 'External API validation',
                  tooltip:
                    "Les tokens sont validés par votre propre endpoint API. Utile pour s'intégrer à un système d'authentification existant.",
                },
                {
                  value: 'open',
                  label: 'Open',
                  desc: 'No auth',
                  tooltip:
                    "Accès libre sans authentification. À utiliser avec précaution — n'importe qui peut interroger ce serveur.",
                },
              ] as { value: AuthMode; label: string; desc: string; tooltip: string }[]
            ).map((mode) => {
              const currentMode = profile.authMode ?? 'token';
              return (
                <button
                  key={mode.value}
                  type="button"
                  onClick={() => handleAuthModeChange(mode.value)}
                  className={`p-3 rounded-lg border text-center transition-all duration-200 ${
                    currentMode === mode.value
                      ? 'border-os-600/60 bg-os-700/10 ring-1 ring-os-600/20'
                      : 'border-gray-700 hover:border-gray-600 bg-gray-800/30'
                  }`}
                  aria-pressed={currentMode === mode.value}
                >
                  <p className="text-xs font-medium text-gray-200">{mode.label}</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">{mode.desc}</p>
                  <HelpTip content={mode.tooltip} position="bottom" maxWidth={300} size="xs" />
                </button>
              );
            })}
          </div>

          {/* Warning for open mode */}
          {(profile.authMode ?? 'token') === 'open' && (
            <p className="mt-2 text-xs text-yellow-500/80 bg-yellow-900/10 border border-yellow-700/30 rounded px-2 py-1">
              Warning: this MCP server will be accessible without any authentication.
            </p>
          )}

          {/* SSO info — rendered only when authMode is 'sso' */}
          {(profile.authMode ?? 'token') === 'sso' && (
            <Suspense fallback={null}>
              <ProfileSsoNotice />
            </Suspense>
          )}

          {/* External auth config */}
          {(profile.authMode ?? 'token') === 'external' && (
            <div className="mt-3 space-y-3 pl-2 border-l-2 border-gray-700">
              <div>
                <label
                  className="block text-xs text-gray-400 mb-1"
                  htmlFor={`external-validation-url-${profile.name}`}
                >
                  Validation URL <span className="text-red-400">*</span>
                </label>
                <input
                  id={`external-validation-url-${profile.name}`}
                  type="text"
                  value={profile.externalAuthConfig?.validationUrl ?? ''}
                  onChange={(e) =>
                    handleExternalAuthConfigChange({ validationUrl: e.target.value })
                  }
                  placeholder="https://your-app.com/api/validate-token"
                  className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
                />
                <p className="text-xs text-gray-600 mt-1">
                  Calame will call this URL with the user&apos;s token to validate it.
                </p>
              </div>

              <div>
                <label
                  className="block text-xs text-gray-400 mb-1"
                  htmlFor={`external-header-name-${profile.name}`}
                >
                  Header Name (optional)
                </label>
                <input
                  id={`external-header-name-${profile.name}`}
                  type="text"
                  value={profile.externalAuthConfig?.headerName ?? ''}
                  onChange={(e) => handleExternalAuthConfigChange({ headerName: e.target.value })}
                  placeholder="Authorization (default)"
                  className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
                />
              </div>

              <div>
                <label
                  className="block text-xs text-gray-400 mb-1"
                  htmlFor={`external-header-template-${profile.name}`}
                >
                  Header Template (optional)
                </label>
                <input
                  id={`external-header-template-${profile.name}`}
                  type="text"
                  value={profile.externalAuthConfig?.headerTemplate ?? ''}
                  onChange={(e) =>
                    handleExternalAuthConfigChange({ headerTemplate: e.target.value })
                  }
                  placeholder="Bearer {token} (default)"
                  className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
                />
                <p className="text-xs text-gray-600 mt-1">
                  Use &#123;token&#125; as placeholder. Examples: &quot;Bearer
                  &#123;token&#125;&quot;, &quot;Token &#123;token&#125;&quot;,
                  &quot;&#123;token&#125;&quot;
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label
                    className="block text-xs text-gray-400 mb-1"
                    htmlFor={`external-email-field-${profile.name}`}
                  >
                    Email field <span className="text-gray-600">(optional)</span>
                  </label>
                  <input
                    id={`external-email-field-${profile.name}`}
                    type="text"
                    value={profile.externalAuthConfig?.emailField ?? ''}
                    onChange={(e) => handleExternalAuthConfigChange({ emailField: e.target.value })}
                    placeholder="email (default)"
                    className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
                  />
                </div>
                <div>
                  <label
                    className="block text-xs text-gray-400 mb-1"
                    htmlFor={`external-name-field-${profile.name}`}
                  >
                    Name field <span className="text-gray-600">(optional)</span>
                  </label>
                  <input
                    id={`external-name-field-${profile.name}`}
                    type="text"
                    value={profile.externalAuthConfig?.nameField ?? ''}
                    onChange={(e) => handleExternalAuthConfigChange({ nameField: e.target.value })}
                    placeholder="name (default)"
                    className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
                  />
                </div>
              </div>
              <p className="text-xs text-gray-600">
                Dot notation supported (e.g., &quot;user.profile.email&quot;).
              </p>

              {/* Auto-create users toggle */}
              <label className="flex items-center gap-2 cursor-pointer mt-2">
                <input
                  type="checkbox"
                  checked={profile.externalAuthConfig?.autoCreateUsers ?? true}
                  onChange={(e) =>
                    handleExternalAuthConfigChange({ autoCreateUsers: e.target.checked })
                  }
                  className="rounded border-gray-600 bg-gray-700 text-os-500 focus:ring-os-500/30 focus:ring-offset-0"
                />
                <span className="text-sm text-gray-300">Auto-create users</span>
              </label>
              <p className="text-xs text-gray-600">
                {profile.externalAuthConfig?.autoCreateUsers !== false
                  ? 'Users validated by the external API will be automatically created in Calame.'
                  : 'Only existing Calame users will be accepted. New users will be rejected.'}
              </p>
            </div>
          )}

          {/* OAuth config */}
          {(profile.authMode ?? 'token') === 'oauth' && (
            <div className="mt-3 space-y-3 pl-2 border-l-2 border-gray-700">
              <div>
                <label
                  className="block text-xs text-gray-400 mb-1"
                  htmlFor={`oauth-provider-${profile.name}`}
                >
                  OAuth Provider
                </label>
                <select
                  id={`oauth-provider-${profile.name}`}
                  value={profile.oauthConfig?.provider ?? 'github'}
                  onChange={(e) =>
                    handleOAuthConfigChange({
                      provider: e.target.value as OAuthConfig['provider'],
                    })
                  }
                  className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
                >
                  <option value="github">GitHub</option>
                  <option value="google">Google</option>
                  <option value="gitlab">GitLab</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              <div>
                <label
                  className="block text-xs text-gray-400 mb-1"
                  htmlFor={`oauth-client-id-${profile.name}`}
                >
                  Client ID <span className="text-red-400">*</span>
                </label>
                <input
                  id={`oauth-client-id-${profile.name}`}
                  type="text"
                  value={profile.oauthConfig?.clientId ?? ''}
                  onChange={(e) => handleOAuthConfigChange({ clientId: e.target.value })}
                  placeholder="your-client-id"
                  className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
                />
              </div>
              <div>
                <label
                  className="block text-xs text-gray-400 mb-1"
                  htmlFor={`oauth-client-secret-${profile.name}`}
                >
                  Client Secret <span className="text-red-400">*</span>
                </label>
                <input
                  id={`oauth-client-secret-${profile.name}`}
                  type="password"
                  value={profile.oauthConfig?.clientSecret ?? ''}
                  onChange={(e) => handleOAuthConfigChange({ clientSecret: e.target.value })}
                  placeholder="your-client-secret"
                  className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
                />
              </div>
              {((profile.oauthConfig?.provider ?? 'github') === 'custom' ||
                (profile.oauthConfig?.provider ?? 'github') === 'gitlab') && (
                <>
                  <div>
                    <label
                      className="block text-xs text-gray-400 mb-1"
                      htmlFor={`oauth-auth-url-${profile.name}`}
                    >
                      Authorization URL <span className="text-red-400">*</span>
                    </label>
                    <input
                      id={`oauth-auth-url-${profile.name}`}
                      type="text"
                      value={profile.oauthConfig?.authorizationUrl ?? ''}
                      onChange={(e) =>
                        handleOAuthConfigChange({ authorizationUrl: e.target.value })
                      }
                      placeholder="https://..."
                      className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
                    />
                  </div>
                  <div>
                    <label
                      className="block text-xs text-gray-400 mb-1"
                      htmlFor={`oauth-token-url-${profile.name}`}
                    >
                      Token URL <span className="text-red-400">*</span>
                    </label>
                    <input
                      id={`oauth-token-url-${profile.name}`}
                      type="text"
                      value={profile.oauthConfig?.tokenUrl ?? ''}
                      onChange={(e) => handleOAuthConfigChange({ tokenUrl: e.target.value })}
                      placeholder="https://..."
                      className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
                    />
                  </div>
                  <div>
                    <label
                      className="block text-xs text-gray-400 mb-1"
                      htmlFor={`oauth-userinfo-url-${profile.name}`}
                    >
                      User Info URL <span className="text-red-400">*</span>
                    </label>
                    <input
                      id={`oauth-userinfo-url-${profile.name}`}
                      type="text"
                      value={profile.oauthConfig?.userinfoUrl ?? ''}
                      onChange={(e) => handleOAuthConfigChange({ userinfoUrl: e.target.value })}
                      placeholder="https://..."
                      className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
                    />
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="mt-3 p-3 rounded-lg bg-red-950/30 border border-red-800/50 text-red-400 text-sm">
            {error}
          </div>
        )}
      </div>

      {/* Section tabs */}
      <div className="border-b border-gray-700">
        <div className="flex gap-0">
          {sectionTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveSection(tab.id)}
              className={`px-5 py-3 text-sm font-medium border-b-2 transition-all duration-200 inline-flex items-center gap-1 ${
                activeSection === tab.id
                  ? 'border-os-500 text-os-400'
                  : 'border-transparent text-gray-500 hover:text-gray-300 hover:border-gray-600'
              }`}
            >
              {tab.label}
              <HelpTip content={tab.tooltip} position="bottom" size="xs" />
            </button>
          ))}
        </div>
      </div>

      {/* Section content */}
      {activeSection === 'tables' && (
        <div className="space-y-4">
          {/* AI settings assignment */}
          <AiSettingsAssignment
            selected={profile.aiSettingNames ?? []}
            onChange={handleAiSettingNamesChange}
            onManageSettings={onNavigateToAiSettings}
          />

          {/* Configurations selection */}
          <div className="card-primary p-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-gray-300">Assigned Data Profiles</h4>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => onNavigateToConfig('')}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-os-700/30 hover:bg-os-700/50 text-os-400 text-xs font-medium transition-all duration-200"
                >
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                  New
                </button>
                <HelpTip
                  content="Create a new data profile and assign it to this server"
                  position="left"
                  size="xs"
                />
              </div>
            </div>
            {configurations.length === 0 ? (
              <p className="text-sm text-gray-500">
                No data profiles available. Click &quot;+ New&quot; to create one.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {configurations.map((cfg) => {
                  const isSelected = profileConfigurations.includes(cfg.name);
                  const tableCount = getConfigurationTableNames(cfg).length;
                  const sourceCount = (cfg.sources ?? []).length;
                  return (
                    <div key={cfg.name} className="flex items-center gap-1">
                      <button
                        onClick={() => handleToggleConfiguration(cfg.name)}
                        className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-all duration-200 ${
                          isSelected
                            ? 'border-os-600/60 bg-os-700/20 text-os-400'
                            : 'border-gray-700 bg-gray-900/40 text-gray-500 hover:border-gray-600 hover:text-gray-300'
                        }`}
                      >
                        <div
                          className={`w-2 h-2 rounded-full ${
                            isSelected ? 'bg-os-400' : 'bg-gray-600'
                          }`}
                        />
                        {cfg.label}
                        <span className="text-xs text-gray-500">
                          ({tableCount} table{tableCount !== 1 ? 's' : ''}, {sourceCount} base
                          {sourceCount !== 1 ? 's' : ''})
                        </span>
                      </button>
                      <button
                        onClick={() => onNavigateToConfig(cfg.name)}
                        title="Modifier ce profil de données"
                        className="p-1 text-gray-500 hover:text-os-400 transition-all duration-200"
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
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Effective tables summary (from merged configurations) */}
          {profileConfigurations.length > 0 && (
            <div className="rounded-lg border border-blue-600/30 bg-blue-700/10 p-5">
              <h4 className="text-sm font-semibold text-blue-400 mb-3">
                Effective Tables (merged from {profileConfigurations.length} configuration
                {profileConfigurations.length !== 1 ? 's' : ''})
              </h4>
              {(() => {
                const mergedTables: Record<string, string[]> = {};
                for (const cfgName of profileConfigurations) {
                  const cfg = configurations.find((c) => c.name === cfgName);
                  if (!cfg) continue;
                  for (const [table, cols] of Object.entries(getConfigurationSelectedTables(cfg))) {
                    if (!mergedTables[table]) {
                      mergedTables[table] = [...cols];
                    } else {
                      const existing = new Set(mergedTables[table]);
                      for (const col of cols) existing.add(col);
                      mergedTables[table] = [...existing];
                    }
                  }
                }
                const tableNames = Object.keys(mergedTables);
                if (tableNames.length === 0) {
                  return (
                    <p className="text-sm text-gray-500">No tables selected in configurations.</p>
                  );
                }
                return (
                  <div className="flex flex-wrap gap-2">
                    {tableNames.map((tableName) => (
                      <span
                        key={tableName}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-blue-600/30 bg-blue-700/10 text-sm text-blue-300"
                      >
                        {tableName}
                        <span className="text-xs text-gray-500">
                          {mergedTables[tableName].length} cols
                        </span>
                      </span>
                    ))}
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {activeSection === 'users' && (
        <div className="card-primary p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-3">
            Users with access to {profile.name}
          </h3>
          <McpUsersLazy profileName={profile.name} onNavigateToUser={onNavigateToUser} />
        </div>
      )}

      {activeSection === 'scoping' && (
        <Suspense fallback={<div className="p-6 text-sm text-gray-500 italic">Chargement…</div>}>
          <DataScopingSection
            profile={profile}
            configurations={configurations}
            onScopeRulesChange={handleScopeRulesChange}
          />
        </Suspense>
      )}

      {activeSection === 'tokens' && (
        <div className="card-primary p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-3">Tokens</h3>
          <TokenManagerLazy profile={profile} port={serveStatus.port} />
        </div>
      )}

      {activeSection === 'audit' && (
        <div className="card-primary p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-3">Audit Log</h3>
          <AuditLogViewerLazy profile={profile} />
        </div>
      )}
    </div>
  );
}

// Thin wrappers that lazy-import the actual components to avoid circular deps at module level

function TokenManagerLazy({ profile, port }: { profile: Profile; port: number }) {
  return <TokenManager profiles={[profile]} port={port} />;
}

function McpUsersLazy({
  profileName,
  onNavigateToUser,
}: {
  profileName: string;
  onNavigateToUser?: (userId: string) => void;
}) {
  return <McpUsers profileName={profileName} onNavigateToUser={onNavigateToUser} />;
}

function AuditLogViewerLazy({ profile }: { profile: Profile }) {
  return <AuditLogViewer profiles={[profile]} />;
}
