import { useTranslations } from 'use-intl/react';
import type { ColumnMasking, MaskingMode } from '../types/schema.js';

const MODE_VALUES: MaskingMode[] = [
  'none',
  'exclude',
  'hash',
  'truncate',
  'replace',
  'aggregate_only',
];

interface MaskingSelectorProps {
  masking: ColumnMasking;
  onChange: (masking: ColumnMasking) => void;
}

export default function MaskingSelector({ masking, onChange }: MaskingSelectorProps) {
  const t = useTranslations('settingsPanels.masking');
  const MODES: { value: MaskingMode; label: string; description: string }[] = MODE_VALUES.map(
    (value) => ({
      value,
      label: t(`modes.${value}.label`),
      description: t(`modes.${value}.description`),
    }),
  );
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
        title={currentMode?.description ?? t('selector.defaultTitle')}
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
          <span>{t('selector.truncate.show')}</span>
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
            title={t('selector.truncate.showFirstTitle')}
            className="w-12 px-1.5 py-0.5 rounded bg-gray-800 border border-white/10 text-gray-200 text-xs focus:outline-none focus:border-os-500"
          />
          <span>{t('selector.truncate.first')}</span>
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
            title={t('selector.truncate.showLastTitle')}
            className="w-12 px-1.5 py-0.5 rounded bg-gray-800 border border-white/10 text-gray-200 text-xs focus:outline-none focus:border-os-500"
          />
          <span>{t('selector.truncate.last')}</span>
        </div>
      )}

      {masking.maskingMode === 'replace' && (
        <input
          type="text"
          value={masking.replaceValue ?? '[MASKED]'}
          onChange={(e) => onChange({ ...masking, replaceValue: e.target.value })}
          placeholder="[MASKED]"
          title={t('selector.replace.title')}
          className="w-32 px-2 py-0.5 rounded bg-gray-800 border border-white/10 text-gray-200 text-xs focus:outline-none focus:border-os-500"
        />
      )}
    </div>
  );
}
