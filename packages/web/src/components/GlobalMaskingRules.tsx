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
const MASKING_MODES: { value: MaskingMode; label: string }[] = [
  { value: 'exclude', label: 'Exclude' },
  { value: 'hash', label: 'Hash' },
  { value: 'truncate', label: 'Truncate' },
  { value: 'replace', label: 'Replace' },
  { value: 'aggregate_only', label: 'Aggregate only' },
];

interface GlobalMaskingRulesProps {
  rules: GlobalMaskingRule[];
  onRulesChange: (rules: GlobalMaskingRule[]) => void;
}

export default function GlobalMaskingRules({ rules, onRulesChange }: GlobalMaskingRulesProps) {
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
          Global Masking Rules
          <HelpTip
            content="Rules automatically applied to all PII columns of a given category, across all tables."
            maxWidth={300}
            size="xs"
          />
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={addRule}
            className="text-xs px-2 py-1 rounded border border-white/10 text-gray-300 hover:bg-gray-800 hover:border-white/20 transition-colors"
          >
            + Add Rule
          </button>
          <HelpTip
            content="Add a new global masking rule for a PII category."
            position="left"
            size="xs"
          />
        </div>
      </div>
      <p className="text-xs text-gray-500">
        Apply a default masking mode to all detected PII columns of a given category.
      </p>
      {rules.length === 0 && (
        <p className="text-xs text-gray-600 italic">No global rules defined.</p>
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
                  {c}
                </option>
              ))}
            </select>
            <HelpTip
              content="PII category this rule applies to (email, phone, name, etc.)."
              position="bottom"
              size="xs"
            />
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
              content="Masking mode: Exclude (removes the column), Hash (SHA-256 hash), Truncate (keeps N leading/trailing characters), Replace (fixed value), Aggregate only (blocks raw queries)."
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
              <HelpTip
                content="Number of characters preserved at the start / end of the value."
                position="bottom"
                size="xs"
              />
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
              <HelpTip
                content="Replacement value displayed in place of the sensitive data."
                position="bottom"
                size="xs"
              />
            </div>
          )}
          <button
            onClick={() => removeRule(i)}
            title="Supprimer cette règle"
            className="text-gray-500 hover:text-red-400 text-xs transition-colors"
            aria-label="Supprimer cette règle de masquage"
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
