// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Calame Tech inc.

/**
 * McpProxySourceAdapter — Slice 0 (read-only proxy) of the MCP Proxy Adapter.
 *
 * Fronts an external MCP server as a Calame `SourceAdapter` of `type: 'mcp'`.
 * Calame becomes an MCP *client* toward the upstream (in addition to being an
 * MCP *server* toward its own agents) — see `docs/mcp-proxy-adapter-spec.md`
 * §8b for the lifecycle rules this adapter implements:
 *
 *   - Connect **on demand**, per call: open → call → close. No persistent
 *     client, no reconnect logic — the per-call handshake cost is accepted
 *     for the spike and is expected to stay well under the 10s hard timeout.
 *   - `introspect` snapshots `tools/list` once; the upstream may add/rename
 *     tools later without Calame noticing until the next introspect (no
 *     auto-refresh in v1).
 *   - Trust boundary: the upstream is untrusted data. Responses are
 *     truncated and normalized to plain text — never interpreted/executed.
 *
 * Slice 0 scope (see spec §9): read-only. A tool classified as a write by
 * `isWriteToolName` is **never** registered, even when explicitly present in
 * `selection.allowedTools` — fail closed, matching the relational adapter's
 * rule for missing `onWriteRequest`. The write-approval flow (queueing an
 * `add_memory`-style call for admin approval) is Slice 1 and lives outside
 * this file.
 */

import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  SourceAdapter,
  SourceSchema,
  ScopeSelection,
  McpRegistrationContext,
  McpToolInfo,
  AuditLogEntry,
  Capability,
} from '@calame/core';
import { isWriteToolName } from '@calame/core';

// ---------------------------------------------------------------------------
// Config type
// ---------------------------------------------------------------------------

/**
 * Persisted, decrypted config for an MCP proxy source.
 *
 * Stored encrypted in `Source.configEncrypted`; the host decrypts before
 * passing into the adapter via `McpRegistrationContext.config`.
 *
 * Slice 0 intentionally keeps this to the bare minimum needed to reach the
 * upstream (spec §9, Slice 0 item 1): no `transport` selector (streamable-http
 * only), no `groupId` / `writeToolNames` — those are hardening-phase additions.
 */
export interface McpProxyAdapterConfig {
  url: string;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard per-call timeout covering connect + the single request. */
const CALL_TIMEOUT_MS = 10_000;

/** Maximum characters of normalized upstream text returned to the LLM. */
const MAX_RESPONSE_CHARS = 100 * 1024; // 100 KB

/** Appended to a response body that was cut off at `MAX_RESPONSE_CHARS`. */
const TRUNCATION_MARKER = '\n[truncated]';

const CLIENT_INFO = { name: 'calame-mcp-proxy', version: '0.1.0' };

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

function isHttpOrHttpsUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

const configSchema = z.object({
  url: z
    .string()
    .url()
    .refine(isHttpOrHttpsUrl, { message: 'url must use the http or https scheme' }),
  headers: z.record(z.string(), z.string()).optional(),
}) as z.ZodType<McpProxyAdapterConfig>;

/**
 * Accepts every kind of ScopeSelection so a single adapter instance can be
 * stored in the registry without type errors (same rationale as the HTTP API
 * adapter's `scopeSelectionSchema`). The adapter validates at runtime that it
 * received a `kind: 'mcp'` selection (see `registerMcpTools`).
 */
const scopeSelectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mcp'),
    allowedTools: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('api'),
    allowedOperations: z.array(z.string()),
    allowedPathPrefixes: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal('relational'),
    selectedTables: z.record(z.string(), z.array(z.string())),
    tableOptions: z.record(z.string(), z.unknown()).optional(),
    columnMasking: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  }),
  z.object({
    kind: z.literal('document'),
    mode: z.enum(['allowAll', 'allowList']),
    allowedFolders: z.array(z.string()),
    allowedDocuments: z.array(z.string()),
  }),
]) as z.ZodType<ScopeSelection>;

// ---------------------------------------------------------------------------
// Public type aliases
// ---------------------------------------------------------------------------

type McpSchema = Extract<SourceSchema, { kind: 'mcp' }>;
type McpCaps = Extract<Capability, 'tools'>;

/**
 * Builds the `Transport` used to reach the upstream MCP server for a single
 * call. Injectable so tests can substitute an `InMemoryTransport` wired to a
 * fake upstream `McpServer` instead of opening a real HTTP connection.
 * Defaults to `StreamableHTTPClientTransport` (spec §8b: streamable-http
 * first; SSE/stdio are out of scope for Slice 0).
 */
export type McpClientTransportFactory = (config: McpProxyAdapterConfig) => Transport;

const defaultTransportFactory: McpClientTransportFactory = (config) =>
  new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: config.headers ? { headers: config.headers } : undefined,
  });

// ---------------------------------------------------------------------------
// Upstream client lifecycle — connect on demand, call, close in a finally.
// ---------------------------------------------------------------------------

/**
 * Opens a fresh client connection to the upstream, runs `fn`, and always
 * closes the connection afterwards — even on failure. No client is ever
 * reused across calls (spec §8b: no persistent client in the spike).
 *
 * `fn` receives the connected `Client` plus the `AbortSignal` backing the
 * single hard 10s deadline that covers both the handshake and the call, so
 * callers can forward it to `listTools`/`callTool` for a true end-to-end cap.
 */
async function withUpstreamClient<T>(
  config: McpProxyAdapterConfig,
  transportFactory: McpClientTransportFactory,
  fn: (client: Client, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const client = new Client(CLIENT_INFO);
  const transport = transportFactory(config);
  try {
    await client.connect(transport, { signal });
    return await fn(client, signal);
  } finally {
    await client.close().catch(() => {
      // Best-effort teardown — a close failure must never mask the original
      // result/error, nor crash the caller.
    });
  }
}

/**
 * Normalizes an upstream `callTool` result to plain text. The upstream is
 * untrusted input (spec §8, §8b Trust boundary): the result is typed
 * `unknown` on purpose — this only stringifies content, it never interprets,
 * executes, or otherwise trusts its shape.
 */
function normalizeUpstreamContent(result: unknown): string {
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content
        .map((block: unknown) => {
          if (block && typeof block === 'object' && 'type' in block) {
            const b = block as { type: unknown; text?: unknown };
            if (b.type === 'text' && typeof b.text === 'string') return b.text;
            return `[${String(b.type)} content omitted]`;
          }
          return '[unrecognized content omitted]';
        })
        .join('\n');
    }
    if ('toolResult' in result) {
      const toolResult = (result as { toolResult: unknown }).toolResult;
      try {
        return JSON.stringify(toolResult);
      } catch {
        return String(toolResult);
      }
    }
  }
  return '';
}

/** Returns true when the upstream result carries `isError: true`. */
function isUpstreamError(result: unknown): boolean {
  return (
    !!result && typeof result === 'object' && (result as { isError?: unknown }).isError === true
  );
}

/** Caps `text` at `maxChars`, appending `TRUNCATION_MARKER` when cut off. */
function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars) + TRUNCATION_MARKER, truncated: true };
}

/**
 * Generates an id for audit-log entries. Uses globalThis.crypto when available
 * (Node ≥ 19, all browsers) and falls back to a Math.random hex string for the
 * rare environments without it. Mirrors the HTTP API adapter's helper.
 */
function cryptoRandomId(): string {
  const g = globalThis as { crypto?: { randomUUID?(): string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Builds a SourceAdapter that proxies a single upstream MCP server.
 *
 * @param transportFactory Injectable transport seam — defaults to
 *   `StreamableHTTPClientTransport`. Tests pass a factory that returns an
 *   `InMemoryTransport` linked to a fake upstream `McpServer`.
 */
export function buildMcpProxySourceAdapter(
  transportFactory: McpClientTransportFactory = defaultTransportFactory,
): SourceAdapter<McpProxyAdapterConfig, McpSchema, McpCaps> {
  return {
    type: 'mcp',
    displayName: 'MCP server (proxy)',
    capabilities: ['tools'] as const,
    configSchema,
    scopeSelectionSchema,

    // -----------------------------------------------------------------------
    // testConnection — connect, list_tools, disconnect.
    // -----------------------------------------------------------------------
    async testConnection(config: McpProxyAdapterConfig): Promise<void> {
      try {
        await withUpstreamClient(config, transportFactory, async (client, signal) => {
          await client.listTools(undefined, { signal });
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to connect to MCP server at "${config.url}": ${message}`);
      }
    },

    // -----------------------------------------------------------------------
    // introspect — connect, list_tools, map to the `mcp` schema arm.
    // Snapshot only — no auto-refresh (spec §8b).
    // -----------------------------------------------------------------------
    async introspect(config: McpProxyAdapterConfig, _sourceId: string): Promise<McpSchema> {
      let listed: {
        tools: ReadonlyArray<{ name: string; description?: string; inputSchema: unknown }>;
      };
      try {
        listed = await withUpstreamClient(config, transportFactory, async (client, signal) =>
          client.listTools(undefined, { signal }),
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to list tools from MCP server at "${config.url}": ${message}`);
      }
      const tools: McpToolInfo[] = listed.tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema,
        isWrite: isWriteToolName(t.name),
      }));
      return { kind: 'mcp', tools };
    },

    // -----------------------------------------------------------------------
    // registerMcpTools — registers a read-through MCP tool per allowlisted,
    // non-write upstream tool.
    // -----------------------------------------------------------------------
    registerMcpTools(ctx: McpRegistrationContext<McpProxyAdapterConfig, McpSchema>): void {
      if (ctx.selection.kind !== 'mcp') {
        throw new Error(
          `McpProxySourceAdapter: expected mcp selection, got '${ctx.selection.kind}'`,
        );
      }

      const scope = ctx.selection;
      const config = ctx.config;
      const ns = ctx.toolNamespace;
      const sourceName = ctx.source.name;

      const audit = (
        toolName: string,
        toolArgs: Record<string, unknown>,
        result: 'success' | 'error',
        resultSummary: string,
        startTime: number,
      ): void => {
        const entry: AuditLogEntry = {
          id: cryptoRandomId(),
          timestamp: new Date().toISOString(),
          profileName: ctx.profileName,
          toolName,
          toolArgs,
          result,
          resultSummary,
          durationMs: Date.now() - startTime,
        };
        ctx.onAuditLog(entry);
      };

      for (const tool of ctx.schema.tools) {
        if (!scope.allowedTools.includes(tool.name)) continue;
        // Fail closed: Slice 0 never registers a write-classified tool, even
        // when explicitly allowlisted. Write approval is Slice 1.
        if (tool.isWrite) continue;

        const registeredName = `${ns}${tool.name}`;
        const description =
          tool.description ||
          `Proxied MCP tool "${tool.name}" from upstream source "${sourceName}". Read-only.`;

        ctx.server.registerTool(
          registeredName,
          {
            description,
            // The upstream's real argument shape is JSON Schema, not a Zod
            // schema the SDK can consume directly (see McpToolInfo.inputSchema
            // doc). A permissive passthrough object defers validation to the
            // upstream server itself — consistent with treating it as an
            // opaque, untrusted-but-forwarded call.
            inputSchema: z.looseObject({}),
            annotations: { readOnlyHint: true },
          },
          async (args: Record<string, unknown>) => {
            const t0 = Date.now();
            try {
              const upstreamResult = await withUpstreamClient(
                config,
                transportFactory,
                async (client, signal) =>
                  client.callTool({ name: tool.name, arguments: args }, undefined, { signal }),
              );
              const rawText = normalizeUpstreamContent(upstreamResult);
              const { text, truncated } = truncateText(rawText, MAX_RESPONSE_CHARS);
              const upstreamIsError = isUpstreamError(upstreamResult);

              audit(
                registeredName,
                args,
                upstreamIsError ? 'error' : 'success',
                `${upstreamIsError ? 'upstream error' : 'forwarded'} (${text.length} chars, truncated=${truncated})`,
                t0,
              );

              return upstreamIsError
                ? { content: [{ type: 'text' as const, text }], isError: true }
                : { content: [{ type: 'text' as const, text }] };
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              audit(registeredName, args, 'error', `call failed: ${message}`, t0);
              return {
                content: [{ type: 'text' as const, text: `Upstream MCP call failed: ${message}` }],
                isError: true,
              };
            }
          },
        );
      }
    },
  };
}
