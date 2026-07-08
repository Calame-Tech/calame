import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../lib/api.js';
import HelpTip from './HelpTip.js';

const SECRET_MASK = '•••';

interface NotificationSettingsData {
  webhookUrl?: string;
  webhookSecret?: string;
  webhookFormat: 'json' | 'slack';
  webhookEnabled: boolean;
  emailRecipients: string[];
  emailEnabled: boolean;
}

interface ChannelResult {
  ok: boolean;
  error?: string;
}

interface TestResults {
  inApp?: ChannelResult;
  webhook?: ChannelResult;
  email?: ChannelResult;
}

const CHANNEL_LABELS: Record<keyof TestResults, string> = {
  inApp: 'In-app',
  webhook: 'Webhook',
  email: 'Email',
};

export default function NotificationSettings() {
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [webhookFormat, setWebhookFormat] = useState<'json' | 'slack'>('json');
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailRecipientsText, setEmailRecipientsText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<TestResults | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/notification-settings', { credentials: 'include' });
      const data = await res.json();
      if (data.success && data.settings) {
        const s = data.settings as NotificationSettingsData;
        setWebhookEnabled(!!s.webhookEnabled);
        setWebhookUrl(s.webhookUrl ?? '');
        setWebhookSecret(s.webhookSecret ?? '');
        setWebhookFormat(s.webhookFormat === 'slack' ? 'slack' : 'json');
        setEmailEnabled(!!s.emailEnabled);
        setEmailRecipientsText((s.emailRecipients ?? []).join('\n'));
      }
    } catch {
      // Not configured yet
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const buildPayload = () => ({
    webhookEnabled,
    webhookUrl,
    webhookSecret,
    webhookFormat,
    emailEnabled,
    emailRecipients: emailRecipientsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  });

  const handleSave = async () => {
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await apiFetch('/api/notification-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(buildPayload()),
      });
      const data = await res.json();
      if (data.success) {
        setSaveResult('Saved successfully.');
        if (data.settings) {
          setWebhookSecret((data.settings as NotificationSettingsData).webhookSecret ?? '');
        }
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
    setTestResults(null);
    setTestError(null);
    try {
      // The test endpoint dispatches with the SAVED settings — persist the
      // current form first so "Send test" always tests what the user sees.
      const saveRes = await apiFetch('/api/notification-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(buildPayload()),
      });
      const saveData = await saveRes.json();
      if (!saveData.success) {
        setTestError(saveData.message || 'Could not save settings before testing.');
        return;
      }
      if (saveData.settings) {
        setWebhookSecret((saveData.settings as NotificationSettingsData).webhookSecret ?? '');
      }

      const res = await apiFetch('/api/notification-settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success) {
        setTestResults(data.results as TestResults);
      } else {
        setTestError(data.message || 'Test failed.');
      }
    } catch {
      setTestError('Connection error.');
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return <div className="text-gray-400 text-sm">Loading notification settings...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="heading-md">Notifications</h2>
          <HelpTip
            content="Get notified in-app, via webhook, or by email whenever a write request enters the human-approval queue."
            position="right"
            maxWidth={320}
          />
        </div>
        <p className="text-sm text-gray-500 mt-1">
          Choose how you want to be alerted when a write request is pending approval.
        </p>
      </div>

      {/* Webhook */}
      <div className="card-primary p-4 space-y-3">
        <label className="flex items-center gap-2 text-sm font-medium text-gray-200">
          <input
            type="checkbox"
            checked={webhookEnabled}
            onChange={(e) => setWebhookEnabled(e.target.checked)}
          />
          Webhook
        </label>

        <div>
          <label htmlFor="notif-webhook-url" className="text-sm text-gray-400 mb-1 block">
            Webhook URL
          </label>
          <input
            id="notif-webhook-url"
            type="text"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder="https://hooks.slack.com/services/…"
            className="input-editorial w-full text-sm"
          />
        </div>

        <div>
          <label htmlFor="notif-webhook-secret" className="text-sm text-gray-400 mb-1 block">
            Webhook Secret
          </label>
          <input
            id="notif-webhook-secret"
            type="password"
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
            placeholder={SECRET_MASK}
            className="input-editorial w-full text-sm"
          />
          <p className="text-xs text-gray-600 mt-1">
            Signs the Generic JSON payload (X-Calame-Signature header). Leave unchanged to keep the
            current secret.
          </p>
        </div>

        <div>
          <label htmlFor="notif-webhook-format" className="text-sm text-gray-400 mb-1 block">
            Format
          </label>
          <select
            id="notif-webhook-format"
            value={webhookFormat}
            onChange={(e) => setWebhookFormat(e.target.value === 'slack' ? 'slack' : 'json')}
            className="input-editorial w-full text-sm"
          >
            <option value="json">Generic JSON</option>
            <option value="slack">Slack</option>
          </select>
        </div>
      </div>

      {/* Email */}
      <div className="card-primary p-4 space-y-3">
        <label className="flex items-center gap-2 text-sm font-medium text-gray-200">
          <input
            type="checkbox"
            checked={emailEnabled}
            onChange={(e) => setEmailEnabled(e.target.checked)}
          />
          Email
        </label>

        <div>
          <label htmlFor="notif-email-recipients" className="text-sm text-gray-400 mb-1 block">
            Recipients (one email per line)
          </label>
          <textarea
            id="notif-email-recipients"
            value={emailRecipientsText}
            onChange={(e) => setEmailRecipientsText(e.target.value)}
            rows={4}
            placeholder={'alice@example.com\nbob@example.com'}
            className="input-editorial w-full text-sm"
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 rounded-lg bg-os-700 hover:bg-os-600 text-white text-sm font-medium transition-all duration-200 disabled:opacity-50 shadow-md shadow-os-900/20"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={handleTest}
          disabled={testing}
          className="px-4 py-2 rounded-lg bg-gray-700/30 hover:bg-gray-700/50 text-gray-300 text-sm font-medium transition-all duration-200 disabled:opacity-50"
        >
          {testing ? 'Sending...' : 'Send test notification'}
        </button>
        {saveResult && <span className="text-sm text-green-400">{saveResult}</span>}
      </div>

      {/* Test results */}
      {testError && (
        <div className="p-3 rounded-lg text-sm bg-red-950/30 border border-red-800/50 text-red-400">
          {testError}
        </div>
      )}
      {testResults && (
        <div className="space-y-1.5">
          {(Object.keys(CHANNEL_LABELS) as (keyof TestResults)[]).map((channel) => {
            const result = testResults[channel];
            if (!result) return null;
            return (
              <div
                key={channel}
                className={`p-2.5 rounded-lg text-sm flex items-center gap-2 ${
                  result.ok
                    ? 'bg-green-950/30 border border-green-800/50 text-green-400'
                    : 'bg-red-950/30 border border-red-800/50 text-red-400'
                }`}
              >
                <span className="font-medium">{CHANNEL_LABELS[channel]}</span>
                <span>{result.ok ? 'OK' : result.error || 'Failed'}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
