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
    };
// TODO: future arms — uncomment when adapters are built
// | { kind: 'stream'; topics: readonly TopicInfo[] }

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
  listScopes?(
    config: TConfig,
    sourceId: string,
    parent?: string,
  ): Promise<ReadonlyArray<unknown>>;
  listItems?(
    config: TConfig,
    sourceId: string,
    scope?: string,
  ): Promise<ReadonlyArray<unknown>>;
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
