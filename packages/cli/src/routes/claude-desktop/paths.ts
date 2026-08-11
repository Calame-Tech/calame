/**
 * Platform-appropriate resolution of the Claude Desktop config file.
 *
 * Claude Desktop reads `mcpServers` entries from a single JSON file whose
 * location is fixed per OS:
 *   - Windows: %APPDATA%\Claude\claude_desktop_config.json
 *   - macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
 *   - Linux:   $XDG_CONFIG_HOME/Claude/claude_desktop_config.json
 *              (falling back to ~/.config/Claude when XDG_CONFIG_HOME is unset)
 *
 * This module never touches the filesystem — it only computes paths — so it
 * can be unit tested without risking a write to the real per-user Claude
 * config on the host machine running the test suite.
 */

import os from 'os';
import path from 'path';

export const CLAUDE_DESKTOP_CONFIG_FILENAME = 'claude_desktop_config.json';

export interface ClaudeDesktopPathOptions {
  /**
   * Explicit override for the config directory — wins over every platform
   * default below. Wired from `AppConfig.claudeDesktopConfigDir` /
   * `CALAME_CLAUDE_DESKTOP_CONFIG_DIR` in production, and used directly by
   * tests to point at a throwaway temp directory instead of the real
   * per-user Claude Desktop config.
   */
  overrideDir?: string | null;
  /** Defaults to `process.platform`. Override for tests. */
  platform?: NodeJS.Platform;
  /** Defaults to `os.homedir()`. Override for tests. */
  homedir?: string;
  /** Defaults to `process.env`. Override for tests. */
  env?: Record<string, string | undefined>;
}

/**
 * Resolve the directory Claude Desktop reads its config from.
 *
 * Always resolvable: every branch has a fallback, so this never throws.
 * That backs the `supported` flag in the status endpoint — see
 * `../claude-desktop.ts`.
 */
export function resolveClaudeDesktopConfigDir(opts: ClaudeDesktopPathOptions = {}): string {
  if (opts.overrideDir) return opts.overrideDir;

  const platform = opts.platform ?? process.platform;
  const homedir = opts.homedir ?? os.homedir();
  const env = opts.env ?? process.env;

  // Join with the path flavour matching the *target* platform rather than
  // the host running this code — otherwise unit tests that exercise the
  // win32 branch on a non-Windows CI runner (or vice versa) would produce
  // paths with the wrong separator even though the logic itself is correct.
  // In production `platform` always equals `process.platform` (no override),
  // so this is a no-op there: `path.win32`/`path.posix` behave exactly like
  // the ambient `path` module on their respective real OS.
  const joiner = platform === 'win32' ? path.win32 : path.posix;

  if (platform === 'win32') {
    const appData = env.APPDATA ?? joiner.join(homedir, 'AppData', 'Roaming');
    return joiner.join(appData, 'Claude');
  }
  if (platform === 'darwin') {
    return joiner.join(homedir, 'Library', 'Application Support', 'Claude');
  }
  // Linux and every other platform: XDG base dir spec, falling back to ~/.config.
  const xdgConfigHome = env.XDG_CONFIG_HOME;
  return joiner.join(xdgConfigHome || joiner.join(homedir, '.config'), 'Claude');
}

/** Resolve the full path to `claude_desktop_config.json`. */
export function resolveClaudeDesktopConfigPath(opts: ClaudeDesktopPathOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  const joiner = platform === 'win32' ? path.win32 : path.posix;
  return joiner.join(resolveClaudeDesktopConfigDir(opts), CLAUDE_DESKTOP_CONFIG_FILENAME);
}
