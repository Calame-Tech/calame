import { useState, useEffect } from 'react';
import { Eyebrow } from './ui/Eyebrow.js';

interface WelcomePageProps {
  code: string;
}

interface ProfileInfo {
  profileName: string;
  accessMode: string;
  tables: string[];
  mcpUrl: string | null;
}

interface OnboardingData {
  user: {
    name: string;
    profiles: ProfileInfo[];
  };
}

interface ActivateResult {
  plaintextToken: string;
  mcpUrls: Array<{ profileName: string; url: string }>;
}

/** Returns a password strength level (0-3) and a label */
function passwordStrength(pw: string): { level: number; label: string; color: string } {
  if (pw.length === 0) return { level: 0, label: '', color: '' };
  if (pw.length < 8) return { level: 1, label: 'Too short', color: 'bg-rose-500' };
  if (pw.length < 12) return { level: 2, label: 'Fair', color: 'bg-amber-400' };
  if (pw.length < 16) return { level: 3, label: 'Good', color: 'bg-emerald-400' };
  return { level: 4, label: 'Strong', color: 'bg-emerald-400' };
}

/** Access mode badge styles */
function accessModeBadge(mode: string): { label: string; className: string } {
  if (mode === 'mcp') {
    return { label: 'MCP', className: 'bg-os-500/10 text-os-300 border border-os-500/20' };
  }
  if (mode === 'chat') {
    return {
      label: 'Chat',
      className: 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20',
    };
  }
  return {
    label: 'MCP + Chat',
    className:
      'bg-gradient-to-r from-os-500/10 to-emerald-500/10 text-os-200 border border-os-500/20',
  };
}

/** Builds the full JSON config snippet */
function buildConfigSnippet(result: ActivateResult): string {
  return JSON.stringify(
    {
      mcpServers: Object.fromEntries(
        result.mcpUrls.map((m) => [
          m.profileName,
          {
            url: m.url,
            headers: { Authorization: `Bearer ${result.plaintextToken}` },
          },
        ]),
      ),
    },
    null,
    2,
  );
}

export default function WelcomePage({ code }: WelcomePageProps) {
  const [data, setData] = useState<OnboardingData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [activated, setActivated] = useState(false);
  const [activateResult, setActivateResult] = useState<ActivateResult | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/onboarding/${code}`);
        const result = await res.json();
        if (result.success) {
          setData(result);
        } else {
          setError(result.message || 'Invalid onboarding link.');
        }
      } catch {
        setError('Failed to load onboarding data.');
      } finally {
        setLoading(false);
      }
    })();
  }, [code]);

  const handleActivate = async () => {
    setPasswordError('');
    if (password.length < 8) {
      setPasswordError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setPasswordError('Passwords do not match.');
      return;
    }
    try {
      const res = await fetch(`/api/onboarding/${code}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const result = await res.json();
      if (result.success) {
        setActivateResult(result);
        setActivated(true);
      } else {
        setError(result.message || 'Failed to activate.');
      }
    } catch {
      setError('Connection error.');
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  /* ---- Loading state ---- */
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="flex items-center gap-3 text-gray-500">
          <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          <span className="font-mono-plex text-xs tracking-widest uppercase">Loading</span>
        </div>
      </div>
    );
  }

  /* ---- Error state ---- */
  if (error && !data) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
        <div className="bg-gray-900/60 border border-white/5 rounded-2xl p-10 max-w-md text-center">
          <div className="w-12 h-12 rounded-full bg-rose-500/10 border border-rose-500/20 flex items-center justify-center mx-auto mb-5">
            <svg
              className="w-5 h-5 text-rose-400"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <p className="font-mono-plex text-[10px] uppercase tracking-[0.25em] text-rose-400/70 mb-2">
            Invalid Link
          </p>
          <h1 className="font-display text-2xl font-light text-white mb-3">
            Something went wrong.
          </h1>
          <p className="text-gray-400 text-sm leading-relaxed">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { user } = data;
  const pwStrength = passwordStrength(password);
  const currentStep = activated ? 3 : 2;

  const steps = [
    { n: 1, label: 'Verify access' },
    { n: 2, label: 'Set password' },
    { n: 3, label: 'Get your token' },
  ];

  return (
    <div className="min-h-screen bg-gray-950 relative overflow-hidden">
      {/* Atmospheric gradient mesh — fixed background */}
      <div className="fixed inset-0 pointer-events-none" aria-hidden="true">
        <div className="absolute top-[-20%] left-[-10%] w-[60vw] h-[60vw] bg-os-900/20 rounded-full blur-3xl opacity-30" />
        <div className="absolute bottom-[-10%] right-[-5%] w-[40vw] h-[40vw] bg-indigo-900/15 rounded-full blur-3xl opacity-30" />
        <div className="absolute top-[40%] left-[30%] w-[30vw] h-[30vw] bg-os-800/10 rounded-full blur-3xl opacity-20" />
      </div>

      <div className="relative z-10 min-h-screen lg:grid lg:grid-cols-[1.1fr_1fr]">
        {/* ---- LEFT COLUMN — brand / context ---- */}
        <div className="lg:sticky lg:top-0 lg:h-screen flex flex-col justify-between p-10 xl:p-16 bg-gray-950/80 border-r border-white/[0.04]">
          {/* Top — logo + headline */}
          <div className="animate-fade-in-up">
            <div className="mb-4">
              <Eyebrow accent>MCP ACCESS</Eyebrow>
            </div>
            <p className="font-display text-4xl font-light text-white tracking-tight mb-8">
              Calame
            </p>
            <h1 className="font-display font-light text-6xl leading-[0.95] text-white mb-5">
              Welcome,
              <br />
              <span className="text-os-300">{user.name}.</span>
            </h1>
            <p className="text-gray-400 max-w-sm leading-relaxed text-sm">
              Activate your account to access your MCP servers.
            </p>
          </div>

          {/* Vertical stepper */}
          <div className="my-10 space-y-5 animate-fade-in-up" style={{ animationDelay: '80ms' }}>
            {steps.map((step) => {
              const isDone = step.n < currentStep;
              const isActive = step.n === currentStep;
              return (
                <div key={step.n} className="flex items-center gap-4">
                  <span
                    className={`font-mono-plex text-2xl w-9 shrink-0 transition-all duration-300 ${
                      isDone
                        ? 'text-emerald-400 opacity-80'
                        : isActive
                          ? 'text-os-400'
                          : 'text-gray-700'
                    }`}
                  >
                    {isDone ? (
                      <svg
                        className="w-6 h-6 mt-1.5 text-emerald-400"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path
                          fillRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                    ) : (
                      step.n
                    )}
                  </span>
                  <div
                    className={`transition-all duration-300 ${isActive ? 'opacity-100' : isDone ? 'opacity-60' : 'opacity-30'}`}
                  >
                    <p
                      className={`text-sm font-medium ${isActive ? 'text-gray-100' : 'text-gray-400'}`}
                    >
                      {step.label}
                    </p>
                    {isActive && (
                      <span className="font-mono-plex text-[9px] uppercase tracking-widest text-os-400">
                        Current step
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <p
            className="font-mono-plex text-[10px] text-gray-700 tracking-wider animate-fade-in-up"
            style={{ animationDelay: '160ms' }}
          >
            Powered by Calame
          </p>
        </div>

        {/* ---- RIGHT COLUMN — action area ---- */}
        <div className="overflow-y-auto p-8 xl:p-12 space-y-6">
          {/* Error banner (post-load errors) */}
          {error && data && (
            <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 px-4 py-3 text-rose-400 text-sm animate-fade-in-up">
              {error}
            </div>
          )}

          {/* Section — Your Access */}
          <div className="animate-fade-in-up" style={{ animationDelay: '80ms' }}>
            <div className="flex items-center gap-3 mb-4 hairline pt-4">
              <Eyebrow>Your Access</Eyebrow>
            </div>
            <div className="space-y-2">
              {user.profiles.map((p) => {
                const badge = accessModeBadge(p.accessMode);
                return (
                  <div
                    key={p.profileName}
                    className="card-interactive p-4 flex items-center justify-between"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="font-display text-lg text-os-300 truncate">
                        {p.profileName}
                      </span>
                      <span
                        className={`font-mono-plex text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    </div>
                    {p.tables.length > 0 && (
                      <span className="font-mono-plex text-[10px] text-gray-500 bg-white/5 px-2 py-0.5 rounded-full shrink-0 ml-3">
                        {p.tables.length} table{p.tables.length > 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Section — Set up account (pre-activation) */}
          {!activated ? (
            <div
              className="card-primary p-6 animate-fade-in-up"
              style={{ animationDelay: '160ms' }}
            >
              <h2 className="font-display text-2xl font-light text-white mb-1">
                Set up your account
              </h2>
              <p className="text-gray-500 text-sm mb-6">
                Choose a password to secure your Calame account.
              </p>

              <div className="space-y-4 max-w-sm">
                <div>
                  <label
                    className="block font-mono-plex text-[10px] uppercase tracking-widest text-gray-500 mb-2"
                    htmlFor="password"
                  >
                    Password
                  </label>
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="input-editorial w-full text-sm"
                    placeholder="Minimum 8 characters"
                    minLength={8}
                    autoComplete="new-password"
                  />
                  {/* Password strength gauge */}
                  {password.length > 0 && (
                    <div className="mt-2 space-y-1">
                      <div className="flex gap-1 h-1">
                        {[1, 2, 3, 4].map((n) => (
                          <div
                            key={n}
                            className={`flex-1 rounded-full transition-all duration-300 ${
                              n <= pwStrength.level ? pwStrength.color : 'bg-white/5'
                            }`}
                          />
                        ))}
                      </div>
                      {pwStrength.label && (
                        <p className="font-mono-plex text-[10px] text-gray-500">
                          {pwStrength.label}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <div>
                  <label
                    className="block font-mono-plex text-[10px] uppercase tracking-widest text-gray-500 mb-2"
                    htmlFor="confirm-password"
                  >
                    Confirm password
                  </label>
                  <input
                    id="confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="input-editorial w-full text-sm"
                    placeholder="Repeat your password"
                    autoComplete="new-password"
                  />
                </div>

                {passwordError && (
                  <p className="text-rose-400 text-sm font-mono-plex text-[11px]">
                    {passwordError}
                  </p>
                )}

                <button
                  onClick={handleActivate}
                  disabled={!password || !confirmPassword}
                  className="flex items-center justify-center gap-2 w-full py-3 px-6 bg-gradient-to-r from-os-600 to-os-500 hover:from-os-500 hover:to-os-400 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-os-600/20 text-white font-medium tracking-wide rounded-lg transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-os-500/50"
                  aria-label="Activate my account"
                >
                  Activate My Account
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 8h10M9 4l4 4-4 4" />
                  </svg>
                </button>

                <p className="font-mono-plex text-[10px] text-gray-600 text-center tracking-wide">
                  You will receive your MCP access token after activation.
                </p>
              </div>
            </div>
          ) : (
            activateResult && (
              <div className="space-y-5 animate-fade-in-up" style={{ animationDelay: '80ms' }}>
                {/* Activated badge */}
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center shrink-0">
                    <svg
                      className="w-4 h-4 text-emerald-400"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </div>
                  <div>
                    <span className="font-mono-plex text-[10px] uppercase tracking-[0.3em] text-emerald-400">
                      Account Activated
                    </span>
                    <p className="text-gray-500 text-xs mt-0.5">Your credentials have been set.</p>
                  </div>
                </div>

                {/* Token spotlight card */}
                <div className="relative card-primary p-6 overflow-hidden ring-2 ring-os-500/40 shadow-[0_0_60px_rgba(76,110,245,0.2)]">
                  {/* Glow blob */}
                  <div
                    className="absolute -top-12 -right-12 w-40 h-40 bg-os-500/10 rounded-full blur-3xl"
                    aria-hidden="true"
                  />

                  <div className="relative">
                    <div className="flex items-center gap-2 mb-1">
                      <Eyebrow accent>Your Access Token</Eyebrow>
                    </div>
                    <div className="flex items-center gap-2 mb-4">
                      <svg
                        className="w-3.5 h-3.5 text-amber-400 shrink-0"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path
                          fillRule="evenodd"
                          d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                          clipRule="evenodd"
                        />
                      </svg>
                      <span className="font-mono-plex text-[10px] uppercase tracking-[0.2em] text-amber-400/80">
                        One-time display — copy now
                      </span>
                    </div>

                    <div className="flex items-start gap-3">
                      <div className="flex-1 bg-black/40 border border-white/5 rounded-lg px-4 py-3 overflow-x-auto">
                        <code className="font-mono-plex text-xs text-os-300 break-all leading-relaxed">
                          {activateResult.plaintextToken}
                        </code>
                      </div>
                      <button
                        onClick={() => copyToClipboard(activateResult.plaintextToken, 'token')}
                        className="shrink-0 px-4 py-3 bg-os-600/20 hover:bg-os-600/30 border border-os-500/20 text-os-300 text-xs font-mono-plex rounded-lg transition-all duration-200 focus:outline-none focus:ring-1 focus:ring-os-500/40"
                        aria-label="Copy token to clipboard"
                      >
                        {copied === 'token' ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* MCP endpoints */}
                {activateResult.mcpUrls.length > 0 && (
                  <div className="card-primary p-6">
                    <div className="flex items-center justify-between mb-4">
                      <Eyebrow>MCP Endpoints</Eyebrow>
                      <button
                        onClick={() =>
                          copyToClipboard(
                            activateResult.mcpUrls
                              .map((m) => `${m.profileName}: ${m.url}`)
                              .join('\n'),
                            'all-urls',
                          )
                        }
                        className="font-mono-plex text-[10px] uppercase tracking-wider text-os-400/70 hover:text-os-300 transition-colors focus:outline-none"
                        aria-label="Copy all endpoint URLs"
                      >
                        {copied === 'all-urls' ? 'Copied!' : 'Copy all'}
                      </button>
                    </div>
                    <div className="space-y-2">
                      {activateResult.mcpUrls.map((m) => (
                        <div
                          key={m.profileName}
                          className="grid grid-cols-[auto_1fr_auto] items-center gap-3 py-2 border-b border-white/[0.03] last:border-0"
                        >
                          <span className="font-display text-sm text-os-300 w-24 truncate shrink-0">
                            {m.profileName}
                          </span>
                          <div className="bg-black/20 border border-white/[0.03] rounded-md px-3 py-1.5 overflow-x-auto min-w-0">
                            <code className="font-mono-plex text-[11px] text-gray-400 whitespace-nowrap">
                              {m.url}
                            </code>
                          </div>
                          <button
                            onClick={() => copyToClipboard(m.url, m.profileName)}
                            className="shrink-0 px-2.5 py-1.5 bg-white/5 hover:bg-white/10 border border-white/5 text-gray-400 hover:text-gray-200 text-[10px] font-mono-plex rounded-md transition-all duration-200 focus:outline-none focus:ring-1 focus:ring-os-500/30"
                            aria-label={`Copy URL for ${m.profileName}`}
                          >
                            {copied === m.profileName ? 'Done' : 'Copy'}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Config snippet */}
                {activateResult.mcpUrls.length > 0 && (
                  <div className="card-primary overflow-hidden">
                    <div className="flex items-center justify-between px-6 py-4 hairline-b">
                      <Eyebrow>Configuration</Eyebrow>
                      <button
                        onClick={() =>
                          copyToClipboard(buildConfigSnippet(activateResult), 'config')
                        }
                        className="font-mono-plex text-[10px] uppercase tracking-wider text-os-400/70 hover:text-os-300 transition-colors focus:outline-none"
                        aria-label="Copy configuration snippet"
                      >
                        {copied === 'config' ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                    <div className="relative">
                      <div
                        className="absolute left-0 top-0 bottom-0 w-0.5 bg-os-500/50"
                        aria-hidden="true"
                      />
                      <pre className="bg-black/60 px-6 py-5 text-[11px] font-mono-plex text-gray-300 overflow-x-auto leading-relaxed">
                        {buildConfigSnippet(activateResult)}
                      </pre>
                    </div>
                    <div className="px-6 py-3 border-t border-white/[0.04]">
                      <p className="text-gray-500 text-xs">
                        Add this to your MCP client configuration file.
                      </p>
                    </div>
                  </div>
                )}

                {/* Link to account */}
                <div className="text-center pt-2 pb-6">
                  <a
                    href="/login"
                    className="inline-flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-os-600 to-os-500 hover:from-os-500 hover:to-os-400 text-white font-medium tracking-wide rounded-lg shadow-lg shadow-os-600/20 transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-os-500/50"
                  >
                    Go to My Account
                    <svg
                      className="w-4 h-4"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M3 8h10M9 4l4 4-4 4" />
                    </svg>
                  </a>
                  <p className="font-mono-plex text-[10px] text-gray-600 mt-3 tracking-wide">
                    Sign in anytime with your email and password.
                  </p>
                </div>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
