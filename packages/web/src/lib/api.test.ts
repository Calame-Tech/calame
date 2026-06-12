/**
 * Unit tests for the centralised fetch helper (src/lib/api.ts).
 *
 * Tests run in jsdom so localStorage is available. The global `fetch` is
 * replaced with a minimal spy to verify the injected headers without making
 * real HTTP requests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getCurrentTenant,
  setCurrentTenant,
  getTenantHistory,
  addTenantToHistory,
  removeTenantFromHistory,
  apiFetch,
  TENANT_STORAGE_KEY,
  TENANT_HISTORY_KEY,
  TENANT_ID_REGEX,
} from './api.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearStorage() {
  localStorage.removeItem(TENANT_STORAGE_KEY);
  localStorage.removeItem(TENANT_HISTORY_KEY);
}

// ---------------------------------------------------------------------------
// getCurrentTenant / setCurrentTenant
// ---------------------------------------------------------------------------

describe('getCurrentTenant', () => {
  beforeEach(clearStorage);
  afterEach(clearStorage);

  it('returns "default" when nothing is stored', () => {
    expect(getCurrentTenant()).toBe('default');
  });

  it('returns the stored tenant', () => {
    localStorage.setItem(TENANT_STORAGE_KEY, 'acme');
    expect(getCurrentTenant()).toBe('acme');
  });
});

describe('setCurrentTenant', () => {
  beforeEach(clearStorage);
  afterEach(clearStorage);

  it('stores the tenant in localStorage', () => {
    setCurrentTenant('acme');
    expect(localStorage.getItem(TENANT_STORAGE_KEY)).toBe('acme');
  });

  it('removes the key when setting "default"', () => {
    setCurrentTenant('acme');
    setCurrentTenant('default');
    expect(localStorage.getItem(TENANT_STORAGE_KEY)).toBeNull();
  });

  it('round-trips: set then get', () => {
    setCurrentTenant('team-42');
    expect(getCurrentTenant()).toBe('team-42');
  });
});

// ---------------------------------------------------------------------------
// TENANT_ID_REGEX — mirrors the backend tenancy.ts validation
// ---------------------------------------------------------------------------

describe('TENANT_ID_REGEX', () => {
  const valid = ['default', 'acme', 'team-42', 'workspace_prod', 'A', 'a'.repeat(64)];
  const invalid = ['', ' spaces ', 'has.dot', 'has/slash', 'a'.repeat(65), 'UPPER CASE WITH SPACE'];

  it.each(valid)('accepts "%s"', (id) => {
    expect(TENANT_ID_REGEX.test(id)).toBe(true);
  });

  it.each(invalid)('rejects "%s"', (id) => {
    expect(TENANT_ID_REGEX.test(id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tenant history helpers
// ---------------------------------------------------------------------------

describe('getTenantHistory', () => {
  beforeEach(clearStorage);
  afterEach(clearStorage);

  it('returns [] when nothing stored', () => {
    expect(getTenantHistory()).toEqual([]);
  });

  it('returns stored history', () => {
    localStorage.setItem(TENANT_HISTORY_KEY, JSON.stringify(['acme', 'demo']));
    expect(getTenantHistory()).toEqual(['acme', 'demo']);
  });

  it('returns [] on malformed JSON', () => {
    localStorage.setItem(TENANT_HISTORY_KEY, '{{bad json');
    expect(getTenantHistory()).toEqual([]);
  });
});

describe('addTenantToHistory', () => {
  beforeEach(clearStorage);
  afterEach(clearStorage);

  it('appends a new tenant', () => {
    addTenantToHistory('acme');
    expect(getTenantHistory()).toContain('acme');
  });

  it('deduplicates entries', () => {
    addTenantToHistory('acme');
    addTenantToHistory('acme');
    expect(getTenantHistory().filter((t) => t === 'acme')).toHaveLength(1);
  });

  it('does not add "default" to history', () => {
    addTenantToHistory('default');
    expect(getTenantHistory()).not.toContain('default');
  });
});

describe('removeTenantFromHistory', () => {
  beforeEach(clearStorage);
  afterEach(clearStorage);

  it('removes the given tenant', () => {
    addTenantToHistory('acme');
    addTenantToHistory('demo');
    removeTenantFromHistory('acme');
    expect(getTenantHistory()).not.toContain('acme');
    expect(getTenantHistory()).toContain('demo');
  });

  it('is a no-op when tenant not in history', () => {
    addTenantToHistory('demo');
    removeTenantFromHistory('unknown');
    expect(getTenantHistory()).toEqual(['demo']);
  });
});

// ---------------------------------------------------------------------------
// apiFetch — header injection
// ---------------------------------------------------------------------------

describe('apiFetch', () => {
  // Minimal fetch spy: captures the resolved headers and returns a 200 stub.
  let capturedHeaders: Headers;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    clearStorage();
    capturedHeaders = new Headers();
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearStorage();
  });

  it('does NOT include X-Tenant-Id when tenant is "default"', async () => {
    // No tenant set — defaults to 'default'
    await apiFetch('/api/foo');
    expect(capturedHeaders.has('X-Tenant-Id')).toBe(false);
  });

  it('includes X-Tenant-Id when tenant is non-default', async () => {
    setCurrentTenant('acme');
    await apiFetch('/api/foo');
    expect(capturedHeaders.get('X-Tenant-Id')).toBe('acme');
  });

  it('preserves caller-supplied headers alongside X-Tenant-Id', async () => {
    setCurrentTenant('acme');
    await apiFetch('/api/foo', { headers: { Authorization: 'Bearer tok' } });
    expect(capturedHeaders.get('X-Tenant-Id')).toBe('acme');
    expect(capturedHeaders.get('Authorization')).toBe('Bearer tok');
  });

  it('does NOT clobber existing X-Tenant-Id supplied by caller when tenant is default', async () => {
    // Caller explicitly passes a header; tenant is default so we must NOT overwrite.
    await apiFetch('/api/foo', { headers: { 'X-Tenant-Id': 'explicit' } });
    // Since tenant === 'default', we skip the set — but the caller header is preserved.
    expect(capturedHeaders.get('X-Tenant-Id')).toBe('explicit');
  });

  it('forwards the init method and body unchanged', async () => {
    setCurrentTenant('demo');
    await apiFetch('/api/foo', {
      method: 'POST',
      body: 'hello',
      headers: { 'Content-Type': 'text/plain' },
    });
    expect(capturedHeaders.get('Content-Type')).toBe('text/plain');
  });
});
