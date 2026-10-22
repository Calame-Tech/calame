// Profile persistence helpers (Phase 3 #14). Extracted verbatim from App.tsx
// so the per-domain pages and the shared data hook can serialize/persist
// profiles without depending on the App module.

import { apiFetch } from './api.js';
import type { Profile } from '../types/schema.js';

export function createDefaultProfile(): Profile {
  return { name: 'default', label: 'Default' };
}

/**
 * Options a freshly created MCP starts with. They match the backend fallbacks
 * (`authMode ?? 'token'` in routes/serve.ts and routes/chat-auth.ts,
 * `responseMode ?? 'friendly'`, file writes off unless opted in) but are written
 * explicitly so a new MCP never relies on implicit behaviour:
 * - authMode 'token': clients need an API key — never open access.
 * - responseMode 'friendly': plain-language answers, no table/column names.
 * - documentWrite disabled: read-only, no file creation or editing.
 * Masking, data scoping and network restrictions are untouched: they live on
 * the configurations / global settings, not on the new profile.
 */
export const NEW_MCP_DEFAULTS = {
  authMode: 'token',
  responseMode: 'friendly',
  documentWrite: { enabled: false, sources: {} },
} as const satisfies Pick<Profile, 'authMode' | 'responseMode' | 'documentWrite'>;

/** Build a new MCP profile with the safe defaults above. */
export function createNewProfile(name: string, label: string): Profile {
  return {
    name,
    label,
    ...newMcpDefaults(),
  };
}

/**
 * Fresh copy of NEW_MCP_DEFAULTS (the nested `documentWrite` object must not
 * be shared between profiles, which mutate it when the user edits them).
 */
export function newMcpDefaults(): Pick<Profile, 'authMode' | 'responseMode' | 'documentWrite'> {
  return {
    authMode: NEW_MCP_DEFAULTS.authMode,
    responseMode: NEW_MCP_DEFAULTS.responseMode,
    documentWrite: {
      enabled: NEW_MCP_DEFAULTS.documentWrite.enabled,
      sources: { ...NEW_MCP_DEFAULTS.documentWrite.sources },
    },
  };
}

/**
 * True only when the server confirms no saved profile has this name. Used to
 * apply NEW_MCP_DEFAULTS without overwriting an existing profile's settings
 * (POST /api/profiles/save merges fields). When existence cannot be checked
 * it answers false: omitting the defaults is safe, the backend fallbacks are
 * the same values.
 */
export async function isNewProfileName(name: string): Promise<boolean> {
  try {
    const res = await apiFetch('/api/profiles/load', { credentials: 'include' });
    if (!res.ok) return false;
    const data = (await res.json()) as { found?: boolean; profiles?: Record<string, unknown> };
    return !data.found || !Object.prototype.hasOwnProperty.call(data.profiles ?? {}, name);
  } catch {
    return false;
  }
}

/** NEW_MCP_DEFAULTS for a profile name not saved yet, nothing otherwise. */
export async function newMcpDefaultsFor(
  name: string,
): Promise<Partial<Pick<Profile, 'authMode' | 'responseMode' | 'documentWrite'>>> {
  return (await isNewProfileName(name)) ? newMcpDefaults() : {};
}

/**
 * Derive a URL-safe profile name from a human-readable label. The backend
 * chat/auth routes only accept `[a-zA-Z0-9_-]+` profile names, so every
 * profile-creation UI must go through this (the label keeps the raw text).
 */
export function slugifyProfileName(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/** Convert Set-based selection to array-based for Profile storage */
export function setsToArrays(sel: Record<string, Set<string>>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(sel)) {
    result[k] = Array.from(v);
  }
  return result;
}

/** Convert array-based selection to Set-based for UI usage */
export function arraysToSets(sel: Record<string, string[]>): Record<string, Set<string>> {
  const result: Record<string, Set<string>> = {};
  for (const [k, v] of Object.entries(sel)) {
    result[k] = new Set(v);
  }
  return result;
}

/**
 * POST a serialized profiles map to the backend. Returns the raw fetch Response
 * so each caller can choose its own error strategy (await + throw, fire-and-forget,
 * chained .then()).
 */
export function persistProfiles(
  profiles: Record<string, Record<string, unknown>>,
): Promise<Response> {
  return apiFetch('/api/profiles/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profiles }),
  });
}

/**
 * Serialize a Profile array into the shape expected by persistProfiles / /api/profiles/save.
 *
 * Phase 5: drops the legacy `selectedTables` / `tableOptions` / `columnMasking` /
 * `connections` projections — the backend `upgradeProfileShape` migrator runs at
 * the save boundary and folds anything legacy back into `sources` / `scopes` when
 * needed. New writes therefore carry only the unified shape.
 */
export function buildProfilesData(profiles: Profile[]): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const p of profiles) {
    result[p.name] = {
      label: p.label,
      configurations: p.configurations,
      authMode: p.authMode,
      oauthConfig: p.oauthConfig,
      externalAuthConfig: p.externalAuthConfig,
      responseMode: p.responseMode,
      documentWrite: p.documentWrite,
      aiInstructions: p.aiInstructions,
      dataScopeRules: p.dataScopeRules,
      sharedTables: p.sharedTables,
      aiSettingNames: p.aiSettingNames,
      sources: p.sources,
      scopes: p.scopes,
    };
  }
  return result;
}
