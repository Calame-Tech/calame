// Visible notice for a data configuration with unsaved edits (kept as a draft
// across page changes, see lib/configuration-draft.ts): save or discard them.

import { useTranslations } from 'use-intl/react';
import { Button } from './ui/index.js';

interface UnsavedChangesBarProps {
  onSave: () => void;
  onDiscard: () => void;
}

export default function UnsavedChangesBar({ onSave, onDiscard }: UnsavedChangesBarProps) {
  const t = useTranslations('configurationDetail.unsavedChanges');
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 p-3 rounded-lg border border-amber-700/50 bg-amber-950/20 text-sm text-amber-300"
    >
      <span>{t('message')}</span>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" onClick={onSave}>
          {t('save')}
        </Button>
        <Button size="sm" variant="secondary" onClick={onDiscard}>
          {t('discard')}
        </Button>
      </div>
    </div>
  );
}
