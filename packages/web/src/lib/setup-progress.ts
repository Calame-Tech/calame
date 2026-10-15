// First-run setup progress. Guided path in four steps, following the real
// model: data → data profile → MCP → client. An MCP is attached to a data
// profile, never to data directly. Every step is derived from resources the
// server already reports — nothing is stored on the client — so the guide
// shows the same state after a reload.

import type { AuditLogEntry } from '../types/schema.js';
import type { RagSourceReadiness } from './rag-source-readiness.js';

export type SetupStepStatus = 'done' | 'current' | 'todo';

/** The four steps, in order. */
export const SETUP_STEPS = ['source', 'dataProfile', 'mcp', 'client'] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number];

/** A profile as returned by GET /api/profiles/load (only the fields used here). */
export interface SavedProfileSummary {
  name: string;
  configurations?: string[];
  sources?: unknown[];
}

/** A data profile as returned by GET /api/configurations (only the fields used here). */
export interface DataProfileSummary {
  name: string;
  sources?: string[];
}

export interface SetupProgressInput {
  /** Database connections known to the server. */
  sourceCount: number;
  /**
   * Knowledge-base sources with their sync state. Only a `ready` one (latest
   * sync completed) completes the step: a registered source whose sync failed
   * or is still running is not usable by an MCP yet.
   */
  ragSources?: RagSourceReadiness[];
  /** Data profiles (configurations) persisted on the server. */
  dataProfiles: DataProfileSummary[];
  /** MCP profiles actually persisted on the server (not the UI placeholder). */
  savedProfiles: SavedProfileSummary[];
  /** Audit log entries — written by the MCP server on every tool call. */
  auditEntries: AuditLogEntry[];
}

export interface SetupProgress {
  source: SetupStepStatus;
  dataProfile: SetupStepStatus;
  mcp: SetupStepStatus;
  client: SetupStepStatus;
  /** First step not done yet, and the one after it (null when none). */
  currentStep: SetupStepId | null;
  nextStep: SetupStepId | null;
  /** Number of completed steps (0–4). */
  doneCount: number;
  /** Knowledge-base sources whose latest sync failed. */
  failedSources: RagSourceReadiness[];
  /** Knowledge-base sources registered but not ready (sync failed, running or never run). */
  notReadySources: RagSourceReadiness[];
  /** Data profile the "create the MCP" action builds on, if any. */
  dataProfileName: string | null;
  /** MCP the "connect a client" action points to, if any. */
  mcpName: string | null;
  allDone: boolean;
}

/**
 * A data profile counts once it contains data (at least one source). The
 * synthetic `'default'` id backfilled on legacy shapes is not a real source.
 */
function dataProfilesWithData(dataProfiles: DataProfileSummary[]): Set<string> {
  return new Set(
    dataProfiles
      .filter((c) => (c.sources ?? []).filter((s) => s !== 'default').length > 0)
      .map((c) => c.name),
  );
}

/**
 * An MCP counts as created once it is saved attached to a data profile that
 * contains data. A saved profile without one — e.g. the `default` placeholder
 * re-persisted after deleting the last MCP — exposes no data, so a client
 * could not use it.
 */
export function mcpProfileNames(
  savedProfiles: SavedProfileSummary[],
  dataProfiles: DataProfileSummary[],
): string[] {
  const withData = dataProfilesWithData(dataProfiles);
  return savedProfiles
    .filter((p) => (p.configurations ?? []).some((c) => withData.has(c)))
    .map((p) => p.name);
}

export function computeSetupProgress({
  sourceCount,
  ragSources = [],
  dataProfiles,
  savedProfiles,
  auditEntries,
}: SetupProgressInput): SetupProgress {
  const profilesWithData = dataProfilesWithData(dataProfiles);
  const mcpNames = new Set(mcpProfileNames(savedProfiles, dataProfiles));
  // Observable proof of client use: a successful tool call recorded in the
  // audit log for one of these MCPs. Copying the URL or opening the
  // "Connect" tab proves nothing, so it never completes this step.
  const usedEntry = auditEntries.find((e) => e.result === 'success' && mcpNames.has(e.profileName));

  const done: Record<SetupStepId, boolean> = {
    source: sourceCount > 0 || ragSources.some((s) => s.state === 'ready'),
    dataProfile: profilesWithData.size > 0,
    mcp: mcpNames.size > 0,
    client: usedEntry !== undefined,
  };
  // A step is only "done" once every previous one is: a later resource built
  // on a missing earlier one does not make the path work.
  let blocked = false;
  const status = {} as Record<SetupStepId, SetupStepStatus>;
  for (const step of SETUP_STEPS) {
    if (!blocked && done[step]) {
      status[step] = 'done';
    } else {
      status[step] = blocked ? 'todo' : 'current';
      blocked = true;
    }
  }
  const currentIndex = SETUP_STEPS.findIndex((s) => status[s] === 'current');
  const currentStep = currentIndex === -1 ? null : SETUP_STEPS[currentIndex]!;

  return {
    ...status,
    currentStep,
    nextStep: currentIndex === -1 ? null : (SETUP_STEPS[currentIndex + 1] ?? null),
    doneCount: SETUP_STEPS.filter((s) => status[s] === 'done').length,
    failedSources: ragSources.filter((s) => s.state === 'failed'),
    notReadySources: ragSources.filter((s) => s.state !== 'ready'),
    dataProfileName: [...profilesWithData][0] ?? null,
    mcpName: usedEntry?.profileName ?? [...mcpNames][0] ?? null,
    allDone: currentStep === null,
  };
}
