// Shared helpers for the page component tests (Phase 3 #16).
//
// Approach: pages consume `useSession()` — each test file mocks the
// SessionContext module (vi.mock) and feeds it a stable state built with
// `makeSession`. Network calls (apiFetch and raw fetch) all go through
// `globalThis.fetch`, which `installFetchMock` replaces with a URL-aware stub
// returning empty-but-well-shaped JSON payloads so mount effects settle
// without errors.

import { vi } from 'vitest';
import { act } from '@testing-library/react';
import type { SessionState } from '../../context/SessionContext.js';
import type { Config, Profile, ServeStatus } from '../../types/schema.js';

/** Builds a full SessionState (authenticated admin by default). */
export function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    authChecked: true,
    authenticated: true,
    authRequired: true,
    needsSetup: false,
    showOnboarding: false,
    userAuthenticated: false,
    currentUser: { email: 'admin@example.com', role: 'admin' },
    ragEnabled: false,
    ragDisabledReason: null,
    dataVersion: 0,
    setAuthenticated: vi.fn(),
    setAuthRequired: vi.fn(),
    setNeedsSetup: vi.fn(),
    setShowOnboarding: vi.fn(),
    setUserAuthenticated: vi.fn(),
    bumpDataVersion: vi.fn(),
    logout: vi.fn(async () => {}),
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * Replaces `globalThis.fetch` with a stub returning empty, guard-friendly JSON
 * per endpoint. Restore with `vi.unstubAllGlobals()` in afterEach.
 */
export function installFetchMock() {
  const mock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/metrics/summary')) {
      return jsonResponse({
        success: true,
        requestsByHour: [],
        topTools: [],
        topTokens: [],
        errorRate: [],
        avgResponseTime: [],
      });
    }
    if (url.includes('/api/metrics/pool')) return jsonResponse({ pools: [] });
    if (url.includes('/api/users')) return jsonResponse({ success: true, users: [] });
    if (url.includes('/api/tenants')) return jsonResponse({ success: true, tenants: [] });
    if (url.includes('/api/ai-settings')) return jsonResponse({ success: true, settings: [] });
    if (url.includes('/api/smtp-settings')) return jsonResponse({ success: true, config: null });
    if (url.includes('/api/rag/sources')) return jsonResponse({ sources: [] });
    if (url.includes('/api/connections')) return jsonResponse({ success: true, connections: {} });
    if (url.includes('/api/tokens')) return jsonResponse({ success: true, tokens: [] });
    if (url.includes('/api/audit')) return jsonResponse({ success: true, entries: [] });
    return jsonResponse({ success: true });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

/**
 * Flushes pending mount effects (fetch → json → setState chains) inside act()
 * so tests don't trip React's act() warning. One macrotask tick drains every
 * queued microtask.
 */
export async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** An idle ServeStatus (no MCP server running). */
export function makeServeStatus(overrides: Partial<ServeStatus> = {}): ServeStatus {
  return {
    active: false,
    port: 4567,
    profiles: [],
    profileStatuses: {},
    totalRequests: 0,
    ...overrides,
  };
}

/** A minimal generation Config as passed to ServePanel / McpDetailView. */
export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    serverName: 'calame',
    transport: 'streamable-http',
    clientTarget: 'claude-desktop',
    outputDir: '',
    ...overrides,
  };
}

/** A named profile fixture. */
export function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return { name: 'default', label: 'Default', ...overrides };
}
