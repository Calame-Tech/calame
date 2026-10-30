/**
 * In-memory drafts of unsaved data-configuration edits (captain feedback on
 * tester point #11, "Data config").
 *
 * The configuration detail page keeps its edits in component state, which is
 * destroyed as soon as the page unmounts — so a detour through Sources threw
 * away a checked knowledge base or the "disable direct document reading"
 * setting without warning. Same rules as the MCP creation draft (see
 * mcp-draft.ts): kept for the lifetime of the app window only, never written
 * to disk or to the server (nothing is saved before the explicit "Save").
 *
 * Lifecycle:
 * - written on every edit while the configuration has unsaved changes;
 * - cleared after a successful save, an explicit "Discard", or the deletion
 *   of the configuration;
 * - wiped entirely when the admin session ends (logout / lost session), see
 *   SessionProvider.
 *
 * Drafts are keyed by account, workspace (tenant) and configuration name:
 * a draft is only ever restored into the configuration it was made for.
 */

import { useCallback, useEffect, useState } from 'react';
import { getCurrentTenant } from './api.js';
import type { ColumnMasking, ScopeSelection, TableToolOptions } from '../types/schema.js';

export interface ConfigurationDraft {
  label: string;
  selectedConns: Set<string>;
  selectedTables: Record<string, Set<string>>;
  tableOptions: Record<string, TableToolOptions>;
  columnMasking: Record<string, Record<string, ColumnMasking>>;
  /** Knowledge-base selection edited in the Knowledge tab (null = untouched). */
  docSelection: { sources: string[]; scopes: Record<string, ScopeSelection> } | null;
  activeTab: 'databases' | 'knowledge';
}

const drafts = new Map<string, ConfigurationDraft>();

/** Draft key for a configuration of an account (admin email, '' when auth is disabled) in a workspace. */
export function configurationDraftKey(account: string, tenant: string, configName: string): string {
  return JSON.stringify([account, tenant, configName]);
}

export function getConfigurationDraft(key: string): ConfigurationDraft | undefined {
  return drafts.get(key);
}

/** Saves (or, with `null`, discards) the draft for `key`. */
export function setConfigurationDraft(key: string, draft: ConfigurationDraft | null): void {
  if (draft) drafts.set(key, draft);
  else drafts.delete(key);
}

/** Discards every draft — called when the admin session ends. */
export function clearConfigurationDrafts(): void {
  drafts.clear();
}

/**
 * Keeps the draft for `key` in step with the page's edits: the current edit
 * state while there are unsaved changes, no draft otherwise. Does nothing
 * until the saved configuration is known (`enabled`).
 */
export function useConfigurationDraftSync(
  key: string,
  enabled: boolean,
  unsavedEdits: ConfigurationDraft | null,
): void {
  useEffect(() => {
    if (enabled) setConfigurationDraft(key, unsavedEdits);
  });
}

/**
 * Draft key of a configuration for the current workspace, plus a "Discard"
 * that drops the draft and changes `viewKey` so the page remounts from the
 * saved configuration.
 */
export function useConfigurationDraftKey(account: string, configName: string) {
  const draftKey = configurationDraftKey(account, getCurrentTenant(), configName);
  const [resets, setResets] = useState(0);
  const discard = useCallback(() => {
    setConfigurationDraft(draftKey, null);
    setResets((n) => n + 1);
  }, [draftKey]);
  return { draftKey, viewKey: `${draftKey}:${resets}`, discard };
}
