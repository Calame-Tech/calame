import { useTranslations } from 'use-intl/react';
import type { GlobalMaskingRule, PiiCategory, MaskingMode } from '../types/schema.js';
import HelpTip from './HelpTip.js';

const PII_CATEGORIES: PiiCategory[] = [
  'email',
  'phone',
  'name',
  'address',
  'credit_card',
  'password',
  'ip_address',
  'ssn',
  'encrypted',
];
const MASKING_MODE_VALUES: MaskingMode[] = ['exclude', 'hash', 'truncate', 'replace', 'aggregate_only'];

interface GlobalMaskingRulesProps {
  rules: GlobalMaskingRule[];
  onRulesChange: (rules: GlobalMaskingRule[]) => void;
}

export default function GlobalMaskingRules({ rules, onRulesChange }: GlobalMaskingRulesProps) {
  const t = useTranslations('settingsPanels.masking');
  const MASKING_MODES: { value: MaskingMode; label: string }[] = MASKING_MODE_VALUES.map(
    (value) => ({ value, label: t(`modes.${value}.label`) }),
  );
  const addRule = () => {
    // Pick first category not already used
    const used = new Set(rules.map((r) => r.piiCategory));
    const available = PII_CATEGORIES.find((c) => !used.has(c)) ?? 'email';
    onRulesChange([...rules, { piiCategory: available, defaultMode: 'truncate' }]);
  };

  const updateRule = (index: number, patch: Partial<GlobalMaskingRule>) => {
    const updated = [...rules];
    updated[index] = { ...updated[index], ...patch };
    onRulesChange(updated);
  };

  const removeRule = (index: number) => {
    onRulesChange(rules.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-xs font-medium text-gray-400">
          {t('global.title')}
          <HelpTip content={t('global.headerHelpTip')} maxWidth={300} size="xs" />
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={addRule}
            className="text-xs px-2 py-1 rounded border border-white/10 text-gray-300 hover:bg-gray-800 hover:border-white/20 transition-colors"
          >
            {t('global.addRule')}
          </button>
          <HelpTip content={t('global.addRuleHelpTip')} position="left" size="xs" />
        </div>
      </div>
      <p className="text-xs text-gray-500">{t('global.description')}</p>
      {rules.length === 0 && (
        <p className="text-xs text-gray-600 italic">{t('global.emptyState')}</p>
      )}
      {rules.map((rule, i) => (
        <div key={i} className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            <select
              value={rule.piiCategory}
              onChange={(e) => updateRule(i, { piiCategory: e.target.value as PiiCategory })}
              className="px-2 py-1 rounded bg-gray-800/80 border border-white/10 text-gray-200 text-xs focus:outline-none focus:border-os-500"
            >
              {PII_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`global.piiCategoryLabels.${c}`)}
                </option>
              ))}
            </select>
            <HelpTip content={t('global.categoryHelpTip')} position="bottom" size="xs" />
          </div>
          <span className="text-xs text-gray-500">&rarr;</span>
          <div className="flex items-center gap-1">
            <select
              value={rule.defaultMode}
              onChange={(e) => updateRule(i, { defaultMode: e.target.value as MaskingMode })}
              className="px-2 py-1 rounded bg-gray-800/80 border border-white/10 text-gray-200 text-xs focus:outline-none focus:border-os-500"
            >
              {MASKING_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <HelpTip
              content={t('global.modeHelpTip')}
              maxWidth={320}
              position="bottom"
              size="xs"
            />
          </div>
          {rule.defaultMode === 'truncate' && (
            <div className="flex items-center gap-1 text-xs text-gray-400">
              <input
                type="number"
                min={0}
                max={10}
                value={rule.truncateOptions?.showFirst ?? 1}
                onChange={(e) =>
                  updateRule(i, {
                    truncateOptions: {
                      ...rule.truncateOptions,
                      showFirst: Number(e.target.value) || 0,
                    },
                  })
                }
                className="w-10 px-1 py-0.5 rounded bg-gray-800 border border-white/10 text-gray-200 text-xs"
              />
              <span>/</span>
              <input
                type="number"
                min={0}
                max={10}
                value={rule.truncateOptions?.showLast ?? 0}
                onChange={(e) =>
                  updateRule(i, {
                    truncateOptions: {
                      ...rule.truncateOptions,
                      showLast: Number(e.target.value) || 0,
                    },
                  })
                }
                className="w-10 px-1 py-0.5 rounded bg-gray-800 border border-white/10 text-gray-200 text-xs"
              />
              <HelpTip content={t('global.truncateHelpTip')} position="bottom" size="xs" />
            </div>
          )}
          {rule.defaultMode === 'replace' && (
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={rule.replaceValue ?? '[MASKED]'}
                onChange={(e) => updateRule(i, { replaceValue: e.target.value })}
                className="w-28 px-2 py-0.5 rounded bg-gray-800 border border-white/10 text-gray-200 text-xs"
              />
              <HelpTip content={t('global.replaceHelpTip')} position="bottom" size="xs" />
            </div>
          )}
          <button
            onClick={() => removeRule(i)}
            title={t('global.deleteRuleTitle')}
            className="text-gray-500 hover:text-red-400 text-xs transition-colors"
            aria-label={t('global.deleteRuleAriaLabel')}
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
