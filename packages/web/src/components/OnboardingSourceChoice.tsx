// Pieces of the onboarding wizard that tie it to the 3-step getting-started
// checklist (SetupChecklist): the checklist step shown next to "Step n of 4",
// and the source choices of the first screen (databases, knowledge base).

import { useTranslations } from 'use-intl/react';

export type DbType = 'postgresql' | 'mysql' | 'sqlite' | 'mssql';

/**
 * Example connection string per engine. Exhaustive over DbType so adding an
 * engine fails the build here rather than silently falling back.
 */
export const CONNECTION_STRING_PLACEHOLDERS: Record<DbType, string> = {
  postgresql: 'postgresql://user:pass@host:5432/db',
  mysql: 'mysql://user:pass@host:3306/db',
  sqlite: '/path/to/database.db',
  mssql: 'Server=host,1433;Database=db;User Id=user;Password=pass',
};

/** Wizard step → step of the 3-step getting-started checklist it belongs to. */
export function checklistPhase(step: number, total: number): 'source' | 'mcp' | 'client' {
  return step === 1 ? 'source' : step < total ? 'mcp' : 'client';
}

export function WizardPhase({ step, total }: { step: number; total: number }) {
  const t = useTranslations('onboarding.checklist');
  return (
    <>
      <span className="text-gray-600"> · </span>
      {t(`${checklistPhase(step, total)}.title`)}
    </>
  );
}

/**
 * Knowledge base: documents are added from the knowledge-base screen. Not
 * rendered without `onSelect` (knowledge bases disabled).
 */
export function KnowledgeBaseChoice({
  onSelect,
  disabled,
}: {
  onSelect?: () => void;
  disabled: boolean;
}) {
  const t = useTranslations('onboarding.wizard.step1.knowledgeBase');
  if (!onSelect) return null;
  return (
    <div className="card-primary p-4 space-y-3">
      <div>
        <p className="text-sm font-medium text-gray-200">{t('title')}</p>
        <p className="text-xs text-gray-500 mt-0.5">{t('description')}</p>
      </div>
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        className="w-full py-2 px-4 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed text-gray-100 text-sm font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-os-500"
      >
        {t('button')}
      </button>
    </div>
  );
}
