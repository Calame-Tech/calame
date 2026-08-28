import { useState, useEffect } from 'react';
import { useTranslations } from 'use-intl/react';
import { apiFetch, getCurrentTenant } from '../lib/api.js';
import { slugifyProfileName } from '../lib/profiles.js';
import { buildMcpUrl } from '../lib/mcp-url.js';

interface OnboardingWizardProps {
  onComplete: () => void;
  onSkip: () => void;
  /**
   * Optional deep link from the final step to the newly created configuration's
   * detail page (Table Tools & Masking / Advanced settings). When omitted, the
   * "Fine-tune..." link is not rendered — callers that don't wire navigation
   * still get a fully working wizard.
   */
  onNavigateToConfig?: (configName: string) => void;
}

type DbType = 'postgresql' | 'mysql' | 'sqlite';

interface Step1State {
  connectionName: string;
  dbType: DbType;
  connectionString: string;
  loading: boolean;
  error: string;
}

interface Step2TablesState {
  tables: Array<{ name: string; columns: Array<{ name: string }> }>;
  checked: Set<string>;
  loading: boolean;
  error: string;
}

interface Step3ProfileState {
  profileName: string;
  loading: boolean;
  error: string;
}

const TOTAL_STEPS = 4;

export default function OnboardingWizard({
  onComplete,
  onSkip,
  onNavigateToConfig,
}: OnboardingWizardProps) {
  const t = useTranslations('onboarding.wizard');
  const [step, setStep] = useState(1);
  const [createdConnectionName, setCreatedConnectionName] = useState('');
  const [createdProfileName, setCreatedProfileName] = useState('');
  const [createdConfigName, setCreatedConfigName] = useState('');

  const [step1, setStep1] = useState<Step1State>({
    connectionName: '',
    dbType: 'postgresql',
    connectionString: '',
    loading: false,
    error: '',
  });

  const [step2Tables, setStep2Tables] = useState<Step2TablesState>({
    tables: [],
    checked: new Set(),
    loading: false,
    error: '',
  });

  const [step3Profile, setStep3Profile] = useState<Step3ProfileState>({
    profileName: t('step3.form.defaultProfileName'),
    loading: false,
    error: '',
  });

  const [copied, setCopied] = useState(false);

  const progressPercent = ((step - 1) / (TOTAL_STEPS - 1)) * 100;

  // -------------------------------------------------------------------------
  // Step 1 helpers
  // -------------------------------------------------------------------------

  async function connectDemo() {
    setStep1((s) => ({ ...s, loading: true, error: '' }));
    try {
      const res = await apiFetch('/api/connections/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      const data = (await res.json()) as { success: boolean; name?: string; message?: string };
      if (!data.success) {
        setStep1((s) => ({
          ...s,
          loading: false,
          error: data.message ?? t('step1.errors.connectionFailed'),
        }));
        return;
      }
      setCreatedConnectionName(data.name ?? 'demo-logistique');
      setStep1((s) => ({ ...s, loading: false }));
      setStep(2);
    } catch {
      setStep1((s) => ({ ...s, loading: false, error: t('networkError') }));
    }
  }

  async function connectCustom(e: React.FormEvent) {
    e.preventDefault();
    if (!step1.connectionName.trim()) {
      setStep1((s) => ({ ...s, error: t('step1.errors.connectionNameRequired') }));
      return;
    }
    if (!step1.connectionString.trim()) {
      setStep1((s) => ({ ...s, error: t('step1.errors.connectionStringRequired') }));
      return;
    }
    setStep1((s) => ({ ...s, loading: true, error: '' }));
    try {
      const res = await apiFetch('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: step1.connectionName.trim(),
          databaseType: step1.dbType,
          connectionString: step1.connectionString.trim(),
        }),
      });
      const data = (await res.json()) as { success: boolean; message?: string };
      if (!data.success) {
        setStep1((s) => ({
          ...s,
          loading: false,
          error: data.message ?? t('step1.errors.connectionFailed'),
        }));
        return;
      }
      setCreatedConnectionName(step1.connectionName.trim());
      setStep1((s) => ({ ...s, loading: false }));
      setStep(2);
    } catch {
      setStep1((s) => ({ ...s, loading: false, error: t('networkError') }));
    }
  }

  // -------------------------------------------------------------------------
  // Step 2 — load schema when arriving on step 2
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (step !== 2 || !createdConnectionName) return;
    setStep2Tables((s) => ({ ...s, loading: true, error: '' }));
    apiFetch(`/api/schema/${encodeURIComponent(createdConnectionName)}`, { credentials: 'include' })
      .then((r) => r.json())
      .then(
        (data: {
          success: boolean;
          schema?: { tables: Array<{ name: string; columns: Array<{ name: string }> }> };
        }) => {
          const tables = data.schema?.tables ?? [];
          setStep2Tables((s) => ({
            ...s,
            tables,
            checked: new Set(tables.map((t) => t.name)),
            loading: false,
          }));
        },
      )
      .catch(() =>
        setStep2Tables((s) => ({
          ...s,
          loading: false,
          error: t('step2.errors.schemaLoadFailed'),
        })),
      );
  }, [step, createdConnectionName]);

  function toggleTable(name: string) {
    setStep2Tables((s) => {
      const next = new Set(s.checked);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { ...s, checked: next };
    });
  }

  function toggleAll() {
    setStep2Tables((s) => ({
      ...s,
      checked:
        s.checked.size === s.tables.length ? new Set() : new Set(s.tables.map((t) => t.name)),
    }));
  }

  // -------------------------------------------------------------------------
  // Step 3 — create profile + activate
  // -------------------------------------------------------------------------

  async function createProfile(e?: React.FormEvent) {
    e?.preventDefault();
    const label = step3Profile.profileName.trim();
    // The backend chat/auth routes only accept [a-zA-Z0-9_-]+ profile names —
    // the typed text becomes the display label, the slug becomes the name.
    const name = slugifyProfileName(label);
    // The configuration lives in its own namespace (the `configurations` table)
    // but sharing the profile's slug would be confusing in the "Data Profiles"
    // list, so it always gets a distinct `-config` suffix.
    const configName = `${name}-config`;
    if (!label) {
      setStep3Profile((s) => ({ ...s, error: t('step3.errors.nameRequired') }));
      return;
    }
    if (!name) {
      setStep3Profile((s) => ({
        ...s,
        error: t('step3.errors.nameInvalid'),
      }));
      return;
    }
    if (step2Tables.checked.size === 0) {
      setStep3Profile((s) => ({
        ...s,
        error: t('step3.errors.noTablesSelected'),
      }));
      return;
    }

    setStep3Profile((s) => ({ ...s, loading: true, error: '' }));
    try {
      // Build selectedTables: table name → all column names
      const selectedTables: Record<string, string[]> = {};
      for (const t of step2Tables.tables) {
        if (step2Tables.checked.has(t.name)) {
          selectedTables[t.name] = t.columns.map((c) => c.name);
        }
      }

      // 1. Create the Data Configuration first — this is what makes the
      // profile show up under "Data Profiles" and gives the user a place to
      // enable the write tool / column masking afterwards (TableOptionsCard
      // only mounts on the configuration detail page).
      const configRes = await apiFetch('/api/configurations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: configName,
          label,
          sources: [createdConnectionName],
          scopes: {
            [createdConnectionName]: {
              kind: 'relational',
              selectedTables,
            },
          },
        }),
      });
      const configData = (await configRes.json()) as { success: boolean; message?: string };
      if (!configData.success) {
        setStep3Profile((s) => ({
          ...s,
          loading: false,
          error: configData.message ?? t('step3.errors.configCreateFailed'),
        }));
        return; // Don't create a profile with no backing configuration.
      }

      // 2. Save the profile referencing the configuration by name (the shape
      // every configuration-backed profile in the app uses).
      const saveRes = await apiFetch('/api/profiles/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          profiles: {
            [name]: {
              label,
              configurations: [configName],
            },
          },
        }),
      });
      const saveData = (await saveRes.json()) as { success: boolean; message?: string };
      if (!saveData.success) {
        setStep3Profile((s) => ({
          ...s,
          loading: false,
          error: saveData.message ?? t('step3.errors.profileCreateFailed'),
        }));
        return;
      }

      // 3. Activate profile — non-blocking: absorb errors, profile is already saved
      try {
        await apiFetch('/api/serve/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ profiles: [name] }),
        });
      } catch (activateErr) {
        console.warn(
          'Could not activate profile immediately; it can be activated from the dashboard.',
          activateErr,
        );
      }

      setCreatedConfigName(configName);
      setCreatedProfileName(name);
      setStep3Profile((s) => ({ ...s, loading: false }));
      setStep(4);
    } catch {
      setStep3Profile((s) => ({
        ...s,
        loading: false,
        error: t('networkError'),
      }));
    }
  }

  // -------------------------------------------------------------------------
  // Step 4 helpers
  // -------------------------------------------------------------------------

  const tenant = getCurrentTenant();
  const mcpUrl = buildMcpUrl(window.location.origin, createdProfileName, tenant);

  function copyUrl() {
    navigator.clipboard.writeText(mcpUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div
      className="fixed inset-0 z-50 bg-gray-950 flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label={t('ariaLabel')}
    >
      {/* Progress bar */}
      <div className="h-1 w-full bg-gray-800" aria-hidden="true">
        <div
          className="h-full bg-os-700 transition-all duration-500 ease-out"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="Calame" className="h-7 w-7 object-contain" />
          <span className="text-sm font-medium text-gray-400">
            {t('stepIndicator', { step, total: TOTAL_STEPS })}
          </span>
        </div>
        <button
          type="button"
          onClick={onSkip}
          className="text-sm text-gray-500 hover:text-gray-300 transition-colors focus:outline-none focus:ring-2 focus:ring-os-700 rounded px-2 py-1"
        >
          {t('skipSetup')}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto flex items-start justify-center px-4 py-10">
        <div className="w-full max-w-lg">
          {step === 1 && (
            <StepConnect
              state={step1}
              setState={setStep1}
              onDemo={connectDemo}
              onCustom={connectCustom}
            />
          )}
          {step === 2 && (
            <StepTables
              state={step2Tables}
              connectionName={createdConnectionName}
              onToggle={toggleTable}
              onToggleAll={toggleAll}
              onNext={() => setStep(3)}
            />
          )}
          {step === 3 && (
            <StepProfile
              state={step3Profile}
              connectionName={createdConnectionName}
              tableCount={step2Tables.checked.size}
              onChange={(profileName) => setStep3Profile((s) => ({ ...s, profileName }))}
              onSubmit={createProfile}
              onBack={() => setStep(2)}
            />
          )}
          {step === 4 && (
            <StepDone
              mcpUrl={mcpUrl}
              profileName={createdProfileName}
              configName={createdConfigName}
              copied={copied}
              onCopy={copyUrl}
              onComplete={onComplete}
              onNavigateToConfig={onNavigateToConfig}
            />
          )}
        </div>
      </div>

      {/* Step dots */}
      <div className="flex items-center justify-center gap-2 py-4" aria-hidden="true">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => (
          <div
            key={i}
            className={`h-1.5 rounded-full transition-all duration-300 ${
              i + 1 === step
                ? 'w-6 bg-os-600'
                : i + 1 < step
                  ? 'w-1.5 bg-os-800'
                  : 'w-1.5 bg-gray-700'
            }`}
          />
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

interface StepConnectProps {
  state: Step1State;
  setState: React.Dispatch<React.SetStateAction<Step1State>>;
  onDemo: () => void;
  onCustom: (e: React.FormEvent) => void;
}

function StepConnect({ state, setState, onDemo, onCustom }: StepConnectProps) {
  const t = useTranslations('onboarding.wizard');
  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold tracking-widest text-os-400 uppercase mb-2">
          {t('step1.stepLabel')}
        </p>
        <h1 className="heading-lg mb-2">{t('step1.title')}</h1>
        <p className="text-sm text-gray-400">{t('step1.description')}</p>
      </div>

      {/* Demo shortcut */}
      <div className="card-primary p-4 space-y-3">
        <div>
          <p className="text-sm font-medium text-gray-200">{t('step1.quickStart.title')}</p>
          <p className="text-xs text-gray-500 mt-0.5">{t('step1.quickStart.description')}</p>
        </div>
        <button
          type="button"
          onClick={onDemo}
          disabled={state.loading}
          className="w-full py-2 px-4 bg-os-700 hover:bg-os-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-os-500"
        >
          {state.loading ? t('connecting') : t('step1.quickStart.useDemoButton')}
        </button>
      </div>

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-gray-800" />
        <span className="text-xs text-gray-600">{t('step1.orDivider')}</span>
        <div className="flex-1 h-px bg-gray-800" />
      </div>

      {/* Custom connection form */}
      <form onSubmit={onCustom} className="card-primary p-4 space-y-4" noValidate>
        <div>
          <label htmlFor="conn-name" className="block text-sm font-medium text-gray-300 mb-1">
            {t('step1.form.connectionNameLabel')}{' '}
            <span className="text-red-400" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id="conn-name"
            type="text"
            value={state.connectionName}
            onChange={(e) => setState((s) => ({ ...s, connectionName: e.target.value }))}
            className="input-editorial w-full"
            placeholder={t('step1.form.connectionNamePlaceholder')}
            autoComplete="off"
          />
        </div>

        <div>
          <label htmlFor="conn-type" className="block text-sm font-medium text-gray-300 mb-1">
            {t('step1.form.dbTypeLabel')}{' '}
            <span className="text-red-400" aria-hidden="true">
              *
            </span>
          </label>
          <select
            id="conn-type"
            value={state.dbType}
            onChange={(e) => setState((s) => ({ ...s, dbType: e.target.value as DbType }))}
            className="input-editorial w-full"
          >
            <option value="postgresql">{t('step1.form.dbTypeOptions.postgresql')}</option>
            <option value="mysql">{t('step1.form.dbTypeOptions.mysql')}</option>
            <option value="sqlite">{t('step1.form.dbTypeOptions.sqlite')}</option>
          </select>
        </div>

        <div>
          <label htmlFor="conn-string" className="block text-sm font-medium text-gray-300 mb-1">
            {t('step1.form.connectionStringLabel')}{' '}
            <span className="text-red-400" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id="conn-string"
            type="text"
            value={state.connectionString}
            onChange={(e) => setState((s) => ({ ...s, connectionString: e.target.value }))}
            className="input-editorial w-full font-mono text-sm"
            placeholder={
              state.dbType === 'sqlite'
                ? '/path/to/database.db'
                : state.dbType === 'mysql'
                  ? 'mysql://user:pass@host:3306/db'
                  : 'postgresql://user:pass@host:5432/db'
            }
            autoComplete="off"
          />
        </div>

        {state.error && (
          <div
            role="alert"
            className="bg-red-950/30 border border-red-800/50 rounded-lg p-3 text-red-400 text-sm"
          >
            {state.error}
          </div>
        )}

        <button
          type="submit"
          disabled={state.loading || !state.connectionName.trim() || !state.connectionString.trim()}
          className="w-full py-2 px-4 bg-os-700 hover:bg-os-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-os-500"
        >
          {state.loading ? t('connecting') : t('step1.form.submitButton')}
        </button>
      </form>
    </div>
  );
}

// -----------------------------------------------------------------------------

interface StepTablesProps {
  state: Step2TablesState;
  connectionName: string;
  onToggle: (name: string) => void;
  onToggleAll: () => void;
  onNext: () => void;
}

function StepTables({ state, connectionName, onToggle, onToggleAll, onNext }: StepTablesProps) {
  const t = useTranslations('onboarding.wizard');
  const allChecked = state.tables.length > 0 && state.checked.size === state.tables.length;
  const noneChecked = state.checked.size === 0;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold tracking-widest text-os-400 uppercase mb-2">
          {t('step2.stepLabel')}
        </p>
        <h1 className="heading-lg mb-2">{t('step2.title')}</h1>
        <p className="text-sm text-gray-400">
          {t.rich('step2.description', {
            connectionName,
            name: (chunks) => <span className="text-gray-200 font-mono">{chunks}</span>,
          })}
        </p>
      </div>

      {state.loading && (
        <div className="flex items-center justify-center py-12 text-gray-500 text-sm">
          {t('step2.loadingSchema')}
        </div>
      )}

      {state.error && (
        <div
          role="alert"
          className="bg-red-950/30 border border-red-800/50 rounded-lg p-3 text-red-400 text-sm"
        >
          {state.error}
        </div>
      )}

      {!state.loading && !state.error && state.tables.length === 0 && (
        <div className="card-primary p-6 text-center text-gray-500 text-sm">
          {t('step2.noTables')}
        </div>
      )}

      {!state.loading && state.tables.length > 0 && (
        <div className="card-primary p-4 space-y-3">
          {/* Select all / none */}
          <div className="flex items-center justify-between pb-2 border-b border-gray-800">
            <span className="text-sm text-gray-400">
              {t('step2.tablesSelected', { checked: state.checked.size, total: state.tables.length })}
            </span>
            <button
              type="button"
              onClick={onToggleAll}
              className="text-xs text-os-400 hover:text-os-300 transition-colors focus:outline-none"
            >
              {allChecked ? t('step2.deselectAll') : t('step2.selectAll')}
            </button>
          </div>

          {/* Table list */}
          <div className="space-y-1 max-h-72 overflow-y-auto">
            {state.tables.map((table) => (
              <label
                key={table.name}
                className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-gray-800/50 cursor-pointer group"
              >
                <input
                  type="checkbox"
                  checked={state.checked.has(table.name)}
                  onChange={() => onToggle(table.name)}
                  className="rounded border-gray-600 bg-gray-800 text-os-600 focus:ring-os-500 focus:ring-offset-gray-900"
                />
                <span className="text-sm text-gray-200 font-mono flex-1 truncate">
                  {table.name}
                </span>
                <span className="text-xs text-gray-600 group-hover:text-gray-500 flex-shrink-0">
                  {t('step2.colCount', { count: table.columns.length })}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={onNext}
        disabled={noneChecked || state.loading}
        className="w-full py-2 px-4 bg-os-700 hover:bg-os-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-os-500"
      >
        {t('step2.continueButton')}
      </button>
    </div>
  );
}

// -----------------------------------------------------------------------------

interface StepProfileProps {
  state: Step3ProfileState;
  connectionName: string;
  tableCount: number;
  onChange: (name: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onBack: () => void;
}

function StepProfile({
  state,
  connectionName,
  tableCount,
  onChange,
  onSubmit,
  onBack,
}: StepProfileProps) {
  const t = useTranslations('onboarding.wizard');
  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold tracking-widest text-os-400 uppercase mb-2">
          {t('step3.stepLabel')}
        </p>
        <h1 className="heading-lg mb-2">{t('step3.title')}</h1>
        <p className="text-sm text-gray-400">
          {t.rich('step3.description', {
            count: tableCount,
            connectionName,
            name: (chunks) => <span className="text-gray-200 font-mono">{chunks}</span>,
          })}
        </p>
      </div>

      <form onSubmit={onSubmit} className="card-primary p-4 space-y-4" noValidate>
        <div>
          <label htmlFor="profile-name" className="block text-sm font-medium text-gray-300 mb-1">
            {t('step3.form.nameLabel')}{' '}
            <span className="text-red-400" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id="profile-name"
            type="text"
            value={state.profileName}
            onChange={(e) => onChange(e.target.value)}
            className="input-editorial w-full"
            placeholder={t('step3.form.defaultProfileName')}
            autoFocus
          />
          {slugifyProfileName(state.profileName) && (
            <p className="text-xs text-gray-500 font-mono mt-1">
              {slugifyProfileName(state.profileName)}
            </p>
          )}
        </div>

        {state.error && (
          <div
            role="alert"
            className="bg-red-950/30 border border-red-800/50 rounded-lg p-3 text-red-400 text-sm"
          >
            {state.error}
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={onBack}
            className="px-4 py-2 text-sm text-gray-500 hover:text-gray-300 border border-gray-700 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-os-700"
          >
            {t('step3.form.backButton')}
          </button>
          <button
            type="submit"
            disabled={state.loading || !state.profileName.trim()}
            className="flex-1 py-2 px-4 bg-os-700 hover:bg-os-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-os-500"
          >
            {state.loading ? t('step3.form.creating') : t('step3.form.submitButton')}
          </button>
        </div>
      </form>
    </div>
  );
}

// -----------------------------------------------------------------------------

interface StepDoneProps {
  mcpUrl: string;
  profileName: string;
  configName: string;
  copied: boolean;
  onCopy: () => void;
  onComplete: () => void;
  onNavigateToConfig?: (configName: string) => void;
}

function StepDone({
  mcpUrl,
  profileName,
  configName,
  copied,
  onCopy,
  onComplete,
  onNavigateToConfig,
}: StepDoneProps) {
  const t = useTranslations('onboarding.wizard');
  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center text-center space-y-3">
        {/* Checkmark */}
        <div
          className="flex items-center justify-center w-14 h-14 rounded-full bg-green-900/40 border border-green-700/50"
          aria-hidden="true"
        >
          <svg
            className="w-7 h-7 text-green-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>

        <div>
          <p className="text-xs font-semibold tracking-widest text-os-400 uppercase mb-2">
            {t('step4.stepLabel')}
          </p>
          <h1 className="heading-lg mb-2">{t('step4.title')}</h1>
          <p className="text-sm text-gray-400">
            {t('step4.readyText')}{' '}
            {profileName &&
              t.rich('step4.createdText', {
                profileName,
                name: (chunks) => <span className="text-gray-200 font-medium">{chunks}</span>,
              })}
          </p>
        </div>
      </div>

      {/* MCP URL */}
      <div className="card-primary p-4 space-y-3">
        <div>
          <p className="text-sm font-medium text-gray-200">{t('step4.urlCard.title')}</p>
          <p className="text-xs text-gray-500 mt-0.5">{t('step4.urlCard.description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-gray-800/60 border border-gray-700/50">
            <code className="text-xs text-gray-300 font-mono break-all">{mcpUrl}</code>
          </div>
          <button
            type="button"
            onClick={onCopy}
            aria-label={copied ? t('step4.urlCard.copiedAriaLabel') : t('step4.urlCard.copyAriaLabel')}
            className="flex-shrink-0 px-3 py-2 rounded-lg border border-gray-700/50 bg-gray-800/60 hover:bg-gray-700/60 text-sm text-gray-300 hover:text-white transition-colors focus:outline-none focus:ring-2 focus:ring-os-500"
          >
            {copied ? (
              <svg
                className="w-4 h-4 text-green-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            ) : (
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
            )}
          </button>
        </div>
      </div>

      <button
        type="button"
        onClick={onComplete}
        className="w-full py-2.5 px-4 bg-os-700 hover:bg-os-600 text-white text-sm font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-os-500"
      >
        {t('step4.goToDashboardButton')}
      </button>

      {onNavigateToConfig && configName && (
        <button
          type="button"
          onClick={() => onNavigateToConfig(configName)}
          className="w-full text-center text-sm text-os-400 hover:text-os-300 transition-colors focus:outline-none focus:ring-2 focus:ring-os-700 rounded px-2 py-1"
        >
          {t('step4.fineTuneLink')}
        </button>
      )}
    </div>
  );
}
