import { useState } from 'react';
import type { Config, DatabaseSchema, TableInfo, TableToolOptions, PiiDetection, ColumnMasking, GlobalMaskingRule } from '../types/schema.js';
import TableOptionsCard from './TableOptionsCard.js';
import GlobalMaskingRulesComponent from './GlobalMaskingRules.js';
import HelpTip from './HelpTip.js';

interface ConfigPanelProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  schema: DatabaseSchema | null;
  selectedTables: Record<string, Set<string>>;
  piiDetections?: Record<string, Record<string, PiiDetection>> | null;
  columnMasking?: Record<string, Record<string, ColumnMasking>>;
  onColumnMaskingChange?: (masking: Record<string, Record<string, ColumnMasking>>) => void;
  globalMaskingRules?: GlobalMaskingRule[];
  onGlobalMaskingRulesChange?: (rules: GlobalMaskingRule[]) => void;
  onPiiOverride?: (tableName: string, columnName: string, detection: PiiDetection | null) => void;
}

function getTableOptions(config: Config, tableName: string, table: TableInfo): TableToolOptions {
  const existing = config.tableOptions?.[tableName];
  return {
    enabledTools: existing?.enabledTools ?? ['describe', 'aggregate', 'query'],
    maxLimit: existing?.maxLimit ?? 100,
    filterableColumns: existing?.filterableColumns ?? table.columns.map((c) => c.name),
    groupableColumns: existing?.groupableColumns ?? table.columns.map((c) => c.name),
  };
}

export default function ConfigPanel({ config, onConfigChange, schema, selectedTables, piiDetections, columnMasking, onColumnMaskingChange, globalMaskingRules, onGlobalMaskingRulesChange, onPiiOverride }: ConfigPanelProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [tableFilter, setTableFilter] = useState('');

  const update = (patch: Partial<Config>) => {
    onConfigChange({ ...config, ...patch });
  };

  // Tables that have at least one selected column
  const activeTables: { name: string; info: TableInfo }[] = [];
  if (schema) {
    for (const table of schema.tables) {
      const selected = selectedTables[table.name];
      if (selected && selected.size > 0) {
        activeTables.push({ name: table.name, info: table });
      }
    }
  }

  const handleTableOptionsChange = (tableName: string, options: TableToolOptions) => {
    update({
      tableOptions: {
        ...config.tableOptions,
        [tableName]: options,
      },
    });
  };

  return (
    <div className="space-y-4">
      {/* Data Masking */}
      {piiDetections && onGlobalMaskingRulesChange && (
        <div className="card-primary p-4">
          <GlobalMaskingRulesComponent
            rules={globalMaskingRules ?? []}
            onRulesChange={onGlobalMaskingRulesChange}
          />
        </div>
      )}

      {/* Advanced Table Options */}
      {activeTables.length > 0 && (
        <div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAdvancedOpen(!advancedOpen)}
              className="flex items-center gap-2 text-sm font-medium text-gray-300 hover:text-gray-100 transition-colors duration-200"
            >
              <svg
                className={`w-4 h-4 transition-transform duration-200 ${advancedOpen ? 'rotate-90' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              Advanced Table Options
              <span className="text-xs text-gray-500 font-normal">({activeTables.length} tables)</span>
            </button>
            <HelpTip
              content="Configure each table individually: exposed tools, row limit, filterable/groupable columns, and sensitive data masking."
              maxWidth={320}
              position="right"
              size="xs"
            />
          </div>

          {advancedOpen && (
            <div className="mt-4 space-y-4">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={tableFilter}
                  onChange={(e) => setTableFilter(e.target.value)}
                  placeholder="Filter tables..."
                  className="input-editorial flex-1 text-sm"
                />
                <HelpTip content="Filter the displayed tables by name." position="right" size="xs" />
              </div>
              {activeTables.filter(({ name }) => name.toLowerCase().includes(tableFilter.toLowerCase())).map(({ name, info }) => (
                <TableOptionsCard
                  key={name}
                  tableName={name}
                  table={info}
                  options={getTableOptions(config, name, info)}
                  onChange={(opts) => handleTableOptionsChange(name, opts)}
                  piiDetections={piiDetections?.[name]}
                  columnMasking={columnMasking?.[name]}
                  onColumnMaskingChange={
                    onColumnMaskingChange
                      ? (tableMasking) => onColumnMaskingChange({ ...columnMasking, [name]: tableMasking })
                      : undefined
                  }
                  onPiiOverride={
                    onPiiOverride
                      ? (colName, detection) => onPiiOverride(name, colName, detection)
                      : undefined
                  }
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
