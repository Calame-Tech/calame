// Per-profile "AI instructions" editor (plain text / Markdown, ≤ 4,000 chars).
// The text is only ever shown in a <textarea> — never rendered as HTML.
// Over the limit the save is refused with an explicit error; the value is never
// truncated (no `maxLength`, which would silently cut a paste).

import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl/react';
import { apiFetch } from '../lib/api.js';

/** Mirrors `AI_INSTRUCTIONS_MAX_LENGTH` in packages/cli/src/profile-ai-instructions.ts. */
export const AI_INSTRUCTIONS_MAX_LENGTH = 4000;

interface AiInstructionsEditorProps {
  profileName: string;
  value: string | undefined;
  /** Called with the value stored by the backend after a successful save. */
  onSaved: (value: string | undefined) => void;
}

export default function AiInstructionsEditor({
  profileName,
  value,
  onSaved,
}: AiInstructionsEditorProps) {
  const t = useTranslations('mcpDetail.aiInstructions');
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(value ?? '');
  }, [value]);

  // Same unit and trimming as the backend check.
  const length = draft.trim().length;
  const tooLong = length > AI_INSTRUCTIONS_MAX_LENGTH;
  const dirty = draft.trim() !== (value ?? '').trim();

  const handleSave = async () => {
    setSaved(false);
    if (tooLong) {
      setError(t('errors.tooLong', { max: AI_INSTRUCTIONS_MAX_LENGTH, count: length }));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/profiles/${encodeURIComponent(profileName)}/ai-instructions`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ aiInstructions: draft }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        code?: string;
        profile?: { aiInstructions?: string };
      };
      if (!res.ok) {
        setError(
          body.code === 'ai_instructions_too_long'
            ? t('errors.tooLong', { max: AI_INSTRUCTIONS_MAX_LENGTH, count: length })
            : t('errors.saveFailed'),
        );
        return;
      }
      onSaved(body.profile?.aiInstructions || undefined);
      setSaved(true);
    } catch {
      setError(t('errors.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 pt-3 border-t border-gray-700/50" data-testid="ai-instructions-section">
      <label htmlFor="ai-instructions-input" className="block text-xs text-gray-300">
        {t('label')}
      </label>
      <p className="text-xs text-gray-400 mt-0.5 mb-2">{t('hint')}</p>
      <textarea
        id="ai-instructions-input"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setSaved(false);
          if (error) setError(null);
        }}
        rows={5}
        placeholder={t('placeholder')}
        aria-invalid={tooLong}
        aria-describedby="ai-instructions-counter"
        className="w-full rounded-lg bg-gray-900/60 border border-gray-700 px-3 py-2 text-sm text-gray-200 font-mono focus:outline-none focus:ring-2 focus:ring-os-500"
      />
      <div className="mt-1 flex items-center justify-between gap-2">
        <span
          id="ai-instructions-counter"
          className={`text-xs ${tooLong ? 'text-red-400' : 'text-gray-400'}`}
        >
          {t('counter', { count: length, max: AI_INSTRUCTIONS_MAX_LENGTH })}
        </span>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !dirty || tooLong}
          className="px-3 py-1 rounded-lg bg-os-700 hover:bg-os-600 text-white text-xs font-medium transition-all duration-200 disabled:opacity-50"
        >
          {saving ? t('saving') : t('save')}
        </button>
      </div>
      {tooLong && !error && (
        <p role="alert" className="text-xs text-red-400 mt-1">
          {t('errors.tooLong', { max: AI_INSTRUCTIONS_MAX_LENGTH, count: length })}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-400 mt-1">
          {error}
        </p>
      )}
      {saved && !error && <p className="text-xs text-green-400 mt-1">{t('saved')}</p>}
      <p className="text-xs text-gray-400 mt-1">{t('reconnectNote')}</p>
    </div>
  );
}
