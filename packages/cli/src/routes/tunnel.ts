/**
 * "Expose for Copilot / ChatGPT" — cloud AI platforms (Microsoft Copilot
 * Studio, ChatGPT connectors) can only reach MCP servers over public HTTPS.
 * This wraps Cloudflare's zero-account "quick tunnel"
 * (`cloudflared tunnel --url http://127.0.0.1:<port>`), which prints a public
 * `https://<random>.trycloudflare.com` URL that proxies straight through to
 * this Calame instance — still bearer-token protected on every `/mcp/*`
 * endpoint, the tunnel only changes *reachability*, not auth.
 *
 * Registered exactly like the other `/api/*` routes (see `../app.ts`) — the
 * generic `app.use('/api', createAdminSessionMiddleware(...))` middleware
 * already protects everything registered here; no extra auth wiring needed.
 *
 * The actual child-process lifecycle lives in `./tunnel/manager.ts`
 * (`AppState.tunnelManager`, created lazily here) and binary resolution in
 * `./tunnel/cloudflared-resolve.ts` — this file is just the thin HTTP layer.
 */

import type { Express } from 'express';
import type { AppState } from '../state.js';
import { TunnelManager } from '../tunnel/manager.js';
import { resolveCloudflaredPath } from '../tunnel/cloudflared-resolve.js';

/** Lazily create (once per process) and return the shared TunnelManager. */
function getOrCreateTunnelManager(state: AppState): TunnelManager {
  if (!state.tunnelManager) {
    state.tunnelManager = new TunnelManager({
      resolveCloudflaredPath: () =>
        resolveCloudflaredPath({
          overridePath: state.config?.cloudflaredPath ?? undefined,
          packaged: state.config?.packaged ?? false,
        }),
      getLocalPort: () => state.config?.port ?? 4567,
      logger: state.logger,
    });
  }
  return state.tunnelManager;
}

export function registerTunnelRoute(app: Express, state: AppState): void {
  // GET /api/tunnel/status
  app.get('/api/tunnel/status', (_req, res) => {
    try {
      const manager = getOrCreateTunnelManager(state);
      res.json({ success: true, ...manager.getStatus() });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Error', { component: 'tunnel/status', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  // POST /api/tunnel/start
  app.post('/api/tunnel/start', async (_req, res) => {
    try {
      const manager = getOrCreateTunnelManager(state);
      const result = await manager.start();
      if (result.success) {
        res.json({ success: true, url: result.url });
        return;
      }

      // Distinguish "cloudflared isn't installed at all" (503 — nothing was
      // even attempted) from "an attempt was made and failed" (502 — timeout,
      // spawn error, or the process exiting before printing a URL). Matches
      // the API contract's explicit "timeout 30s -> kill + 502" requirement.
      const status = manager.getStatus().available ? 502 : 503;
      state.logger?.warn('Tunnel start failed', {
        component: 'tunnel/start',
        message: result.message,
      });
      res.status(status).json({ success: false, message: result.message });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Error', { component: 'tunnel/start', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  // POST /api/tunnel/stop
  app.post('/api/tunnel/stop', async (_req, res) => {
    try {
      const manager = getOrCreateTunnelManager(state);
      await manager.stop();
      res.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Error', { component: 'tunnel/stop', error: message });
      res.status(500).json({ success: false, message });
    }
  });
}
