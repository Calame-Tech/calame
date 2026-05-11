import type { Express, Request } from 'express';
import type { AppState } from '../state.js';
import type { ServeProfile } from '@calame/core';
import {
  upgradeProfileShape,
  getProfileRelationalSources,
  getConfigurationSelectedTables,
} from '@calame/core';
import { readConfigurationsFile } from './configurations.js';
import { getTenantId } from '../tenancy.js';

export function registerServeStatusRoute(app: Express, state: AppState): void {
  const dataDir = state.config?.dataDir ?? process.cwd();

  /**
   * Load profiles from SQLite into state.serveProfiles (no-op if already loaded).
   *
   * Phase B multi-tenancy: the profile blob is scoped to the caller's
   * tenant — `state.serveProfiles` is a process-wide cache, so the first
   * tenant to hit the endpoint after boot determines which blob lands in
   * memory. Subsequent tenants that pass through `state.serveProfiles`
   * (e.g. via the MCP endpoint) will observe that blob until `serve/stop`
   * clears the cache. This matches the MVP choice of pinning MCP to the
   * default tenant — Phase C will key the cache by tenant.
   */
  async function ensureProfilesLoaded(req: Request): Promise<void> {
    if (Object.keys(state.serveProfiles).length > 0) return;
    if (!state.db) return;

    try {
      const tenantId = getTenantId(req);
      const row = state.db.raw
        .prepare("SELECT data FROM profiles WHERE key = 'main' AND tenant_id = ?")
        .get(tenantId) as { data: string } | undefined;
      if (!row) return;

      const parsed = JSON.parse(row.data) as Record<string, unknown>;
      if (!parsed.profiles || typeof parsed.profiles !== 'object') return;

      const serveProfiles: Record<string, ServeProfile> = {};
      for (const [name, profile] of Object.entries(parsed.profiles as Record<string, unknown>)) {
        serveProfiles[name] = upgradeProfileShape({ ...(profile as Record<string, unknown>), name });
      }
      // Backward compat: synthesise a default relational source on profiles
      // that have no configurations and no sources. Mirrors the historic
      // behaviour where empty profiles defaulted to `connections: ['default']`.
      for (const profile of Object.values(serveProfiles)) {
        if (
          !profile.configurations?.length &&
          getProfileRelationalSources(profile).length === 0
        ) {
          profile.sources = ['default'];
          profile.scopes = {
            ...(profile.scopes ?? {}),
            default: { kind: 'relational', selectedTables: {} },
          };
        }
      }

      state.serveProfiles = serveProfiles;
    } catch {
      // DB not available or data is invalid — that's OK
    }
  }

  app.get('/api/serve/status', async (req, res) => {
    try {
      await ensureProfilesLoaded(req);
      const profileNames = Object.keys(state.serveProfiles);
      const profileStatuses: Record<string, { active: boolean; endpoint: string }> = {};
      for (const name of profileNames) {
        profileStatuses[name] = {
          active: state.activeProfileNames.has(name),
          endpoint: `/mcp/${name}`,
        };
      }
      res.json({
        success: true,
        serving: state.serveMode,
        profiles: profileNames,
        profileStatuses,
        hasDatabase: state.connections.size > 0,
        hasTokenManager: !!state.tokenManager,
        hasAuditLog: !!state.auditLog,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Error', { component: 'serve/status', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  app.post('/api/serve/start', async (req, res) => {
    try {
      // Validate prerequisites
      if (state.connections.size === 0) {
        res.status(400).json({ success: false, message: 'No database connections available. Add a connection first.' });
        return;
      }

      // Load profiles from SQLite
      let profilesData: Record<string, ServeProfile>;

      {
        if (!state.db) {
          // Initialise db lazily (mirrors serve/start lazy-init below)
          const { CalameDatabase } = await import('../database.js');
          state.db = new CalameDatabase(dataDir);
        }
        const tenantId = getTenantId(req);
        const row = state.db.raw
          .prepare("SELECT data FROM profiles WHERE key = 'main' AND tenant_id = ?")
          .get(tenantId) as { data: string } | undefined;
        if (!row) {
          res.status(400).json({ success: false, message: 'No profiles found. Create profiles first.' });
          return;
        }
        const parsed = JSON.parse(row.data) as Record<string, unknown>;
        if (!parsed.profiles || typeof parsed.profiles !== 'object') {
          res.status(400).json({ success: false, message: 'No profiles found in profiles data.' });
          return;
        }
        profilesData = parsed.profiles as Record<string, ServeProfile>;
      }

      // If frontend sent a list of profile names, filter to only those
      if (Array.isArray(req.body?.profiles)) {
        const requestedNames = req.body.profiles as string[];
        const filtered: Record<string, ServeProfile> = {};
        for (const name of requestedNames) {
          if (profilesData[name]) {
            filtered[name] = profilesData[name];
          }
        }
        profilesData = filtered;
      }

      // Convert profiles to ServeProfile format and store
      const serveProfiles: Record<string, ServeProfile> = {};
      for (const [name, profile] of Object.entries(profilesData)) {
        serveProfiles[name] = upgradeProfileShape({
          ...(profile as unknown as Record<string, unknown>),
          name,
        });
      }

      // Resolve configurations to get effective selectedTables. Phase B
      // multi-tenancy: bind the caller's tenant so this can't pick up a
      // configuration row owned by another tenant.
      const configsFile = readConfigurationsFile(state.db!, getTenantId(req));
      for (const [_name, sp] of Object.entries(serveProfiles)) {
        if (sp.configurations && sp.configurations.length > 0) {
          const mergedTables: Record<string, string[]> = {};
          for (const cfgName of sp.configurations) {
            const cfg = configsFile.configurations[cfgName];
            if (cfg) {
              // Use the accessor so that both the legacy shape (selectedTables at root)
              // and the Phase 5 unified shape (scopes[].selectedTables) are handled.
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
          }
          // Phase 5 — write the merged tables into a `default` relational
          // scope rather than the legacy `selectedTables` root field.
          sp.sources = sp.sources?.length ? sp.sources : ['default'];
          sp.scopes = {
            ...(sp.scopes ?? {}),
            [sp.sources[0]]: { kind: 'relational', selectedTables: mergedTables },
          };
        }
      }

      // Merge new profiles into existing ones (additive, not replacing)
      state.serveProfiles = { ...state.serveProfiles, ...serveProfiles };

      // Mark all started profiles as active
      for (const name of Object.keys(serveProfiles)) {
        state.activeProfileNames.add(name);
      }

      // Initialize db first — other managers depend on it.
      if (!state.db) {
        const { CalameDatabase } = await import('../database.js');
        state.db = new CalameDatabase(dataDir);
      }

      // Initialize token manager, user manager, and audit log if not already done
      if (!state.tokenManager) {
        const { TokenManager } = await import('../token.js');
        state.tokenManager = new TokenManager(state.db);
      }

      if (!state.userManager) {
        const { UserManager } = await import('../user.js');
        state.userManager = new UserManager(state.db!);
      }

      if (!state.auditLog) {
        const { AuditLog } = await import('../audit.js');
        state.auditLog = new AuditLog(state.db);
      }

      if (!state.writeQueue) {
        const { WriteQueue } = await import('../write-queue.js');
        state.writeQueue = new WriteQueue(state.db);
      }

      const profileNames = Object.keys(serveProfiles);
      state.logger?.info(`Started serving ${profileNames.length} profile(s): ${profileNames.join(', ')}`, { component: 'serve' });
      state.logger?.info('MCP endpoints available at POST /mcp/<profileName>', { component: 'serve' });

      // Pre-warm local model KV cache in the background (custom provider only)
      // so the first real user message doesn't pay the full cold-start penalty
      void (async () => {
        try {
          const aiSetting = state.aiConfigManager?.getConfig?.();
          if (aiSetting?.provider === 'custom' && aiSetting.baseUrl && aiSetting.model) {
            const { warmupLlmCache, createMcpChatTools, getDefaultSystemPrompt } = await import('../chat-engine.js');
            const firstProfile = profileNames[0];
            const host = `localhost:${process.env.PORT ?? 4567}`;
            const mcpUrl = `http://${host}/mcp/${firstProfile}`;
            const adminToken = state.userManager
              ? (() => {
                  const admins = state.userManager.listUsers({ role: 'admin', status: 'active' });
                  return admins[0] ? state.userManager.getUserToken(admins[0].id) : null;
                })()
              : null;
            if (adminToken) {
              const { tools, close } = await createMcpChatTools(mcpUrl, adminToken);
              try {
                const profile = state.serveProfiles[firstProfile];
                const responseMode = profile?.responseMode ?? 'friendly';
                await warmupLlmCache({
                  apiKey: aiSetting.apiKey,
                  model: aiSetting.model,
                  baseUrl: aiSetting.baseUrl,
                  systemPrompt: getDefaultSystemPrompt(responseMode),
                  tools,
                });
                state.logger?.info('LLM cache pre-warmed for local model', { component: 'serve' });
              } finally {
                await close();
              }
            }
          }
        } catch {
          // Warmup failure is non-blocking
        }
      })();

      res.json({
        success: true,
        message: `Now serving ${profileNames.length} profile(s).`,
        profiles: profileNames,
        endpoints: profileNames.map(p => `/mcp/${p}`),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Error', { component: 'serve/start', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  app.post('/api/serve/stop', async (req, res) => {
    try {
      const profilesToStop: string[] | undefined = Array.isArray(req.body?.profiles)
        ? req.body.profiles
        : undefined;

      if (profilesToStop) {
        // Selective stop: deactivate only the specified profiles
        for (const name of profilesToStop) {
          state.activeProfileNames.delete(name);
        }
        state.logger?.info(`Deactivated profile(s): ${profilesToStop.join(', ')}`, { component: 'serve' });
        res.json({
          success: true,
          message: `Deactivated ${profilesToStop.length} profile(s).`,
          stoppedProfiles: profilesToStop,
          remainingActive: [...state.activeProfileNames],
        });
      } else {
        // Stop all: clear active set and profiles
        state.activeProfileNames.clear();
        state.serveProfiles = {};
        state.logger?.info('Stopped serving all MCP endpoints.', { component: 'serve' });
        res.json({ success: true, message: 'Serve mode stopped.' });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Error', { component: 'serve/stop', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  // Refresh active profiles: re-read profiles and configurations from disk
  app.post('/api/serve/refresh', async (req, res) => {
    try {
      if (state.activeProfileNames.size === 0) {
        res.json({ success: true, refreshed: [] });
        return;
      }

      // Re-read profiles from SQLite
      let profilesData: Record<string, Record<string, unknown>> = {};
      if (state.db) {
        try {
          const tenantId = getTenantId(req);
          const row = state.db.raw
            .prepare("SELECT data FROM profiles WHERE key = 'main' AND tenant_id = ?")
            .get(tenantId) as { data: string } | undefined;
          if (row) {
            const parsed = JSON.parse(row.data) as Record<string, unknown>;
            if (parsed.profiles && typeof parsed.profiles === 'object') {
              profilesData = parsed.profiles as Record<string, Record<string, unknown>>;
            }
          }
        } catch {
          // DB not available or data is invalid
        }
      }

      // Re-read configurations from SQLite. Phase B multi-tenancy: bind
      // the caller's tenant so the refreshed serve profile is rebuilt from
      // its own tenant's configuration set.
      const configsFile = state.db
        ? readConfigurationsFile(state.db, getTenantId(req))
        : { configurations: {} };

      const refreshedNames: string[] = [];

      for (const name of state.activeProfileNames) {
        const profileRaw = profilesData[name];
        if (!profileRaw) continue;

        // Rebuild the ServeProfile with fresh data via the unified migrator.
        const updatedProfile = upgradeProfileShape({
          ...(profileRaw as unknown as Record<string, unknown>),
          name,
        });

        // If profile uses configurations, resolve them and write the merged
        // tables into a `default` relational scope.
        if (updatedProfile.configurations && updatedProfile.configurations.length > 0) {
          const mergedTables: Record<string, string[]> = {};
          for (const cfgName of updatedProfile.configurations) {
            const cfg = configsFile.configurations[cfgName];
            if (cfg) {
              // Use the accessor so that both the legacy shape (selectedTables at root)
              // and the Phase 5 unified shape (scopes[].selectedTables) are handled.
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
          }
          updatedProfile.sources = updatedProfile.sources?.length
            ? updatedProfile.sources
            : ['default'];
          updatedProfile.scopes = {
            ...(updatedProfile.scopes ?? {}),
            [updatedProfile.sources[0]]: { kind: 'relational', selectedTables: mergedTables },
          };
        }

        state.serveProfiles[name] = updatedProfile;
        refreshedNames.push(name);
      }

      state.logger?.info(`Refreshed ${refreshedNames.length} profile(s): ${refreshedNames.join(', ')}`, { component: 'serve/refresh' });
      res.json({ success: true, refreshed: refreshedNames });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Error', { component: 'serve/refresh', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  // Toggle a single profile's active state
  app.post('/api/serve/profile/:name/toggle', async (req, res) => {
    try {
      const { name } = req.params;

      // Profile must exist in serveProfiles to be toggled
      if (!state.serveProfiles[name]) {
        res.status(404).json({
          success: false,
          message: `Profile "${name}" is not loaded. Start it first.`,
        });
        return;
      }

      const wasActive = state.activeProfileNames.has(name);
      if (wasActive) {
        state.activeProfileNames.delete(name);
      } else {
        state.activeProfileNames.add(name);
      }

      const nowActive = !wasActive;
      state.logger?.info(`Profile "${name}" toggled to ${nowActive ? 'active' : 'inactive'}.`, { component: 'serve' });

      res.json({
        success: true,
        profile: name,
        active: nowActive,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Error', { component: 'serve/toggle', error: message });
      res.status(500).json({ success: false, message });
    }
  });
}
