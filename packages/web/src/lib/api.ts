/**
 * Centralised fetch wrapper that injects X-Tenant-Id on every request.
 *
 * Phase C of multi-tenancy: the current tenant is stored in localStorage and
 * forwarded via the HTTP header validated by packages/cli/src/tenancy.ts.
 * The backend regex is ^[A-Za-z0-9_-]{1,64}$; this module mirrors that
 * constraint for client-side validation.
 */

export const TENANT_STORAGE_KEY = 'calame.tenant';
export const TENANT_HISTORY_KEY = 'calame.tenants.history';

/** Regex that mirrors the backend tenancy.ts validation. */
export const TENANT_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Returns the tenant id stored in localStorage, or 'default' when absent.
 * Safe to call during SSR (no window access).
 */
export function getCurrentTenant(): string {
  if (typeof window === 'undefined') return 'default';
  return localStorage.getItem(TENANT_STORAGE_KEY) ?? 'default';
}

/**
 * Persists the tenant id to localStorage.
 * Passing 'default' removes the key so the default behaviour is transparent.
 */
export function setCurrentTenant(tenant: string): void {
  if (typeof window === 'undefined') return;
  if (tenant === 'default') {
    localStorage.removeItem(TENANT_STORAGE_KEY);
  } else {
    localStorage.setItem(TENANT_STORAGE_KEY, tenant);
  }
}

/**
 * Returns the list of previously used tenant ids from localStorage history.
 * Always returns an array (empty when no history exists).
 */
export function getTenantHistory(): string[] {
  if (typeof window === 'undefined') return [];
  const stored = localStorage.getItem(TENANT_HISTORY_KEY);
  if (!stored) return [];
  try {
    const list = JSON.parse(stored) as unknown;
    if (Array.isArray(list)) return list.filter((t): t is string => typeof t === 'string');
  } catch {
    // Malformed storage entry — ignore.
  }
  return [];
}

/**
 * Adds a tenant id to the history list, deduplicating it.
 * Does not include 'default' (it is always implicitly available).
 */
export function addTenantToHistory(tenant: string): void {
  if (typeof window === 'undefined') return;
  if (tenant === 'default') return;
  const current = getTenantHistory();
  const updated = Array.from(new Set([...current, tenant]));
  localStorage.setItem(TENANT_HISTORY_KEY, JSON.stringify(updated));
}

/**
 * Removes a tenant id from the history list.
 * Does not affect the currently active tenant.
 */
export function removeTenantFromHistory(tenant: string): void {
  if (typeof window === 'undefined') return;
  const updated = getTenantHistory().filter((t) => t !== tenant);
  localStorage.setItem(TENANT_HISTORY_KEY, JSON.stringify(updated));
}

/**
 * Drop-in replacement for fetch() that automatically injects X-Tenant-Id
 * when the current tenant is not 'default'. Existing headers on `init` are
 * preserved.
 *
 * Usage:
 *   const res = await apiFetch('/api/profiles/load', { credentials: 'include' });
 */
export async function apiFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const tenant = getCurrentTenant();
  const headers = new Headers(init?.headers);
  if (tenant !== 'default') {
    headers.set('X-Tenant-Id', tenant);
  }
  return fetch(input, { ...init, headers });
}

// ---------------------------------------------------------------------------
// Convenience helpers — thin wrappers used throughout the codebase.
// ---------------------------------------------------------------------------

/** GET /api/… → parsed JSON */
export function apiGet<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  return apiFetch(url, { credentials: 'include', ...init }).then((r) => r.json() as Promise<T>);
}

/** POST /api/… with JSON body → raw Response (caller handles .json()) */
export function apiPost(url: string, body: unknown, init?: RequestInit): Promise<Response> {
  return apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
}

/** PATCH /api/… with JSON body → raw Response */
export function apiPatch(url: string, body: unknown, init?: RequestInit): Promise<Response> {
  return apiFetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
}

/** DELETE /api/… → raw Response */
export function apiDelete(url: string, init?: RequestInit): Promise<Response> {
  return apiFetch(url, { method: 'DELETE', ...init });
}
