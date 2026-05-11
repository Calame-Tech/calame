import { useState, useCallback, useMemo, useEffect, lazy, Suspense } from 'react';
import { apiFetch, getCurrentTenant } from './lib/api.js';
import { buildMcpPath } from './lib/mcp-url.js';
import { Button, Card, PageHeader, Eyebrow, KpiCard, EmptyState, Breadcrumb } from './components/ui/index.js';
import Sidebar from './components/Sidebar.js';
import HelpTip from './components/HelpTip.js';
import SchemaExplorer from './components/SchemaExplorer.js';
import ConfigPanel from './components/ConfigPanel.js';
import ServePanel from './components/ServePanel.js';
import LoginPage from './components/LoginPage.js';
import SetupPage from './components/SetupPage.js';
import UserDashboard from './components/UserDashboard.js';
import UserManagement from './components/UserManagement.js';
import WelcomePage from './components/WelcomePage.js';
import AiSettings from './components/AiSettings.js';
import AiSettingsAssignment from './components/AiSettingsAssignment.js';
import SmtpSettings from './components/SmtpSettings.js';
import { OidcSettings, ProfileSsoNotice, DataScopingSection } from '@calame-ee/sso/web';
import ProfilePreview from './components/ProfilePreview.js';
import MetricsDashboard from './components/MetricsDashboard.js';
import ChatEntryPage from './components/ChatEntryPage.js';
import SourcesPage from './components/SourcesPage.js';
import TenantManagement from './components/TenantManagement.js';
import {
  pickMaskingTargetSourceId,
  getProfileSelectedTables,
  getProfileTableOptions,
  getProfileColumnMasking,
} from './lib/profile-accessors.js';
import {
  getConfigurationTableNames,
  getConfigurationSelectedTables,
  getConfigurationTableOptions,
  getConfigurationColumnMasking,
} from './lib/configuration-accessors.js';
import type {
  DatabaseSchema,
  Config,
  Configuration,
  Profile,
  PiiDetection,
  ColumnMasking,
  GlobalMaskingRule,
  NamedConnection,
  ServeStatus,
  AuditLogEntry,
  AuthMode,
  OAuthConfig,
  ExternalAuthConfig,
  DataScopeRule,
  ScopeSelection,
} from './types/schema.js';

/**
 * Lazy-loaded KnowledgeBaseManager from the ee package. The import is deferred
 * at runtime so the main bundle stays lean and the RAG chunk is only loaded when
 * the user explicitly navigates to the "Bases de connaissance" view.
 */
const KnowledgeBaseManager = lazy(() =>
  import('@calame-ee/rag-core/web')
    .then((m) => ({ default: m.KnowledgeBaseManager }))
    .catch(() => ({
      default: function RagUnavailable() {
        return (
          <div className="p-6 text-sm text-gray-400 text-center">
            Les fonctionnalités RAG ne sont pas disponibles sur cette instance.
          </div>
        );
      },
    })),
);

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

/** View-based navigation replacing the old step wizard */
type View =
  | { page: 'dashboard' }
  /**
   * Unified sources page — databases and knowledge bases in one place.
   * `tab` defaults to 'databases' when omitted.
   */
  | { page: 'sources'; tab?: 'databases' | 'knowledge'; backTo?: View; editConnectionName?: string }
  /**
   * Legacy alias for `{ page: 'sources', tab: 'databases' }`.
   * Kept for backwards-compat (existing navigation calls, deep links).
   */
  | { page: 'connections'; backTo?: View; editConnectionName?: string }
  | { page: 'configurations' }
  | { page: 'config-detail'; configName: string; backTo?: View }
  | { page: 'mcp-list' }
  | { page: 'mcp-detail'; profileName: string; activeSection?: string }
  | { page: 'users'; selectedUserId?: string; backTo?: View }
  | { page: 'settings'; backTo?: View; initialTab?: 'ai' | 'email' | 'sso' }
  | { page: 'metrics' }
  /**
   * Tenant administration page — lists every distinct tenant id discovered
   * across tenanted tables and lets the admin hard-delete one.
   */
  | { page: 'tenants' }
  /**
   * Legacy alias for `{ page: 'sources', tab: 'knowledge' }`.
   * Kept for backwards-compat.
   */
  | { page: 'knowledge' };

function createDefaultProfile(): Profile {
  return { name: 'default', label: 'Default' };
}

/** Convert Set-based selection to array-based for Profile storage */
function setsToArrays(sel: Record<string, Set<string>>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(sel)) {
    result[k] = Array.from(v);
  }
  return result;
}

/** Convert array-based selection to Set-based for UI usage */
function arraysToSets(sel: Record<string, string[]>): Record<string, Set<string>> {
  const result: Record<string, Set<string>> = {};
  for (const [k, v] of Object.entries(sel)) {
    result[k] = new Set(v);
  }
  return result;
}

/**
 * POST a serialized profiles map to the backend. Returns the raw fetch Response
 * so each caller can choose its own error strategy (await + throw, fire-and-forget,
 * chained .then()).
 */
function persistProfiles(profiles: Record<string, Record<string, unknown>>): Promise<Response> {
  return apiFetch('/api/profiles/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profiles }),
  });
}

/**
 * Serialize a Profile array into the shape expected by persistProfiles / /api/profiles/save.
 *
 * Phase 5: drops the legacy `selectedTables` / `tableOptions` / `columnMasking` /
 * `connections` projections — the backend `upgradeProfileShape` migrator runs at
 * the save boundary and folds anything legacy back into `sources` / `scopes` when
 * needed. New writes therefore carry only the unified shape.
 */
function buildProfilesData(profiles: Profile[]): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const p of profiles) {
    result[p.name] = {
      label: p.label,
      configurations: p.configurations,
      authMode: p.authMode,
      oauthConfig: p.oauthConfig,
      externalAuthConfig: p.externalAuthConfig,
      responseMode: p.responseMode,
      dataScopeRules: p.dataScopeRules,
      sharedTables: p.sharedTables,
      aiSettingNames: p.aiSettingNames,
      sources: p.sources,
      scopes: p.scopes,
    };
  }
  return result;
}

/**
 * Navigate to another URL via a useEffect so the redirect is a post-mount side
 * effect rather than an impure render. Returns null so the current route renders
 * nothing while the browser transitions away.
 */
function Redirect({ to }: { to: string }): null {
  useEffect(() => {
    window.location.href = to;
  }, [to]);
  return null;
}

export default function App() {
  // --- Auth state ---
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  // Whether the RAG runtime is available on this instance (from /health).
  const [ragEnabled, setRagEnabled] = useState(false);
  // Human-readable reason when RAG is unavailable (null when ragEnabled is true).
  const [ragDisabledReason, setRagDisabledReason] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);

  // Check if we're on a special page (no admin auth needed)
  const welcomeMatch = window.location.pathname.match(/^\/welcome\/([a-f0-9]+)$/);
  const chatMatch = window.location.pathname.match(/^\/chat\/(.+)/);
  const isAccountPage = window.location.pathname === '/account';
  const isUserLoginPage = window.location.pathname === '/login';

  // User auth state (for /account and /login pages)
  const [userAuthenticated, setUserAuthenticated] = useState(false);

  // Logged-in admin user info (email + role) for the Sidebar footer
  const [currentUser, setCurrentUser] = useState<{ email: string; role: string } | null>(null);

  // Check auth status on mount
  useEffect(() => {
    if (welcomeMatch || chatMatch) {
      setAuthChecked(true);
      return;
    }
    (async () => {
      try {
        // Always check both admin and user auth status and health (for ragEnabled).
        const [adminRes, userRes, healthRes] = await Promise.all([
          apiFetch('/api/auth/status', { credentials: 'include' }),
          apiFetch('/api/auth/user-status', { credentials: 'include' }),
          apiFetch('/health').catch(() => null),
        ]);

        if (healthRes?.ok) {
          try {
            const healthData = (await healthRes.json()) as {
              ragEnabled?: boolean;
              ragDisabledReason?: string | null;
            };
            setRagEnabled(healthData.ragEnabled === true);
            setRagDisabledReason(healthData.ragDisabledReason ?? null);
          } catch {
            // Ignore parse errors — ragEnabled stays false.
          }
        }
        const adminData = await adminRes.json();
        const userData = await userRes.json();

        if (adminData.success) {
          setAuthenticated(adminData.authenticated);
          setAuthRequired(adminData.authRequired);
          setNeedsSetup(!!adminData.needsSetup);
        }
        if (userData.success) {
          setUserAuthenticated(userData.authenticated);
          // Populate the Sidebar user info when the admin is authenticated
          if (userData.authenticated && userData.user) {
            const u = userData.user as { email?: string; role?: string };
            setCurrentUser({
              email: u.email ?? '',
              role: u.role ?? 'admin',
            });
          }
        }
      } catch {
        // Network error — keep defaults (not authenticated)
      } finally {
        setAuthChecked(true);
      }
    })();
  }, []);

  // View-based navigation
  const [view, setView] = useState<View>({ page: 'dashboard' });

  // Multi-connection state
  const [connections, setConnections] = useState<NamedConnection[]>([]);
  const [connectionSchemas, setConnectionSchemas] = useState<Record<string, DatabaseSchema>>({});

  const [config] = useState<Config>({
    serverName: 'my-mcp-server',
    transport: 'streamable-http',
    clientTarget: 'claude-desktop',
    outputDir: './generated-server',
  });

  // Configurations state (reusable across profiles)
  const [configurations, setConfigurations] = useState<Configuration[]>([]);

  // Profiles state
  const [profiles, setProfiles] = useState<Profile[]>([createDefaultProfile()]);
  const [activeProfileIndex, setActiveProfileIndex] = useState(0);

  // Profile preview modal state
  const [previewProfile, setPreviewProfile] = useState<string | null>(null);

  // Serve status for dashboard counts
  const [serveStatus, setServeStatus] = useState<ServeStatus>({
    active: false,
    port: 0,
    profiles: [],
    totalRequests: 0,
  });

  const isUserPage = isUserLoginPage || isAccountPage || !!welcomeMatch || !!chatMatch;

  // Auto-load connections then profiles once authenticated
  useEffect(() => {
    if (!authenticated || isUserPage) return;
    (async () => {
      // 1. Fetch connections and schemas
      try {
        const res = await apiFetch('/api/connections', { credentials: 'include' });
        const data = await res.json();
        if (data.success && data.connections) {
          const loadedConns: NamedConnection[] = Object.entries(data.connections).map(
            ([name, info]: [string, unknown]) => {
              const connInfo = info as Record<string, unknown>;
              return {
                name,
                label: (connInfo.label as string) ?? name,
                databaseType:
                  (connInfo.databaseType as NamedConnection['databaseType']) ?? 'postgresql',
                connectionString: '', // Not returned by API for security
              };
            },
          );
          setConnections(loadedConns);
          // Fetch schemas for connected ones
          for (const [name, info] of Object.entries(data.connections) as [
            string,
            Record<string, unknown>,
          ][]) {
            if (info.connected && (info.tableCount as number) > 0) {
              const schemaRes = await apiFetch(`/api/schema/${name}`, { credentials: 'include' });
              const schemaData = await schemaRes.json();
              const schema = schemaData.schema ?? schemaData;
              if (schema.tables) {
                setConnectionSchemas((prev) => ({ ...prev, [name]: schema as DatabaseSchema }));
              }
            }
          }
        }
      } catch {
        // No connections yet
      }

      // 2. Fetch configurations
      try {
        const configRes = await apiFetch('/api/configurations', { credentials: 'include' });
        const configData = await configRes.json();
        if (configData.success && configData.configurations) {
          const configs: Configuration[] = Object.entries(
            configData.configurations as Record<string, Omit<Configuration, 'name'>>,
          ).map(([name, c]) => ({ name, ...c }));
          setConfigurations(configs);
        }
      } catch {
        // No configurations yet
      }

      // 3. Fetch profiles
      try {
        const res = await apiFetch('/api/profiles/load', { credentials: 'include' });
        const data = await res.json();
        if (data.found && data.profiles) {
          const loaded: Record<string, Omit<Profile, 'name'>> = data.profiles;
          // Phase 5 — load uses the unified shape only. The backend
          // `upgradeProfileShape` runs at every read boundary and synthesises
          // `sources` / `scopes` for legacy profiles before they reach this
          // code, so the frontend never has to handle the legacy fields.
          const loadedProfiles: Profile[] = Object.entries(loaded).map(([name, p]) => ({
            name,
            label: p.label,
            configurations: p.configurations,
            authMode: p.authMode,
            oauthConfig: p.oauthConfig,
            externalAuthConfig: p.externalAuthConfig,
            responseMode: p.responseMode,
            dataScopeRules: p.dataScopeRules,
            sharedTables: p.sharedTables,
            aiSettingNames: p.aiSettingNames,
            sources: p.sources,
            scopes: p.scopes,
          }));
          if (loadedProfiles.length > 0) {
            setProfiles(loadedProfiles);
            setActiveProfileIndex(0);
          }
        }
      } catch {
        // No profiles file — keep defaults
      }
    })();
  }, [authenticated]);

  // Fetch serve status — shared between the 5s poller and the ServePanel action callback
  const fetchServeStatus = useCallback(async () => {
    try {
      const res = await apiFetch('/api/serve/status', { credentials: 'include' });
      const data = await res.json();
      if (data.success !== false) {
        setServeStatus({
          active: data.serving ?? data.active ?? false,
          port: data.port ?? 0,
          profiles: data.profiles ?? [],
          profileStatuses: data.profileStatuses,
          startedAt: data.startedAt,
          totalRequests: data.totalRequests ?? 0,
        });
      }
    } catch {
      // Status endpoint may not exist yet
    }
  }, []);

  // Poll serve status for dashboard counts (5s interval, single poller for the whole app)
  useEffect(() => {
    if (!authenticated || isUserPage) return;
    fetchServeStatus();
    const interval = setInterval(fetchServeStatus, 5000);
    return () => clearInterval(interval);
  }, [authenticated, fetchServeStatus]);

  // Recent activity for dashboard
  const [recentActivity, setRecentActivity] = useState<AuditLogEntry[]>([]);

  // Fetch recent audit entries once authenticated
  useEffect(() => {
    if (!authenticated || isUserPage) return;
    const fetchRecent = async () => {
      try {
        const res = await apiFetch('/api/audit?limit=10&offset=0', { credentials: 'include' });
        const data = await res.json();
        if (data.success !== false && data.entries) {
          setRecentActivity(data.entries);
        }
      } catch {
        // Audit endpoint may not be available
      }
    };
    fetchRecent();
    const interval = setInterval(fetchRecent, 15_000);
    return () => clearInterval(interval);
  }, [authenticated]);

  // PII & Masking state
  const [piiDetections, setPiiDetections] = useState<Record<
    string,
    Record<string, PiiDetection>
  > | null>(null);
  const [scanning, setScanning] = useState(false);
  const [globalMaskingRules, setGlobalMaskingRules] = useState<GlobalMaskingRule[]>([]);

  const safeActiveIndex = Math.max(0, Math.min(activeProfileIndex, profiles.length - 1));
  const activeProfile = profiles[safeActiveIndex] ?? createDefaultProfile();

  // Derive selectedTables (Set-based) from active profile's relational scopes
  const selectedTables = useMemo(
    () => arraysToSets(getProfileSelectedTables(activeProfile)),
    [activeProfile],
  );

  // Derive config with active profile's tableOptions
  const configWithProfileOptions = useMemo(
    () => ({ ...config, tableOptions: getProfileTableOptions(activeProfile) }),
    [config, activeProfile],
  );

  const handlePiiOverride = useCallback(
    (tableName: string, columnName: string, detection: PiiDetection | null) => {
      setPiiDetections((prev) => {
        const updated = { ...(prev ?? {}) };
        if (detection === null) {
          // Remove the detection
          if (updated[tableName]) {
            const tableDets = { ...updated[tableName] };
            delete tableDets[columnName];
            if (Object.keys(tableDets).length === 0) {
              delete updated[tableName];
            } else {
              updated[tableName] = tableDets;
            }
          }
        } else {
          // Set or update the detection
          updated[tableName] = { ...(updated[tableName] ?? {}), [columnName]: detection };
        }
        return updated;
      });
    },
    [],
  );

  const handleScanPii = useCallback(async () => {
    setScanning(true);
    try {
      const res = await apiFetch('/api/pii/scan', { method: 'POST' });
      const data = await res.json();
      if (data.detections) {
        setPiiDetections(data.detections);
      }
    } catch {
      // silently fail
    } finally {
      setScanning(false);
    }
  }, []);

  const handleGlobalMaskingRulesChange = useCallback(
    (rules: GlobalMaskingRule[]) => {
      setGlobalMaskingRules(rules);
      // Auto-apply rules to columns with matching PII detections
      if (!piiDetections) return;
      setProfiles((prev) => {
        const updated = [...prev];
        const profile = { ...updated[activeProfileIndex] };

        // Phase 5 — write masking into the unified scope shape rather than the
        // legacy `profile.columnMasking` field. Pick a single relational scope
        // as target (multi-DB profiles get the masking on their first source —
        // good enough for the global-rules use case; per-source overrides can
        // still be done from RagAccessSelector / TableOptionsCard).
        const targetSourceId = pickMaskingTargetSourceId(profile);
        const scopes = { ...(profile.scopes ?? {}) };
        const existingScope = scopes[targetSourceId];
        const baseMasking =
          existingScope?.kind === 'relational'
            ? { ...(existingScope.columnMasking ?? {}) }
            : { ...getProfileColumnMasking(profile) };

        const masking = baseMasking;

        for (const [tableName, colDetections] of Object.entries(piiDetections)) {
          const tableMasking = { ...(masking[tableName] ?? {}) };
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
          masking[tableName] = tableMasking;
        }

        // Reflect the masking into the relational scope (creating the scope
        // skeleton if the profile didn't have one yet).
        const existingRelational =
          existingScope?.kind === 'relational' ? existingScope : null;
        scopes[targetSourceId] = {
          kind: 'relational',
          selectedTables: existingRelational?.selectedTables ?? getProfileSelectedTables(profile),
          tableOptions: existingRelational?.tableOptions ?? getProfileTableOptions(profile),
          columnMasking: masking,
        };
        profile.scopes = scopes;
        if (!profile.sources?.includes(targetSourceId)) {
          profile.sources = [...(profile.sources ?? []), targetSourceId];
        }
        updated[activeProfileIndex] = profile;
        return updated;
      });
    },
    [activeProfileIndex, piiDetections],
  );

  const handleSchemaLoaded = useCallback((connectionName: string, connSchema: DatabaseSchema) => {
    setConnectionSchemas((prev) => ({ ...prev, [connectionName]: connSchema }));
    setPiiDetections(null);
  }, []);

  // Profile CRUD
  const handleProfileCreate = useCallback((name: string, label: string) => {
    setProfiles((prev) => [...prev, { name, label }]);
    setActiveProfileIndex((prev) => prev + 1);
  }, []);

  const handleProfileDelete = useCallback(
    async (index: number) => {
      const profileToDelete = profiles[index];
      if (!profileToDelete) return;

      // Stop the profile if active
      try {
        await apiFetch('/api/serve/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profiles: [profileToDelete.name] }),
        });
      } catch {
        // ignore stop errors
      }

      const remaining = profiles.filter((_, i) => i !== index);
      // If no profiles left, keep a default one
      const newProfiles = remaining.length > 0 ? remaining : [createDefaultProfile()];
      setProfiles(newProfiles);
      setActiveProfileIndex((prev) => {
        if (prev >= index && prev > 0) return prev - 1;
        return prev;
      });

      // Persist the deletion to backend
      try {
        await persistProfiles(buildProfilesData(newProfiles));
      } catch {
        // ignore save errors
      }
    },
    [profiles],
  );

  // Dashboard counts
  const allProfileNames = useMemo(() => {
    const names = new Set<string>();
    for (const p of profiles) names.add(p.name);
    for (const name of serveStatus.profiles) names.add(name);
    return names;
  }, [profiles, serveStatus.profiles]);

  const totalMcpCount = allProfileNames.size;

  const activeMcpCount = useMemo(() => {
    let count = 0;
    for (const name of allProfileNames) {
      if (serveStatus.profileStatuses?.[name]?.active === true) count++;
    }
    return count;
  }, [allProfileNames, serveStatus.profileStatuses]);

  const hasActiveMcp = activeMcpCount > 0;
  const totalConnCount = connections.length;
  const connectedCount = connections.filter((c) => connectionSchemas[c.name]).length;
  const hasConnections = connectedCount > 0;

  // Configuration CRUD handlers
  const handleConfigurationSave = useCallback(async (config: Configuration): Promise<boolean> => {
    try {
      const res = await apiFetch('/api/configurations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (data.success) {
        setConfigurations((prev) => {
          const idx = prev.findIndex((c) => c.name === config.name);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = config;
            return updated;
          }
          return [...prev, config];
        });
        // Silently refresh active MCP servers so they pick up the new configuration
        apiFetch('/api/serve/refresh', { method: 'POST' }).catch(() => {});
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  const handleConfigurationDelete = useCallback(async (name: string) => {
    try {
      const res = await apiFetch(`/api/configurations/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (data.success) {
        setConfigurations((prev) => prev.filter((c) => c.name !== name));
      }
    } catch {
      // silently fail
    }
  }, []);

  // Navigate to MCP detail from ServePanel
  const handleSelectProfile = useCallback((profileName: string) => {
    setView({ page: 'mcp-detail', profileName });
  }, []);

  // --- Auth gates (must be after all hooks) ---
  if (welcomeMatch) {
    return <WelcomePage code={welcomeMatch[1]} />;
  }

  // /chat/:profileName — public-facing chat entry page (handles its own auth)
  if (chatMatch) {
    return <ChatEntryPage profileName={decodeURIComponent(chatMatch[1])} />;
  }

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  // /account — user dashboard (redirect to /login if not authenticated)
  if (isAccountPage) {
    if (userAuthenticated) {
      return (
        <UserDashboard
          onLogout={() => {
            setUserAuthenticated(false);
            window.location.href = '/login';
          }}
        />
      );
    }
    // Not authenticated — redirect to unified login
    return <Redirect to="/login" />;
  }

  // First-run setup
  if (needsSetup) {
    return (
      <SetupPage
        onSetupComplete={() => {
          setNeedsSetup(false);
          setAuthenticated(true);
          setAuthRequired(true);
        }}
      />
    );
  }

  // /login or unauthenticated admin — unified login page
  if (isUserLoginPage || (authRequired && !authenticated)) {
    // If already authenticated, redirect to the right dashboard
    if (authenticated) {
      return <Redirect to="/" />;
    }
    if (userAuthenticated) {
      return <Redirect to="/account" />;
    }
    return (
      <LoginPage
        onAdminLogin={() => {
          setAuthenticated(true);
          window.location.href = '/';
        }}
        onUserLogin={() => {
          setUserAuthenticated(true);
          window.location.href = '/account';
        }}
      />
    );
  }

  /** Logout handler — extracted from the old header for reuse in Sidebar footer */
  const handleLogout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      /* ignore network errors */
    }
    setAuthenticated(false);
  };

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-gray-950 text-gray-100">
      {/* Left sidebar navigation */}
      <Sidebar
        currentPage={view.page}
        onNavigate={(page) => setView({ page } as View)}
        user={currentUser ?? undefined}
        onLogout={handleLogout}
      />

      {/* Main content column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Page content */}
        <main
          className="flex-1 p-6 md:p-8 pt-16 md:pt-8 animate-fade-in-up overflow-x-hidden"
          key={`${view.page}-${activeProfile.name}`}
        >
          <div className="max-w-7xl mx-auto w-full">
            {view.page === 'dashboard' && (
              <div className="relative space-y-4">
                {/* Fixed background blobs */}
                <div className="fixed inset-0 -z-10 pointer-events-none overflow-hidden" aria-hidden="true">
                  <div className="absolute -top-40 -left-40 w-[500px] h-[500px] bg-os-900/20 rounded-full blur-3xl" />
                  <div className="absolute top-1/3 -right-40 w-[400px] h-[400px] bg-indigo-900/15 rounded-full blur-3xl" />
                  <div className="absolute -bottom-40 left-1/3 w-[450px] h-[450px] bg-os-800/10 rounded-full blur-3xl" />
                </div>

                {/* Page header */}
                <PageHeader
                  title="Dashboard"
                  description="Overview of your MCP servers, connections, and activity."
                  actions={
                    <Button variant="primary" onClick={() => setView({ page: 'mcp-list' })}>
                      New MCP server
                    </Button>
                  }
                />

                {/* Status ribbon */}
                <div
                  className="card-primary rounded-full px-4 py-2 flex flex-wrap items-center gap-3 animate-fade-in-up"
                  style={{ animationDelay: '0ms' }}
                >
                  <Eyebrow live>{activeMcpCount} server{activeMcpCount !== 1 ? 's' : ''} running</Eyebrow>
                  <span className="eyebrow text-gray-700">·</span>
                  <Eyebrow>{connectedCount} database{connectedCount !== 1 ? 's' : ''} connected</Eyebrow>
                  <span className="eyebrow text-gray-700">·</span>
                  <Eyebrow>{profiles.length} profile{profiles.length !== 1 ? 's' : ''}</Eyebrow>
                  {recentActivity.length > 0 && (() => {
                    const last = recentActivity[0];
                    const diffMs = Date.now() - new Date(last.timestamp).getTime();
                    const diffMin = Math.floor(diffMs / 60000);
                    const diffHour = Math.floor(diffMs / 3600000);
                    const ago = diffMin < 1 ? 'just now' : diffMin < 60 ? `${diffMin}m ago` : `${diffHour}h ago`;
                    return (
                      <>
                        <span className="eyebrow text-gray-700">·</span>
                        <Eyebrow>last activity {ago}</Eyebrow>
                      </>
                    );
                  })()}
                </div>

                {/* Resources grid: MCP Servers / Data Profiles / Databases */}
                <div
                  className="grid grid-cols-1 md:grid-cols-3 gap-4 animate-fade-in-up"
                  style={{ animationDelay: '80ms' }}
                >
                  {/* MCP Servers */}
                  <KpiCard
                    accent="indigo"
                    onClick={() => setView({ page: 'mcp-list' })}
                    eyebrow={
                      <Eyebrow dotColor={hasActiveMcp ? 'bg-emerald-400' : 'bg-gray-600'}>
                        MCP SERVERS
                        <HelpTip
                          content="Start, stop and manage your MCP servers exposed to AI clients"
                          position="bottom"
                        />
                      </Eyebrow>
                    }
                    value={
                      <>
                        <span className="text-3xl">{activeMcpCount}</span>
                        <span className="text-lg text-gray-500">/{totalMcpCount}</span>
                      </>
                    }
                    footer={
                      <div className="space-y-0 max-h-40 overflow-y-auto">
                        {profiles.slice(0, 4).map((p) => {
                          const pStatus = serveStatus.profileStatuses?.[p.name];
                          const pActive = pStatus?.active === true;
                          return (
                            <button
                              key={p.name}
                              onClick={() => setView({ page: 'mcp-detail', profileName: p.name })}
                              className="w-full flex items-center justify-between px-2 py-1 rounded-md hover:bg-white/[0.02] transition-all duration-200 text-left"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${pActive ? 'bg-emerald-400' : 'bg-gray-600'}`} />
                                <span className="font-mono-plex text-xs text-gray-300 truncate">{p.label || p.name}</span>
                              </div>
                              <span className={`font-mono-plex text-[10px] px-2 py-0.5 rounded-full flex-shrink-0 ${pActive ? 'bg-emerald-400/10 text-emerald-400 ring-1 ring-emerald-400/20' : 'bg-white/5 text-gray-600'}`}>
                                {pActive ? 'ON' : 'OFF'}
                              </span>
                            </button>
                          );
                        })}
                        {profiles.length === 0 && (
                          <p className="text-[10px] text-gray-600 text-center py-2 eyebrow">No servers</p>
                        )}
                        <button
                          onClick={() => setView({ page: 'mcp-list' })}
                          className="mt-1 w-full text-left"
                        >
                          <span className="eyebrow-accent hover:text-os-300 transition-colors">View all &rarr;</span>
                        </button>
                      </div>
                    }
                  />

                  {/* Data Profiles */}
                  <KpiCard
                    accent="blue"
                    onClick={() => setView({ page: 'configurations' })}
                    eyebrow={
                      <Eyebrow dotColor={configurations.length > 0 ? 'bg-blue-400' : 'bg-gray-600'}>
                        DATA PROFILES
                        <HelpTip
                          content="Configure which tables and columns from your databases are exposed to AI clients"
                          position="bottom"
                        />
                      </Eyebrow>
                    }
                    value={<span className="text-3xl">{configurations.length}</span>}
                    footer={
                      <div className="space-y-0 max-h-40 overflow-y-auto">
                        {configurations.slice(0, 4).map((cfg) => {
                          const tCount = getConfigurationTableNames(cfg).length;
                          return (
                            <button
                              key={cfg.name}
                              onClick={() => setView({ page: 'config-detail', configName: cfg.name })}
                              className="w-full flex items-center justify-between px-2 py-1 rounded-md hover:bg-white/[0.02] transition-all duration-200 text-left"
                            >
                              <span className="font-mono-plex text-xs text-gray-300 truncate">{cfg.label}</span>
                              <span className="font-mono-plex text-[10px] text-gray-500 flex-shrink-0">{tCount} table{tCount !== 1 ? 's' : ''}</span>
                            </button>
                          );
                        })}
                        {configurations.length === 0 && (
                          <p className="text-[10px] text-gray-600 text-center py-2 eyebrow">No profiles</p>
                        )}
                        <button
                          onClick={() => setView({ page: 'configurations' })}
                          className="mt-1 w-full text-left"
                        >
                          <span className="eyebrow-accent hover:text-os-300 transition-colors">View all &rarr;</span>
                        </button>
                      </div>
                    }
                  />

                  {/* Databases */}
                  <KpiCard
                    accent="emerald"
                    onClick={() => setView({ page: 'connections' })}
                    eyebrow={
                      <Eyebrow dotColor={hasConnections ? 'bg-emerald-400' : 'bg-gray-600'}>
                        DATABASES
                        <HelpTip
                          content="Manage connections to PostgreSQL, MySQL or SQLite databases"
                          position="bottom"
                        />
                      </Eyebrow>
                    }
                    value={
                      <>
                        <span className="text-3xl">{connectedCount}</span>
                        <span className="text-lg text-gray-500">/{totalConnCount}</span>
                      </>
                    }
                    footer={
                      <div className="space-y-0 max-h-40 overflow-y-auto">
                        {connections.slice(0, 4).map((conn) => {
                          const hasSchema = !!connectionSchemas[conn.name];
                          return (
                            <div
                              key={conn.name}
                              className="flex items-center justify-between px-2 py-1"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <div
                                  className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${hasSchema ? 'bg-emerald-400' : 'bg-gray-600'}`}
                                  title={hasSchema ? 'Connected and schema loaded' : 'Not connected'}
                                />
                                <span className="font-mono-plex text-xs text-gray-300 truncate">{conn.label || conn.name}</span>
                              </div>
                              <span className={`font-mono-plex text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${
                                conn.databaseType === 'postgresql'
                                  ? 'text-blue-300 bg-blue-500/10'
                                  : conn.databaseType === 'mysql'
                                    ? 'text-orange-300 bg-orange-500/10'
                                    : 'text-emerald-300 bg-emerald-500/10'
                              }`}>
                                {conn.databaseType === 'postgresql' ? 'PG' : conn.databaseType === 'mysql' ? 'MySQL' : 'SQLite'}
                              </span>
                            </div>
                          );
                        })}
                        {connections.length === 0 && (
                          <p className="text-[10px] text-gray-600 text-center py-2 eyebrow">No databases</p>
                        )}
                        <button
                          onClick={() => setView({ page: 'connections' })}
                          className="mt-1 w-full text-left"
                        >
                          <span className="eyebrow-accent hover:text-os-300 transition-colors">View all &rarr;</span>
                        </button>
                      </div>
                    }
                  />
                </div>

                {/* Governance tiles: Users / Settings / Metrics */}
                <div
                  className="grid grid-cols-1 md:grid-cols-3 gap-3 animate-fade-in-up"
                  style={{ animationDelay: '160ms' }}
                >
                  {[
                    {
                      label: 'USERS',
                      description: 'Manage user accounts and permissions',
                      dot: 'bg-purple-500',
                      page: 'users' as const,
                    },
                    {
                      label: 'SETTINGS',
                      description: 'AI provider, SMTP and SSO/OIDC',
                      dot: 'bg-amber-500',
                      page: 'settings' as const,
                    },
                    {
                      label: 'METRICS',
                      description: 'Usage analytics and performance',
                      dot: 'bg-cyan-500',
                      page: 'metrics' as const,
                    },
                  ].map((tile) => (
                    <button
                      key={tile.page}
                      onClick={() => setView({ page: tile.page })}
                      className="card-interactive group p-3 flex items-center gap-3 text-left"
                    >
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${tile.dot}`} aria-hidden="true" />
                      <div className="flex-1 min-w-0">
                        <div className="eyebrow mb-0.5">{tile.label}</div>
                        <p className="text-xs text-gray-400 truncate">{tile.description}</p>
                      </div>
                      <span className="font-mono-plex text-sm text-gray-600 group-hover:text-os-400 transition-colors flex-shrink-0">
                        &rarr;
                      </span>
                    </button>
                  ))}
                </div>

                {/* Recent Activity */}
                {recentActivity.length > 0 && (
                  <div
                    className="card-primary overflow-hidden animate-fade-in-up"
                    style={{ animationDelay: '240ms' }}
                  >
                    <div className="flex items-center justify-between px-4 py-2 hairline-b">
                      <Eyebrow accent live>RECENT ACTIVITY</Eyebrow>
                      <Eyebrow>{recentActivity.length} events</Eyebrow>
                    </div>
                    <div>
                      {recentActivity.slice(0, 8).map((entry) => {
                        const time = new Date(entry.timestamp);
                        const diffMs = Date.now() - time.getTime();
                        const diffMin = Math.floor(diffMs / 60000);
                        const diffHour = Math.floor(diffMs / 3600000);
                        const timeAgo =
                          diffMin < 1
                            ? 'just now'
                            : diffMin < 60
                              ? `${diffMin}m ago`
                              : diffHour < 24
                                ? `${diffHour}h ago`
                                : time.toLocaleDateString();

                        return (
                          <div key={entry.id} className="px-4 py-1.5 border-b border-white/5 last:border-0 flex items-center gap-3">
                            <span
                              className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${
                                entry.result === 'success' ? 'bg-emerald-400' : 'bg-rose-400'
                              }`}
                              title={entry.result === 'success' ? 'Success' : 'Error'}
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-mono-plex text-sm text-gray-200 truncate">
                                  {entry.toolName}
                                </span>
                                <span className="font-mono-plex text-[10px] px-2 py-0.5 rounded-full bg-os-500/10 text-os-300 ring-1 ring-os-500/20 flex-shrink-0">
                                  {entry.profileName}
                                </span>
                              </div>
                              {entry.resultSummary && (
                                <p className="text-xs text-gray-500 truncate mt-0.5">
                                  {entry.resultSummary}
                                </p>
                              )}
                            </div>
                            <span className="font-mono-plex text-xs text-gray-600 flex-shrink-0 whitespace-nowrap">
                              {timeAgo}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Unified Sources page */}
            {view.page === 'sources' && (
              <SourcesPage
                currentTab={view.tab ?? 'databases'}
                onTabChange={(tab) =>
                  setView({ page: 'sources', tab, backTo: view.backTo })
                }
                connections={connections}
                onConnectionsChange={setConnections}
                onSchemaLoaded={handleSchemaLoaded}
                editConnectionName={view.editConnectionName}
                ragEnabled={ragEnabled}
                ragDisabledReason={ragDisabledReason}
                KnowledgeBaseManagerComponent={KnowledgeBaseManager}
              />
            )}

            {/* Legacy alias: 'connections' → sources/databases tab */}
            {view.page === 'connections' && (
              <SourcesPage
                currentTab="databases"
                onTabChange={(tab) =>
                  setView({ page: 'sources', tab, backTo: view.backTo })
                }
                connections={connections}
                onConnectionsChange={setConnections}
                onSchemaLoaded={handleSchemaLoaded}
                editConnectionName={view.editConnectionName}
                ragEnabled={ragEnabled}
                ragDisabledReason={ragDisabledReason}
                KnowledgeBaseManagerComponent={KnowledgeBaseManager}
              />
            )}

            {view.page === 'configurations' && (
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
            )}

            {view.page === 'config-detail' && (
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
                          { label: 'Data Profiles', onClick: () => setView({ page: 'configurations' }) },
                        ]),
                    {
                      label:
                        configurations.find((c) => c.name === view.configName)?.label ??
                        view.configName,
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
                />
              </div>
            )}

            {view.page === 'mcp-list' && (
              <div className="space-y-4">
                <PageHeader
                  breadcrumb={[
                    { label: 'Dashboard', onClick: () => setView({ page: 'dashboard' }) },
                    { label: 'MCP Servers' },
                  ]}
                  title="MCP Servers"
                  description="Manage your MCP server profiles. Start, stop, and configure access for each profile."
                />
                <div className="mt-4">
                  <ServePanel
                    config={configWithProfileOptions}
                    selectedTables={selectedTables}
                    profiles={profiles}
                    serveStatus={serveStatus}
                    onServeAction={fetchServeStatus}
                    onSelectProfile={handleSelectProfile}
                    onBack={() => setView({ page: 'dashboard' })}
                    onCreateProfile={(name, label) => {
                      handleProfileCreate(name, label);
                      setView({ page: 'mcp-detail', profileName: name });
                    }}
                    onDeleteProfile={handleProfileDelete}
                    onPreviewProfile={(name) => setPreviewProfile(name)}
                  />
                </div>
              </div>
            )}

            {view.page === 'mcp-detail' && (
              <div className="max-w-7xl mx-auto">
                <Breadcrumb
                  className="mb-4"
                  items={[
                    { label: 'Dashboard', onClick: () => setView({ page: 'dashboard' }) },
                    { label: 'MCP Servers', onClick: () => setView({ page: 'mcp-list' }) },
                    {
                      label:
                        profiles.find((p) => p.name === view.profileName)?.label ?? view.profileName,
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
                  ragEnabled={ragEnabled}
                  ragDisabledReason={ragDisabledReason}
                />
              </div>
            )}

            {view.page === 'settings' && (
              <SettingsPage
                allProfileNames={Array.from(allProfileNames)}
                onNavigateDashboard={() => setView({ page: 'dashboard' })}
                initialTab={view.initialTab}
                backTo={(() => {
                  const bt = view.backTo;
                  if (bt?.page === 'mcp-detail') {
                    return {
                      label: profiles.find((p) => p.name === bt.profileName)?.label ?? bt.profileName,
                      view: bt,
                    };
                  }
                  return undefined;
                })()}
                onNavigate={(v) => setView(v)}
              />
            )}

            {view.page === 'users' && (
              <div className="space-y-4">
                <PageHeader
                  breadcrumb={[
                    { label: 'Dashboard', onClick: () => setView({ page: 'dashboard' }) },
                    { label: 'Users' },
                  ]}
                  title="Users & Access"
                  description="Manage administrator accounts and end-user access to your MCP profiles."
                />
                <UserManagement profiles={profiles} initialSelectedUserId={view.selectedUserId} />
              </div>
            )}

            {view.page === 'metrics' && (
              <div className="space-y-4">
                <PageHeader
                  breadcrumb={[
                    { label: 'Dashboard', onClick: () => setView({ page: 'dashboard' }) },
                    { label: 'Metrics' },
                  ]}
                  title="Metrics"
                  description="Request volume, tool usage, and performance over time."
                />
                <MetricsDashboard />
              </div>
            )}

            {view.page === 'tenants' && (
              <div className="space-y-4">
                <PageHeader
                  breadcrumb={[
                    { label: 'Dashboard', onClick: () => setView({ page: 'dashboard' }) },
                    { label: 'Workspaces' },
                  ]}
                  title="Workspaces"
                  description="Liste de tous les workspaces (tenants) découverts sur cette instance. Les workspaces sont créés implicitement lors de la première écriture avec un identifiant donné."
                />
                <TenantManagement />
              </div>
            )}

            {/* Legacy alias: 'knowledge' → sources/knowledge tab */}
            {view.page === 'knowledge' && (
              <SourcesPage
                currentTab="knowledge"
                onTabChange={(tab) => setView({ page: 'sources', tab })}
                connections={connections}
                onConnectionsChange={setConnections}
                onSchemaLoaded={handleSchemaLoaded}
                ragEnabled={ragEnabled}
                ragDisabledReason={ragDisabledReason}
                KnowledgeBaseManagerComponent={KnowledgeBaseManager}
              />
            )}
          </div>
        </main>

        {/* Profile preview modal */}
        {previewProfile && (
          <ProfilePreview profileName={previewProfile} onClose={() => setPreviewProfile(null)} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MCP Detail / Config view — shown when clicking an MCP card
// ---------------------------------------------------------------------------

/** Totals returned by GET /api/profiles/:name/scopes/preview */
interface ScopesPreviewTotals {
  tables: number;
  columns: number;
  folders: number;
  documents: number;
  chunks: number;
}

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
  ragEnabled: boolean;
  ragDisabledReason: string | null;
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
  ragEnabled,
  ragDisabledReason,
}: McpDetailViewProps) {
  const [togglingProfile, setTogglingProfile] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedEndpoint, setCopiedEndpoint] = useState(false);
  const [activeSection, setActiveSection] = useState<
    'tables' | 'config' | 'tokens' | 'audit' | 'users' | 'scoping' | 'sources'
  >(
    (initialActiveSection as
      | 'tables'
      | 'config'
      | 'tokens'
      | 'audit'
      | 'users'
      | 'scoping'
      | 'sources') ?? 'tables',
  );

  // RAG scopes preview state
  const [scopesPreview, setScopesPreview] = useState<ScopesPreviewTotals | null>(null);
  const [scopesPreviewLoading, setScopesPreviewLoading] = useState(false);
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

  // Fetch RAG scopes preview when on the "Knowledge Bases" section
  const fetchScopesPreview = useCallback(async () => {
    setScopesPreviewLoading(true);
    try {
      const res = await fetch(`/api/profiles/${encodeURIComponent(profileName)}/scopes/preview`, {
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success !== false && data.totals) {
        setScopesPreview(data.totals as ScopesPreviewTotals);
      }
    } catch {
      // Preview is best-effort — silently ignore errors
    } finally {
      setScopesPreviewLoading(false);
    }
  }, [profileName]);

  useEffect(() => {
    if (activeSection === 'sources') {
      void fetchScopesPreview();
    }
  }, [activeSection, fetchScopesPreview]);

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
  const basePath = _tenant === 'default'
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
      id: 'sources',
      label: 'Knowledge Bases',
      tooltip: 'Configurer les bases de connaissance RAG accessibles via ce serveur MCP',
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
                  tooltip:
                    'Les utilisateurs se connectent avec leur email et mot de passe Calame.',
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
          {(profile.authMode ?? 'token') === 'sso' && <ProfileSsoNotice />}

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
                          ({tableCount} table{tableCount !== 1 ? 's' : ''}, {sourceCount}{' '}
                          base{sourceCount !== 1 ? 's' : ''})
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
        <DataScopingSection
          profile={profile}
          configurations={configurations}
          onScopeRulesChange={handleScopeRulesChange}
        />
      )}

      {activeSection === 'tokens' && (
        <div className="card-primary p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-3">Tokens</h3>
          <TokenManagerLazy profile={profile} port={serveStatus.port} />
        </div>
      )}

      {activeSection === 'sources' && (
        <div className="space-y-4">
          {/* Preview header */}
          <div className="card-primary p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-300">Knowledge Bases</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Sélectionnez les bases de connaissance et les dossiers accessibles via ce serveur MCP.
                </p>
              </div>
              {/* Scope summary badge */}
              {scopesPreviewLoading ? (
                <span className="text-xs text-gray-500 italic">Chargement…</span>
              ) : scopesPreview ? (
                <div className="flex items-center gap-2 text-xs text-gray-400 flex-wrap justify-end">
                  {scopesPreview.tables > 0 && (
                    <span className="px-2 py-0.5 rounded bg-gray-800/60 border border-gray-700">
                      {scopesPreview.tables} table{scopesPreview.tables !== 1 ? 's' : ''}
                    </span>
                  )}
                  {scopesPreview.columns > 0 && (
                    <span className="px-2 py-0.5 rounded bg-gray-800/60 border border-gray-700">
                      {scopesPreview.columns} col{scopesPreview.columns !== 1 ? 's' : ''}
                    </span>
                  )}
                  {scopesPreview.folders > 0 && (
                    <span className="px-2 py-0.5 rounded bg-gray-800/60 border border-gray-700">
                      {scopesPreview.folders} dossier{scopesPreview.folders !== 1 ? 's' : ''}
                    </span>
                  )}
                  {scopesPreview.documents > 0 && (
                    <span className="px-2 py-0.5 rounded bg-gray-800/60 border border-gray-700">
                      {scopesPreview.documents} document{scopesPreview.documents !== 1 ? 's' : ''}
                    </span>
                  )}
                  {scopesPreview.chunks > 0 && (
                    <span className="px-2 py-0.5 rounded bg-gray-800/60 border border-gray-700">
                      ~{scopesPreview.chunks} chunk{scopesPreview.chunks !== 1 ? 's' : ''}
                    </span>
                  )}
                  {scopesPreview.tables === 0 &&
                    scopesPreview.folders === 0 &&
                    scopesPreview.documents === 0 && (
                      <span className="text-gray-600 italic">Aucun élément accessible</span>
                    )}
                </div>
              ) : null}
            </div>
          </div>

          {/* RAG access selector body */}
          {!ragEnabled ? (
            <div className="card-primary p-6 text-center space-y-2">
              <svg
                className="w-8 h-8 text-gray-600 mx-auto"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"
                />
              </svg>
              <p className="text-sm font-medium text-gray-400">
                Bases de connaissance non disponibles
              </p>
              {ragDisabledReason && (
                <p className="text-xs text-gray-600 max-w-sm mx-auto">{ragDisabledReason}</p>
              )}
            </div>
          ) : (
            <div className="card-primary p-4">
              <Suspense
                fallback={
                  <div className="p-6 text-sm text-gray-500 italic flex items-center gap-2">
                    <svg
                      className="w-3 h-3 animate-spin text-gray-500 flex-shrink-0"
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
                  profileName={profile.name}
                  initialScopes={profile.scopes as unknown as Record<string, ScopeSelection>}
                  initialSources={profile.sources ?? []}
                  onSaved={(newScopes, newSources) => {
                    // Update local profile state — do NOT call persistProfiles here.
                    // The RagAccessSelector already posted to /api/profiles/:name/scopes.
                    // Cast via unknown: the mirror type in schema.ts and @calame/core are
                    // structurally equivalent at the values we use; the mismatch is only on
                    // tableOptions (unknown vs TableToolOptions) which is inert here.
                    onProfilesChange((prev) => {
                      const updated = [...prev];
                      updated[profileIndex] = {
                        ...updated[profileIndex],
                        scopes: newScopes as unknown as Record<string, ScopeSelection>,
                        sources: newSources,
                      };
                      return updated;
                    });
                    // Refresh the preview summary
                    void fetchScopesPreview();
                  }}
                />
              </Suspense>
            </div>
          )}
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
import TokenManager from './components/TokenManager.js';
import AuditLogViewer from './components/AuditLogViewer.js';
import McpUsers from './components/McpUsers.js';

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
}: ConfigurationDetailViewProps) {
  const config = configurations.find((c) => c.name === configName);

  // Local editing state
  const [label, setLabel] = useState(config?.label ?? configName);
  const [selectedConns, setSelectedConns] = useState<Set<string>>(
    new Set(config?.sources ?? []),
  );
  const [localSelectedTables, setLocalSelectedTables] = useState<Record<string, Set<string>>>(
    config ? arraysToSets(getConfigurationSelectedTables(config)) : {},
  );
  const [localTableOptions, setLocalTableOptions] = useState<
    Record<string, import('./types/schema.js').TableToolOptions>
  >(config ? getConfigurationTableOptions(config) : {});
  const [localColumnMasking, setLocalColumnMasking] = useState<
    Record<string, Record<string, ColumnMasking>>
  >(config ? getConfigurationColumnMasking(config) : {});
  const [editingLabel, setEditingLabel] = useState(false);
  const [loadingSchemas, setLoadingSchemas] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
    const cleanedTableOptions: Record<string, import('./types/schema.js').TableToolOptions> = {};
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
    const sourcesArray = [...selectedConns];
    const scopes: Record<string, import('./types/schema.js').ScopeSelection> = {};
    for (const sourceId of sourcesArray) {
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
    return (
      <EmptyState
        title={`Configuration "${configName}" not found.`}
        className="py-10"
      />
    );
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
                <HelpTip
                  content="Click to rename this data profile"
                  position="right"
                  size="xs"
                />
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
                <Button
                  variant="danger"
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? 'Deleting...' : 'Yes, delete'}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setConfirmDelete(false)}
                >
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

      {/* Connections selection */}
      <div className="card-primary p-4">
        <div className="mb-3"><Eyebrow>Databases</Eyebrow></div>
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
          <div className="mb-3"><Eyebrow>Advanced: Table Options &amp; Masking</Eyebrow></div>
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// SettingsPage — tabbed layout wrapping AiSettings / SmtpSettings / OidcSettings
// ---------------------------------------------------------------------------

type SettingsTab = 'ai' | 'email' | 'sso';

interface SettingsTabItem {
  id: SettingsTab;
  label: string;
  description: string;
}

const SETTINGS_TABS: SettingsTabItem[] = [
  { id: 'ai', label: 'AI Provider', description: 'Configure Claude or OpenAI' },
  { id: 'email', label: 'Email (SMTP)', description: 'Outgoing mail server' },
  { id: 'sso', label: 'Single Sign-On (OIDC)', description: 'SSO identity provider' },
];

interface SettingsPageProps {
  allProfileNames: string[];
  onNavigateDashboard: () => void;
  initialTab?: SettingsTab;
  /** Optional intermediate breadcrumb crumb — used when the page is opened from an MCP detail. */
  backTo?: { label: string; view: View };
  onNavigate?: (view: View) => void;
}

function SettingsPage({
  allProfileNames,
  onNavigateDashboard,
  initialTab,
  backTo,
  onNavigate,
}: SettingsPageProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'ai');

  const breadcrumb: { label: string; onClick?: () => void }[] = [
    { label: 'Dashboard', onClick: onNavigateDashboard },
  ];
  if (backTo && onNavigate) {
    breadcrumb.push({ label: backTo.label, onClick: () => onNavigate(backTo.view) });
  }
  breadcrumb.push({ label: 'Settings' });

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumb={breadcrumb}
        title="Settings"
        description="Configure AI providers, email delivery, and single sign-on for your Calame instance."
      />

      {/* Mobile: horizontal scrollable tab bar */}
      <div className="flex gap-1 overflow-x-auto md:hidden border-b border-gray-800/60 pb-0">
        {SETTINGS_TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              aria-current={isActive ? 'page' : undefined}
              className={[
                'flex-shrink-0 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
                isActive
                  ? 'border-os-400 text-gray-100'
                  : 'border-transparent text-gray-400 hover:text-gray-200 hover:border-gray-600',
              ].join(' ')}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Desktop: sidebar nav + content */}
      <div className="hidden md:grid md:grid-cols-[220px_1fr] md:gap-4">
        {/* Left tab nav */}
        <nav aria-label="Settings navigation" className="flex flex-col gap-1">
          {SETTINGS_TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                aria-current={isActive ? 'page' : undefined}
                className={[
                  'relative flex flex-col items-start w-full px-3 py-2.5 rounded-lg text-sm text-left transition-colors focus:outline-none focus:ring-2 focus:ring-os-400',
                  isActive
                    ? 'bg-gray-800/70 text-gray-100'
                    : 'text-gray-400 hover:bg-gray-800/40 hover:text-gray-200',
                ].join(' ')}
              >
                {/* Blue left indicator for active tab */}
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-os-400"
                  />
                )}
                <span className={isActive ? 'pl-2' : undefined}>{tab.label}</span>
                <span
                  className={[
                    'text-xs mt-0.5 hidden md:block',
                    isActive ? 'text-gray-400 pl-2' : 'text-gray-500',
                  ].join(' ')}
                >
                  {tab.description}
                </span>
              </button>
            );
          })}
        </nav>

        {/* Right content pane — desktop only */}
        <Card padded={true} key={activeTab} className="animate-fade-in-up">
          {activeTab === 'ai' && <AiSettings />}
          {activeTab === 'email' && <SmtpSettings />}
          {activeTab === 'sso' && <OidcSettings availableProfiles={[...allProfileNames]} />}
        </Card>
      </div>

      {/* Mobile content pane */}
      <Card padded={true} key={`mobile-${activeTab}`} className="animate-fade-in-up md:hidden">
        {activeTab === 'ai' && <AiSettings />}
        {activeTab === 'email' && <SmtpSettings />}
        {activeTab === 'sso' && <OidcSettings availableProfiles={[...allProfileNames]} />}
      </Card>
    </div>
  );
}
