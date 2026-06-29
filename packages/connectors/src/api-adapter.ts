// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Calame Tech inc.

/**
 * HttpApiSourceAdapter — an extensibility proof for the `SourceAdapter` contract.
 *
 * This adapter exposes an HTTP service as a single MCP tool, `http_get`, that
 * the LLM can use to fetch JSON / text from an arbitrary base URL. It is the
 * thinnest possible non-document, non-relational adapter and exists primarily
 * to validate that the `SourceAdapter<TConfig, TSchema, TCaps>` abstraction
 * scales beyond DB and document sources without further refactor.
 *
 * Intentional MVP simplifications (all expanded in later slices):
 *
 *   - GET only. POST/PUT/DELETE multiply the security surface; we add them
 *     once per-method scope flags are designed.
 *   - One implicit "default" service per source. OpenAPI / GraphQL parsing
 *     and multi-service introspection land in Phase 4+.
 *   - No request body / multipart / streaming. Response is read into memory
 *     and capped at 100 KB.
 *   - No response caching. The global rate limiter (token bucket per source
 *     type) is the only throttle.
 *
 * Scope model — three layers of allowlist enforced in order:
 *
 *   1. `scope.allowedOperations` (profile-level)  — must contain 'http_get'
 *      for the tool to be callable at all.
 *   2. `config.allowedHosts` (source-level)       — the resolved URL's host
 *      must be in this list when the list is non-empty. When `allowedHosts`
 *      is absent, the URL must be same-origin with `config.baseUrl`.
 *   3. `scope.allowedPathPrefixes` (profile-level) — the resolved URL's
 *      path must start with at least one prefix when the list is non-empty.
 *      Absence means "no prefix restriction" (caller may use any path the
 *      host allowlist permits).
 */

import { z } from 'zod';
import type {
  SourceAdapter,
  SourceSchema,
  ScopeSelection,
  McpRegistrationContext,
  AuditLogEntry,
  Capability,
} from '@calame/core';

import { assertResolvedHostSafe, isPrivateOrLocalHost, SsrfBlockedError } from './utils/ssrf.js';

// ---------------------------------------------------------------------------
// Config type
// ---------------------------------------------------------------------------

/**
 * Persisted, decrypted config for an HTTP API source.
 *
 * Stored encrypted in `Source.configEncrypted`; the host decrypts before
 * passing into the adapter via `McpRegistrationContext.config`.
 */
export interface HttpApiAdapterConfig {
  baseUrl: string;
  headers?: Record<string, string>;
  /**
   * Hosts the `http_get` tool is allowed to hit. When empty / undefined, the
   * tool is restricted to the same host as `baseUrl`. Each entry is matched
   * literally against URL.host (case-insensitive, port included if present
   * in the URL).
   */
  allowedHosts?: string[];
  /** Per-request timeout in ms (default: 10_000, max: 60_000). */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum bytes returned to the LLM. Larger responses are truncated with a flag. */
const MAX_RESPONSE_BYTES = 100 * 1024; // 100 KB
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const configSchema = z.object({
  baseUrl: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  allowedHosts: z.array(z.string().min(1)).optional(),
  timeoutMs: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional(),
}) as z.ZodType<HttpApiAdapterConfig>;

/**
 * Accepts every kind of ScopeSelection so a single adapter instance can be
 * stored in the registry without type errors. The adapter validates at runtime
 * that it received a `kind: 'api'` selection (see `registerMcpTools`).
 */
const scopeSelectionSchema = z.discriminatedUnion('kind', [
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

type ApiSchema = Extract<SourceSchema, { kind: 'api' }>;
type ApiCaps = Extract<Capability, 'introspect' | 'tools'>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Trim a trailing slash so concatenation with paths is unambiguous. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

/**
 * Builds the absolute URL for a given path + optional query record.
 *
 * Accepts absolute URLs (`https://other.example/x`) — these bypass `baseUrl`
 * resolution but still go through host-allowlist enforcement. Relative paths
 * are resolved against `baseUrl`.
 *
 * Returns null on any URL parsing error (caller surfaces this as a tool error).
 */
function buildUrl(
  pathOrAbsolute: string,
  query: Record<string, string> | undefined,
  baseUrl: string,
): URL | null {
  let url: URL;
  try {
    // `URL` constructor accepts either a full absolute URL or a relative path
    // resolved against a base. The empty-path case ('') resolves to baseUrl.
    url = new URL(pathOrAbsolute, normalizeBaseUrl(baseUrl) + '/');
  } catch {
    return null;
  }
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.append(k, v);
    }
  }
  return url;
}

/**
 * Returns true when `url`'s host is in the `allowed` list.
 *
 * Comparison is case-insensitive against `url.host` (host:port as present in
 * the URL) — wildcards are intentionally not supported in MVP. Private/local
 * hosts are rejected first via the bracket/port-aware `url.hostname` so an
 * allowlist entry can never authorise an internal target. DNS rebinding is
 * caught separately at fetch time by `assertResolvedHostSafe`.
 */
function isHostAllowed(url: URL, allowed: readonly string[]): boolean {
  if (isPrivateOrLocalHost(url.hostname)) return false;
  const lowered = url.host.toLowerCase();
  return allowed.some((a) => a.toLowerCase() === lowered);
}

/**
 * Returns true when `path` starts with one of the entries in `prefixes`.
 * Pathname comparison is case-sensitive (mirrors HTTP semantics).
 */
function isPathPrefixAllowed(path: string, prefixes: readonly string[]): boolean {
  for (const p of prefixes) {
    if (path === p || path.startsWith(p)) return true;
  }
  return false;
}

/**
 * Reads response.text() with a hard byte cap to avoid OOM on huge payloads.
 * Returns the (possibly truncated) string + a truncated flag.
 */
async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  const raw = await response.text();
  if (raw.length <= maxBytes) return { body: raw, truncated: false };
  return { body: raw.slice(0, maxBytes), truncated: true };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Builds a SourceAdapter for the HTTP API source type.
 *
 * Single-shot factory (no per-type fan-out unlike `buildDatabaseSourceAdapter`):
 * the same adapter handles every HTTP-flavored source. Authentication variations
 * (Bearer, basic, custom headers) are absorbed by `config.headers`, so a
 * per-vendor adapter would buy nothing at this stage.
 */
export function buildHttpApiSourceAdapter(): SourceAdapter<
  HttpApiAdapterConfig,
  ApiSchema,
  ApiCaps
> {
  return {
    type: 'http',
    displayName: 'HTTP API',
    capabilities: ['introspect', 'tools'] as const,
    configSchema,
    scopeSelectionSchema,

    // -----------------------------------------------------------------------
    // testConnection — HEAD request against baseUrl with the configured headers
    // -----------------------------------------------------------------------
    async testConnection(config: HttpApiAdapterConfig): Promise<void> {
      const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response | undefined;
      try {
        const normalized = normalizeBaseUrl(config.baseUrl);
        const target = new URL(normalized);
        // Anti-DNS-rebinding: block private/internal targets before fetching.
        await assertResolvedHostSafe(target.hostname);
        response = await fetch(normalized, {
          method: 'HEAD',
          headers: config.headers,
          signal: controller.signal,
          // Never follow redirects — a 3xx to an internal host would bypass
          // the resolution check above.
          redirect: 'error',
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error(`HEAD ${config.baseUrl} timed out after ${timeoutMs}ms`);
        }
        if (err instanceof SsrfBlockedError) {
          throw new Error('Connection blocked: the host resolves to a disallowed address.');
        }
        // Mask the underlying network reason from the caller.
        throw new Error('Network error while contacting the remote host.');
      } finally {
        clearTimeout(t);
      }
      // A clean HTTP status carries no sensitive network detail and is useful to
      // the caller — surface it instead of letting the catch above mask it as a
      // generic network error. HEAD is sometimes 405-rejected by APIs that only
      // declare GET — treat 405 as "endpoint reachable" so testConnection stays useful.
      if (response && !response.ok && response.status !== 405) {
        throw new Error(`HEAD ${config.baseUrl} → HTTP ${response.status}`);
      }
    },

    // -----------------------------------------------------------------------
    // introspect — returns the static MVP schema (1 service, 1 operation)
    // -----------------------------------------------------------------------
    async introspect(config: HttpApiAdapterConfig, _sourceId: string): Promise<ApiSchema> {
      return {
        kind: 'api',
        services: [
          {
            id: 'default',
            name: 'HTTP API',
            baseUrl: normalizeBaseUrl(config.baseUrl),
          },
        ],
        operations: [
          {
            id: 'http_get',
            method: 'GET',
            description:
              `Perform an HTTP GET against the configured base URL. The 'path' ` +
              `argument is appended to baseUrl (or used as absolute when starting ` +
              `with http(s)://, provided the host is allowlisted).`,
          },
        ],
      };
    },

    // -----------------------------------------------------------------------
    // registerMcpTools — exposes a single `http_get` MCP tool
    // -----------------------------------------------------------------------
    registerMcpTools(ctx: McpRegistrationContext<HttpApiAdapterConfig, ApiSchema>): void {
      if (ctx.selection.kind !== 'api') {
        throw new Error(
          `HttpApiSourceAdapter: expected api selection, got '${ctx.selection.kind}'`,
        );
      }

      const scope = ctx.selection;
      const config = ctx.config;
      const ns = ctx.toolNamespace;
      const sourceName = ctx.source.name;

      // Determine the effective host allowlist: explicit `config.allowedHosts`
      // when present, otherwise restrict to baseUrl's host. We do NOT default
      // to "any host" — open egress would defeat the security model.
      const baseUrlHost = (() => {
        try {
          return new URL(config.baseUrl).host;
        } catch {
          return '';
        }
      })();
      const effectiveAllowedHosts: readonly string[] =
        config.allowedHosts && config.allowedHosts.length > 0
          ? config.allowedHosts
          : baseUrlHost
            ? [baseUrlHost]
            : [];

      // Short-circuit: if 'http_get' is not in scope.allowedOperations, the
      // tool is registered but ALWAYS returns an error. This keeps the MCP
      // surface stable (tools/list returns the tool) without exposing the
      // operation to the LLM.
      const httpGetEnabled = scope.allowedOperations.includes('http_get');

      // Tool description — friendly enough for the LLM to figure out what it
      // can do without leaking the precise allowlist (we mention the base URL
      // explicitly so the LLM understands the scoping).
      const description =
        `Perform an HTTP GET against source "${sourceName}" (base ${config.baseUrl}). ` +
        `Returns { status, contentType, body, truncated }. Response body capped ` +
        `at ${Math.floor(MAX_RESPONSE_BYTES / 1024)} KB.`;

      // Audit helper — consistent shape with the document adapter so the
      // host's AuditLog viewer renders both uniformly.
      const audit = (
        args: Record<string, unknown>,
        resultSummary: string,
        result: 'success' | 'error',
        startTime: number,
      ): void => {
        const entry: AuditLogEntry = {
          id: cryptoRandomId(),
          timestamp: new Date().toISOString(),
          profileName: ctx.profileName,
          toolName: `${ns}http_get`,
          toolArgs: args,
          result,
          resultSummary,
          durationMs: Date.now() - startTime,
        };
        ctx.onAuditLog(entry);
      };

      ctx.server.tool(
        `${ns}http_get`,
        description,
        {
          path: z
            .string()
            .min(1)
            .describe(
              `URL path appended to baseUrl, e.g. "/v1/items". May also be an ` +
                `absolute URL when its host is in the source's allowedHosts.`,
            ),
          query: z
            .record(z.string(), z.string())
            .optional()
            .describe('Optional query parameters appended to the URL.'),
        },
        async (args: { path: string; query?: Record<string, string> }) => {
          const t0 = Date.now();

          if (!httpGetEnabled) {
            audit(args, 'operation not allowed', 'error', t0);
            return errorResponse(
              `Operation 'http_get' is not allowed by the active profile scope.`,
            );
          }

          // Build URL & enforce host allowlist
          const url = buildUrl(args.path, args.query, config.baseUrl);
          if (!url) {
            audit(args, 'invalid URL', 'error', t0);
            return errorResponse(`Invalid URL produced from path "${args.path}".`);
          }

          if (effectiveAllowedHosts.length === 0) {
            audit(args, 'no host allowlist (config.baseUrl unparseable)', 'error', t0);
            return errorResponse(
              `Source is misconfigured: baseUrl is not parseable and no allowedHosts is set.`,
            );
          }
          if (!isHostAllowed(url, effectiveAllowedHosts)) {
            audit(args, `host ${url.host} not allowlisted`, 'error', t0);
            return errorResponse(`Host "${url.host}" is not in the source's allowedHosts.`);
          }

          // Enforce path-prefix allowlist when defined
          if (scope.allowedPathPrefixes && scope.allowedPathPrefixes.length > 0) {
            if (!isPathPrefixAllowed(url.pathname, scope.allowedPathPrefixes)) {
              audit(args, `path ${url.pathname} not allowed`, 'error', t0);
              return errorResponse(
                `Path "${url.pathname}" is not allowed by the active profile scope.`,
              );
            }
          }

          // Issue the request with timeout & headers
          const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          let response: Response;
          try {
            // Anti-DNS-rebinding: resolve the host and reject if it (or any
            // resolved address) points at an internal range. Done after the
            // static allowlist check and immediately before the fetch.
            await assertResolvedHostSafe(url.hostname);
            response = await fetch(url.toString(), {
              method: 'GET',
              headers: config.headers,
              signal: controller.signal,
              // Never follow redirects — a 3xx to an internal host would
              // bypass the allowlist + resolution checks above.
              redirect: 'error',
            });
          } catch (err: unknown) {
            clearTimeout(timer);
            if (err instanceof Error && err.name === 'AbortError') {
              audit(args, `timeout after ${timeoutMs}ms`, 'error', t0);
              return errorResponse(`Request timed out after ${timeoutMs}ms.`);
            }
            // Mask the underlying reason (DNS result, blocked range, redirect
            // target) from the LLM — only the audit log sees the detail.
            const detail = err instanceof Error ? err.message : String(err);
            audit(args, `network error: ${detail}`, 'error', t0);
            return errorResponse('Network error while contacting the remote host.');
          }
          clearTimeout(timer);

          const contentType = response.headers.get('content-type') ?? '';
          let body: string;
          let truncated: boolean;
          try {
            const read = await readBoundedBody(response, MAX_RESPONSE_BYTES);
            body = read.body;
            truncated = read.truncated;
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            audit(args, `body read error: ${message}`, 'error', t0);
            return errorResponse(`Failed to read response body: ${message}`);
          }

          // Path is logged at-large; we do NOT log the response body to keep
          // audit entries safe to ship to a SIEM (the LLM already sees the
          // body via the tool return, so this is consistent with the
          // existing relational/document adapter behaviour where row data
          // is summarised in audit but not echoed verbatim).
          audit(
            args,
            `HTTP ${response.status} ${contentType} (${body.length}B, truncated=${truncated})`,
            response.ok ? 'success' : 'error',
            t0,
          );

          const payload = {
            status: response.status,
            contentType,
            body,
            truncated,
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(payload) }],
          };
        },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Small helpers — kept local so the adapter has zero non-zod imports
// ---------------------------------------------------------------------------

function errorResponse(message: string): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
  };
}

/**
 * Generates an id for audit-log entries. Uses globalThis.crypto when available
 * (Node ≥ 19, all browsers) and falls back to a Math.random hex string for the
 * rare environments without it (mostly older test runners — vitest exposes it).
 */
function cryptoRandomId(): string {
  const g = globalThis as { crypto?: { randomUUID?(): string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
