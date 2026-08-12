/**
 * Resolve the absolute path to the `mcp-remote` stdio<->HTTP proxy entry
 * point that Claude Desktop should launch, so the client machine needs
 * nothing besides Calame itself (no global npm install of `mcp-remote`).
 *
 * Two resolution strategies, depending on how the server itself is running:
 *
 *   - Packaged mode (Tauri desktop app): `scripts/bundle-server.mjs` bundles
 *     `mcp-remote`'s CLI entry into `dist-bundle/mcp-remote.mjs`, sitting
 *     right next to the bundled `server.mjs`; `prepare-desktop.mjs` mirrors
 *     `dist-bundle/` into the Tauri resources dir unchanged. Since esbuild
 *     inlines *this* module's code into that same `server.mjs` bundle,
 *     `import.meta.url` at runtime resolves to the bundle's own location —
 *     i.e. exactly the directory `mcp-remote.mjs` was copied into.
 *
 *   - Dev mode (monorepo, `pnpm dev` / tests): resolve the installed
 *     `mcp-remote` npm package's CLI entry from `node_modules` directly.
 *     The package has no `exports` map restricting deep imports, so a plain
 *     `require.resolve('mcp-remote/dist/proxy.js')` finds it.
 */

import path from 'path';
import { fileURLToPath } from 'url';
// Aliased on purpose: the esbuild bundle (scripts/bundle-server.mjs) injects
// a banner that already declares a top-level `createRequire` binding; a
// same-named named-import here would collide with it in the flat bundle.
import { createRequire as nodeCreateRequire } from 'module';

export interface ResolveMcpRemoteEntryOptions {
  /** Whether the server is running in packaged desktop mode. */
  packaged: boolean;
  /**
   * Override for the packaged-mode base directory (the directory
   * `mcp-remote.mjs` is expected to sit in). Defaults to this module's own
   * directory at runtime — override only in tests, so they don't depend on
   * `dist-bundle/` actually existing.
   */
  packagedBaseDir?: string;
}

/**
 * Returns the absolute path to the mcp-remote proxy entry point (the file
 * to run as `node <entry> <url> --header ...`).
 */
export function resolveMcpRemoteEntry(opts: ResolveMcpRemoteEntryOptions): string {
  if (opts.packaged) {
    const baseDir = opts.packagedBaseDir ?? path.dirname(fileURLToPath(import.meta.url));
    return path.join(baseDir, 'mcp-remote.mjs');
  }

  const requireFromHere = nodeCreateRequire(import.meta.url);
  return requireFromHere.resolve('mcp-remote/dist/proxy.js');
}
