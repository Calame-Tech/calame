/**
 * In-memory draft of the "new MCP server" form (tester feedback #11).
 *
 * The creation form lives in ServePanel's component state, which is destroyed
 * as soon as the MCP list page unmounts — so a detour through Sources or Data
 * configurations silently threw the half-filled form away. The draft is kept
 * here, outside the React tree, for the lifetime of the app window only
 * (nothing is written to disk or to the server, and no MCP is created until
 * the explicit "Create").
 *
 * Lifecycle:
 * - written on every edit while the form is open;
 * - cleared after a successful creation or an explicit "Cancel" (the form
 *   closes → `setMcpDraft(key, null)`);
 * - wiped entirely when the admin session ends (logout / lost session), see
 *   SessionProvider.
 *
 * Drafts are keyed by account and workspace (tenant), and each draft carries
 * the data configuration it was started with: it is only restored for that
 * same configuration (or when none is requested), never merged into another.
 */

export interface McpCreateDraft {
  label: string;
  name: string;
  /** The preselected data configuration is included in the new server. */
  withPrefill: boolean;
  /** Data configuration the draft was started with (guided configuration → server step). */
  prefillConfiguration?: string;
}

const drafts = new Map<string, McpCreateDraft>();

/** Draft key for an account (admin email, '' when auth is disabled) in a workspace. */
export function mcpDraftKey(account: string, tenant: string): string {
  return JSON.stringify([account, tenant]);
}

/**
 * The draft to restore for `key`, or undefined. When a specific data
 * configuration is requested, a draft started for another one is ignored.
 */
export function getMcpDraft(
  key: string,
  prefillConfiguration?: string,
): McpCreateDraft | undefined {
  const draft = drafts.get(key);
  if (!draft) return undefined;
  if (prefillConfiguration !== undefined && draft.prefillConfiguration !== prefillConfiguration) {
    return undefined;
  }
  return draft;
}

/** Saves (or, with `null`, discards) the draft for `key`. */
export function setMcpDraft(key: string, draft: McpCreateDraft | null): void {
  if (draft) drafts.set(key, { ...draft });
  else drafts.delete(key);
}

/** Discards every draft — called when the admin session ends. */
export function clearMcpDrafts(): void {
  drafts.clear();
}
