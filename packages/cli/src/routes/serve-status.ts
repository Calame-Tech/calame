import type { Express } from 'express';
import type { AppState } from '../state.js';
import type { ServeProfile } from '@calame/core';
import { readConfigurationsFile } from './configurations.js';

export function registerServeStatusRoute(app: Express, state: AppState): void {
  const dataDir = state.config?.dataDir ?? process.cwd();

  /** Load profiles from SQLite into state.serveProfiles (no-op if already loaded). */
  async function ensureProfilesLoaded(): Promise<void> {
    if (Object.keys(state.serveProfiles).length > 0) return;
    if (!state.db) return;

    try {
      const row = state.db.raw
        .prepare("SELECT data FROM profiles WHERE key = 'main'")
        .get() as { data: string } | undefined;
      if (!row) return;

      const parsed = JSON.parse(row.data) as Record<string, unknown>;
      if (!parsed.profiles || typeof parsed.profiles !== 'object') return;

      const serveProfiles: Record<string, ServeProfile> = {};
      for (const [name, profile] of Object.entries(parsed.profiles as Record<string, unknown>)) {
        const p = profile as Record<string, unknown>;
        serveProfiles[name] = {
          name,
          label: (p.label as string) ?? name,
          configurations: p.configurations as string[] | undefined,
          selectedTables: (p.selectedTables as Record<string, string[]>) ?? {},
          tableOptions: p.tableOptions,
          columnMasking: p.columnMasking,
          authMode: p.authMode as ServeProfile['authMode'],
          oauthConfig: p.oauthConfig as ServeProfile['oauthConfig'],
          externalAuthConfig: p.externalAuthConfig as ServeProfile['externalAuthConfig'],
          responseMode: p.responseMode as ServeProfile['responseMode'],
          dataScopeRules: p.dataScopeRules as ServeProfile['dataScopeRules'],
          sharedTables: p.sharedTables as ServeProfile['sharedTables'],
          aiSettingNames: p.aiSettingNames as string[] | undefined,
        } as ServeProfile;
      }
      // Backward compat: set default connections on profiles that lack the field
      for (const profile of Object.values(serveProfiles)) {
        const p = profile as ServeProfile & { connections?: string[] };
        if (!p.configurations?.length && (!p.connections || p.connections.length === 0)) {
          p.connections = ['default'];
        }
      }

      state.serveProfiles = serveProfiles;
    } catch {
      // DB not available or data is invalid — that's OK
    }
  }

  app.get('/api/serve/status', async (_req, res) => {
    try {
      await ensureProfilesLoaded();
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
        const row = state.db.raw
          .prepare("SELECT data FROM profiles WHERE key = 'main'")
          .get() as { data: string } | undefined;
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
        const p = profile as unknown as Record<string, unknown>;
        serveProfiles[name] = {
          name,
          label: (p.label as string) ?? name,
          configurations: p.configurations as string[] | undefined,
          selectedTables: (p.selectedTables as Record<string, string[]>) ?? {},
          tableOptions: p.tableOptions,
          columnMasking: p.columnMasking,
          authMode: p.authMode as ServeProfile['authMode'],
          oauthConfig: p.oauthConfig as ServeProfile['oauthConfig'],
          externalAuthConfig: p.externalAuthConfig as ServeProfile['externalAuthConfig'],
          responseMode: p.responseMode as ServeProfile['responseMode'],
          dataScopeRules: p.dataScopeRules as ServeProfile['dataScopeRules'],
          sharedTables: p.sharedTables as ServeProfile['sharedTables'],
          aiSettingNames: p.aiSettingNames as string[] | undefined,
        } as ServeProfile;
      }

      // Resolve configurations to get effective selectedTables
      const configsFile = readConfigurationsFile(state.db!);
      for (const [name, sp] of Object.entries(serveProfiles)) {
        if (sp.configurations && sp.configurations.length > 0) {
          const mergedTables: Record<string, string[]> = {};
          for (const cfgName of sp.configurations) {
            const cfg = configsFile.configurations[cfgName];
            if (cfg) {
              for (const [table, cols] of Object.entries(cfg.selectedTables)) {
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
          serveProfiles[name].selectedTables = mergedTables;
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
  app.post('/api/serve/refresh', async (_req, res) => {
    try {
      if (state.activeProfileNames.size === 0) {
        res.json({ success: true, refreshed: [] });
        return;
      }

      // Re-read profiles from SQLite
      let profilesData: Record<string, Record<string, unknown>> = {};
      if (state.db) {
        try {
          const row = state.db.raw
            .prepare("SELECT data FROM profiles WHERE key = 'main'")
            .get() as { data: string } | undefined;
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

      // Re-read configurations from SQLite
      const configsFile = state.db ? readConfigurationsFile(state.db) : { configurations: {} };

      const refreshedNames: string[] = [];

      for (const name of state.activeProfileNames) {
        const profileRaw = profilesData[name];
        if (!profileRaw) continue;

        // Rebuild the ServeProfile with fresh data
        const updatedProfile: ServeProfile = {
          name,
          label: (profileRaw.label as string) ?? name,
          configurations: profileRaw.configurations as string[] | undefined,
          selectedTables: (profileRaw.selectedTables as Record<string, string[]>) ?? {},
          tableOptions: profileRaw.tableOptions,
          columnMasking: profileRaw.columnMasking,
          authMode: profileRaw.authMode as ServeProfile['authMode'],
          oauthConfig: profileRaw.oauthConfig as ServeProfile['oauthConfig'],
          externalAuthConfig: profileRaw.externalAuthConfig as ServeProfile['externalAuthConfig'],
          responseMode: profileRaw.responseMode as ServeProfile['responseMode'],
          dataScopeRules: profileRaw.dataScopeRules as ServeProfile['dataScopeRules'],
          sharedTables: profileRaw.sharedTables as ServeProfile['sharedTables'],
          aiSettingNames: profileRaw.aiSettingNames as string[] | undefined,
        } as ServeProfile;

        // If profile uses configurations, resolve them to get the latest selectedTables
        if (updatedProfile.configurations && updatedProfile.configurations.length > 0) {
          const mergedTables: Record<string, string[]> = {};
          for (const cfgName of updatedProfile.configurations) {
            const cfg = configsFile.configurations[cfgName];
            if (cfg) {
              for (const [table, cols] of Object.entries(cfg.selectedTables)) {
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
          updatedProfile.selectedTables = mergedTables;
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
