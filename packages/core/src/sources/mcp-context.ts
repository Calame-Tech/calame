import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Source } from './types.js';
import type { SourceSchema, ScopeSelection } from './types.js';
import type { AuditLogEntry } from '../serve/types.js';
import type { ScopeGuard } from '../serve/scoped-executor.js';

export interface McpRegistrationContext<
  TConfig = unknown,
  TSchema extends SourceSchema = SourceSchema,
> {
  server: McpServer;
  source: Source;
  /** Already decrypted by host before being passed to the adapter. */
  config: TConfig;
  schema: TSchema;
  /** Already validated by host against the adapter's scopeSelectionSchema. */
  selection: ScopeSelection;
  profileName: string;
  /**
   * Empty string when there is only one source of this adapter kind active in
   * the profile, so tool names remain stable for single-source profiles.
   * Non-empty (e.g. `'prod_'`) when multiple sources of the same kind are
   * active — prevents tool name collisions.
   */
  toolNamespace: string;
  responseMode: 'friendly' | 'raw';
  onAuditLog: (entry: AuditLogEntry) => void;

  // Capability-specific extras supplied by host when relevant for the adapter.
  scopeGuard?: ScopeGuard;
  executeQuery?: (sql: string, params?: ReadonlyArray<unknown>) => Promise<unknown>;
  /** For 'search' adapters — loosely typed; Phase 3 will tighten once the RAG adapter ships. */
  searchIndex?: { search(query: string, opts?: unknown): Promise<unknown> };
}
