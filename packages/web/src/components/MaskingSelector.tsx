import type { ColumnMasking, MaskingMode } from '../types/schema.js';

const MODES: { value: MaskingMode; label: string; description: string }[] = [
  {
    value: 'none',
    label: 'None',
    description: 'Aucun masquage — la valeur brute est exposée telle quelle.',
  },
  {
    value: 'exclude',
    label: 'Exclude',
    description: 'Exclut complètement cette colonne des résultats renvoyés par le serveur MCP.',
  },
  {
    value: 'hash',
    label: 'Hash',
    description:
      'Remplace la valeur par son empreinte SHA-256. Permet la comparaison sans révéler la donnée réelle.',
  },
  {
    value: 'truncate',
    label: 'Truncate',
    description:
      'Masque une partie de la valeur en ne conservant que les premiers et/ou derniers caractères configurés.',
  },
  {
    value: 'replace',
    label: 'Replace',
    description: 'Remplace la valeur entière par une chaîne fixe (ex. [MASQUÉ]).',
  },
  {
    value: 'aggregate_only',
    label: 'Aggregate only',
    description:
      'Autorise uniquement les agrégats (COUNT, SUM…). Les valeurs individuelles ne sont pas accessibles.',
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
        title={currentMode?.description ?? 'Sélectionnez un mode de masquage pour cette colonne.'}
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
            title="Nombre de caractères à conserver depuis le début de la valeur."
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
            title="Nombre de caractères à conserver depuis la fin de la valeur."
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
          title="Valeur fixe qui remplacera la donnée réelle dans toutes les réponses."
          className="w-32 px-2 py-0.5 rounded bg-gray-800 border border-white/10 text-gray-200 text-xs focus:outline-none focus:border-os-500"
        />
      )}
    </div>
  );
}
