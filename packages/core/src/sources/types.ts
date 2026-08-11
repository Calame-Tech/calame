import type { z } from 'zod';
import type { TableInfo, Relation, TableToolOptions } from '../introspect/types.js';
import type { ColumnMasking } from '../pii/types.js';
import type { McpRegistrationContext } from './mcp-context.js';

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

/**
 * The set of capabilities a SourceAdapter may declare.
 * Optional methods on SourceAdapter should be present iff the adapter declares
 * the matching capability — this is a runtime convention, not enforced by TS.
 *
 * `tools` and `write` are declared for future HTTP/SaaS adapters that ship
 * their own MCP tools or need write access. Not used by any current adapter.
 */
export type Capability =
  | 'introspect'
  | 'query'
  | 'search'
  | 'enumerate'
  | 'fetch'
  | 'subscribe'
  | 'sample'
  | 'tools' // future: HTTP/SaaS adapters that ship custom MCP tools
  | 'write'; // future: adapters that support write operations

// ---------------------------------------------------------------------------
// Source — persisted record shape
// ---------------------------------------------------------------------------

export interface Source {
  id: string;
  name: string;
  /** Adapter type key, e.g. 'postgresql' | 'local' | 's3' | 'http'. */
  type: string;
  /** AES-256-GCM encrypted JSON blob of adapter-specific config. */
  configEncrypted: string;
  capabilities: ReadonlyArray<Capability>;
  /** ISO-8601 */
  createdAt: string;
  /** ISO-8601 */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// SourceSchema — discriminated union per source kind
// ---------------------------------------------------------------------------

/** Minimal folder info needed at schema-projection level. */
export interface DocumentFolderInfo {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
}

/** Minimal document info needed at schema-projection level. */
export interface DocumentItemInfo {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
  mimeType: string;
  size: number;
}

/**
 * A logical service exposed by an API source (e.g. "weather", "stripe-customers").
 *
 * For the MVP HTTP adapter, every source has a single implicit "default" service
 * — the schema is intentionally flat. Once adapters parse OpenAPI / GraphQL / etc.
 * specs (Phase 4+), a source may declare several services and the LLM-facing tool
 * naming can fan out per service.
 */
export interface ServiceInfo {
  /** Stable id, unique within the source. MVP: always 'default'. */
  id: string;
  /** Human-readable label (e.g. 'HTTP API', 'Stripe Customers'). */
  name: string;
  /** Fully-resolved base URL (no trailing slash). */
  baseUrl: string;
}

/**
 * A single operation the LLM can invoke through this source.
 *
 * For the MVP HTTP adapter, exactly one operation (`http_get`) is exposed and
 * `pathPattern` is left undefined — the caller supplies the path at tool-call
 * time. Future iterations may pin operations to specific paths derived from an
 * OpenAPI spec.
 */
export interface OperationInfo {
  /** Stable id, unique within the source (e.g. 'http_get'). */
  id: string;
  /**
   * HTTP method. The MVP intentionally exposes GET only — adding POST/PUT/DELETE
   * expands the security surface significantly and should land in its own slice
   * with explicit per-method scope flags.
   */
  method: 'GET';
  /**
   * Path pattern (relative to `ServiceInfo.baseUrl`). Empty / undefined means
   * the LLM supplies the path at call time, constrained by `allowedPathPrefixes`.
   */
  pathPattern?: string;
  /** Human-readable description shown to the LLM. */
  description: string;
}

/**
 * A single tool exposed by an upstream MCP server, as reported by its
 * `tools/list` response.
 *
 * `inputSchema` is the upstream's raw JSON Schema for the tool's arguments —
 * kept as `unknown` here (not converted to a Zod schema) because JSON Schema
 * → Zod conversion is out of scope for the read-only proxy (Slice 0); the
 * proxy adapter registers a permissive passthrough schema instead and lets
 * the upstream server validate the real shape.
 */
/**
 * The subset of the MCP `ToolAnnotations` shape Calame reads. Upstream servers
 * are free to send more (or none at all) — every field is optional and
 * untrusted, so a missing/garbage value must degrade to the fail-closed
 * default rather than to "read".
 */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
  /**
   * Result of the read/write classification policy — see `classifyMcpTool` in
   * `@calame/connectors`. `true` means the tool is approval-gated: its handler
   * queues a `kind: 'mcp-tool'` write request instead of calling upstream.
   */
  isWrite: boolean;
  /**
   * Raw annotations as advertised by the upstream `tools/list`, when present.
   * Preserved (rather than dropped at introspect time) because they are the
   * highest-confidence signal the classification policy has.
   */
  annotations?: McpToolAnnotations;
}

export type SourceSchema =
  | { kind: 'relational'; tables: readonly TableInfo[]; relations: readonly Relation[] }
  | {
      kind: 'document';
      folders: readonly DocumentFolderInfo[];
      documents: readonly DocumentItemInfo[];
    }
  | {
      kind: 'api';
      services: readonly ServiceInfo[];
      operations: readonly OperationInfo[];
    }
  | {
      kind: 'mcp';
      /** Upstream server name, when advertised during initialization. */
      serverName?: string;
      tools: readonly McpToolInfo[];
    };
// TODO: future arms — uncomment when adapters are built
// | { kind: 'stream'; topics: readonly TopicInfo[] }

/**
 * Name-based half of the MCP read/write classification policy (the other half
 * — the upstream's own `annotations` — is applied by `classifyMcpTool` in
 * `@calame/connectors`, which is the policy's entry point).
 *
 * This used to be a fail-OPEN write-verb heuristic: a leading
 * `add_|create_|update_|delete_|set_|put_|write_|remove_` meant "write", and
 * *everything else* meant "read". That let real, side-effecting tools through
 * the approval gate purely because their verb was not on the list —
 * `store_memory`, `save_report`, `append_row`, `upsert_entity`, `move_file`,
 * `purge_cache` all classified as reads and were proxied straight through to
 * the upstream with no admin approval.
 *
 * The polarity is now inverted, which is the whole point: an ALLOWLIST of
 * unambiguously read-shaped prefixes classifies reads, and every other name —
 * including names nobody anticipated — classifies as a write. Misclassifying a
 * read as a write costs an admin one click in the approval queue;
 * misclassifying a write as a read executes an ungoverned mutation on the
 * upstream. Only the cheap mistake is allowed to happen by default.
 */
const READ_TOOL_NAME_PATTERN =
  /^(search|get|list|find|query|read|fetch|count|describe|retrieve|lookup|browse)_/i;

/** True when the tool name matches a known read-shaped prefix. */
export function isReadToolName(name: string): boolean {
  return READ_TOOL_NAME_PATTERN.test(name);
}

/**
 * Fail-closed name classification: anything that is not recognisably a read
 * is a write. Callers should prefer `classifyMcpTool` (connectors), which
 * consults the upstream annotations first and only falls back to this.
 */
export function isWriteToolName(name: string): boolean {
  return !isReadToolName(name);
}

// ---------------------------------------------------------------------------
// ScopeSelection — per-kind allowlist
// ---------------------------------------------------------------------------

export type ScopeSelection =
  | {
      kind: 'relational';
      selectedTables: Record<string, string[]>;
      tableOptions?: Record<string, TableToolOptions>;
      columnMasking?: Record<string, Record<string, ColumnMasking>>;
    }
  | {
      kind: 'document';
      mode: 'allowAll' | 'allowList';
      allowedFolders: readonly string[];
      allowedDocuments: readonly string[];
      piiMaskingMode?: 'inherit' | 'off';
      directFetchDisabled?: boolean;
    }
  | {
      kind: 'api';
      /**
       * Allowlist of operation ids (per `OperationInfo.id`) the LLM may invoke
       * via this source. Empty array effectively disables the adapter — the
       * tools register but every call returns `error: operation not allowed`.
       */
      allowedOperations: readonly string[];
      /**
       * Optional path prefix allowlist applied to the generic `http_get` tool.
       * When defined, the resolved request path MUST match at least one prefix.
       * When undefined, the adapter falls back to the host-allowlist defined
       * in the source's config (`allowedHosts`).
       */
      allowedPathPrefixes?: readonly string[];
    }
  | {
      kind: 'mcp';
      /**
       * Allowlist of upstream tool names (per `McpToolInfo.name`) the LLM may
       * invoke via this source. A tool absent from this list is never
       * registered. An allowlisted tool whose `McpToolInfo.isWrite` is `true`
       * registers only as an approval-gated proposal (Slice 1) — and only when
       * the host wired an `onWriteRequest`; without one it stays unregistered
       * (fail closed).
       */
      allowedTools: readonly string[];
    };

// ---------------------------------------------------------------------------
// SourceAdapter — runtime registry entry
// ---------------------------------------------------------------------------

/**
 * Adapter interface for a single source kind.
 *
 * Optional capability-gated methods (`query`, `listScopes`, `listItems`,
 * `fetchItem`, `search`, `sampleValues`, `registerMcpTools`) SHOULD be
 * present iff the adapter declares the matching capability in `capabilities`.
 * TypeScript cannot statically enforce this correlation without conditional
 * types that hurt ergonomics; use `registry.requireWithCapability(type, cap)`
 * at call sites to guard capability presence at runtime.
 */
export interface SourceAdapter<
  TConfig = unknown,
  TSchema extends SourceSchema = SourceSchema,
  TCaps extends Capability = Capability,
> {
  readonly type: string;
  readonly displayName: string;
  readonly capabilities: ReadonlyArray<TCaps>;
  readonly configSchema: z.ZodType<TConfig>;
  readonly scopeSelectionSchema: z.ZodType<ScopeSelection>;

  testConnection(config: TConfig): Promise<void>;
  introspect?(config: TConfig, sourceId: string): Promise<TSchema>;

  query?(config: TConfig, sql: string, params?: ReadonlyArray<unknown>): Promise<unknown>;
  listScopes?(config: TConfig, sourceId: string, parent?: string): Promise<ReadonlyArray<unknown>>;
  listItems?(config: TConfig, sourceId: string, scope?: string): Promise<ReadonlyArray<unknown>>;
  fetchItem?(config: TConfig, sourceId: string, itemId: string): Promise<unknown>;
  search?(config: TConfig, query: string, options?: unknown): Promise<unknown>;
  sampleValues?(
    config: TConfig,
    sourceId: string,
    scope: string,
    item: string,
    limit?: number,
  ): Promise<ReadonlyArray<unknown>>;

  registerMcpTools?(ctx: McpRegistrationContext<TConfig, TSchema>): void;
}
