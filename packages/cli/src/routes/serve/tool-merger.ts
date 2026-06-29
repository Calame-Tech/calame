import type {
  TableToolOptions,
  ColumnMasking,
  ScopeSelection,
} from '@calame/core';
import {
  getConfigurationColumnMasking,
  getConfigurationRelationalSources,
  getConfigurationSelectedTables,
  getConfigurationTableOptions,
  getConfigurationDocumentScopes,
} from '@calame/core';
import type { ServeConfiguration } from '@calame/core';

/** Masking mode restrictiveness order (lower index = less restrictive). */
const MASKING_ORDER: readonly string[] = [
  'none',
  'aggregate_only',
  'replace',
  'truncate',
  'hash',
  'exclude',
];

/**
 * Merge multiple configurations into a single effective configuration.
 * Union permissive strategy: all tools enabled by any config are enabled,
 * max limits are taken, columns are unioned, least restrictive masking wins.
 *
 * Phase 5: now accepts `ServeConfiguration` objects directly (the type returned
 * by `readConfigurationsFile`). The legacy `connections`/`selectedTables`/
 * `tableOptions`/`columnMasking` root fields have been made optional as of Phase 5
 * (the migrator deletes them after folding their data into `sources`/`scopes`).
 * All field reads go through the Configuration accessors so that both the
 * pre-migration legacy shape and the new unified shape are handled identically.
 *
 * Phase 6 — document scopes: per-source `kind: 'document'` allowlists declared
 * in any of the Configurations are merged into `documentScopes`. The merge
 * follows the same "least restrictive" spirit as the relational side:
 *   - if **any** config sets `mode: 'allowAll'` for a sourceId, the result is
 *     `allowAll` with empty allowlists (least restrictive wins);
 *   - otherwise (every config is `allowList`) the merged allowedFolders and
 *     allowedDocuments are the unions of the individual config lists.
 */
/** Narrowed document scope type. */
type DocumentScope = Extract<ScopeSelection, { kind: 'document' }>;

export function mergeConfigurations(
  configs: ServeConfiguration[],
): {
  connections: string[];
  selectedTables: Record<string, string[]>;
  tableOptions: Record<string, TableToolOptions>;
  columnMasking: Record<string, Record<string, ColumnMasking>>;
  /**
   * Merged document (RAG) scopes from every configuration in the array.
   * Merge rule: "allowAll wins" — if any config has mode='allowAll' for a
   * given sourceId, the result is allowAll (empty allowlists). Otherwise the
   * allowedFolders and allowedDocuments lists are unioned across all configs.
   * Mirrors the relational strategy (union / least-restrictive).
   */
  documentScopes: Record<string, DocumentScope>;
} {
  const connectionsSet = new Set<string>();
  const selectedTables: Record<string, string[]> = {};
  const tableOptions: Record<string, TableToolOptions> = {};
  const columnMasking: Record<string, Record<string, ColumnMasking>> = {};
  const documentScopes: Record<string, DocumentScope> = {};

  for (const config of configs) {
    for (const c of getConfigurationRelationalSources(config)) connectionsSet.add(c);

    // Union of tables and columns (read via accessor — handles both unified and legacy shape)
    for (const [table, cols] of Object.entries(getConfigurationSelectedTables(config))) {
      if (!selectedTables[table]) {
        selectedTables[table] = [...cols];
      } else {
        const existing = new Set(selectedTables[table]);
        for (const col of cols) existing.add(col);
        selectedTables[table] = [...existing];
      }
    }

    // Union permissive for tableOptions
    for (const [table, rawOpts] of Object.entries(getConfigurationTableOptions(config) ?? {})) {
      const opts = rawOpts as Partial<TableToolOptions>;
      if (!tableOptions[table]) {
        tableOptions[table] = {
          enabledTools: opts.enabledTools ?? ['describe', 'aggregate', 'query'],
          maxLimit: opts.maxLimit ?? 200,
          filterableColumns: opts.filterableColumns ?? [],
          groupableColumns: opts.groupableColumns ?? [],
        };
      } else {
        const existing = tableOptions[table];
        // Union of enabledTools
        const toolsSet = new Set([...existing.enabledTools, ...(opts.enabledTools ?? [])]);
        existing.enabledTools = [...toolsSet] as TableToolOptions['enabledTools'];
        // Max of maxLimit
        existing.maxLimit = Math.max(existing.maxLimit, opts.maxLimit ?? 200);
        // Union of filterableColumns
        const filterSet = new Set([...(existing.filterableColumns ?? []), ...(opts.filterableColumns ?? [])]);
        existing.filterableColumns = [...filterSet];
        // Union of groupableColumns
        const groupSet = new Set([...(existing.groupableColumns ?? []), ...(opts.groupableColumns ?? [])]);
        existing.groupableColumns = [...groupSet];
      }
    }

    // Least restrictive masking wins
    for (const [table, colMasking] of Object.entries(getConfigurationColumnMasking(config) ?? {})) {
      if (!columnMasking[table]) {
        columnMasking[table] = { ...colMasking };
      } else {
        for (const [col, masking] of Object.entries(colMasking)) {
          if (!columnMasking[table][col]) {
            columnMasking[table][col] = masking;
          } else {
            // Keep the least restrictive masking mode
            const currentIdx = MASKING_ORDER.indexOf(columnMasking[table][col].maskingMode);
            const newIdx = MASKING_ORDER.indexOf(masking.maskingMode);
            if (newIdx < currentIdx) {
              columnMasking[table][col] = masking;
            }
          }
        }
      }
    }

    // Merge document (RAG) scopes — "allowAll wins, else union of allowlists".
    //
    // piiMaskingMode merge policy: 'off' wins. Rationale — the toggle is an
    // explicit user opt-out for sources whose content collides with the PII
    // detector heuristics. When any linked configuration disables masking we
    // honour that intent; otherwise masking stays at the default. This
    // mirrors the "least-restrictive-on-access" merge for allowAll/allowList.
    for (const [sourceId, docScope] of Object.entries(getConfigurationDocumentScopes(config))) {
      const existing = documentScopes[sourceId];
      const piiMaskingMode: 'off' | undefined =
        existing?.piiMaskingMode === 'off' || docScope.piiMaskingMode === 'off' ? 'off' : undefined;
      // directFetchDisabled merge policy: true wins. If any configuration disables direct fetch
      // for the same source, it stays disabled in the merged scope.
      const directFetchDisabled: true | undefined =
        existing?.directFetchDisabled === true || docScope.directFetchDisabled === true
          ? true
          : undefined;
      if (!existing) {
        // First time we see this sourceId: copy as-is (mutable snapshot).
        documentScopes[sourceId] = {
          kind: 'document',
          mode: docScope.mode,
          allowedFolders: [...docScope.allowedFolders],
          allowedDocuments: [...docScope.allowedDocuments],
          ...(piiMaskingMode !== undefined ? { piiMaskingMode } : {}),
          ...(directFetchDisabled !== undefined ? { directFetchDisabled } : {}),
        };
      } else if (existing.mode === 'allowAll' || docScope.mode === 'allowAll') {
        // Either side is allowAll → promote to allowAll (least restrictive wins).
        documentScopes[sourceId] = {
          kind: 'document',
          mode: 'allowAll',
          allowedFolders: [],
          allowedDocuments: [],
          ...(piiMaskingMode !== undefined ? { piiMaskingMode } : {}),
          ...(directFetchDisabled !== undefined ? { directFetchDisabled } : {}),
        };
      } else {
        // Both are allowList → union of the two allowlists.
        const foldersSet = new Set([...existing.allowedFolders, ...docScope.allowedFolders]);
        const docsSet = new Set([...existing.allowedDocuments, ...docScope.allowedDocuments]);
        documentScopes[sourceId] = {
          kind: 'document',
          mode: 'allowList',
          allowedFolders: [...foldersSet],
          allowedDocuments: [...docsSet],
          ...(piiMaskingMode !== undefined ? { piiMaskingMode } : {}),
          ...(directFetchDisabled !== undefined ? { directFetchDisabled } : {}),
        };
      }
    }
  }

  return {
    connections: [...connectionsSet],
    selectedTables,
    tableOptions,
    columnMasking,
    documentScopes,
  };
}
