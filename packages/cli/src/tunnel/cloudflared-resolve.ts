/**
 * Resolve the absolute path to the `cloudflared` binary that powers the
 * "Expose for Copilot / ChatGPT" tunnel feature (see `./manager.ts`), mirroring
 * `../routes/claude-desktop/mcp-remote-resolve.ts`'s packaged-vs-dev split —
 * except `cloudflared` is a standalone native binary (not an npm package), so
 * there is no `node_modules` fallback to resolve it from; it has to be staged
 * ahead of time by `scripts/prepare-desktop.mjs`.
 *
 * Resolution order:
 *   1. `overridePath` (wired from `AppConfig.cloudflaredPath` /
 *      `CALAME_CLOUDFLARED_PATH`) — the Tauri desktop app sets this env var
 *      to the resource path it bundled `cloudflared.exe` at (see
 *      `apps/desktop/src-tauri/src/server.rs`), so this wins unconditionally
 *      when set.
 *   2. Packaged mode (Tauri sidecar) without the env var: sibling
 *      `cloudflared[.exe]` next to the bundled `server.mjs` — same directory
 *      `mcp-remote.mjs` sits in (`resources/server/` once staged).
 *   3. Dev mode (monorepo, `pnpm dev` / tests): a cached download under
 *      `node_modules/.cache/calame-desktop/cloudflared[.exe]`, staged there by
 *      `scripts/prepare-desktop.mjs` (see that script's cloudflared section).
 *
 * Deliberately does NOT auto-download at runtime — a missing binary in dev
 * mode is reported via `unavailableReason` instead, pointing at the prepare
 * script.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface ResolveCloudflaredPathOptions {
  /**
   * Override wired from `AppConfig.cloudflaredPath` (`CALAME_CLOUDFLARED_PATH`).
   * Wins over every other strategy below, but is validated to actually exist —
   * an env var pointing at a stale/missing path must not silently report
   * "available".
   */
  overridePath?: string | null;
  /** Whether the server is running in packaged desktop mode. */
  packaged: boolean;
  /**
   * Override for the packaged-mode base directory (the directory
   * `cloudflared[.exe]` is expected to sit in). Defaults to this module's own
   * directory at runtime — override only in tests.
   */
  packagedBaseDir?: string;
  /**
   * Override for the dev-mode cache directory. Defaults to
   * `node_modules/.cache/calame-desktop` at the repo root — override only in
   * tests, so they don't depend on a real cached download existing.
   */
  devCacheDir?: string;
  /** Defaults to `process.platform`. Override for tests. */
  platform?: NodeJS.Platform;
  /** Defaults to `fs.existsSync`. Override for tests. */
  existsFn?: (candidate: string) => boolean;
}

export interface CloudflaredResolution {
  /** Absolute path to the resolved binary, or `null` when unavailable. */
  path: string | null;
  /** True iff `path` is non-null — a binary was found on disk. */
  available: boolean;
  /** Human-readable reason `path` is null. Always `null` when `available` is true. */
  unavailableReason: string | null;
}

// packages/cli/src/tunnel/cloudflared-resolve.ts -> repo root is 4 levels up
// (tunnel -> src -> cli -> packages -> <root>). Only used in dev mode (see
// resolveCloudflaredPath); packaged mode never reaches this constant.
const DEFAULT_DEV_CACHE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'node_modules/.cache/calame-desktop',
);

function found(candidate: string): CloudflaredResolution {
  return { path: candidate, available: true, unavailableReason: null };
}

function notFound(reason: string): CloudflaredResolution {
  return { path: null, available: false, unavailableReason: reason };
}

export function resolveCloudflaredPath(opts: ResolveCloudflaredPathOptions): CloudflaredResolution {
  const platform = opts.platform ?? process.platform;
  const existsFn = opts.existsFn ?? fs.existsSync;
  const binaryName = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';

  // Join with the path flavour matching the *target* platform rather than the
  // host running this code — otherwise unit tests exercising the win32
  // branch on a non-Windows host (or vice versa) would produce paths with
  // the wrong separator even though the logic itself is correct. Mirrors
  // `../routes/claude-desktop/paths.ts`. In production `platform` always
  // equals `process.platform` (no override), so this is a no-op there.
  const joiner = platform === 'win32' ? path.win32 : path.posix;

  if (opts.overridePath) {
    if (existsFn(opts.overridePath)) return found(opts.overridePath);
    return notFound(
      `CALAME_CLOUDFLARED_PATH is set to "${opts.overridePath}", but no file exists there.`,
    );
  }

  if (opts.packaged) {
    const baseDir = opts.packagedBaseDir ?? path.dirname(fileURLToPath(import.meta.url));
    const candidate = joiner.join(baseDir, binaryName);
    if (existsFn(candidate)) return found(candidate);
    return notFound(
      `cloudflared binary not found next to the bundled server (looked at "${candidate}").`,
    );
  }

  const cacheDir = opts.devCacheDir ?? DEFAULT_DEV_CACHE_DIR;
  const candidate = joiner.join(cacheDir, binaryName);
  if (existsFn(candidate)) return found(candidate);
  return notFound(
    `cloudflared binary not found (looked at "${candidate}"). Run "node scripts/prepare-desktop.mjs" ` +
      `to download it, or set CALAME_CLOUDFLARED_PATH to an existing cloudflared install.`,
  );
}
