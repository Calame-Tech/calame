/**
 * Builds the data configuration persisted by ConfigurationDetailPage's single
 * Save from its local edit state (moved verbatim out of the page component).
 */
import type {
  ColumnMasking,
  Configuration,
  ScopeSelection,
  TableToolOptions,
} from '../types/schema.js';
import { setsToArrays } from './profiles.js';

export interface ConfigurationSaveInput {
  configName: string;
  label: string;
  selectedConns: Set<string>;
  selectedTables: Record<string, Set<string>>;
  tableOptions: Record<string, TableToolOptions>;
  columnMasking: Record<string, Record<string, ColumnMasking>>;
  /** Tables of the currently selected connections. */
  tableNames: string[];
  /** Names of the actual database connections. */
  connectionNames: string[];
  /** Knowledge-base (document) selection to persist. */
  documentSources: string[];
  documentScopes: Record<string, ScopeSelection>;
}

export function buildConfigurationToSave(input: ConfigurationSaveInput): {
  configToSave: Configuration;
  cleanedTables: Record<string, string[]>;
  cleanedTableOptions: Record<string, TableToolOptions>;
  cleanedColumnMasking: Record<string, Record<string, ColumnMasking>>;
} {
  // Only keep tables that belong to currently selected connections
  // and that have at least one column selected
  const validTableNames = new Set(input.tableNames);
  const cleanedTables: Record<string, string[]> = {};
  for (const [tableName, cols] of Object.entries(setsToArrays(input.selectedTables))) {
    if (validTableNames.has(tableName) && cols.length > 0) {
      cleanedTables[tableName] = cols;
    }
  }

  // Also clean tableOptions and columnMasking to remove orphaned tables
  const cleanedTableOptions: Record<string, TableToolOptions> = {};
  for (const [tableName, opts] of Object.entries(input.tableOptions)) {
    if (cleanedTables[tableName]) {
      cleanedTableOptions[tableName] = opts;
    }
  }
  const cleanedColumnMasking: Record<string, Record<string, ColumnMasking>> = {};
  for (const [tableName, masking] of Object.entries(input.columnMasking)) {
    if (cleanedTables[tableName]) {
      cleanedColumnMasking[tableName] = masking;
    }
  }

  // Build the Phase 5 unified shape. Each selected connection becomes a
  // relational scope carrying the cleaned tables/options/masking. When
  // multiple connections are selected they all share the same selection for
  // now (per-source differentiation can be added later via RagAccessSelector).
  //
  // Critical: PRESERVE any document-kind sources/scopes already on the
  // config. This save runs from the Databases tab but the top-level Save
  // button is visible on the Knowledge tab too — without the merge below
  // a click here would discard every RAG selection configured via
  // RagAccessSelector.
  //
  // Also critical: `selectedConns` is seeded from `config.sources` which can
  // contain non-DB source ids (e.g. a RAG nanoid that found its way in via
  // an earlier save). Filtering to actual DB connection names is what stops
  // the relational loop from overwriting `scopes[ragSourceId]` with
  // `kind: 'relational'` — which would clobber the document scope we just
  // spread above.
  const validConnNames = new Set(input.connectionNames);
  const relationalSources = [...input.selectedConns].filter((id) => validConnNames.has(id));

  const sourcesArray = [...relationalSources, ...input.documentSources];
  const scopes: Record<string, ScopeSelection> = { ...input.documentScopes };
  for (const sourceId of relationalSources) {
    scopes[sourceId] = {
      kind: 'relational',
      selectedTables: cleanedTables,
      tableOptions: cleanedTableOptions,
      columnMasking: cleanedColumnMasking,
    };
  }
  const configToSave: Configuration = {
    name: input.configName,
    label: input.label,
    sources: sourcesArray,
    scopes,
  };
  return { configToSave, cleanedTables, cleanedTableOptions, cleanedColumnMasking };
}
