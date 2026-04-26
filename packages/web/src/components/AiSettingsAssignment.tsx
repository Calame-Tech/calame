import { useState, useEffect, useCallback } from 'react';
import HelpTip from './HelpTip.js';

interface AiSettingMeta {
  name: string;
  label: string;
  provider: string;
  configured: boolean;
}

interface AiSettingsAssignmentProps {
  selected: string[];
  onChange: (names: string[]) => void;
  /** Optional shortcut: opens the AI Settings page with a breadcrumb back to this MCP. */
  onManageSettings?: () => void;
}

/**
 * Multi-select for AI settings attached to a single MCP profile.
 * The first entry in `selected` acts as the default for chat clients.
 */
export default function AiSettingsAssignment({
  selected,
  onChange,
  onManageSettings,
}: AiSettingsAssignmentProps) {
  const [available, setAvailable] = useState<AiSettingMeta[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/ai-settings', { credentials: 'include' });
      const data = await res.json();
      if (data.success) setAvailable((data.settings ?? []) as AiSettingMeta[]);
    } catch {
      // ignore — UI shows empty state
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = (name: string) => {
    if (selected.includes(name)) {
      onChange(selected.filter((n) => n !== name));
    } else {
      onChange([...selected, name]);
    }
  };

  const moveUp = (index: number) => {
    if (index <= 0) return;
    const next = [...selected];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    onChange(next);
  };

  const moveDown = (index: number) => {
    if (index >= selected.length - 1) return;
    const next = [...selected];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    onChange(next);
  };

  return (
    <div className="card-primary p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-semibold text-gray-300">AI Settings</h4>
          <HelpTip
            content="Select which AI settings the chat clients of this MCP can use. Drag the order: the first entry is the default. Leave empty to fall back to the global default."
            position="right"
            maxWidth={340}
          />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500">
            {selected.length === 0 ? 'No setting · global default' : `${selected.length} selected`}
          </span>
          {onManageSettings && (
            <button
              type="button"
              onClick={onManageSettings}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-os-700/30 hover:bg-os-700/50 text-os-400 text-xs font-medium transition-all duration-200"
              title="Open the AI Settings page (you can come back via the breadcrumb)"
            >
              Manage AI settings →
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : available.length === 0 ? (
        <p className="text-sm text-gray-500">
          No AI setting defined yet. Create one from the AI Settings panel first.
        </p>
      ) : (
        <div className="space-y-3">
          {/* Selected list — ordered, first = default */}
          {selected.length > 0 && (
            <div className="space-y-1">
              {selected.map((name, i) => {
                const meta = available.find((s) => s.name === name);
                return (
                  <div
                    key={name}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg border border-os-600/40 bg-os-700/10"
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${meta?.configured ? 'bg-green-500' : 'bg-gray-600'}`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-os-300 truncate">
                        {meta?.label ?? name}{' '}
                        {i === 0 && (
                          <span className="text-[10px] uppercase tracking-wide text-os-400/80 ml-1">
                            default
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500">
                        {meta ? `${meta.provider} · ${meta.name}` : `${name} (deleted?)`}
                      </div>
                    </div>
                    <button
                      onClick={() => moveUp(i)}
                      disabled={i === 0}
                      title="Move up"
                      className="px-1.5 py-0.5 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => moveDown(i)}
                      disabled={i === selected.length - 1}
                      title="Move down"
                      className="px-1.5 py-0.5 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => toggle(name)}
                      title="Remove"
                      className="px-1.5 py-0.5 text-xs text-red-400 hover:text-red-300"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Available (non-selected) */}
          {available.some((s) => !selected.includes(s.name)) && (
            <div className="pt-1 border-t border-white/5">
              <p className="text-xs text-gray-500 mb-2 mt-2">Add a setting:</p>
              <div className="flex flex-wrap gap-2">
                {available
                  .filter((s) => !selected.includes(s.name))
                  .map((s) => (
                    <button
                      key={s.name}
                      onClick={() => toggle(s.name)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-700 bg-gray-900/40 text-gray-400 hover:text-gray-200 hover:border-gray-600 text-xs"
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${s.configured ? 'bg-green-500' : 'bg-gray-600'}`}
                      />
                      {s.label}
                      <span className="text-[10px] text-gray-500">({s.provider})</span>
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
