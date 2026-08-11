/**
 * Read/merge/write helpers for `claude_desktop_config.json`.
 *
 * These never clobber the file blindly: an existing file is parsed first (a
 * corrupt file throws `ClaudeDesktopConfigCorruptError` instead of being
 * silently overwritten), a timestamped `.bak` copy is written next to it
 * before any write, and the merge only ever touches our own key inside
 * `mcpServers` — every other key (other MCP servers a user configured by
 * hand, or top-level Claude Desktop settings) passes through untouched.
 */

import fs from 'fs';
import path from 'path';

export interface ClaudeDesktopMcpServerEntry {
  command: string;
  args: string[];
}

export interface ClaudeDesktopConfig {
  mcpServers?: Record<string, ClaudeDesktopMcpServerEntry>;
  [key: string]: unknown;
}

/**
 * Thrown when `claude_desktop_config.json` exists but is not valid JSON.
 * Route handlers must translate this into a 400 and must NOT attempt to
 * write anything — the corrupt file is left exactly as found so the user
 * can recover it manually.
 */
export class ClaudeDesktopConfigCorruptError extends Error {
  constructor(
    public readonly configPath: string,
    cause: unknown,
  ) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(
      `Claude Desktop config at "${configPath}" is not valid JSON (${causeMessage}). ` +
        `Fix or remove the file manually, then try connecting again.`,
    );
    this.name = 'ClaudeDesktopConfigCorruptError';
  }
}

/**
 * Read and parse `claude_desktop_config.json`.
 * Returns `{}` when the file (or its parent directory) doesn't exist yet —
 * that is the normal "Claude Desktop never configured any MCP server" state,
 * not an error. Throws {@link ClaudeDesktopConfigCorruptError} when the file
 * exists but isn't valid JSON, or isn't a JSON object.
 */
export function readClaudeDesktopConfig(configPath: string): ClaudeDesktopConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ClaudeDesktopConfigCorruptError(configPath, err);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ClaudeDesktopConfigCorruptError(
      configPath,
      new Error('expected a top-level JSON object'),
    );
  }
  return parsed as ClaudeDesktopConfig;
}

/**
 * List the current `mcpServers` entries, tolerating a missing file/dir
 * (returns `{}`) AND a corrupt file (also returns `{}` rather than
 * throwing) — this is used by the read-only status endpoint, which must
 * stay resilient even when the config is broken; `connect` is the endpoint
 * that surfaces corruption as an error, because that is the operation that
 * would otherwise silently clobber it.
 */
export function listMcpServerEntries(
  configPath: string,
): Record<string, ClaudeDesktopMcpServerEntry> {
  try {
    return readClaudeDesktopConfig(configPath).mcpServers ?? {};
  } catch {
    return {};
  }
}

/**
 * Merge a single `mcpServers` entry into the config file and persist it:
 *   1. Read-if-exists (tolerating a missing file/dir; throws on corrupt JSON
 *      — the caller must not have side effects in that case, and this
 *      function performs none of its own writes before this call succeeds).
 *   2. If a file existed, copy it to a timestamped `.bak` sibling.
 *   3. Write the merged config (existing keys and other `mcpServers`
 *      entries preserved; only `serverKey` is added/replaced).
 *
 * Returns the merged config that was written.
 */
export function upsertMcpServerEntry(
  configPath: string,
  serverKey: string,
  entry: ClaudeDesktopMcpServerEntry,
): ClaudeDesktopConfig {
  const existing = readClaudeDesktopConfig(configPath); // throws ClaudeDesktopConfigCorruptError — no writes happen below in that case.

  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(configPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${configPath}.${stamp}.bak`;
    fs.copyFileSync(configPath, backupPath);
  }

  const merged: ClaudeDesktopConfig = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      [serverKey]: entry,
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  return merged;
}
