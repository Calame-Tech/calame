import { useState, useEffect } from 'react';
import { apiFetch, getCurrentTenant } from '../lib/api.js';
import { buildMcpUrl } from '../lib/mcp-url.js';

interface OnboardingWizardProps {
  onComplete: () => void;
  onSkip: () => void;
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

export default function OnboardingWizard({ onComplete, onSkip }: OnboardingWizardProps) {
  const [step, setStep] = useState(1);
  const [createdConnectionName, setCreatedConnectionName] = useState('');
  const [createdProfileName, setCreatedProfileName] = useState('');

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
    profileName: 'My first profile',
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
        setStep1((s) => ({ ...s, loading: false, error: data.message ?? 'Connection failed.' }));
        return;
      }
      setCreatedConnectionName(data.name ?? 'demo-logistique');
      setStep1((s) => ({ ...s, loading: false }));
      setStep(2);
    } catch {
      setStep1((s) => ({ ...s, loading: false, error: 'Network error. Please try again.' }));
    }
  }

  async function connectCustom(e: React.FormEvent) {
    e.preventDefault();
    if (!step1.connectionName.trim()) {
      setStep1((s) => ({ ...s, error: 'Connection name is required.' }));
      return;
    }
    if (!step1.connectionString.trim()) {
      setStep1((s) => ({ ...s, error: 'Connection string is required.' }));
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
        setStep1((s) => ({ ...s, loading: false, error: data.message ?? 'Connection failed.' }));
        return;
      }
      setCreatedConnectionName(step1.connectionName.trim());
      setStep1((s) => ({ ...s, loading: false }));
      setStep(2);
    } catch {
      setStep1((s) => ({ ...s, loading: false, error: 'Network error. Please try again.' }));
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
        setStep2Tables((s) => ({ ...s, loading: false, error: 'Failed to load schema.' })),
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
    const name = step3Profile.profileName.trim();
    if (!name) {
      setStep3Profile((s) => ({ ...s, error: 'Profile name is required.' }));
      return;
    }
    if (step2Tables.checked.size === 0) {
      setStep3Profile((s) => ({
        ...s,
        error: 'Select at least one table in the previous step.',
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

      // 1. Save profile with real scopes
      const saveRes = await apiFetch('/api/profiles/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          profiles: {
            [name]: {
              sources: [createdConnectionName],
              scopes: {
                [createdConnectionName]: {
                  kind: 'relational',
                  selectedTables,
                },
              },
            },
          },
        }),
      });
      const saveData = (await saveRes.json()) as { success: boolean; message?: string };
      if (!saveData.success) {
        setStep3Profile((s) => ({
          ...s,
          loading: false,
          error: saveData.message ?? 'Failed to create profile.',
        }));
        return;
      }

      // 2. Activate profile — non-blocking: absorb errors, profile is already saved
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

      setCreatedProfileName(name);
      setStep3Profile((s) => ({ ...s, loading: false }));
      setStep(4);
    } catch {
      setStep3Profile((s) => ({
        ...s,
        loading: false,
        error: 'Network error. Please try again.',
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
      aria-label="Onboarding wizard"
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
            Step {step} of {TOTAL_STEPS}
          </span>
        </div>
        <button
          type="button"
          onClick={onSkip}
          className="text-sm text-gray-500 hover:text-gray-300 transition-colors focus:outline-none focus:ring-2 focus:ring-os-700 rounded px-2 py-1"
        >
          Skip setup
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
              copied={copied}
              onCopy={copyUrl}
              onComplete={onComplete}
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
  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold tracking-widest text-os-400 uppercase mb-2">Step 1</p>
        <h1 className="heading-lg mb-2">Connect your first database</h1>
        <p className="text-sm text-gray-400">
          Connect to a database to start exploring your data and building MCP profiles.
        </p>
      </div>

      {/* Demo shortcut */}
      <div className="card-primary p-4 space-y-3">
        <div>
          <p className="text-sm font-medium text-gray-200">Quick start</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Use our demo logistics database to explore Calame without any setup.
          </p>
        </div>
        <button
          type="button"
          onClick={onDemo}
          disabled={state.loading}
          className="w-full py-2 px-4 bg-os-700 hover:bg-os-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-os-500"
        >
          {state.loading ? 'Connecting...' : 'Use demo database (SQLite)'}
        </button>
      </div>

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-gray-800" />
        <span className="text-xs text-gray-600">or connect your own</span>
        <div className="flex-1 h-px bg-gray-800" />
      </div>

      {/* Custom connection form */}
      <form onSubmit={onCustom} className="card-primary p-4 space-y-4" noValidate>
        <div>
          <label htmlFor="conn-name" className="block text-sm font-medium text-gray-300 mb-1">
            Connection name{' '}
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
            placeholder="e.g. Production DB"
            autoComplete="off"
          />
        </div>

        <div>
          <label htmlFor="conn-type" className="block text-sm font-medium text-gray-300 mb-1">
            Database type{' '}
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
            <option value="postgresql">PostgreSQL</option>
            <option value="mysql">MySQL</option>
            <option value="sqlite">SQLite</option>
          </select>
        </div>

        <div>
          <label htmlFor="conn-string" className="block text-sm font-medium text-gray-300 mb-1">
            Connection string{' '}
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
          {state.loading ? 'Connecting...' : 'Connect'}
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
  const allChecked = state.tables.length > 0 && state.checked.size === state.tables.length;
  const noneChecked = state.checked.size === 0;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold tracking-widest text-os-400 uppercase mb-2">Step 2</p>
        <h1 className="heading-lg mb-2">Select tables to expose</h1>
        <p className="text-sm text-gray-400">
          Choose which tables from <span className="text-gray-200 font-mono">{connectionName}</span>{' '}
          will be accessible through your MCP profile. All columns are included by default.
        </p>
      </div>

      {state.loading && (
        <div className="flex items-center justify-center py-12 text-gray-500 text-sm">
          Loading schema...
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
          No tables found in this database.
        </div>
      )}

      {!state.loading && state.tables.length > 0 && (
        <div className="card-primary p-4 space-y-3">
          {/* Select all / none */}
          <div className="flex items-center justify-between pb-2 border-b border-gray-800">
            <span className="text-sm text-gray-400">
              {state.checked.size} / {state.tables.length} tables selected
            </span>
            <button
              type="button"
              onClick={onToggleAll}
              className="text-xs text-os-400 hover:text-os-300 transition-colors focus:outline-none"
            >
              {allChecked ? 'Deselect all' : 'Select all'}
            </button>
          </div>

          {/* Table list */}
          <div className="space-y-1 max-h-72 overflow-y-auto">
            {state.tables.map((t) => (
              <label
                key={t.name}
                className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-gray-800/50 cursor-pointer group"
              >
                <input
                  type="checkbox"
                  checked={state.checked.has(t.name)}
                  onChange={() => onToggle(t.name)}
                  className="rounded border-gray-600 bg-gray-800 text-os-600 focus:ring-os-500 focus:ring-offset-gray-900"
                />
                <span className="text-sm text-gray-200 font-mono flex-1 truncate">{t.name}</span>
                <span className="text-xs text-gray-600 group-hover:text-gray-500 flex-shrink-0">
                  {t.columns.length} col{t.columns.length !== 1 ? 's' : ''}
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
        Continue
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
  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold tracking-widest text-os-400 uppercase mb-2">Step 3</p>
        <h1 className="heading-lg mb-2">Name your MCP profile</h1>
        <p className="text-sm text-gray-400">
          Your profile will expose {tableCount} table{tableCount !== 1 ? 's' : ''} from{' '}
          <span className="text-gray-200 font-mono">{connectionName}</span>.
        </p>
      </div>

      <form onSubmit={onSubmit} className="card-primary p-4 space-y-4" noValidate>
        <div>
          <label htmlFor="profile-name" className="block text-sm font-medium text-gray-300 mb-1">
            Profile name{' '}
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
            placeholder="My first profile"
            autoFocus
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

        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={onBack}
            className="px-4 py-2 text-sm text-gray-500 hover:text-gray-300 border border-gray-700 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-os-700"
          >
            Back
          </button>
          <button
            type="submit"
            disabled={state.loading || !state.profileName.trim()}
            className="flex-1 py-2 px-4 bg-os-700 hover:bg-os-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-os-500"
          >
            {state.loading ? 'Creating...' : 'Create profile & activate'}
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
  copied: boolean;
  onCopy: () => void;
  onComplete: () => void;
}

function StepDone({ mcpUrl, profileName, copied, onCopy, onComplete }: StepDoneProps) {
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
          <p className="text-xs font-semibold tracking-widest text-os-400 uppercase mb-2">Step 4</p>
          <h1 className="heading-lg mb-2">You're all set!</h1>
          <p className="text-sm text-gray-400">
            Your MCP server is ready.{' '}
            {profileName && (
              <>
                Profile <span className="text-gray-200 font-medium">{profileName}</span> has been
                created.
              </>
            )}
          </p>
        </div>
      </div>

      {/* MCP URL */}
      <div className="card-primary p-4 space-y-3">
        <div>
          <p className="text-sm font-medium text-gray-200">MCP server URL</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Add this URL to your MCP client (Cursor, Claude Desktop, etc.)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-gray-800/60 border border-gray-700/50">
            <code className="text-xs text-gray-300 font-mono break-all">{mcpUrl}</code>
          </div>
          <button
            type="button"
            onClick={onCopy}
            aria-label={copied ? 'URL copied' : 'Copy MCP URL'}
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
        Go to dashboard
      </button>
    </div>
  );
}
