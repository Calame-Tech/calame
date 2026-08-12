/**
 * "Connect to Claude Desktop" integration — one click wires a Calame MCP
 * profile into the user's local `claude_desktop_config.json` via the
 * `mcp-remote` stdio<->HTTP bridge (vendored, see
 * `./claude-desktop/mcp-remote-resolve.ts`), so Claude Desktop can talk to
 * Calame's HTTP-only MCP endpoint without any extra install on the client
 * machine.
 *
 * Registered exactly like the other `/api/*` routes (see `../app.ts`) — the
 * generic `app.use('/api', createAdminSessionMiddleware(...))` middleware
 * already protects everything registered here; no extra auth wiring needed.
 */

import type { Express } from 'express';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type { AppState } from '../state.js';
import { DEFAULT_TENANT_ID, getTenantId } from '../tenancy.js';
import { buildMcpPath } from '../utils/mcp-url.js';
import { isServeProfileActive } from './serve/routing.js';
import {
  resolveClaudeDesktopConfigDir,
  resolveClaudeDesktopConfigPath,
} from './claude-desktop/paths.js';
import { resolveMcpRemoteEntry } from './claude-desktop/mcp-remote-resolve.js';
import {
  ClaudeDesktopConfigCorruptError,
  listMcpServerEntries,
  upsertMcpServerEntry,
} from './claude-desktop/config-writer.js';
import {
  listProfileNamesForTenant,
  profileExistsForTenant,
} from './claude-desktop/profile-lookup.js';
import { buildServerKey } from './claude-desktop/keys.js';

// Shared alphabet check for a body-supplied tenant id — mirrors
// `MCP_TENANT_ID_RE` in `./serve/routing.ts` / `TENANT_ID_RE` in
// `../tenancy.ts`. Duplicated locally (both are private to their modules)
// rather than exported solely for this one extra call site.
const TENANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const connectSchema = z.object({
  profileName: z.string().min(1, 'profileName is required'),
  tenantId: z.string().regex(TENANT_ID_RE, 'Invalid tenant id format.').optional(),
});

export function registerClaudeDesktopRoute(app: Express, state: AppState): void {
  // GET /api/integrations/claude-desktop/status
  app.get('/api/integrations/claude-desktop/status', (req, res) => {
    try {
      const overrideDir = state.config?.claudeDesktopConfigDir ?? undefined;
      const configDir = resolveClaudeDesktopConfigDir({ overrideDir });
      const configPath = path.join(configDir, 'claude_desktop_config.json');

      // Always true: resolveClaudeDesktopConfigDir has a fallback for every
      // process.platform value, so the location is always resolvable. This
      // endpoint is admin-authenticated already, so packaged-vs-dev adds no
      // further gate worth expressing here — see module docstring in
      // ./claude-desktop/paths.ts.
      const supported = true;

      // "Detected" = Claude Desktop's config DIRECTORY exists, i.e. the app
      // has been installed and run at least once on this machine.
      const detected = fs.existsSync(configDir);

      const tenantId = getTenantId(req);
      const rawEntries = listMcpServerEntries(configPath);
      const knownProfileNames = listProfileNamesForTenant(state, tenantId);

      const entries = Object.keys(rawEntries).map((key) => ({
        key,
        profileName:
          knownProfileNames.find((name) => buildServerKey(name, tenantId) === key) ?? null,
      }));

      res.json({ success: true, supported, detected, configPath, entries });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Error', {
        component: 'integrations/claude-desktop/status',
        error: message,
      });
      res.status(500).json({ success: false, message });
    }
  });

  // POST /api/integrations/claude-desktop/connect
  app.post('/api/integrations/claude-desktop/connect', async (req, res) => {
    try {
      const parsed = connectSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          message: parsed.error.issues[0]?.message ?? 'Invalid request body',
        });
        return;
      }
      const { profileName } = parsed.data;
      const tenantId = parsed.data.tenantId ?? getTenantId(req);

      if (!profileExistsForTenant(state, tenantId, profileName)) {
        res.status(404).json({ success: false, message: `Profile "${profileName}" not found.` });
        return;
      }
      if (!isServeProfileActive(state, tenantId, profileName)) {
        res.status(400).json({
          success: false,
          message: `Profile "${profileName}" is not active. Start serving it from the Serve tab, then try connecting again.`,
        });
        return;
      }

      const tokenManager = state.tokenManager;
      if (!tokenManager) {
        res.status(500).json({ success: false, message: 'Token manager not initialized.' });
        return;
      }

      // Contract: tokens are hashed / shown-once in this system (see
      // ../token.ts) — there is no way to retrieve a previously issued
      // token's plaintext without the admin re-confirming their password
      // through the separate "reveal" flow. So we always mint a fresh
      // token dedicated to this integration rather than trying to "reuse"
      // one. Revoking it later works exactly like any other token, through
      // the existing /api/tokens UI/API (same tenant, same profile).
      const label = `claude-desktop:${profileName}`;
      const tokenEntry = tokenManager.generateToken(profileName, label, tenantId);

      const packaged = state.config?.packaged ?? false;
      const mcpRemoteEntry = resolveMcpRemoteEntry({ packaged });
      const port = state.config?.port ?? 4567;
      const mcpUrl = `http://127.0.0.1:${port}${buildMcpPath(profileName, tenantId)}`;

      const command = process.execPath;
      const args = [
        mcpRemoteEntry,
        mcpUrl,
        '--header',
        `Authorization: Bearer ${tokenEntry._plaintextToken}`,
      ];

      const overrideDir = state.config?.claudeDesktopConfigDir ?? undefined;
      const configPath = resolveClaudeDesktopConfigPath({ overrideDir });
      const serverKey = buildServerKey(profileName, tenantId);

      try {
        upsertMcpServerEntry(configPath, serverKey, { command, args });
      } catch (err) {
        if (err instanceof ClaudeDesktopConfigCorruptError) {
          res.status(400).json({ success: false, message: err.message });
          return;
        }
        throw err;
      }

      res.json({ success: true, serverKey, configPath });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Error', {
        component: 'integrations/claude-desktop/connect',
        error: message,
      });
      res.status(500).json({ success: false, message });
    }
  });

  // GET /api/integrations/claude-desktop/snippet?profileName=&tenantId=
  app.get('/api/integrations/claude-desktop/snippet', (req, res) => {
    try {
      const profileNameRaw = req.query.profileName;
      const profileName = typeof profileNameRaw === 'string' ? profileNameRaw : '';
      if (!profileName) {
        res.status(400).json({ success: false, message: 'profileName is required.' });
        return;
      }

      const tenantIdRaw = req.query.tenantId;
      let tenantId = DEFAULT_TENANT_ID;
      if (typeof tenantIdRaw === 'string' && tenantIdRaw.length > 0) {
        if (!TENANT_ID_RE.test(tenantIdRaw)) {
          res.status(400).json({ success: false, message: 'Invalid tenant id format.' });
          return;
        }
        tenantId = tenantIdRaw;
      }

      const mcpPath = buildMcpPath(profileName, tenantId);
      const serverKey = buildServerKey(profileName, tenantId);

      // Deliberately no token minted here — this snippet is meant to be
      // copy/pasted onto another machine or handed to another MCP client;
      // <TOKEN> and <YOUR-CALAME-HOST> are placeholders the user fills in.
      const snippetConfig = {
        mcpServers: {
          [serverKey]: {
            command: 'npx',
            args: [
              '-y',
              'mcp-remote',
              `http://<YOUR-CALAME-HOST>${mcpPath}`,
              '--header',
              'Authorization: Bearer <TOKEN>',
            ],
          },
        },
      };

      res.json({ success: true, snippet: JSON.stringify(snippetConfig, null, 2) });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Error', {
        component: 'integrations/claude-desktop/snippet',
        error: message,
      });
      res.status(500).json({ success: false, message });
    }
  });
}
