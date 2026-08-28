// MCP server detail page (Phase 3 #14). The page wrapper is the
// `view.page === 'mcp-detail'` branch of App.tsx; the McpDetailView component,
// its lazy EE sections and the Token/Users/Audit lazy wrappers below were all
// moved verbatim from App.tsx.

import { useState, useMemo, useEffect, lazy, Suspense } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslations } from 'use-intl/react';
import { apiFetch, getCurrentTenant } from '../lib/api.js';
import { buildMcpPath } from '../lib/mcp-url.js';
import { Breadcrumb } from '../components/ui/index.js';
import HelpTip from '../components/HelpTip.js';
import AiSettingsAssignment from '../components/AiSettingsAssignment.js';
import ConnectClaudeDesktop from '../components/ConnectClaudeDesktop.js';
import ExposeTunnel from '../components/ExposeTunnel.js';
import TokenManager from '../components/TokenManager.js';
import AuditLogViewer from '../components/AuditLogViewer.js';
import McpUsers from '../components/McpUsers.js';
import { persistProfiles, buildProfilesData } from '../lib/profiles.js';
import {
  getConfigurationTableNames,
  getConfigurationSelectedTables,
  getConfigurationTableOptions,
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
  TableToolOptions,
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
        const t = useTranslations('mcpDetail.scoping');
        return (
          <div className="p-6 text-sm text-gray-400 text-center">{t('unavailable')}</div>
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
  const t = useTranslations('mcpDetail');
  const tCommon = useTranslations('common');
  return (
    <div className="max-w-7xl mx-auto">
      <Breadcrumb
        className="mb-4"
        items={[
          { label: tCommon('dashboard'), onClick: () => setView({ page: 'dashboard' }) },
          { label: t('breadcrumb.mcpServers'), onClick: () => setView({ page: 'mcp-list' }) },
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
              label: t('newConfigurationLabel'),
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
  const t = useTranslations('mcpDetail');
  const tCommon = useTranslations('common');
  const [togglingProfile, setTogglingProfile] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'endpoint' | 'chat' | null>(null);
  const [activeSection, setActiveSection] = useState<
    'tables' | 'connect' | 'config' | 'tokens' | 'audit' | 'users' | 'scoping'
  >(
    (initialActiveSection as
      | 'tables'
      | 'connect'
      | 'config'
      | 'tokens'
      | 'audit'
      | 'users'
      | 'scoping') ?? 'tables',
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

  // Count effective tables from configurations — computed unconditionally
  // (with the profile-not-found early return happening *after* this hook) so
  // the hook always runs in the same order across renders, per the Rules of
  // Hooks.
  const profileConfigurations = profile?.configurations ?? [];
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

  if (!profile) {
    return (
      <div className="text-center text-gray-500 py-12">
        <p>{t('notFound.message', { name: profileName })}</p>
        <button
          onClick={onNavigateBack}
          className="mt-4 px-4 py-2 rounded-lg bg-os-700 hover:bg-os-600 text-white text-sm font-medium transition-all duration-200"
        >
          {t('notFound.backButton')}
        </button>
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
        setError(data.message || t('errors.startFailed', { name: profile.name }));
      }
    } catch {
      setError(t('errors.startNetworkError', { name: profile.name }));
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
        setError(data.message || t('errors.stopFailed', { name: profile.name }));
      }
    } catch {
      setError(t('errors.stopNetworkError', { name: profile.name }));
    } finally {
      setTogglingProfile(false);
    }
  };

  const handleCopyEndpoint = () => {
    navigator.clipboard.writeText(endpoint).then(() => {
      setCopied('endpoint');
      setTimeout(() => setCopied(null), 2000);
    });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await apiFetch('/api/serve/refresh', { method: 'POST' });
      const data = await res.json();
      if (data.success === false) {
        setError(data.message || t('errors.refreshFailed'));
      }
    } catch {
      setError(t('errors.refreshNetworkError'));
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
      setResponseModeError(t('responseMode.error'));
    } finally {
      setTogglingResponseMode(false);
    }
  };

  // Lazy-import detail sub-components
  const sectionTabs: { id: typeof activeSection; label: string; tooltip: string }[] = [
    {
      id: 'tables',
      label: t('tabs.tables.label'),
      tooltip: t('tabs.tables.tooltip'),
    },
    {
      id: 'connect',
      label: t('tabs.connect.label'),
      tooltip: t('tabs.connect.tooltip'),
    },
    {
      id: 'users',
      label: t('tabs.users.label'),
      tooltip: t('tabs.users.tooltip'),
    },
    {
      id: 'tokens',
      label: t('tabs.tokens.label'),
      tooltip: t('tabs.tokens.tooltip'),
    },
    {
      id: 'scoping',
      label: t('tabs.scoping.label'),
      tooltip: t('tabs.scoping.tooltip'),
    },
    {
      id: 'audit',
      label: t('tabs.audit.label'),
      tooltip: t('tabs.audit.tooltip'),
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
              title={isActive ? t('header.statusRunningTooltip') : t('header.statusStoppedTooltip')}
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
                          persistProfiles(buildProfilesData(updated)).catch(() => {
                            setError(t('errors.saveLabelFailed'));
                          });
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
                          persistProfiles(buildProfilesData(updated)).catch(() => {
                            setError(t('errors.saveLabelFailed'));
                          });
                          return updated;
                        });
                      }
                      setEditingLabel(false);
                    }}
                    className="text-xs text-os-400 hover:text-os-300"
                  >
                    {tCommon('save')}
                  </button>
                  <button
                    onClick={() => setEditingLabel(false)}
                    className="text-xs text-gray-500 hover:text-gray-300"
                  >
                    {tCommon('cancel')}
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
                  <HelpTip content={t('header.renameTooltip')} position="right" size="xs" />
                </h2>
              )}
              <p className="text-sm text-gray-500 mt-1">
                {isActive ? t('header.statusActive') : t('header.statusInactive')} &middot;{' '}
                {t('header.dataConfigCount', { count: profileConfigurations.length })} &middot;{' '}
                {t('header.tableCount', { count: effectiveTableCount })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isActive && (
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                title={t('header.refreshTooltip')}
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
              title={isActive ? t('header.stopTooltip') : t('header.startTooltip')}
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
                t('header.stop')
              ) : (
                t('header.start')
              )}
            </button>
            {confirmDelete ? (
              <div className="flex items-center gap-1">
                <span className="text-xs text-gray-400 mr-1">{t('header.deleteConfirm')}</span>
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
                  {t('header.yes')}
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="px-2 py-1.5 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition-all duration-200"
                >
                  {t('header.no')}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                title={t('header.deleteTooltip')}
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
              {t('endpoint.label')}
              <HelpTip
                content={t('endpoint.tooltip')}
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
                {copied === 'endpoint' ? t('copy.copied') : t('copy.copy')}
              </span>
            </button>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1 flex items-center gap-1">
              {t('chat.label')}
              <HelpTip
                content={t('chat.tooltip')}
                position="bottom"
                size="xs"
              />
            </p>
            <button
              onClick={() => {
                const chatUrl = `${window.location.origin}/chat/${encodeURIComponent(profile.name)}`;
                navigator.clipboard.writeText(chatUrl).then(() => {
                  setCopied('chat');
                  setTimeout(() => setCopied(null), 2000);
                });
              }}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-900/60 border border-gray-700 hover:border-os-600 transition-all duration-200 group"
            >
              <code className="text-sm text-os-400 font-mono">
                {window.location.origin}/chat/{encodeURIComponent(profile.name)}
              </code>
              <span className="text-xs text-gray-500 group-hover:text-os-400 transition-all duration-200">
                {copied === 'chat' ? t('copy.copied') : t('copy.copy')}
              </span>
            </button>
          </div>
        </div>

        {/* Response mode */}
        <div className="mt-4 flex items-center justify-between pt-3 border-t border-gray-700/50">
          <div>
            <span className="text-xs text-gray-400">{t('responseMode.label')}</span>
            {responseModeError && (
              <p className="text-xs text-red-400 mt-0.5">{responseModeError}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`text-xs font-medium ${isRawMode ? 'text-orange-400' : 'text-green-400'}`}
            >
              {togglingResponseMode
                ? t('responseMode.toggling')
                : isRawMode
                  ? t('responseMode.technical')
                  : t('responseMode.natural')}
            </span>
            <button
              role="switch"
              aria-checked={isRawMode}
              aria-label={t('responseMode.toggleAriaLabel')}
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
              content={t('responseMode.tooltip')}
              position="left"
              size="xs"
            />
          </div>
        </div>

        {/* Chat authentication mode selector */}
        <div className="mt-4">
          <label className="block text-xs text-gray-500 mb-2">{t('authMode.label')}</label>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {(
              [
                {
                  value: 'token',
                  label: t('authMode.options.token.label'),
                  desc: t('authMode.options.token.desc'),
                  tooltip: t('authMode.options.token.tooltip'),
                },
                {
                  value: 'calame',
                  label: t('authMode.options.calame.label'),
                  desc: t('authMode.options.calame.desc'),
                  tooltip: t('authMode.options.calame.tooltip'),
                },
                {
                  value: 'sso',
                  label: t('authMode.options.sso.label'),
                  desc: t('authMode.options.sso.desc'),
                  tooltip: t('authMode.options.sso.tooltip'),
                },
                {
                  value: 'oauth',
                  label: t('authMode.options.oauth.label'),
                  desc: t('authMode.options.oauth.desc'),
                  tooltip: t('authMode.options.oauth.tooltip'),
                },
                {
                  value: 'external',
                  label: t('authMode.options.external.label'),
                  desc: t('authMode.options.external.desc'),
                  tooltip: t('authMode.options.external.tooltip'),
                },
                {
                  value: 'open',
                  label: t('authMode.options.open.label'),
                  desc: t('authMode.options.open.desc'),
                  tooltip: t('authMode.options.open.tooltip'),
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
              {t('authMode.openWarning')}
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
                  {t('external.validationUrlLabel')} <span className="text-red-400">*</span>
                </label>
                <input
                  id={`external-validation-url-${profile.name}`}
                  type="text"
                  value={profile.externalAuthConfig?.validationUrl ?? ''}
                  onChange={(e) =>
                    handleExternalAuthConfigChange({ validationUrl: e.target.value })
                  }
                  placeholder={t('external.validationUrlPlaceholder')}
                  className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
                />
                <p className="text-xs text-gray-600 mt-1">
                  {t('external.validationUrlHelp')}
                </p>
              </div>

              <div>
                <label
                  className="block text-xs text-gray-400 mb-1"
                  htmlFor={`external-header-name-${profile.name}`}
                >
                  {t('external.headerNameLabel')}
                </label>
                <input
                  id={`external-header-name-${profile.name}`}
                  type="text"
                  value={profile.externalAuthConfig?.headerName ?? ''}
                  onChange={(e) => handleExternalAuthConfigChange({ headerName: e.target.value })}
                  placeholder={t('external.headerNamePlaceholder')}
                  className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
                />
              </div>

              <div>
                <label
                  className="block text-xs text-gray-400 mb-1"
                  htmlFor={`external-header-template-${profile.name}`}
                >
                  {t('external.headerTemplateLabel')}
                </label>
                <input
                  id={`external-header-template-${profile.name}`}
                  type="text"
                  value={profile.externalAuthConfig?.headerTemplate ?? ''}
                  onChange={(e) =>
                    handleExternalAuthConfigChange({ headerTemplate: e.target.value })
                  }
                  placeholder={t('external.headerTemplatePlaceholder')}
                  className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
                />
                <p className="text-xs text-gray-600 mt-1">
                  {t('external.headerTemplateHelp')}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label
                    className="block text-xs text-gray-400 mb-1"
                    htmlFor={`external-email-field-${profile.name}`}
                  >
                    {t('external.emailFieldLabel')}{' '}
                    <span className="text-gray-600">{t('external.optionalSuffix')}</span>
                  </label>
                  <input
                    id={`external-email-field-${profile.name}`}
                    type="text"
                    value={profile.externalAuthConfig?.emailField ?? ''}
                    onChange={(e) => handleExternalAuthConfigChange({ emailField: e.target.value })}
                    placeholder={t('external.emailFieldPlaceholder')}
                    className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
                  />
                </div>
                <div>
                  <label
                    className="block text-xs text-gray-400 mb-1"
                    htmlFor={`external-name-field-${profile.name}`}
                  >
                    {t('external.nameFieldLabel')}{' '}
                    <span className="text-gray-600">{t('external.optionalSuffix')}</span>
                  </label>
                  <input
                    id={`external-name-field-${profile.name}`}
                    type="text"
                    value={profile.externalAuthConfig?.nameField ?? ''}
                    onChange={(e) => handleExternalAuthConfigChange({ nameField: e.target.value })}
                    placeholder={t('external.nameFieldPlaceholder')}
                    className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
                  />
                </div>
              </div>
              <p className="text-xs text-gray-600">
                {t('external.dotNotationHelp')}
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
                <span className="text-sm text-gray-300">{t('external.autoCreateUsersLabel')}</span>
              </label>
              <p className="text-xs text-gray-600">
                {profile.externalAuthConfig?.autoCreateUsers !== false
                  ? t('external.autoCreateEnabled')
                  : t('external.autoCreateDisabled')}
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
                  {t('oauth.providerLabel')}
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
                  <option value="github">{t('oauth.providers.github')}</option>
                  <option value="google">{t('oauth.providers.google')}</option>
                  <option value="gitlab">{t('oauth.providers.gitlab')}</option>
                  <option value="custom">{t('oauth.providers.custom')}</option>
                </select>
              </div>
              <div>
                <label
                  className="block text-xs text-gray-400 mb-1"
                  htmlFor={`oauth-client-id-${profile.name}`}
                >
                  {t('oauth.clientIdLabel')} <span className="text-red-400">*</span>
                </label>
                <input
                  id={`oauth-client-id-${profile.name}`}
                  type="text"
                  value={profile.oauthConfig?.clientId ?? ''}
                  onChange={(e) => handleOAuthConfigChange({ clientId: e.target.value })}
                  placeholder={t('oauth.clientIdPlaceholder')}
                  className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
                />
              </div>
              <div>
                <label
                  className="block text-xs text-gray-400 mb-1"
                  htmlFor={`oauth-client-secret-${profile.name}`}
                >
                  {t('oauth.clientSecretLabel')} <span className="text-red-400">*</span>
                </label>
                <input
                  id={`oauth-client-secret-${profile.name}`}
                  type="password"
                  value={profile.oauthConfig?.clientSecret ?? ''}
                  onChange={(e) => handleOAuthConfigChange({ clientSecret: e.target.value })}
                  placeholder={t('oauth.clientSecretPlaceholder')}
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
                      {t('oauth.authUrlLabel')} <span className="text-red-400">*</span>
                    </label>
                    <input
                      id={`oauth-auth-url-${profile.name}`}
                      type="text"
                      value={profile.oauthConfig?.authorizationUrl ?? ''}
                      onChange={(e) =>
                        handleOAuthConfigChange({ authorizationUrl: e.target.value })
                      }
                      placeholder={t('oauth.urlPlaceholder')}
                      className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
                    />
                  </div>
                  <div>
                    <label
                      className="block text-xs text-gray-400 mb-1"
                      htmlFor={`oauth-token-url-${profile.name}`}
                    >
                      {t('oauth.tokenUrlLabel')} <span className="text-red-400">*</span>
                    </label>
                    <input
                      id={`oauth-token-url-${profile.name}`}
                      type="text"
                      value={profile.oauthConfig?.tokenUrl ?? ''}
                      onChange={(e) => handleOAuthConfigChange({ tokenUrl: e.target.value })}
                      placeholder={t('oauth.urlPlaceholder')}
                      className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
                    />
                  </div>
                  <div>
                    <label
                      className="block text-xs text-gray-400 mb-1"
                      htmlFor={`oauth-userinfo-url-${profile.name}`}
                    >
                      {t('oauth.userinfoUrlLabel')} <span className="text-red-400">*</span>
                    </label>
                    <input
                      id={`oauth-userinfo-url-${profile.name}`}
                      type="text"
                      value={profile.oauthConfig?.userinfoUrl ?? ''}
                      onChange={(e) => handleOAuthConfigChange({ userinfoUrl: e.target.value })}
                      placeholder={t('oauth.urlPlaceholder')}
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
          {/* Configurations selection */}
          <div className="card-primary p-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-gray-300">{t('tables.assignedHeading')}</h4>
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
                  {t('tables.newButton')}
                </button>
                <HelpTip
                  content={t('tables.newTooltip')}
                  position="left"
                  size="xs"
                />
              </div>
            </div>
            {configurations.length === 0 ? (
              <p className="text-sm text-gray-500">
                {t('tables.emptyState')}
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
                          {t('tables.configSummary', { tableCount, sourceCount })}
                        </span>
                      </button>
                      <button
                        onClick={() => onNavigateToConfig(cfg.name)}
                        title={t('tables.editTooltip')}
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
                {t('tables.effectiveHeading', { count: profileConfigurations.length })}
              </h4>
              {(() => {
                const mergedTables: Record<string, string[]> = {};
                const mergedToolOptions: Record<string, TableToolOptions> = {};
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
                  // Last writer wins per table when multiple configurations set options —
                  // mirrors getConfigurationTableOptions's own merge semantics.
                  for (const [table, opts] of Object.entries(getConfigurationTableOptions(cfg))) {
                    mergedToolOptions[table] = opts;
                  }
                }
                const tableNames = Object.keys(mergedTables);
                if (tableNames.length === 0) {
                  return (
                    <p className="text-sm text-gray-500">{t('tables.noTablesSelected')}</p>
                  );
                }
                return (
                  <div className="flex flex-wrap gap-2">
                    {tableNames.map((tableName) => {
                      const enabledTools = mergedToolOptions[tableName]?.enabledTools ?? [
                        'describe',
                        'aggregate',
                        'query',
                      ];
                      return (
                        <span
                          key={tableName}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-blue-600/30 bg-blue-700/10 text-sm text-blue-300"
                        >
                          {tableName}
                          <span className="text-xs text-gray-500">
                            {t('tables.colsLabel', { count: mergedTables[tableName].length })}
                          </span>
                          <span className="flex items-center gap-1">
                            {enabledTools.map((tool) => (
                              <span
                                key={tool}
                                title={t('tables.toolTitle', { tool })}
                                className={`text-[9px] px-1 py-0.5 rounded font-bold ${
                                  tool === 'write'
                                    ? 'bg-amber-500/20 text-amber-400'
                                    : 'bg-gray-700/60 text-gray-400'
                                }`}
                              >
                                {tool}
                              </span>
                            ))}
                          </span>
                        </span>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {activeSection === 'connect' && (
        <div className="space-y-4">
          {/* Connect to Claude Desktop (or grab a manual snippet for other clients) */}
          <ConnectClaudeDesktop profileName={profile.name} />

          {/* Expose this server to cloud AIs (Copilot Studio, ChatGPT connectors) via a tunnel */}
          <ExposeTunnel profileName={profile.name} />

          {/* AI settings assignment */}
          <AiSettingsAssignment
            selected={profile.aiSettingNames ?? []}
            onChange={handleAiSettingNamesChange}
            onManageSettings={onNavigateToAiSettings}
          />
        </div>
      )}

      {activeSection === 'users' && (
        <div className="card-primary p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-3">
            {t('users.heading', { name: profile.name })}
          </h3>
          <McpUsersLazy profileName={profile.name} onNavigateToUser={onNavigateToUser} />
        </div>
      )}

      {activeSection === 'scoping' && (
        <Suspense fallback={<div className="p-6 text-sm text-gray-500 italic">{tCommon('loading')}</div>}>
          <DataScopingSection
            profile={profile}
            configurations={configurations}
            onScopeRulesChange={handleScopeRulesChange}
          />
        </Suspense>
      )}

      {activeSection === 'tokens' && (
        <div className="card-primary p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-3">{t('tabs.tokens.label')}</h3>
          <TokenManagerLazy profile={profile} port={serveStatus.port} />
        </div>
      )}

      {activeSection === 'audit' && (
        <div className="card-primary p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-3">{t('tabs.audit.label')}</h3>
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
