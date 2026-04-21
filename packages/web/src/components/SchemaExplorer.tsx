import React, { useState, useMemo } from 'react';
import type { DatabaseSchema, TableInfo, Relation, PiiDetection } from '../types/schema.js';
import PiiBadge from './PiiBadge.js';

interface SchemaExplorerProps {
  schema: DatabaseSchema | null;
  selectedTables: Record<string, Set<string>>;
  onSelectionChange: (selection: Record<string, Set<string>>) => void;
  piiDetections?: Record<string, Record<string, PiiDetection>> | null;
  onScanPii?: () => void;
  scanning?: boolean;
  /** When provided, tables are grouped by database instead of shown flat */
  connectionSchemas?: Record<string, DatabaseSchema>;
  /** Labels for connection names (keyed by connection name) */
  connectionLabels?: Record<string, string>;
}

/** Map common PG type keywords to badge colors */
function getTypeBadgeClasses(pgType: string): string {
  const t = pgType.toLowerCase();
  if (t.includes('int') || t.includes('numeric') || t.includes('float') || t.includes('double') || t.includes('decimal') || t.includes('serial') || t.includes('real'))
    return 'bg-emerald-500/15 text-emerald-400 ring-emerald-500/25';
  if (t.includes('bool'))
    return 'bg-amber-500/15 text-amber-400 ring-amber-500/25';
  if (t.includes('time') || t.includes('date') || t.includes('interval'))
    return 'bg-purple-500/15 text-purple-400 ring-purple-500/25';
  if (t.includes('json'))
    return 'bg-pink-500/15 text-pink-400 ring-pink-500/25';
  if (t.includes('uuid'))
    return 'bg-cyan-500/15 text-cyan-400 ring-cyan-500/25';
  // text, varchar, char, etc.
  return 'bg-blue-500/15 text-blue-400 ring-blue-500/25';
}

/** Stable color for a database name */
const DB_COLORS = [
  { dot: 'bg-blue-400', badge: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
  { dot: 'bg-emerald-400', badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  { dot: 'bg-purple-400', badge: 'bg-purple-500/15 text-purple-400 border-purple-500/30' },
  { dot: 'bg-orange-400', badge: 'bg-orange-500/15 text-orange-400 border-orange-500/30' },
  { dot: 'bg-pink-400', badge: 'bg-pink-500/15 text-pink-400 border-pink-500/30' },
  { dot: 'bg-cyan-400', badge: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30' },
];

export default function SchemaExplorer({
  schema,
  selectedTables,
  onSelectionChange,
  piiDetections,
  onScanPii,
  scanning,
  connectionSchemas,
  connectionLabels,
}: SchemaExplorerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());

  const toggleColumn = (tableName: string, columnName: string) => {
    const tableSet = new Set(selectedTables[tableName] ?? []);
    if (tableSet.has(columnName)) {
      tableSet.delete(columnName);
    } else {
      tableSet.add(columnName);
    }
    if (tableSet.size === 0) {
      // Remove the table entirely when no columns are selected
      const { [tableName]: _, ...rest } = selectedTables;
      onSelectionChange(rest);
    } else {
      onSelectionChange({ ...selectedTables, [tableName]: tableSet });
    }
  };

  const toggleAllColumns = (table: TableInfo) => {
    const tableSet = new Set(selectedTables[table.name] ?? []);
    if (tableSet.size === table.columns.length) {
      // Deselect: remove the table entirely
      const { [table.name]: _, ...rest } = selectedTables;
      onSelectionChange(rest);
    } else {
      onSelectionChange({
        ...selectedTables,
        [table.name]: new Set(table.columns.map((c) => c.name)),
      });
    }
  };

  const selectAllTables = () => {
    if (!schema) return;
    // Merge with existing selections (preserve tables from other connections)
    const newSelection = { ...selectedTables };
    for (const table of schema.tables) {
      newSelection[table.name] = new Set(table.columns.map((c) => c.name));
    }
    onSelectionChange(newSelection);
  };

  const deselectAllTables = () => {
    if (!schema) return;
    // Only remove tables that belong to the current schema
    const schemaTableNames = new Set(schema.tables.map((t) => t.name));
    const newSelection: Record<string, Set<string>> = {};
    for (const [tableName, cols] of Object.entries(selectedTables)) {
      if (!schemaTableNames.has(tableName)) {
        newSelection[tableName] = cols; // keep tables from other connections
      }
    }
    onSelectionChange(newSelection);
  };

  const getRelationsForTable = (tableName: string, relations: Relation[]) =>
    relations.filter((r) => r.fromTable === tableName || r.toTable === tableName);

  // Compute stats
  const stats = useMemo(() => {
    let tablesSelected = 0;
    let columnsTotal = 0;
    for (const cols of Object.values(selectedTables)) {
      if (cols.size > 0) {
        tablesSelected++;
        columnsTotal += cols.size;
      }
    }
    return { tablesSelected, columnsTotal };
  }, [selectedTables]);

  // Build table-to-connection mapping when connectionSchemas is provided
  const tableToConnection = useMemo(() => {
    if (!connectionSchemas) return null;
    const map: Record<string, string> = {};
    for (const [connName, connSchema] of Object.entries(connectionSchemas)) {
      for (const table of connSchema.tables) {
        map[table.name] = connName;
      }
    }
    return map;
  }, [connectionSchemas]);

  // Connection names in stable order
  const connectionNames = useMemo(() => {
    if (!connectionSchemas) return [];
    return Object.keys(connectionSchemas);
  }, [connectionSchemas]);

  // Filtered tables
  const filteredTables = useMemo(() => {
    if (!schema) return [];
    if (!searchQuery.trim()) return schema.tables;
    const q = searchQuery.toLowerCase();
    return schema.tables.filter((t) => t.name.toLowerCase().includes(q));
  }, [schema, searchQuery]);

  // Group filtered tables by connection
  const groupedTables = useMemo(() => {
    if (!tableToConnection || connectionNames.length <= 1) return null;
    const groups: Record<string, TableInfo[]> = {};
    for (const connName of connectionNames) {
      groups[connName] = [];
    }
    for (const table of filteredTables) {
      const conn = tableToConnection[table.name];
      if (conn && groups[conn]) {
        groups[conn].push(table);
      }
    }
    return groups;
  }, [filteredTables, tableToConnection, connectionNames]);

  const allSelected = useMemo(() => {
    if (!schema || schema.tables.length === 0) return false;
    return schema.tables.every((table) => {
      const sel = selectedTables[table.name];
      return sel && sel.size === table.columns.length;
    });
  }, [schema, selectedTables]);

  if (!schema || schema.tables.length === 0) {
    return (
      <p className="text-gray-400">
        No tables found. Connect a database first.
      </p>
    );
  }

  // Handle clicking a table toggle button — toggle in set (multi-open)
  const handleTableClick = (tableName: string) => {
    setExpandedTables((prev) => {
      const next = new Set(prev);
      if (next.has(tableName)) {
        next.delete(tableName);
      } else {
        next.add(tableName);
      }
      return next;
    });
  };

  // Get color for a connection
  const getConnColor = (connName: string) => {
    const idx = connectionNames.indexOf(connName);
    return DB_COLORS[idx % DB_COLORS.length];
  };

  // Render a table button
  const renderTableButton = (table: TableInfo, connName?: string) => {
    const selectedCols = selectedTables[table.name] ?? new Set<string>();
    const hasSelection = selectedCols.size > 0;
    const isExpanded = expandedTables.has(table.name);
    const allColumnsSelected = selectedCols.size === table.columns.length;

    return (
      <button
        key={table.name}
        onClick={() => handleTableClick(table.name)}
        className={`flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm transition-all duration-200 border ${
          isExpanded
            ? 'border-os-500 bg-os-900/30 ring-1 ring-os-500/30'
            : hasSelection
              ? 'border-os-600/50 bg-gray-800/50 ring-1 ring-os-600/20'
              : 'border-gray-700/70 bg-gray-800/50 hover:border-gray-600'
        }`}
      >
        {/* Selection indicator dot */}
        <span
          className={`flex-shrink-0 w-2 h-2 rounded-full ${
            allColumnsSelected
              ? 'bg-os-400'
              : hasSelection
                ? 'bg-os-600'
                : 'bg-gray-600'
          }`}
        />
        {/* Table name */}
        <span className="font-mono text-xs text-gray-200 truncate flex-1">{table.name}</span>
        {/* DB badge when showing flat (single db or search) */}
        {!connName && tableToConnection && connectionNames.length > 1 && (
          <span
            title={`Base de données : ${connectionLabels?.[tableToConnection[table.name]] ?? tableToConnection[table.name]}`}
            className={`flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded border font-medium ${getConnColor(tableToConnection[table.name]).badge}`}
          >
            {connectionLabels?.[tableToConnection[table.name]] ?? tableToConnection[table.name]}
          </span>
        )}
        {/* Column count badge */}
        <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-gray-700/80 text-gray-400 font-medium">
          {selectedCols.size}/{table.columns.length}
        </span>
      </button>
    );
  };

  // Render accordion panel for a table
  const renderAccordion = (table: TableInfo) => {
    if (!expandedTables.has(table.name)) return null;
    const selectedCols = selectedTables[table.name] ?? new Set<string>();
    const tableRelations = getRelationsForTable(table.name, schema.relations);
    const connName = tableToConnection?.[table.name];
    const color = connName ? getConnColor(connName) : null;

    return (
      <div key={`accordion-${table.name}`} className="col-span-full mt-1 mb-2 rounded-lg border border-os-500/40 bg-gray-800/60 p-4">
        {/* Accordion header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h3 className="font-mono font-semibold text-os-400 text-sm">
              {table.name}
              <span className="ml-2 text-gray-500 font-normal text-xs">
                ({table.columns.length} columns)
              </span>
            </h3>
            {color && connName && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${color.badge}`}>
                {connectionLabels?.[connName] ?? connName}
              </span>
            )}
          </div>
          <button
            onClick={() => toggleAllColumns(table)}
            className="text-xs text-gray-400 hover:text-gray-200 transition-colors px-2 py-1 rounded border border-gray-700 hover:border-gray-600"
          >
            {selectedCols.size === table.columns.length ? 'Deselect all' : 'Select all'}
          </button>
        </div>

        {/* FK relations summary */}
        {tableRelations.length > 0 && (
          <div className="mb-3 text-xs text-gray-500 flex flex-wrap gap-2">
            {tableRelations.map((r, i) => {
              const isFrom = r.fromTable === table.name;
              const tooltipText = isFrom
                ? `Clé étrangère : ${r.fromColumn} référence ${r.toTable}.${r.toColumn}`
                : `Clé étrangère : ${r.fromTable}.${r.fromColumn} référence ${r.toColumn} dans cette table`;
              return (
                <span
                  key={i}
                  title={tooltipText}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-gray-700/50 border border-gray-700 cursor-default"
                >
                  <span className="text-blue-400 font-mono">{isFrom ? r.fromColumn : r.toColumn}</span>
                  <span className="text-gray-600">&rarr;</span>
                  <span className="text-gray-400 font-mono">{isFrom ? `${r.toTable}.${r.toColumn}` : `${r.fromTable}.${r.fromColumn}`}</span>
                </span>
              );
            })}
          </div>
        )}

        {/* Multi-column column grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-1.5">
          {table.columns.map((col) => {
            const isFk = tableRelations.some(
              (r) => r.fromTable === table.name && r.fromColumn === col.name,
            );
            return (
              <label
                key={col.name}
                className="flex items-center gap-2 text-sm px-2 py-1 rounded hover:bg-gray-700/30 cursor-pointer transition-colors"
              >
                <input
                  type="checkbox"
                  checked={selectedCols.has(col.name)}
                  onChange={() => toggleColumn(table.name, col.name)}
                  className="rounded border-gray-600 text-os-600 focus:ring-os-500/30 focus:ring-offset-0 flex-shrink-0"
                />
                <span className="font-mono text-gray-200 text-xs truncate">{col.name}</span>
                <span
                  title={`Type SQL : ${col.type}${col.nullable ? ' — accepte les valeurs NULL' : ' — NOT NULL'}`}
                  className={`flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-md font-medium ring-1 ${getTypeBadgeClasses(col.type)}`}
                >
                  {col.type}
                </span>
                {table.primaryKeys.includes(col.name) && (
                  <span
                    title="Clé primaire — identifiant unique de chaque ligne de cette table."
                    className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-md font-bold bg-yellow-500/15 text-yellow-400 ring-1 ring-yellow-500/25"
                  >
                    PK
                  </span>
                )}
                {isFk && (
                  <span
                    title="Clé étrangère — référence une ligne dans une autre table. Cliquez sur la table pour voir les relations."
                    className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-md font-bold bg-blue-500/15 text-blue-400 ring-1 ring-blue-500/25"
                  >
                    FK
                  </span>
                )}
                {piiDetections?.[table.name]?.[col.name] && (
                  <PiiBadge detection={piiDetections[table.name][col.name]} />
                )}
                {col.nullable && (
                  <span className="flex-shrink-0 text-[10px] text-gray-600">null</span>
                )}
              </label>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div>
      {/* Header row */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-5">
        <div>
          <h2 className="text-xl font-semibold">Tables &amp; Columns</h2>
          <p className="text-sm text-gray-500 mt-1">
            <span className="text-os-400 font-medium">{stats.tablesSelected}</span> table{stats.tablesSelected !== 1 ? 's' : ''} selected,{' '}
            <span className="text-os-400 font-medium">{stats.columnsTotal}</span> column{stats.columnsTotal !== 1 ? 's' : ''} total
          </p>
        </div>
        <div className="flex items-center gap-3">
          {onScanPii && (
            <button
              onClick={onScanPii}
              disabled={scanning}
              title="Analyser toutes les colonnes sélectionnées pour détecter automatiquement les données personnelles (IIP) telles que e-mails, téléphones, noms, etc."
              className="px-3 py-1.5 text-xs font-medium rounded-md border border-amber-600/50 text-amber-400 hover:bg-amber-900/20 hover:border-amber-500/50 transition-all duration-200 disabled:opacity-50"
            >
              {scanning ? 'Scanning...' : 'Scan for PII'}
            </button>
          )}
          <button
            onClick={allSelected ? deselectAllTables : selectAllTables}
            title={allSelected ? 'Désélectionner toutes les tables et colonnes de ce schéma.' : 'Sélectionner toutes les tables et colonnes de ce schéma pour les inclure dans le serveur MCP.'}
            className="px-3 py-1.5 text-xs font-medium rounded-md border border-gray-700 text-gray-300 hover:bg-gray-800 hover:border-gray-600 transition-all duration-200"
          >
            {allSelected ? 'Deselect All' : 'Select All'}
          </button>
        </div>
      </div>

      {/* Search bar */}
      <div className="relative mb-5">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
        </svg>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search tables..."
          className="w-full sm:w-72 pl-10 pr-4 py-2 rounded-lg bg-gray-800/80 border border-gray-700 text-gray-100 placeholder-gray-500 text-sm focus:outline-none focus:border-os-500 focus:ring-1 focus:ring-os-500/30 transition-all duration-200"
        />
      </div>

      {/* Tables — grouped by database or flat */}
      {groupedTables && !searchQuery.trim() ? (
        // Grouped by database
        <div className="space-y-6">
          {connectionNames.map((connName) => {
            const tables = groupedTables[connName];
            if (!tables || tables.length === 0) return null;
            const color = getConnColor(connName);
            const displayName = connectionLabels?.[connName] ?? connName;

            return (
              <div key={connName}>
                {/* Database group header */}
                <div className="flex items-center gap-2 mb-3">
                  <span className={`w-2.5 h-2.5 rounded-full ${color.dot}`} />
                  <h3 className="text-sm font-semibold text-gray-200">{displayName}</h3>
                  <span className="text-xs text-gray-500">({tables.length} table{tables.length !== 1 ? 's' : ''})</span>
                </div>

                {/* Table buttons grid */}
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
                  {tables.map((table) => (
                    <React.Fragment key={table.name}>
                      {renderTableButton(table, connName)}
                      {renderAccordion(table)}
                    </React.Fragment>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        // Flat view (single db, or search active)
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
            {filteredTables.map((table) => (
              <React.Fragment key={table.name}>
                {renderTableButton(table)}
                {renderAccordion(table)}
              </React.Fragment>
            ))}
          </div>
        </>
      )}

      {filteredTables.length === 0 && (
        <p className="text-gray-500 text-sm text-center py-8">
          No tables matching &quot;{searchQuery}&quot;
        </p>
      )}
    </div>
  );
}
