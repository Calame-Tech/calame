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
 * Slice 1 (see spec §5, §9) adds the approval gate: a tool classified as a
 * write by `classifyMcpTool` registers IFF `ctx.onWriteRequest` is present —
 * fail closed otherwise, matching the relational adapter's rule for missing
 * `onWriteRequest`. When it registers, its handler never calls upstream: it
 * queues `{ kind: 'mcp-tool', sourceId, toolName, args }` for admin approval
 * via `ctx.onWriteRequest` and returns immediately. The upstream call happens
 * later, out of this file, when the write-executor forwards an APPROVED
 * queue entry via `callUpstreamTool` (exported below).
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
  McpToolAnnotations,
  AuditLogEntry,
  Capability,
} from '@calame/core';
import { isReadToolName } from '@calame/core';

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

/** Result of a single forwarded upstream tool call — see `callUpstreamTool`. */
export interface UpstreamToolCallResult {
  /** Normalized, truncated plain-text content (see `normalizeUpstreamContent` / `truncateText`). */
  text: string;
  /** True when the upstream marked its own result `isError: true`. */
  isError: boolean;
}

/**
 * Forwards a single tool call to the upstream MCP server: connect on demand,
 * call, close (spec §8b) — then normalize and truncate the result. This is
 * the one place that talks to the upstream; it is shared by:
 *   - the read-through handler registered below (unchanged behavior, now
 *     factored through here instead of duplicating the connect/call/close), and
 *   - the write-executor's approval path (`packages/cli/src/write-executor.ts`),
 *     which calls this directly after resolving an approved `kind: 'mcp-tool'`
 *     queue entry's source config by `sourceId` (spec §5/§6) — the config
 *     never touches the queue row itself.
 */
export async function callUpstreamTool(
  config: McpProxyAdapterConfig,
  toolName: string,
  args: Record<string, unknown>,
  transportFactory: McpClientTransportFactory = defaultTransportFactory,
): Promise<UpstreamToolCallResult> {
  const upstreamResult = await withUpstreamClient(
    config,
    transportFactory,
    async (client, signal) =>
      client.callTool({ name: toolName, arguments: args }, undefined, { signal }),
  );
  const rawText = normalizeUpstreamContent(upstreamResult);
  const { text } = truncateText(rawText, MAX_RESPONSE_CHARS);
  return { text, isError: isUpstreamError(upstreamResult) };
}

// ---------------------------------------------------------------------------
// Read/write classification policy — the reference implementation.
// ---------------------------------------------------------------------------

/** Outcome of {@link classifyMcpTool}. */
export type McpToolClassification = 'read' | 'write';

/**
 * Decide whether an upstream MCP tool is a READ (proxied straight through) or
 * a WRITE (registered only as an approval-gated proposal, never executed by
 * the LLM's call). This function is the single reference for that decision —
 * `introspect` stamps its result onto `McpToolInfo.isWrite` and everything
 * downstream reads that flag.
 *
 * The policy, in order:
 *
 *  1. **The upstream's own annotations win.** If the tool carries an MCP
 *     `annotations` object, `readOnlyHint === true` means read; ANY other
 *     shape (`readOnlyHint: false`, a `destructiveHint` with no
 *     `readOnlyHint`, an annotations object that says nothing at all) means
 *     write. A server that annotates its tools and declines to mark this one
 *     read-only is taken at its word.
 *  2. **Otherwise, a name allowlist.** With no annotations to go on, only a
 *     recognisably read-shaped prefix (`search_`, `get_`, `list_`, `find_`,
 *     `query_`, `read_`, `fetch_`, `count_`, `describe_`, `retrieve_`,
 *     `lookup_`, `browse_` — see `isReadToolName` in `@calame/core`)
 *     classifies as a read.
 *  3. **Everything else is a write.** This is the fail-closed rule and the
 *     reason the policy exists: the previous heuristic listed *write* verbs
 *     and defaulted the rest to read, so `store_memory`, `append_row`,
 *     `upsert_entity`, `purge_cache` and every tool name nobody thought of
 *     were proxied to the upstream with no approval. An unknown name is now
 *     approval-gated by construction.
 *
 * The cost asymmetry justifies the bias: a read misclassified as a write
 * costs an admin one click; a write misclassified as a read is an ungoverned
 * mutation on someone else's server.
 */
export function classifyMcpTool(tool: {
  name: string;
  annotations?: McpToolAnnotations | null;
}): McpToolClassification {
  const annotations = tool.annotations;
  if (annotations !== undefined && annotations !== null) {
    return annotations.readOnlyHint === true ? 'read' : 'write';
  }
  return isReadToolName(tool.name) ? 'read' : 'write';
}

/**
 * Narrow an untrusted `tools/list` entry's `annotations` field to the subset
 * Calame reads. Returns `undefined` when the upstream sent nothing usable, so
 * `classifyMcpTool` falls through to the name policy rather than treating a
 * malformed value as "annotated".
 */
function readToolAnnotations(raw: unknown): McpToolAnnotations | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const picked: McpToolAnnotations = {};
  for (const key of [
    'readOnlyHint',
    'destructiveHint',
    'idempotentHint',
    'openWorldHint',
  ] as const) {
    if (typeof source[key] === 'boolean') picked[key] = source[key];
  }
  return picked;
}

/**
 * Builds a compact, human-readable summary of a queued write for the admin
 * approval UI: tool name + a JSON preview of its arguments, capped so a
 * pathological payload never blows up the write_queue `description` column.
 */
const WRITE_SUMMARY_MAX_CHARS = 500;
/**
 * Map an upstream write tool's verb onto the legacy SQL operation enum so the
 * approval UI applies the right friction: delete/remove-shaped tools get the
 * two-step confirm (like SQL DELETE), update/set/put-shaped get the UPDATE
 * treatment, everything else (add/create/write) is an additive one-click
 * INSERT.
 */
export function operationForWriteTool(toolName: string): 'insert' | 'update' | 'delete' {
  if (/^(delete|remove)_/i.test(toolName)) return 'delete';
  if (/^(update|set|put)_/i.test(toolName)) return 'update';
  return 'insert';
}

function summarizeWriteForApproval(toolName: string, args: Record<string, unknown>): string {
  let preview: string;
  try {
    preview = JSON.stringify(args);
  } catch {
    preview = '[unserializable args]';
  }
  if (preview.length > WRITE_SUMMARY_MAX_CHARS) {
    preview = preview.slice(0, WRITE_SUMMARY_MAX_CHARS) + '…';
  }
  return `MCP write "${toolName}" with args ${preview}`;
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
        tools: ReadonlyArray<{
          name: string;
          description?: string;
          inputSchema: unknown;
          annotations?: unknown;
        }>;
      };
      try {
        listed = await withUpstreamClient(config, transportFactory, async (client, signal) =>
          client.listTools(undefined, { signal }),
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to list tools from MCP server at "${config.url}": ${message}`);
      }
      const tools: McpToolInfo[] = listed.tools.map((t) => {
        // The upstream's annotations are carried onto McpToolInfo rather than
        // dropped: they are the strongest classification signal available, and
        // keeping them makes the decision auditable after the fact.
        const annotations = readToolAnnotations(t.annotations);
        return {
          name: t.name,
          description: t.description ?? '',
          inputSchema: t.inputSchema,
          isWrite: classifyMcpTool({ name: t.name, annotations }) === 'write',
          ...(annotations ? { annotations } : {}),
        };
      });
      return { kind: 'mcp', tools };
    },

    // -----------------------------------------------------------------------
    // registerMcpTools — registers a read-through MCP tool per allowlisted,
    // non-write upstream tool, plus (Slice 1) an approval-gated write tool
    // for allowlisted tools classified as writes — but only when the host
    // provides `ctx.onWriteRequest`; otherwise those stay unregistered,
    // exactly like Slice 0 (fail closed).
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
      const sourceId = ctx.source.id;
      const onWriteRequest = ctx.onWriteRequest;

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

        const registeredName = `${ns}${tool.name}`;

        // Per-tool isolation: `server.registerTool` throws on a duplicate name,
        // and an upstream tool can collide with one already registered by a
        // neighbouring source (`calc`, `query`, …) or by another proxied server
        // sharing this namespace. Without this guard the first collision aborts
        // the whole loop and every REMAINING tool of this source disappears
        // silently. Audit the collision and keep going instead.
        try {
          // -----------------------------------------------------------------
          // Write tool (Slice 1) — approval-gated. Fail closed: only registers
          // when the host wired an onWriteRequest, matching the relational
          // adapter's rule for the same missing dependency.
          // -----------------------------------------------------------------
          if (tool.isWrite) {
            if (!onWriteRequest) continue;

            const writeDescription =
              (tool.description ? `${tool.description} ` : '') +
              `Proposes a write via the proxied MCP tool "${tool.name}" from upstream source "${sourceName}". Queued for admin approval — nothing executes immediately.`;

            ctx.server.registerTool(
              registeredName,
              {
                description: writeDescription,
                inputSchema: z.looseObject({}),
                annotations: { readOnlyHint: false, destructiveHint: true },
              },
              (args: Record<string, unknown>) => {
                const t0 = Date.now();
                const id = onWriteRequest({
                  profileName: ctx.profileName,
                  description: summarizeWriteForApproval(tool.name, args),
                  // Compat values for the legacy flat PendingWriteQuery fields —
                  // see the PendingWriteAction doc comment in @calame/core:
                  // sql is empty (there is none), tableName carries the upstream
                  // tool name (keeps it visible in list views keyed on
                  // tableName). operation is derived from the tool-name verb so
                  // destructive upstream tools (delete_entity, remove_fact,
                  // update_x) inherit the UI's two-step approve confirmation
                  // exactly like SQL update/delete; additive tools map to
                  // 'insert' (one-click).
                  sql: '',
                  params: [],
                  tableName: tool.name,
                  operation: operationForWriteTool(tool.name),
                  action: { kind: 'mcp-tool', sourceId, toolName: tool.name, args },
                });

                audit(registeredName, args, 'success', `queued for approval (ID: ${id})`, t0);

                const text = `Write request submitted for approval (ID: ${id}). An admin will review it.\n\nTool: ${tool.name}\nArgs: ${JSON.stringify(args)}`;
                return { content: [{ type: 'text' as const, text }] };
              },
            );
            continue;
          }

          // -----------------------------------------------------------------
          // Read tool — forwards immediately and audits.
          // -----------------------------------------------------------------
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
                const { text, isError } = await callUpstreamTool(
                  config,
                  tool.name,
                  args,
                  transportFactory,
                );

                audit(
                  registeredName,
                  args,
                  isError ? 'error' : 'success',
                  `${isError ? 'upstream error' : 'forwarded'} (${text.length} chars)`,
                  t0,
                );

                return isError
                  ? { content: [{ type: 'text' as const, text }], isError: true }
                  : { content: [{ type: 'text' as const, text }] };
              } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                audit(registeredName, args, 'error', `call failed: ${message}`, t0);
                return {
                  content: [
                    { type: 'text' as const, text: `Upstream MCP call failed: ${message}` },
                  ],
                  isError: true,
                };
              }
            },
          );
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          audit(
            registeredName,
            {},
            'error',
            `tool registration skipped (likely a name collision): ${message}`,
            Date.now(),
          );
        }
      }
    },
  };
}
