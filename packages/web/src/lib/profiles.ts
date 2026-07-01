// Profile persistence helpers (Phase 3 #14). Extracted verbatim from App.tsx
// so the per-domain pages and the shared data hook can serialize/persist
// profiles without depending on the App module.

import { apiFetch } from './api.js';
import type { Profile } from '../types/schema.js';

export function createDefaultProfile(): Profile {
  return { name: 'default', label: 'Default' };
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
      dataScopeRules: p.dataScopeRules,
      sharedTables: p.sharedTables,
      aiSettingNames: p.aiSettingNames,
      sources: p.sources,
      scopes: p.scopes,
    };
  }
  return result;
}
