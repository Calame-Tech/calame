import { useState, useEffect } from 'react';
import { apiFetch } from '../lib/api.js';
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
        const res = await apiFetch('/api/smtp-settings', { credentials: 'include' });
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
      const res = await apiFetch('/api/smtp-settings/reveal', {
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
      const res = await apiFetch('/api/smtp-settings', {
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
      const res = await apiFetch('/api/smtp-settings/test', {
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
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="heading-md">Email / SMTP Settings</h2>
            <HelpTip
              content="SMTP (Simple Mail Transfer Protocol) is used to send invitation emails to new users. Without SMTP configuration, invitations cannot be sent automatically."
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
            className={`w-2 h-2 rounded-full ${
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
            content="Hostname of the outgoing SMTP server. Common examples: smtp.gmail.com (Gmail), smtp.office365.com (Microsoft 365), email-smtp.eu-west-1.amazonaws.com (Amazon SES). Ask your email provider for this value."
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
          className="input-editorial w-full text-sm"
        />
      </div>

      {/* SMTP Port */}
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <label htmlFor="smtp-port" className="text-sm text-gray-400">
            SMTP Port <span className="text-red-400">*</span>
          </label>
          <HelpTip
            content="TCP port of the SMTP server. Standard ports: 25 (SMTP without encryption, often blocked), 465 (SMTPS — SSL/TLS from connection), 587 (SMTP + STARTTLS — recommended for most modern servers). When in doubt, use 587."
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
          className="input-editorial w-full text-sm"
        />
        <p className="text-xs text-gray-600 mt-1">
          Common ports: 25 (SMTP), 465 (SSL), 587 (STARTTLS)
        </p>
      </div>

      {/* Username */}
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <label htmlFor="smtp-username" className="text-sm text-gray-400">
            Username
          </label>
          <HelpTip
            content="Login identifier for the SMTP server. For Gmail or Microsoft 365, this is typically your full email address. Some corporate SMTP servers use a separate identifier."
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
          className="input-editorial w-full text-sm"
        />
      </div>

      {/* Password */}
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <label htmlFor="smtp-password" className="text-sm text-gray-400">
            Password
          </label>
          <HelpTip
            content="SMTP password, stored encrypted on the server. For Gmail, use an App Password rather than your main account password. For Amazon SES, use the SMTP secret key generated in the AWS console."
            position="right"
            maxWidth={340}
          />
        </div>
        <div className="relative">
          <input
            id="smtp-password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setPasswordRevealed(true);
            }}
            placeholder="••••••••"
            readOnly={isPasswordMasked}
            className={`input-editorial w-full text-sm pr-16 ${isPasswordMasked ? 'cursor-pointer' : ''}`}
            onClick={() => {
              if (isPasswordMasked) setShowRevealPrompt(true);
            }}
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
            <p className="text-xs text-gray-300">
              Enter your admin password to reveal the SMTP password.
            </p>
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={revealPassword}
                onChange={(e) => setRevealPassword(e.target.value)}
                placeholder="Admin password"
                autoFocus
                className="input-editorial flex-1 text-sm"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRevealPassword();
                }}
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
                onClick={() => {
                  setShowRevealPrompt(false);
                  setRevealPassword('');
                  setRevealError('');
                }}
                className="px-2 py-1.5 text-gray-500 hover:text-gray-300 text-sm transition-all duration-200"
              >
                Cancel
              </button>
            </div>
            {revealStatus === 'error' && <p className="text-xs text-red-400">{revealError}</p>}
          </div>
        )}

        {!showRevealPrompt && (
          <p className="text-xs text-gray-600 mt-1">
            {isPasswordMasked
              ? 'Click "Show" to reveal with admin password.'
              : 'If left unchanged, the existing password is kept on the server.'}
          </p>
        )}
      </div>

      {/* From Address */}
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <label htmlFor="smtp-from" className="text-sm text-gray-400">
            From Address
          </label>
          <HelpTip
            content="Email address displayed as the sender in invitation emails. Can include a display name, e.g. Calame &lt;noreply@example.com&gt;. This address must be authorized by your SMTP provider (verified domain on Amazon SES, alias in Gmail, etc.)."
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
          className="input-editorial w-full text-sm"
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

        {saveResult && <span className="text-sm text-green-400">{saveResult}</span>}
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
