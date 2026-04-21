import type { TableInfo, TableToolOptions, PiiDetection, ColumnMasking, PiiCategory } from '../types/schema.js';
import PiiBadge from './PiiBadge.js';
import MaskingSelector from './MaskingSelector.js';
import HelpTip from './HelpTip.js';

const TOOLS = ['describe', 'aggregate', 'query', 'write'] as const;

const TOOL_TOOLTIPS: Record<typeof TOOLS[number], string> = {
  describe: 'Expose un outil MCP permettant de décrire la structure de la table (colonnes, types, relations).',
  aggregate: 'Expose un outil MCP permettant d\'effectuer des agrégations (COUNT, SUM, AVG, GROUP BY) sur la table.',
  query: 'Expose un outil MCP permettant d\'interroger les données brutes de la table avec filtres et pagination.',
  write: 'Expose un outil MCP permettant d\'insérer ou de modifier des données dans la table (opérations d\'écriture).',
};

interface TableOptionsCardProps {
  tableName: string;
  table: TableInfo;
  options: TableToolOptions;
  onChange: (options: TableToolOptions) => void;
  piiDetections?: Record<string, PiiDetection>;
  columnMasking?: Record<string, ColumnMasking>;
  onColumnMaskingChange?: (masking: Record<string, ColumnMasking>) => void;
  onPiiOverride?: (columnName: string, detection: PiiDetection | null) => void;
}

export default function TableOptionsCard({ tableName, table, options, onChange, piiDetections, columnMasking, onColumnMaskingChange, onPiiOverride }: TableOptionsCardProps) {
  const toggleTool = (tool: typeof TOOLS[number]) => {
    const current = options.enabledTools;
    const next = current.includes(tool)
      ? current.filter((t) => t !== tool)
      : [...current, tool];
    onChange({ ...options, enabledTools: next });
  };

  const toggleColumn = (field: 'filterableColumns' | 'groupableColumns', col: string) => {
    const current = options[field];
    const next = current.includes(col)
      ? current.filter((c) => c !== col)
      : [...current, col];
    onChange({ ...options, [field]: next });
  };

  return (
    <div className="border border-gray-700 rounded-lg p-4 bg-gray-800/40 space-y-4">
      <h4 className="text-sm font-semibold text-gray-200">
        Table: <span className="text-os-400 font-mono">{tableName}</span>
      </h4>

      {/* Tools */}
      <div>
        <span className="flex items-center gap-1 text-xs font-medium text-gray-400 mb-2">
          Tools
          <HelpTip
            content="Sélectionner les outils MCP exposés pour cette table. Chaque outil correspond à une capacité accessible par les clients MCP."
            maxWidth={320}
            size="xs"
          />
        </span>
        <div className="flex flex-wrap gap-3">
          {TOOLS.map((tool) => (
            <label key={tool} className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={options.enabledTools.includes(tool)}
                onChange={() => toggleTool(tool)}
                className="rounded bg-gray-700 border-gray-600 text-os-500 focus:ring-os-500/30 focus:ring-offset-0"
              />
              {tool}
              <HelpTip content={TOOL_TOOLTIPS[tool]} position="bottom" maxWidth={300} size="xs" />
            </label>
          ))}
        </div>
      </div>

      {/* Max rows */}
      <div>
        <span className="flex items-center gap-1 text-xs font-medium text-gray-400 mb-1.5">
          Max rows
          <HelpTip
            content="Nombre maximum de lignes retournées par requête pour cette table. Limite appliquée côté serveur MCP."
            position="right"
            size="xs"
          />
        </span>
        <input
          type="number"
          min={1}
          value={options.maxLimit}
          onChange={(e) => onChange({ ...options, maxLimit: Math.max(1, Number(e.target.value) || 1) })}
          className="w-32 px-3 py-1.5 rounded-lg bg-gray-800/80 border border-gray-700 text-gray-100 text-sm font-mono focus:outline-none focus:border-os-500 focus:ring-1 focus:ring-os-500/30 transition-all duration-200"
        />
      </div>

      {/* Filterable columns */}
      <div>
        <span className="flex items-center gap-1 text-xs font-medium text-gray-400 mb-2">
          Filterable columns
          <HelpTip
            content="Colonnes sur lesquelles les clients MCP pourront appliquer des filtres WHERE. Décocher une colonne empêche tout filtrage sur celle-ci."
            maxWidth={300}
            size="xs"
          />
        </span>
        <div className="flex flex-wrap gap-x-3 gap-y-1.5">
          {table.columns.map((col) => (
            <label key={col.name} className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={options.filterableColumns.includes(col.name)}
                onChange={() => toggleColumn('filterableColumns', col.name)}
                className="rounded bg-gray-700 border-gray-600 text-os-500 focus:ring-os-500/30 focus:ring-offset-0"
              />
              <span className="font-mono text-xs">{col.name}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Groupable columns */}
      <div>
        <span className="flex items-center gap-1 text-xs font-medium text-gray-400 mb-2">
          Groupable columns
          <HelpTip
            content="Colonnes disponibles dans les clauses GROUP BY lors d'une agrégation. Décocher une colonne l'exclut des regroupements possibles."
            maxWidth={300}
            size="xs"
          />
        </span>
        <div className="flex flex-wrap gap-x-3 gap-y-1.5">
          {table.columns.map((col) => (
            <label key={col.name} className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={options.groupableColumns.includes(col.name)}
                onChange={() => toggleColumn('groupableColumns', col.name)}
                className="rounded bg-gray-700 border-gray-600 text-os-500 focus:ring-os-500/30 focus:ring-offset-0"
              />
              <span className="font-mono text-xs">{col.name}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Column Masking */}
      {onColumnMaskingChange && (
        <div>
          <span className="flex items-center gap-1 text-xs font-medium text-gray-400 mb-2">
            Column Masking
            <HelpTip
              content="Définir comment chaque colonne est masquée avant d'être transmise aux clients MCP. Les colonnes PII sont détectées automatiquement."
              maxWidth={320}
              size="xs"
            />
          </span>
          <div className="space-y-2">
            {table.columns.map((col) => {
              const detection = piiDetections?.[col.name];
              const masking: ColumnMasking = columnMasking?.[col.name] ?? { maskingMode: 'none', piiDetected: detection };
              return (
                <div key={col.name} className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs text-gray-300 w-28 shrink-0">{col.name}</span>
                  {detection ? (
                    <PiiBadge
                      detection={detection}
                      onChangeCategory={
                        onPiiOverride
                          ? (cat: PiiCategory) => onPiiOverride(col.name, { category: cat, confidence: 'manual', matchedBy: 'manual' })
                          : undefined
                      }
                      onRemove={
                        onPiiOverride
                          ? () => onPiiOverride(col.name, null)
                          : undefined
                      }
                    />
                  ) : (
                    onPiiOverride && (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => onPiiOverride(col.name, { category: 'name', confidence: 'manual', matchedBy: 'manual' })}
                          className="text-[10px] px-1.5 py-0.5 rounded-md font-medium ring-1 bg-gray-700/30 text-gray-500 ring-gray-600/30 hover:text-indigo-400 hover:ring-indigo-500/30 hover:bg-indigo-500/10 transition-colors cursor-pointer"
                        >
                          + PII
                        </button>
                        <HelpTip
                          content="Marquer manuellement cette colonne comme données personnelles (PII) pour lui appliquer un masquage"
                          position="right"
                          size="xs"
                        />
                      </div>
                    )
                  )}
                  <MaskingSelector
                    masking={masking}
                    onChange={(m) =>
                      onColumnMaskingChange({
                        ...columnMasking,
                        [col.name]: { ...m, piiDetected: detection },
                      })
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
