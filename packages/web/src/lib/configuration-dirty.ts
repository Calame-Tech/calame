/**
 * Dirty-state comparison for ConfigurationDetailPage (Lot D3). All the local
 * editing state lives as component state (label, selected connections,
 * selected tables, table options, column masking) with nothing tying it back
 * to the last-saved `Configuration` — so edits were silently lost on
 * navigation. This helper compares the two so the page can warn before the
 * user leaves with unsaved changes.
 */
import type { Configuration, TableToolOptions, ColumnMasking } from '../types/schema.js';
import {
  getConfigurationSelectedTables,
  getConfigurationTableOptions,
  getConfigurationColumnMasking,
} from './configuration-accessors.js';

/** The subset of ConfigurationDetailPage's local edit state relevant to dirtiness. */
export interface ConfigurationEditState {
  label: string;
  selectedConns: Set<string>;
  selectedTables: Record<string, Set<string>>;
  tableOptions: Record<string, TableToolOptions>;
  columnMasking: Record<string, Record<string, ColumnMasking>>;
}

/**
 * True when `edit` differs from `config` (or from the empty baseline of a
 * brand-new configuration when `config` is undefined). Plain-data fields only
 * — JSON.stringify equality is exactly the structural equality wanted here.
 */
export function isConfigurationDirty(
  config: Configuration | undefined,
  configName: string,
  edit: ConfigurationEditState,
): boolean {
  const baseline = JSON.stringify({
    label: config?.label ?? configName,
    sources: [...(config?.sources ?? [])].sort(),
    selectedTables: config ? getConfigurationSelectedTables(config) : {},
    tableOptions: config ? getConfigurationTableOptions(config) : {},
    columnMasking: config ? getConfigurationColumnMasking(config) : {},
  });
  const current = JSON.stringify({
    label: edit.label,
    sources: [...edit.selectedConns].sort(),
    selectedTables: Object.fromEntries(
      Object.entries(edit.selectedTables).map(([table, cols]) => [table, [...cols]]),
    ),
    tableOptions: edit.tableOptions,
    columnMasking: edit.columnMasking,
  });
  return baseline !== current;
}
