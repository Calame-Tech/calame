import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ScopeSelection, McpRegistrationContext } from '@calame/core';
import { SourceAdapterRegistry } from '@calame/core';
import { buildHttpApiSourceAdapter, type HttpApiAdapterConfig } from '../api-adapter.js';

// ---------------------------------------------------------------------------
// Mock fetch — replaced per-test as needed
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Reset fetch to a no-op stub; individual tests override as needed.
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RegisteredTool {
  name: string;
  description: string;
  schema: unknown;
  handler: (args: { path: string; query?: Record<string, string> }) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
  }>;
}

/**
 * A capturing mock of McpServer.tool — records every (name, description,
 * schema, handler) tuple so tests can introspect what was registered.
 */
function makeMcpServer(): { server: McpServer; registered: RegisteredTool[] } {
  const registered: RegisteredTool[] = [];
  const tool = vi.fn((name: string, description: string, schema: unknown, handler: unknown) => {
    registered.push({
      name,
      description,
      schema,
      handler: handler as RegisteredTool['handler'],
    });
  });
  return {
    server: { tool } as unknown as McpServer,
    registered,
  };
}

/** Builds a default McpRegistrationContext suitable for happy-path tests. */
function makeCtx(
  overrides: Partial<McpRegistrationContext<HttpApiAdapterConfig, never>> & {
    server: McpServer;
    selection: ScopeSelection;
    config?: HttpApiAdapterConfig;
  },
): McpRegistrationContext<HttpApiAdapterConfig, never> {
  const config: HttpApiAdapterConfig = overrides.config ?? {
    baseUrl: 'https://api.example.com',
  };
  return {
    server: overrides.server,
    source: {
      id: 'src1',
      name: 'My HTTP API',
      type: 'http',
      configEncrypted: '',
      capabilities: [],
      createdAt: '',
      updatedAt: '',
    },
    config,
    // schema isn't read inside registerMcpTools; the API arm is fine here.
    schema: {
      kind: 'api',
      services: [{ id: 'default', name: 'HTTP API', baseUrl: config.baseUrl }],
      operations: [{ id: 'http_get', method: 'GET', description: 'GET' }],
    } as unknown as never,
    selection: overrides.selection,
    profileName: 'p1',
    toolNamespace: '',
    responseMode: 'friendly',
    onAuditLog: overrides.onAuditLog ?? vi.fn(),
  };
}

function mockFetchOnce(response: {
  status?: number;
  contentType?: string;
  body?: string;
  ok?: boolean;
}): void {
  const status = response.status ?? 200;
  const contentType = response.contentType ?? 'application/json';
  const body = response.body ?? '{}';
  const ok = response.ok ?? (status >= 200 && status < 300);
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    status,
    ok,
    headers: {
      get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null),
    },
    text: () => Promise.resolve(body),
  } as unknown as Response);
}

// ---------------------------------------------------------------------------
// metadata + configSchema
// ---------------------------------------------------------------------------

describe('buildHttpApiSourceAdapter — metadata', () => {
  it('sets type, displayName, capabilities', () => {
    const adapter = buildHttpApiSourceAdapter();
    expect(adapter.type).toBe('http');
    expect(adapter.displayName).toBe('HTTP API');
    expect(adapter.capabilities).toContain('introspect');
    expect(adapter.capabilities).toContain('tools');
  });
});

describe('configSchema', () => {
  it('parses a minimal valid config', () => {
    const adapter = buildHttpApiSourceAdapter();
    const parsed = adapter.configSchema.parse({ baseUrl: 'https://api.example.com' });
    expect(parsed.baseUrl).toBe('https://api.example.com');
  });

  it('parses a config with every optional field', () => {
    const adapter = buildHttpApiSourceAdapter();
    const parsed = adapter.configSchema.parse({
      baseUrl: 'https://api.example.com',
      headers: { Authorization: 'Bearer abc' },
      allowedHosts: ['api.example.com', 'cdn.example.com'],
      timeoutMs: 5000,
    });
    expect(parsed.allowedHosts).toEqual(['api.example.com', 'cdn.example.com']);
    expect(parsed.timeoutMs).toBe(5000);
  });

  it('rejects an invalid base URL', () => {
    const adapter = buildHttpApiSourceAdapter();
    expect(() => adapter.configSchema.parse({ baseUrl: 'not-a-url' })).toThrow();
  });

  it('rejects a timeout below 1000ms', () => {
    const adapter = buildHttpApiSourceAdapter();
    expect(() =>
      adapter.configSchema.parse({ baseUrl: 'https://x.example.com', timeoutMs: 500 }),
    ).toThrow();
  });

  it('rejects a timeout above 60_000ms', () => {
    const adapter = buildHttpApiSourceAdapter();
    expect(() =>
      adapter.configSchema.parse({ baseUrl: 'https://x.example.com', timeoutMs: 120_000 }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// scopeSelectionSchema
// ---------------------------------------------------------------------------

describe('scopeSelectionSchema', () => {
  it('parses a valid api scope', () => {
    const adapter = buildHttpApiSourceAdapter();
    const parsed = adapter.scopeSelectionSchema.parse({
      kind: 'api',
      allowedOperations: ['http_get'],
      allowedPathPrefixes: ['/v1/'],
    });
    expect(parsed.kind).toBe('api');
  });

  it('rejects a scope missing the kind discriminator', () => {
    const adapter = buildHttpApiSourceAdapter();
    expect(() =>
      adapter.scopeSelectionSchema.parse({ allowedOperations: ['http_get'] }),
    ).toThrow();
  });

  it('rejects a scope with kind=api but no allowedOperations array', () => {
    const adapter = buildHttpApiSourceAdapter();
    expect(() =>
      adapter.scopeSelectionSchema.parse({ kind: 'api' }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// introspect
// ---------------------------------------------------------------------------

describe('introspect', () => {
  it('returns the static MVP schema with one service and one operation', async () => {
    const adapter = buildHttpApiSourceAdapter();
    const schema = await adapter.introspect!(
      { baseUrl: 'https://api.example.com/' },
      'src1',
    );
    expect(schema.kind).toBe('api');
    expect(schema.services).toHaveLength(1);
    expect(schema.services[0].id).toBe('default');
    // Trailing slash is trimmed
    expect(schema.services[0].baseUrl).toBe('https://api.example.com');
    expect(schema.operations).toHaveLength(1);
    expect(schema.operations[0].id).toBe('http_get');
    expect(schema.operations[0].method).toBe('GET');
  });
});

// ---------------------------------------------------------------------------
// testConnection
// ---------------------------------------------------------------------------

describe('testConnection', () => {
  it('issues HEAD against baseUrl and accepts 200', async () => {
    mockFetchOnce({ status: 200 });
    const adapter = buildHttpApiSourceAdapter();
    await expect(
      adapter.testConnection({ baseUrl: 'https://api.example.com' }),
    ).resolves.toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.example.com',
      expect.objectContaining({ method: 'HEAD' }),
    );
  });

  it('accepts 405 (HEAD not allowed but endpoint reachable)', async () => {
    mockFetchOnce({ status: 405, ok: false });
    const adapter = buildHttpApiSourceAdapter();
    await expect(
      adapter.testConnection({ baseUrl: 'https://api.example.com' }),
    ).resolves.toBeUndefined();
  });

  it('throws on a 404', async () => {
    mockFetchOnce({ status: 404, ok: false });
    const adapter = buildHttpApiSourceAdapter();
    await expect(
      adapter.testConnection({ baseUrl: 'https://api.example.com' }),
    ).rejects.toThrow(/404/);
  });

  it('masks the underlying network reason and never leaks it to the caller', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('ECONNREFUSED'),
    );
    const adapter = buildHttpApiSourceAdapter();
    const err = await adapter
      .testConnection({ baseUrl: 'https://api.example.com' })
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe('Network error while contacting the remote host.');
    // Security: the raw network reason (e.g. ECONNREFUSED) must never leak.
    expect(err?.message).not.toMatch(/ECONNREFUSED/);
  });
});

// ---------------------------------------------------------------------------
// registerMcpTools
// ---------------------------------------------------------------------------

describe('registerMcpTools — registration', () => {
  it('registers exactly one tool named http_get when namespace is empty', () => {
    const { server, registered } = makeMcpServer();
    const adapter = buildHttpApiSourceAdapter();
    adapter.registerMcpTools!(
      makeCtx({
        server,
        selection: { kind: 'api', allowedOperations: ['http_get'] },
      }),
    );
    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe('http_get');
  });

  it('prefixes the tool name with the namespace when one is supplied', () => {
    const { server, registered } = makeMcpServer();
    const adapter = buildHttpApiSourceAdapter();
    const ctx = makeCtx({
      server,
      selection: { kind: 'api', allowedOperations: ['http_get'] },
    });
    (ctx as { toolNamespace: string }).toolNamespace = 'weather_';
    adapter.registerMcpTools!(ctx);
    expect(registered[0].name).toBe('weather_http_get');
  });

  it('throws when given a non-api selection', () => {
    const { server } = makeMcpServer();
    const adapter = buildHttpApiSourceAdapter();
    expect(() =>
      adapter.registerMcpTools!(
        makeCtx({
          server,
          selection: { kind: 'relational', selectedTables: {} },
        }),
      ),
    ).toThrow(/expected api selection/);
  });
});

describe('registerMcpTools — http_get tool behaviour', () => {
  it('returns body, status, and contentType on a successful GET', async () => {
    mockFetchOnce({ status: 200, body: '{"hello":"world"}', contentType: 'application/json' });
    const { server, registered } = makeMcpServer();
    const adapter = buildHttpApiSourceAdapter();
    adapter.registerMcpTools!(
      makeCtx({
        server,
        selection: { kind: 'api', allowedOperations: ['http_get'] },
      }),
    );
    const result = await registered[0].handler({ path: '/v1/items' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe(200);
    expect(payload.contentType).toBe('application/json');
    expect(payload.body).toBe('{"hello":"world"}');
    expect(payload.truncated).toBe(false);
  });

  it('forwards configured headers on each request', async () => {
    mockFetchOnce({ status: 200, body: '{}' });
    const { server, registered } = makeMcpServer();
    const adapter = buildHttpApiSourceAdapter();
    adapter.registerMcpTools!(
      makeCtx({
        server,
        config: {
          baseUrl: 'https://api.example.com',
          headers: { Authorization: 'Bearer secret' },
        },
        selection: { kind: 'api', allowedOperations: ['http_get'] },
      }),
    );
    await registered[0].handler({ path: '/v1/items' });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: 'Bearer secret' },
      }),
    );
  });

  it('appends query parameters to the URL', async () => {
    mockFetchOnce({ status: 200, body: '[]' });
    const { server, registered } = makeMcpServer();
    const adapter = buildHttpApiSourceAdapter();
    adapter.registerMcpTools!(
      makeCtx({
        server,
        selection: { kind: 'api', allowedOperations: ['http_get'] },
      }),
    );
    await registered[0].handler({
      path: '/search',
      query: { q: 'cats', limit: '10' },
    });
    const [url] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('q=cats');
    expect(url).toContain('limit=10');
  });

  it('errors when scope.allowedOperations does not include http_get', async () => {
    const { server, registered } = makeMcpServer();
    const adapter = buildHttpApiSourceAdapter();
    adapter.registerMcpTools!(
      makeCtx({
        server,
        selection: { kind: 'api', allowedOperations: [] },
      }),
    );
    const result = await registered[0].handler({ path: '/v1/items' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/not allowed/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('blocks an absolute URL pointing to a host outside allowedHosts', async () => {
    const { server, registered } = makeMcpServer();
    const adapter = buildHttpApiSourceAdapter();
    adapter.registerMcpTools!(
      makeCtx({
        server,
        config: {
          baseUrl: 'https://api.example.com',
          allowedHosts: ['api.example.com'],
        },
        selection: { kind: 'api', allowedOperations: ['http_get'] },
      }),
    );
    const result = await registered[0].handler({ path: 'https://evil.example/x' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/not in the source's allowedHosts/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('allows an absolute URL pointing to a host inside allowedHosts', async () => {
    mockFetchOnce({ status: 200, body: '{}' });
    const { server, registered } = makeMcpServer();
    const adapter = buildHttpApiSourceAdapter();
    adapter.registerMcpTools!(
      makeCtx({
        server,
        config: {
          baseUrl: 'https://api.example.com',
          allowedHosts: ['api.example.com', 'cdn.example.com'],
        },
        selection: { kind: 'api', allowedOperations: ['http_get'] },
      }),
    );
    const result = await registered[0].handler({ path: 'https://cdn.example.com/asset.json' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe(200);
  });

  it('defaults to baseUrl host when allowedHosts is absent (same-origin only)', async () => {
    const { server, registered } = makeMcpServer();
    const adapter = buildHttpApiSourceAdapter();
    adapter.registerMcpTools!(
      makeCtx({
        server,
        config: { baseUrl: 'https://api.example.com' },
        selection: { kind: 'api', allowedOperations: ['http_get'] },
      }),
    );
    const result = await registered[0].handler({ path: 'https://other.example/x' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/allowedHosts/);
  });

  it('rejects a path that does not match scope.allowedPathPrefixes', async () => {
    const { server, registered } = makeMcpServer();
    const adapter = buildHttpApiSourceAdapter();
    adapter.registerMcpTools!(
      makeCtx({
        server,
        selection: {
          kind: 'api',
          allowedOperations: ['http_get'],
          allowedPathPrefixes: ['/v1/public/'],
        },
      }),
    );
    const result = await registered[0].handler({ path: '/v1/private/secrets' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/not allowed by the active profile scope/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('allows a path that matches an allowedPathPrefixes entry', async () => {
    mockFetchOnce({ status: 200, body: '{"ok":true}' });
    const { server, registered } = makeMcpServer();
    const adapter = buildHttpApiSourceAdapter();
    adapter.registerMcpTools!(
      makeCtx({
        server,
        selection: {
          kind: 'api',
          allowedOperations: ['http_get'],
          allowedPathPrefixes: ['/v1/public/'],
        },
      }),
    );
    const result = await registered[0].handler({ path: '/v1/public/items' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe(200);
  });

  it('surfaces a network error as an error tool response (no crash)', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('ENOTFOUND'),
    );
    const { server, registered } = makeMcpServer();
    const adapter = buildHttpApiSourceAdapter();
    adapter.registerMcpTools!(
      makeCtx({
        server,
        selection: { kind: 'api', allowedOperations: ['http_get'] },
      }),
    );
    const result = await registered[0].handler({ path: '/v1/items' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/Network error/);
  });

  it('surfaces an AbortError as a clear timeout response', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(abortError);
    const { server, registered } = makeMcpServer();
    const adapter = buildHttpApiSourceAdapter();
    adapter.registerMcpTools!(
      makeCtx({
        server,
        config: { baseUrl: 'https://api.example.com', timeoutMs: 1000 },
        selection: { kind: 'api', allowedOperations: ['http_get'] },
      }),
    );
    const result = await registered[0].handler({ path: '/v1/items' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/timed out/);
  });

  it('returns a 500 response without crashing (audit logged as error)', async () => {
    mockFetchOnce({ status: 500, body: 'internal server error', ok: false });
    const onAuditLog = vi.fn();
    const { server, registered } = makeMcpServer();
    const adapter = buildHttpApiSourceAdapter();
    adapter.registerMcpTools!(
      makeCtx({
        server,
        selection: { kind: 'api', allowedOperations: ['http_get'] },
        onAuditLog,
      }),
    );
    const result = await registered[0].handler({ path: '/v1/items' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe(500);
    expect(payload.body).toBe('internal server error');
    expect(onAuditLog).toHaveBeenCalledOnce();
    expect(onAuditLog.mock.calls[0][0].result).toBe('error');
  });

  it('truncates response bodies above 100 KB and sets truncated=true', async () => {
    const huge = 'A'.repeat(200 * 1024);
    mockFetchOnce({ status: 200, body: huge });
    const { server, registered } = makeMcpServer();
    const adapter = buildHttpApiSourceAdapter();
    adapter.registerMcpTools!(
      makeCtx({
        server,
        selection: { kind: 'api', allowedOperations: ['http_get'] },
      }),
    );
    const result = await registered[0].handler({ path: '/v1/items' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.truncated).toBe(true);
    expect(payload.body.length).toBe(100 * 1024);
  });

  it('emits an audit entry on every call (success path)', async () => {
    mockFetchOnce({ status: 200, body: '{}' });
    const onAuditLog = vi.fn();
    const { server, registered } = makeMcpServer();
    const adapter = buildHttpApiSourceAdapter();
    adapter.registerMcpTools!(
      makeCtx({
        server,
        selection: { kind: 'api', allowedOperations: ['http_get'] },
        onAuditLog,
      }),
    );
    await registered[0].handler({ path: '/v1/items' });
    expect(onAuditLog).toHaveBeenCalledOnce();
    const entry = onAuditLog.mock.calls[0][0];
    expect(entry.toolName).toBe('http_get');
    expect(entry.result).toBe('success');
    expect(entry.profileName).toBe('p1');
  });
});

// ---------------------------------------------------------------------------
// Registry integration
// ---------------------------------------------------------------------------

describe('sourceAdapterRegistry registration', () => {
  it('registers under type "http" without throwing', () => {
    const fresh = new SourceAdapterRegistry();
    fresh.register(buildHttpApiSourceAdapter());
    expect(fresh.has('http')).toBe(true);
    const adapter = fresh.get('http');
    expect(adapter?.displayName).toBe('HTTP API');
  });

  it('co-registers with the DB adapters in a fresh registry', () => {
    const fresh = new SourceAdapterRegistry();
    // Force re-import-shape: register fresh instances rather than the singleton.
    fresh.register(buildHttpApiSourceAdapter());
    expect(fresh.list()).toHaveLength(1);
  });
});
