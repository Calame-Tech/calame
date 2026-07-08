import type { ColumnMasking, MaskingMode } from '../types/schema.js';

const MODES: { value: MaskingMode; label: string; description: string }[] = [
  {
    value: 'none',
    label: 'None',
    description: 'No masking — the raw value is exposed as-is.',
  },
  {
    value: 'exclude',
    label: 'Exclude',
    description: 'Completely excludes this column from results returned by the MCP server.',
  },
  {
    value: 'hash',
    label: 'Hash',
    description:
      'Replaces the value with its SHA-256 hash. Allows comparison without revealing the real data.',
  },
  {
    value: 'truncate',
    label: 'Truncate',
    description:
      'Masks part of the value, keeping only the configured number of leading and/or trailing characters.',
  },
  {
    value: 'replace',
    label: 'Replace',
    description: 'Replaces the entire value with a fixed string (e.g. [MASKED]).',
  },
  {
    value: 'aggregate_only',
    label: 'Aggregate only',
    description: 'Allows only aggregates (COUNT, SUM…). Individual values are not accessible.',
  },
];

interface MaskingSelectorProps {
  masking: ColumnMasking;
  onChange: (masking: ColumnMasking) => void;
}

export default function MaskingSelector({ masking, onChange }: MaskingSelectorProps) {
  const currentMode = MODES.find((m) => m.value === masking.maskingMode);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        value={masking.maskingMode}
        onChange={(e) => {
          const mode = e.target.value as MaskingMode;
          const updated: ColumnMasking = { ...masking, maskingMode: mode };
          if (mode === 'truncate' && !masking.truncateOptions) {
            updated.truncateOptions = { showFirst: 1, showLast: 0 };
          }
          if (mode === 'replace' && masking.replaceValue === undefined) {
            updated.replaceValue = '[MASKED]';
          }
          onChange(updated);
        }}
        title={currentMode?.description ?? 'Select a masking mode for this column.'}
        className="px-2 py-1 rounded bg-gray-800/80 border border-white/10 text-gray-200 text-xs focus:outline-none focus:border-os-500 focus:ring-1 focus:ring-os-500/30"
      >
        {MODES.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>

      {masking.maskingMode === 'truncate' && (
        <div className="flex items-center gap-1.5 text-xs text-gray-400">
          <span>Show</span>
          <input
            type="number"
            min={0}
            max={10}
            value={masking.truncateOptions?.showFirst ?? 1}
            onChange={(e) =>
              onChange({
                ...masking,
                truncateOptions: {
                  ...masking.truncateOptions,
                  showFirst: Math.max(0, Number(e.target.value) || 0),
                },
              })
            }
            title="Number of characters to keep from the start of the value."
            className="w-12 px-1.5 py-0.5 rounded bg-gray-800 border border-white/10 text-gray-200 text-xs focus:outline-none focus:border-os-500"
          />
          <span>first /</span>
          <input
            type="number"
            min={0}
            max={10}
            value={masking.truncateOptions?.showLast ?? 0}
            onChange={(e) =>
              onChange({
                ...masking,
                truncateOptions: {
                  ...masking.truncateOptions,
                  showLast: Math.max(0, Number(e.target.value) || 0),
                },
              })
            }
            title="Number of characters to keep from the end of the value."
            className="w-12 px-1.5 py-0.5 rounded bg-gray-800 border border-white/10 text-gray-200 text-xs focus:outline-none focus:border-os-500"
          />
          <span>last</span>
        </div>
      )}

      {masking.maskingMode === 'replace' && (
        <input
          type="text"
          value={masking.replaceValue ?? '[MASKED]'}
          onChange={(e) => onChange({ ...masking, replaceValue: e.target.value })}
          placeholder="[MASKED]"
          title="Fixed value that will replace the real data in all responses."
          className="w-32 px-2 py-0.5 rounded bg-gray-800 border border-white/10 text-gray-200 text-xs focus:outline-none focus:border-os-500"
        />
      )}
    </div>
  );
}
