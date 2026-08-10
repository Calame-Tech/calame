import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer as CalameMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ScopeSelection, McpRegistrationContext, SourceSchema } from '@calame/core';
import { SourceAdapterRegistry, isWriteToolName } from '@calame/core';
import {
  buildMcpProxySourceAdapter,
  type McpProxyAdapterConfig,
  type McpClientTransportFactory,
} from '../mcp-proxy-adapter.js';

// ---------------------------------------------------------------------------
// Fake upstream MCP server — 3 tools mirroring the Graphiti design-partner
// surface referenced in docs/mcp-proxy-adapter-spec.md: two reads
// (search_nodes, search_memory_facts) and one write (add_memory).
// ---------------------------------------------------------------------------

function buildFakeUpstream(overrides?: {
  onAddMemory?: (fact: string) => void;
  searchNodesResponseLength?: number;
}): McpServer {
  const server = new McpServer({ name: 'fake-graphiti', version: '1.0.0' });

  server.registerTool(
    'search_nodes',
    { description: 'Search nodes in the knowledge graph', inputSchema: { query: z.string() } },
    async ({ query }) => {
      const text = overrides?.searchNodesResponseLength
        ? 'A'.repeat(overrides.searchNodesResponseLength)
        : `nodes matching "${query}"`;
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.registerTool(
    'search_memory_facts',
    { description: 'Search memory facts', inputSchema: { query: z.string() } },
    async ({ query }) => ({
      content: [{ type: 'text' as const, text: `facts matching "${query}"` }],
    }),
  );

  server.registerTool(
    'add_memory',
    { description: 'Add a fact to memory', inputSchema: { fact: z.string() } },
    async ({ fact }) => {
      overrides?.onAddMemory?.(fact);
      return { content: [{ type: 'text' as const, text: `added: ${fact}` }] };
    },
  );

  return server;
}

/**
 * Builds an injectable `McpClientTransportFactory` that, on every call, links
 * a fresh `InMemoryTransport` pair and connects a fresh fake-upstream
 * `McpServer` to one end (the adapter connects on demand per call — see
 * `withUpstreamClient` — so a factory must produce a usable transport each
 * time it is invoked, not just once).
 */
function fakeUpstreamTransportFactory(buildServer: () => McpServer): McpClientTransportFactory {
  return () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer();
    // Fire-and-forget: InMemoryTransport queues messages sent before the
    // other side's onmessage handler is registered, so connect ordering
    // between the two ends does not matter (see inMemory.js `send`/`start`).
    void server.connect(serverTransport);
    return clientTransport;
  };
}

/** A transport factory that fails before ever touching the network/transport. */
function throwingTransportFactory(message: string): McpClientTransportFactory {
  return () => {
    throw new Error(message);
  };
}

const DEFAULT_CONFIG: McpProxyAdapterConfig = { url: 'https://mock-upstream.example.com/mcp' };

function makeCtx(
  overrides: Partial<
    McpRegistrationContext<McpProxyAdapterConfig, Extract<SourceSchema, { kind: 'mcp' }>>
  > & {
    server: CalameMcpServer;
    selection: ScopeSelection;
    tools: Extract<SourceSchema, { kind: 'mcp' }>['tools'];
  },
): McpRegistrationContext<McpProxyAdapterConfig, Extract<SourceSchema, { kind: 'mcp' }>> {
  return {
    server: overrides.server,
    source: {
      id: 'src1',
      name: 'Graphiti',
      type: 'mcp',
      configEncrypted: '',
      capabilities: [],
      createdAt: '',
      updatedAt: '',
    },
    config: overrides.config ?? DEFAULT_CONFIG,
    schema: { kind: 'mcp', tools: overrides.tools },
    selection: overrides.selection,
    profileName: 'p1',
    toolNamespace: overrides.toolNamespace ?? '',
    responseMode: 'friendly',
    onAuditLog: overrides.onAuditLog ?? vi.fn(),
  };
}

interface RegisteredTool {
  name: string;
  config: { description?: string; inputSchema?: unknown };
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>;
}

/** A capturing mock of McpServer.registerTool. */
function makeMcpServer(): { server: CalameMcpServer; registered: RegisteredTool[] } {
  const registered: RegisteredTool[] = [];
  const registerTool = vi.fn(
    (name: string, config: RegisteredTool['config'], handler: RegisteredTool['handler']) => {
      registered.push({ name, config, handler });
    },
  );
  return { server: { registerTool } as unknown as CalameMcpServer, registered };
}

const readTools: Extract<SourceSchema, { kind: 'mcp' }>['tools'] = [
  { name: 'search_nodes', description: 'Search nodes', inputSchema: {}, isWrite: false },
  { name: 'search_memory_facts', description: 'Search facts', inputSchema: {}, isWrite: false },
  { name: 'add_memory', description: 'Add a fact', inputSchema: {}, isWrite: true },
];

// ---------------------------------------------------------------------------
// metadata + configSchema
// ---------------------------------------------------------------------------

describe('buildMcpProxySourceAdapter — metadata', () => {
  it('sets type, displayName, capabilities', () => {
    const adapter = buildMcpProxySourceAdapter();
    expect(adapter.type).toBe('mcp');
    expect(adapter.displayName).toBe('MCP server (proxy)');
    expect(adapter.capabilities).toEqual(['tools']);
  });
});

describe('configSchema', () => {
  it('parses a minimal valid config', () => {
    const adapter = buildMcpProxySourceAdapter();
    const parsed = adapter.configSchema.parse({ url: 'https://upstream.example.com/mcp' });
    expect(parsed.url).toBe('https://upstream.example.com/mcp');
  });

  it('parses a config with headers', () => {
    const adapter = buildMcpProxySourceAdapter();
    const parsed = adapter.configSchema.parse({
      url: 'http://upstream.example.com/mcp',
      headers: { Authorization: 'Bearer abc' },
    });
    expect(parsed.headers).toEqual({ Authorization: 'Bearer abc' });
  });

  it('rejects a malformed URL', () => {
    const adapter = buildMcpProxySourceAdapter();
    expect(() => adapter.configSchema.parse({ url: 'not-a-url' })).toThrow();
  });

  it('rejects a non-http(s) scheme', () => {
    const adapter = buildMcpProxySourceAdapter();
    expect(() => adapter.configSchema.parse({ url: 'ftp://upstream.example.com/mcp' })).toThrow();
  });
});

describe('scopeSelectionSchema', () => {
  it('parses a valid mcp scope', () => {
    const adapter = buildMcpProxySourceAdapter();
    const parsed = adapter.scopeSelectionSchema.parse({
      kind: 'mcp',
      allowedTools: ['search_nodes'],
    });
    expect(parsed.kind).toBe('mcp');
  });

  it('rejects a scope missing the kind discriminator', () => {
    const adapter = buildMcpProxySourceAdapter();
    expect(() => adapter.scopeSelectionSchema.parse({ allowedTools: ['search_nodes'] })).toThrow();
  });

  it('rejects a scope with kind=mcp but no allowedTools array', () => {
    const adapter = buildMcpProxySourceAdapter();
    expect(() => adapter.scopeSelectionSchema.parse({ kind: 'mcp' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// isWriteToolName heuristic
// ---------------------------------------------------------------------------

describe('isWriteToolName', () => {
  it.each([
    ['add_memory', true],
    ['create_widget', true],
    ['update_record', true],
    ['delete_row', true],
    ['set_flag', true],
    ['put_object', true],
    ['write_log', true],
    ['remove_item', true],
    ['ADD_MEMORY', true], // case-insensitive
    ['search_nodes', false],
    ['search_memory_facts', false],
    ['get_status', false],
    ['list_tables', false],
    ['random_name', false],
  ])('%s -> %s', (name, expected) => {
    expect(isWriteToolName(name)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// testConnection
// ---------------------------------------------------------------------------

describe('testConnection', () => {
  it('succeeds against a reachable upstream', async () => {
    const adapter = buildMcpProxySourceAdapter(
      fakeUpstreamTransportFactory(() => buildFakeUpstream()),
    );
    await expect(adapter.testConnection(DEFAULT_CONFIG)).resolves.toBeUndefined();
  });

  it('throws a clear error when the upstream is unreachable', async () => {
    const adapter = buildMcpProxySourceAdapter(throwingTransportFactory('ECONNREFUSED'));
    const err = await adapter
      .testConnection(DEFAULT_CONFIG)
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/Failed to connect to MCP server/);
    expect(err?.message).toMatch(/ECONNREFUSED/);
  });
});

// ---------------------------------------------------------------------------
// introspect
// ---------------------------------------------------------------------------

describe('introspect', () => {
  it('maps the 3 upstream tools with the correct isWrite classification', async () => {
    const adapter = buildMcpProxySourceAdapter(
      fakeUpstreamTransportFactory(() => buildFakeUpstream()),
    );
    const schema = await adapter.introspect!(DEFAULT_CONFIG, 'src1');
    expect(schema.kind).toBe('mcp');
    expect(schema.tools).toHaveLength(3);

    const byName = Object.fromEntries(schema.tools.map((t) => [t.name, t]));
    expect(byName.search_nodes.isWrite).toBe(false);
    expect(byName.search_memory_facts.isWrite).toBe(false);
    expect(byName.add_memory.isWrite).toBe(true);
    expect(byName.search_nodes.description).toContain('Search nodes');
    expect(byName.add_memory.inputSchema).toBeDefined();
  });

  it('surfaces a clear error when the upstream cannot be reached', async () => {
    const adapter = buildMcpProxySourceAdapter(throwingTransportFactory('ENOTFOUND'));
    await expect(adapter.introspect!(DEFAULT_CONFIG, 'src1')).rejects.toThrow(
      /Failed to list tools from MCP server/,
    );
  });
});

// ---------------------------------------------------------------------------
// registerMcpTools — registration (allowlist + fail-closed on write)
// ---------------------------------------------------------------------------

describe('registerMcpTools — registration', () => {
  it('registers only allowlisted, non-write tools', () => {
    const { server, registered } = makeMcpServer();
    const adapter = buildMcpProxySourceAdapter();
    adapter.registerMcpTools!(
      makeCtx({
        server,
        tools: readTools,
        selection: { kind: 'mcp', allowedTools: ['search_nodes', 'add_memory'] },
      }),
    );
    // add_memory is allowlisted but MUST NOT be registered (fail-closed, Slice 0).
    expect(registered.map((r) => r.name)).toEqual(['search_nodes']);
  });

  it('never registers a write tool even when it is the only allowlisted tool', () => {
    const { server, registered } = makeMcpServer();
    const adapter = buildMcpProxySourceAdapter();
    adapter.registerMcpTools!(
      makeCtx({
        server,
        tools: readTools,
        selection: { kind: 'mcp', allowedTools: ['add_memory'] },
      }),
    );
    expect(registered).toHaveLength(0);
  });

  it('skips a tool not present in allowedTools', () => {
    const { server, registered } = makeMcpServer();
    const adapter = buildMcpProxySourceAdapter();
    adapter.registerMcpTools!(
      makeCtx({
        server,
        tools: readTools,
        selection: { kind: 'mcp', allowedTools: ['search_nodes'] },
      }),
    );
    expect(registered.map((r) => r.name)).toEqual(['search_nodes']);
  });

  it('applies the tool namespace prefix when one is supplied', () => {
    const { server, registered } = makeMcpServer();
    const adapter = buildMcpProxySourceAdapter();
    adapter.registerMcpTools!(
      makeCtx({
        server,
        tools: readTools,
        toolNamespace: 'graphiti_',
        selection: { kind: 'mcp', allowedTools: ['search_nodes'] },
      }),
    );
    expect(registered[0].name).toBe('graphiti_search_nodes');
  });

  it('throws when given a non-mcp selection', () => {
    const { server } = makeMcpServer();
    const adapter = buildMcpProxySourceAdapter();
    expect(() =>
      adapter.registerMcpTools!(
        makeCtx({
          server,
          tools: readTools,
          selection: { kind: 'relational', selectedTables: {} },
        }),
      ),
    ).toThrow(/expected mcp selection/);
  });
});

// ---------------------------------------------------------------------------
// registerMcpTools — tool call behaviour
// ---------------------------------------------------------------------------

describe('registerMcpTools — read tool call behaviour', () => {
  it('forwards a read call and returns the upstream content, with audit emitted', async () => {
    const onAuditLog = vi.fn();
    const { server, registered } = makeMcpServer();
    const adapter = buildMcpProxySourceAdapter(
      fakeUpstreamTransportFactory(() => buildFakeUpstream()),
    );
    adapter.registerMcpTools!(
      makeCtx({
        server,
        tools: readTools,
        selection: { kind: 'mcp', allowedTools: ['search_nodes'] },
        onAuditLog,
      }),
    );

    const result = await registered[0].handler({ query: 'alice' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('nodes matching "alice"');

    expect(onAuditLog).toHaveBeenCalledOnce();
    const entry = onAuditLog.mock.calls[0][0];
    expect(entry.toolName).toBe('search_nodes');
    expect(entry.result).toBe('success');
    expect(entry.profileName).toBe('p1');
    expect(typeof entry.durationMs).toBe('number');
  });

  it('never calls the upstream for a write tool (it is not even registered)', () => {
    const { server, registered } = makeMcpServer();
    // A throwing transport factory would fail loudly if the adapter ever tried
    // to open a connection for add_memory — since it's never registered, the
    // transport factory must never be invoked at all.
    const adapter = buildMcpProxySourceAdapter(
      throwingTransportFactory('must not be called for a write tool'),
    );
    adapter.registerMcpTools!(
      makeCtx({
        server,
        tools: readTools,
        selection: { kind: 'mcp', allowedTools: ['search_nodes', 'add_memory'] },
      }),
    );
    expect(registered.find((r) => r.name === 'add_memory')).toBeUndefined();
  });

  it('returns a clean isError result and audits an error when the upstream is unreachable', async () => {
    const onAuditLog = vi.fn();
    const { server, registered } = makeMcpServer();
    const adapter = buildMcpProxySourceAdapter(throwingTransportFactory('connection refused'));
    adapter.registerMcpTools!(
      makeCtx({
        server,
        tools: readTools,
        selection: { kind: 'mcp', allowedTools: ['search_nodes'] },
        onAuditLog,
      }),
    );

    const result = await registered[0].handler({ query: 'alice' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Upstream MCP call failed/);
    expect(result.content[0].text).toMatch(/connection refused/);

    expect(onAuditLog).toHaveBeenCalledOnce();
    expect(onAuditLog.mock.calls[0][0].result).toBe('error');
  });

  it('surfaces an upstream isError tool result as isError and audits it as an error', async () => {
    const server0 = new McpServer({ name: 'fake-erroring-upstream', version: '1.0.0' });
    server0.registerTool(
      'search_nodes',
      { description: 'Search nodes', inputSchema: { query: z.string() } },
      async () => ({
        content: [{ type: 'text' as const, text: 'boom' }],
        isError: true,
      }),
    );

    const onAuditLog = vi.fn();
    const { server, registered } = makeMcpServer();
    const adapter = buildMcpProxySourceAdapter(fakeUpstreamTransportFactory(() => server0));
    adapter.registerMcpTools!(
      makeCtx({
        server,
        tools: readTools,
        selection: { kind: 'mcp', allowedTools: ['search_nodes'] },
        onAuditLog,
      }),
    );

    const result = await registered[0].handler({ query: 'alice' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('boom');
    expect(onAuditLog.mock.calls[0][0].result).toBe('error');
  });

  it('truncates a response above 100 KB and marks it truncated', async () => {
    const huge = 300 * 1024;
    const { server, registered } = makeMcpServer();
    const adapter = buildMcpProxySourceAdapter(
      fakeUpstreamTransportFactory(() => buildFakeUpstream({ searchNodesResponseLength: huge })),
    );
    adapter.registerMcpTools!(
      makeCtx({
        server,
        tools: readTools,
        selection: { kind: 'mcp', allowedTools: ['search_nodes'] },
      }),
    );

    const result = await registered[0].handler({ query: 'alice' });
    expect(result.content[0].text.endsWith('[truncated]')).toBe(true);
    // 100 KB of content plus the marker, not the full 300 KB.
    expect(result.content[0].text.length).toBeLessThan(101 * 1024);
    expect(result.content[0].text.length).toBeGreaterThan(100 * 1024);
  });

  it('does not truncate a response at or under 100 KB', async () => {
    const exact = 50 * 1024;
    const { server, registered } = makeMcpServer();
    const adapter = buildMcpProxySourceAdapter(
      fakeUpstreamTransportFactory(() => buildFakeUpstream({ searchNodesResponseLength: exact })),
    );
    adapter.registerMcpTools!(
      makeCtx({
        server,
        tools: readTools,
        selection: { kind: 'mcp', allowedTools: ['search_nodes'] },
      }),
    );

    const result = await registered[0].handler({ query: 'alice' });
    expect(result.content[0].text.endsWith('[truncated]')).toBe(false);
    expect(result.content[0].text.length).toBe(exact);
  });
});

// ---------------------------------------------------------------------------
// Registry integration
// ---------------------------------------------------------------------------

describe('sourceAdapterRegistry registration', () => {
  it('registers under type "mcp" without throwing', () => {
    const fresh = new SourceAdapterRegistry();
    fresh.register(buildMcpProxySourceAdapter());
    expect(fresh.has('mcp')).toBe(true);
    const adapter = fresh.get('mcp');
    expect(adapter?.displayName).toBe('MCP server (proxy)');
  });
});
