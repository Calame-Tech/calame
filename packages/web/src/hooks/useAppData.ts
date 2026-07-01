// Shared admin data hook (Phase 3 #14). Owns the data state, loading effects
// and CRUD handlers that used to live inline in the App god-component:
// connections/schemas, configurations, profiles, serve status, recent
// activity, PII detections and global masking rules. Code moved verbatim from
// App.tsx — only the session values are now read from `useSession()`.

import { useState, useCallback, useMemo, useEffect } from 'react';
import { apiFetch } from '../lib/api.js';
import {
  createDefaultProfile,
  arraysToSets,
  persistProfiles,
  buildProfilesData,
} from '../lib/profiles.js';
import {
  pickMaskingTargetSourceId,
  getProfileSelectedTables,
  getProfileTableOptions,
  getProfileColumnMasking,
} from '../lib/profile-accessors.js';
import type {
  DatabaseSchema,
  Config,
  Configuration,
  Profile,
  PiiDetection,
  GlobalMaskingRule,
  NamedConnection,
  ServeStatus,
  AuditLogEntry,
} from '../types/schema.js';
import { useSession } from '../context/SessionContext.js';

/**
 * Owns the shared admin data (connections, configurations, profiles, serve
 * status, audit activity, PII/masking) plus the polling/loading effects and
 * CRUD handlers. `isUserPage` disables the admin data loading on the
 * URL-driven end-user pages.
 */
export function useAppData(isUserPage: boolean) {
  const { authenticated, dataVersion, setShowOnboarding } = useSession();

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

  // Serve status for dashboard counts
  const [serveStatus, setServeStatus] = useState<ServeStatus>({
    active: false,
    port: 0,
    profiles: [],
    totalRequests: 0,
  });

  // Auto-load connections then profiles once authenticated (re-runs on dataVersion bump)
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

      // Show onboarding wizard when dashboard is empty and user hasn't dismissed it
      const dismissed = localStorage.getItem('calame_onboarding_dismissed');
      if (!dismissed) {
        try {
          const connRes = await apiFetch('/api/connections', { credentials: 'include' });
          const connData = await connRes.json();
          const hasConnections =
            connData.success && Object.keys(connData.connections ?? {}).length > 0;
          if (!hasConnections) {
            setShowOnboarding(true);
          }
        } catch {
          // ignore
        }
      }
    })();
  }, [authenticated, dataVersion]);

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
        const existingRelational = existingScope?.kind === 'relational' ? existingScope : null;
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

  return {
    // Connections
    connections,
    setConnections,
    connectionSchemas,
    // Configurations
    configurations,
    setConfigurations,
    // Profiles
    profiles,
    setProfiles,
    activeProfileIndex,
    setActiveProfileIndex,
    activeProfile,
    // Serve status
    serveStatus,
    fetchServeStatus,
    // Recent activity
    recentActivity,
    // PII & Masking
    piiDetections,
    scanning,
    globalMaskingRules,
    // Derived values
    selectedTables,
    configWithProfileOptions,
    allProfileNames,
    totalMcpCount,
    activeMcpCount,
    hasActiveMcp,
    totalConnCount,
    connectedCount,
    hasConnections,
    // Handlers
    handlePiiOverride,
    handleScanPii,
    handleGlobalMaskingRulesChange,
    handleSchemaLoaded,
    handleProfileCreate,
    handleProfileDelete,
    handleConfigurationSave,
    handleConfigurationDelete,
  };
}

/** The return shape of {@link useAppData} — what App prop-drills into the pages. */
export type AppData = ReturnType<typeof useAppData>;
