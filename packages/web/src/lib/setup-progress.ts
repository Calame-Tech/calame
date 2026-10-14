// First-run setup progress (guided path: source → MCP → client). Every step is
// derived from resources the server already reports — nothing is stored on
// the client — so the checklist shows the same state after a reload.

import type { AuditLogEntry } from '../types/schema.js';

export type SetupStepStatus = 'done' | 'current' | 'todo';

/** A profile as returned by GET /api/profiles/load (only the fields used here). */
export interface SavedProfileSummary {
  name: string;
  configurations?: string[];
  sources?: unknown[];
}

export interface SetupProgressInput {
  /** Database connections + knowledge-base sources known to the server. */
  sourceCount: number;
  /** Profiles actually persisted on the server (not the UI placeholder). */
  savedProfiles: SavedProfileSummary[];
  /** Audit log entries — written by the MCP server on every tool call. */
  auditEntries: AuditLogEntry[];
}

export interface SetupProgress {
  source: SetupStepStatus;
  mcp: SetupStepStatus;
  client: SetupStepStatus;
  /** MCP the "create" / "connect a client" actions point to, if any. */
  mcpName: string | null;
  allDone: boolean;
}

/**
 * An MCP counts as created once it is saved with data attached (a
 * configuration or an inline source). A saved profile without data — e.g. the
 * `default` placeholder re-persisted after deleting the last MCP — exposes no
 * tool, so a client could not use it.
 *
 * GET /api/profiles/load backfills `connections: ['default']` on profiles
 * without connections, and `upgradeProfileShape` derives `sources` from it, so
 * that synthetic `'default'` id is not evidence of an attached source.
 */
function hasData(p: SavedProfileSummary): boolean {
  const sources = (p.sources ?? []).filter((s) => s !== 'default');
  return (p.configurations?.length ?? 0) > 0 || sources.length > 0;
}

export function computeSetupProgress({
  sourceCount,
  savedProfiles,
  auditEntries,
}: SetupProgressInput): SetupProgress {
  const mcps = savedProfiles.filter(hasData);
  const mcpNames = new Set(mcps.map((p) => p.name));
  // Observable proof of client use: a successful tool call recorded in the
  // audit log for one of these MCPs. Copying the URL or opening the
  // "Connect" tab proves nothing, so it never completes this step.
  const usedEntry = auditEntries.find((e) => e.result === 'success' && mcpNames.has(e.profileName));

  const sourceDone = sourceCount > 0;
  const mcpDone = mcps.length > 0;
  const clientDone = mcpDone && usedEntry !== undefined;

  const source: SetupStepStatus = sourceDone ? 'done' : 'current';
  const mcp: SetupStepStatus = mcpDone ? 'done' : sourceDone ? 'current' : 'todo';
  const client: SetupStepStatus = clientDone ? 'done' : mcpDone ? 'current' : 'todo';

  return {
    source,
    mcp,
    client,
    mcpName: usedEntry?.profileName ?? mcps[0]?.name ?? null,
    allDone: sourceDone && mcpDone && clientDone,
  };
}
