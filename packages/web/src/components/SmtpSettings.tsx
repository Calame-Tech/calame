import { useState, useEffect } from 'react';
import { useTranslations } from 'use-intl/react';
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
  const t = useTranslations('settingsPanels.smtp');
  const tCommon = useTranslations('common');
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
  const [saveResult, setSaveResult] = useState<{ ok: boolean; message: string } | null>(null);
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
        setRevealError(data.message || t('messages.incorrectPassword'));
      }
    } catch {
      setRevealStatus('error');
      setRevealError(t('messages.failedToReachServer'));
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
        setSaveResult({ ok: true, message: t('messages.savedSuccess') });
        setConfigured(true);
      } else {
        setSaveResult({ ok: false, message: data.message || t('messages.saveFailed') });
      }
    } catch {
      setSaveResult({ ok: false, message: t('messages.connectionError') });
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
        setTestResult({ success: true, message: data.message || t('messages.connectionOk') });
        setConfigured(true);
      } else {
        setTestResult({ success: false, message: data.message || t('messages.testFailed') });
      }
    } catch {
      setTestResult({ success: false, message: t('messages.connectionError') });
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return <div className="text-gray-400 text-sm">{t('loading')}</div>;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="heading-md">{t('title')}</h2>
            <HelpTip content={t('helpTip')} position="right" maxWidth={300} />
          </div>
          <p className="text-sm text-gray-500 mt-1">{t('description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${
              configured ? 'bg-green-500 shadow-lg shadow-green-500/30' : 'bg-gray-600'
            }`}
          />
          <span className="text-sm text-gray-400">
            {configured ? t('status.configured') : t('status.notConfigured')}
          </span>
        </div>
      </div>

      {/* SMTP Host */}
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <label htmlFor="smtp-host" className="text-sm text-gray-400">
            {t('host.label')} <span className="text-red-400">*</span>
          </label>
          <HelpTip content={t('host.help')} position="right" maxWidth={340} />
        </div>
        <input
          id="smtp-host"
          type="text"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder={t('host.placeholder')}
          className="input-editorial w-full text-sm"
        />
      </div>

      {/* SMTP Port */}
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <label htmlFor="smtp-port" className="text-sm text-gray-400">
            {t('port.label')} <span className="text-red-400">*</span>
          </label>
          <HelpTip content={t('port.help')} position="right" maxWidth={340} />
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
        <p className="text-xs text-gray-600 mt-1">{t('port.hint')}</p>
      </div>

      {/* Username */}
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <label htmlFor="smtp-username" className="text-sm text-gray-400">
            {t('username.label')}
          </label>
          <HelpTip content={t('username.help')} position="right" maxWidth={320} />
        </div>
        <input
          id="smtp-username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t('username.placeholder')}
          className="input-editorial w-full text-sm"
        />
      </div>

      {/* Password */}
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <label htmlFor="smtp-password" className="text-sm text-gray-400">
            {t('password.label')}
          </label>
          <HelpTip content={t('password.help')} position="right" maxWidth={340} />
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
            {isPasswordMasked
              ? t('password.show')
              : showPassword
                ? t('password.hide')
                : t('password.show')}
          </button>
        </div>

        {/* Admin password prompt to reveal SMTP password */}
        {showRevealPrompt && (
          <div className="mt-2 p-3 rounded-lg border border-os-600/40 bg-os-900/20 space-y-2">
            <p className="text-xs text-gray-300">{t('password.revealPrompt')}</p>
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={revealPassword}
                onChange={(e) => setRevealPassword(e.target.value)}
                placeholder={t('password.adminPasswordPlaceholder')}
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
                {revealStatus === 'loading' ? '...' : t('password.ok')}
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
                {tCommon('cancel')}
              </button>
            </div>
            {revealStatus === 'error' && <p className="text-xs text-red-400">{revealError}</p>}
          </div>
        )}

        {!showRevealPrompt && (
          <p className="text-xs text-gray-600 mt-1">
            {isPasswordMasked ? t('password.hintMasked') : t('password.hintUnchanged')}
          </p>
        )}
      </div>

      {/* From Address */}
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <label htmlFor="smtp-from" className="text-sm text-gray-400">
            {t('fromAddress.label')}
          </label>
          <HelpTip content={t('fromAddress.help')} position="right" maxWidth={340} />
        </div>
        <input
          id="smtp-from"
          type="text"
          value={fromAddress}
          onChange={(e) => setFromAddress(e.target.value)}
          placeholder={t('fromAddress.placeholder')}
          className="input-editorial w-full text-sm"
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          title={t('actions.saveTooltip')}
          className="px-4 py-2 rounded-lg bg-os-700 hover:bg-os-600 text-white text-sm font-medium transition-all duration-200 disabled:opacity-50 shadow-md shadow-os-900/20"
        >
          {saving ? t('actions.saving') : tCommon('save')}
        </button>
        <button
          onClick={handleTest}
          disabled={testing}
          title={t('actions.testTooltip')}
          className="px-4 py-2 rounded-lg bg-gray-700/30 hover:bg-gray-700/50 text-gray-300 text-sm font-medium transition-all duration-200 disabled:opacity-50"
        >
          {testing ? t('actions.testing') : t('actions.testConnection')}
        </button>

        {saveResult && (
          <span className={`text-sm ${saveResult.ok ? 'text-green-400' : 'text-red-400'}`}>
            {saveResult.message}
          </span>
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
