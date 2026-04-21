import { useState, useEffect } from 'react';
import HelpTip from './HelpTip.js';

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  configured: boolean;
}

const DEFAULT_PORT = 587;

export default function SmtpSettings() {
  const [host, setHost] = useState('');
  const [port, setPort] = useState<number>(DEFAULT_PORT);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fromAddress, setFromAddress] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [passwordRevealed, setPasswordRevealed] = useState(false);
  const [showRevealPrompt, setShowRevealPrompt] = useState(false);
  const [revealPassword, setRevealPassword] = useState('');
  const [revealStatus, setRevealStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [revealError, setRevealError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saveResult, setSaveResult] = useState<string | null>(null);
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/smtp-settings', { credentials: 'include' });
        const data = await res.json();
        if (data.success && data.config) {
          const cfg = data.config as SmtpConfig;
          setHost(cfg.host ?? '');
          setPort(cfg.port ?? DEFAULT_PORT);
          setUsername(cfg.user ?? '');
          setPassword(cfg.pass ?? '');
          setFromAddress(cfg.from ?? '');
          setConfigured(cfg.configured);
        }
      } catch {
        // Not configured yet
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleRevealPassword = async () => {
    if (!revealPassword) return;
    setRevealStatus('loading');
    setRevealError('');
    try {
      const res = await fetch('/api/smtp-settings/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password: revealPassword }),
      });
      const data = await res.json();
      if (data.success) {
        setPassword(data.pass);
        setPasswordRevealed(true);
        setShowPassword(true);
        setShowRevealPrompt(false);
        setRevealStatus('idle');
        setRevealPassword('');
      } else {
        setRevealStatus('error');
        setRevealError(data.message || 'Incorrect password.');
      }
    } catch {
      setRevealStatus('error');
      setRevealError('Failed to reach the server.');
    }
  };

  // Whether password is a masked value from the server (contains ***)
  const isPasswordMasked = password.includes('***') && !passwordRevealed;

  const buildPayload = () => ({
    host,
    port,
    user: username,
    pass: password,
    from: fromAddress,
  });

  const handleSave = async () => {
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await fetch('/api/smtp-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(buildPayload()),
      });
      const data = await res.json();
      if (data.success) {
        setSaveResult('Saved successfully.');
        setConfigured(true);
      } else {
        setSaveResult(data.message || 'Failed to save.');
      }
    } catch {
      setSaveResult('Connection error.');
    } finally {
      setSaving(false);
      setTimeout(() => setSaveResult(null), 3000);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/smtp-settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(buildPayload()),
      });
      const data = await res.json();
      if (data.success) {
        setTestResult({ success: true, message: data.message || 'Connection OK.' });
        setConfigured(true);
      } else {
        setTestResult({ success: false, message: data.message || 'Test failed.' });
      }
    } catch {
      setTestResult({ success: false, message: 'Connection error.' });
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return <div className="text-gray-400 text-sm">Loading SMTP settings...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-gray-100">Email / SMTP Settings</h2>
            <HelpTip
              content="SMTP (Simple Mail Transfer Protocol) est utilisé pour envoyer des e-mails d'invitation aux nouveaux utilisateurs. Sans configuration SMTP, les invitations ne peuvent pas être envoyées automatiquement."
              position="right"
              maxWidth={300}
            />
          </div>
          <p className="text-sm text-gray-500 mt-1">
            Configure SMTP to send invitation emails to users.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div
            className={`w-2.5 h-2.5 rounded-full ${
              configured ? 'bg-green-500 shadow-lg shadow-green-500/30' : 'bg-gray-600'
            }`}
          />
          <span className="text-sm text-gray-400">
            {configured ? 'Configured' : 'Not configured'}
          </span>
        </div>
      </div>

      {/* SMTP Host */}
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <label htmlFor="smtp-host" className="text-sm text-gray-400">
            SMTP Host <span className="text-red-400">*</span>
          </label>
          <HelpTip
            content="Nom d'hôte du serveur SMTP sortant. Exemples courants : smtp.gmail.com (Gmail), smtp.office365.com (Microsoft 365), email-smtp.eu-west-1.amazonaws.com (Amazon SES). Demandez cette valeur à votre fournisseur de messagerie."
            position="right"
            maxWidth={340}
          />
        </div>
        <input
          id="smtp-host"
          type="text"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="smtp.gmail.com"
          className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
        />
      </div>

      {/* SMTP Port */}
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <label htmlFor="smtp-port" className="text-sm text-gray-400">
            SMTP Port <span className="text-red-400">*</span>
          </label>
          <HelpTip
            content="Port TCP du serveur SMTP. Ports standards : 25 (SMTP sans chiffrement, souvent bloqué), 465 (SMTPS — SSL/TLS dès la connexion), 587 (SMTP + STARTTLS — recommandé pour la plupart des serveurs modernes). En cas de doute, utilisez 587."
            position="right"
            maxWidth={340}
          />
        </div>
        <input
          id="smtp-port"
          type="number"
          value={port}
          onChange={(e) => setPort(Number(e.target.value))}
          min={1}
          max={65535}
          className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
        />
        <p className="text-xs text-gray-600 mt-1">
          Common ports: 25 (SMTP), 465 (SSL), 587 (STARTTLS)
        </p>
      </div>

      {/* Username */}
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <label htmlFor="smtp-username" className="text-sm text-gray-400">Username</label>
          <HelpTip
            content="Identifiant de connexion au serveur SMTP. Pour Gmail ou Microsoft 365, il s'agit généralement de votre adresse e-mail complète. Certains serveurs SMTP d'entreprise utilisent un identifiant distinct."
            position="right"
            maxWidth={320}
          />
        </div>
        <input
          id="smtp-username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="user@example.com"
          className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
        />
      </div>

      {/* Password */}
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <label htmlFor="smtp-password" className="text-sm text-gray-400">Password</label>
          <HelpTip
            content="Mot de passe SMTP, stocké chiffré sur le serveur. Pour Gmail, utilisez un « mot de passe d'application » (App Password) plutôt que votre mot de passe principal. Pour Amazon SES, utilisez la clé secrète SMTP générée dans la console AWS."
            position="right"
            maxWidth={340}
          />
        </div>
        <div className="relative">
          <input
            id="smtp-password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => { setPassword(e.target.value); setPasswordRevealed(true); }}
            placeholder="••••••••"
            readOnly={isPasswordMasked}
            className={`w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500 pr-16 ${isPasswordMasked ? 'cursor-pointer' : ''}`}
            onClick={() => { if (isPasswordMasked) setShowRevealPrompt(true); }}
          />
          <button
            type="button"
            onClick={() => {
              if (isPasswordMasked) {
                setShowRevealPrompt(true);
              } else {
                setShowPassword(!showPassword);
              }
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-gray-300"
          >
            {isPasswordMasked ? 'Show' : showPassword ? 'Hide' : 'Show'}
          </button>
        </div>

        {/* Admin password prompt to reveal SMTP password */}
        {showRevealPrompt && (
          <div className="mt-2 p-3 rounded-lg border border-os-600/40 bg-os-900/20 space-y-2">
            <p className="text-xs text-gray-300">Enter your admin password to reveal the SMTP password.</p>
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={revealPassword}
                onChange={(e) => setRevealPassword(e.target.value)}
                placeholder="Admin password"
                autoFocus
                className="flex-1 px-3 py-1.5 rounded-lg bg-gray-800/80 border border-gray-700 text-gray-100 placeholder-gray-500 text-sm focus:outline-none focus:border-os-500 focus:ring-1 focus:ring-os-500/30 transition-all duration-200"
                onKeyDown={(e) => { if (e.key === 'Enter') handleRevealPassword(); }}
              />
              <button
                type="button"
                onClick={handleRevealPassword}
                disabled={!revealPassword || revealStatus === 'loading'}
                className="px-3 py-1.5 bg-os-700 hover:bg-os-600 disabled:opacity-50 rounded-lg text-sm font-medium transition-all duration-200"
              >
                {revealStatus === 'loading' ? '...' : 'OK'}
              </button>
              <button
                type="button"
                onClick={() => { setShowRevealPrompt(false); setRevealPassword(''); setRevealError(''); }}
                className="px-2 py-1.5 text-gray-500 hover:text-gray-300 text-sm transition-all duration-200"
              >
                Cancel
              </button>
            </div>
            {revealStatus === 'error' && (
              <p className="text-xs text-red-400">{revealError}</p>
            )}
          </div>
        )}

        {!showRevealPrompt && (
          <p className="text-xs text-gray-600 mt-1">
            {isPasswordMasked ? 'Click "Show" to reveal with admin password.' : 'If left unchanged, the existing password is kept on the server.'}
          </p>
        )}
      </div>

      {/* From Address */}
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <label htmlFor="smtp-from" className="text-sm text-gray-400">From Address</label>
          <HelpTip
            content="Adresse e-mail affichée comme expéditeur dans les e-mails d'invitation. Peut inclure un nom d'affichage : « Calame <noreply@example.com> ». Cette adresse doit être autorisée par votre fournisseur SMTP (domaine vérifié sur Amazon SES, alias dans Gmail, etc.)."
            position="right"
            maxWidth={340}
          />
        </div>
        <input
          id="smtp-from"
          type="text"
          value={fromAddress}
          onChange={(e) => setFromAddress(e.target.value)}
          placeholder="Calame <noreply@example.com>"
          className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          title="Enregistre la configuration SMTP sur le serveur. Les e-mails d'invitation utiliseront ces paramètres dès la prochaine invitation."
          className="px-4 py-2 rounded-lg bg-os-700 hover:bg-os-600 text-white text-sm font-medium transition-all duration-200 disabled:opacity-50 shadow-md shadow-os-900/20"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={handleTest}
          disabled={testing}
          title="Envoie un e-mail de test à l'adresse « From » pour vérifier que la connexion SMTP fonctionne correctement avant d'enregistrer."
          className="px-4 py-2 rounded-lg bg-gray-700/30 hover:bg-gray-700/50 text-gray-300 text-sm font-medium transition-all duration-200 disabled:opacity-50"
        >
          {testing ? 'Testing...' : 'Test Connection'}
        </button>

        {saveResult && (
          <span className="text-sm text-green-400">{saveResult}</span>
        )}
      </div>

      {/* Test result */}
      {testResult && (
        <div
          className={`p-3 rounded-lg text-sm ${
            testResult.success
              ? 'bg-green-950/30 border border-green-800/50 text-green-400'
              : 'bg-red-950/30 border border-red-800/50 text-red-400'
          }`}
        >
          {testResult.message}
        </div>
      )}
    </div>
  );
}
