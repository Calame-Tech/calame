// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { useState, useEffect, useRef } from 'react';
import HelpTip from '../../../../packages/web/src/components/HelpTip.js';

interface OidcConfig {
  enabled: boolean;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  groupClaim: string;
  autoCreateUsers: boolean;
  groupToProfile: Record<string, string>;
}

interface GroupMapping {
  group: string;
  profile: string;
}

const DEFAULT_REDIRECT_URI = window.location.origin + '/api/auth/oidc/callback';
const DEFAULT_SCOPES = 'openid profile email';
const DEFAULT_GROUP_CLAIM = 'groups';

interface OidcSettingsProps {
  availableProfiles?: string[];
}

export default function OidcSettings({ availableProfiles = [] }: OidcSettingsProps) {
  const [enabled, setEnabled] = useState(false);
  const [issuerUrl, setIssuerUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState(DEFAULT_REDIRECT_URI);
  const [scopes, setScopes] = useState(DEFAULT_SCOPES);
  const [groupClaim, setGroupClaim] = useState(DEFAULT_GROUP_CLAIM);
  const [autoCreateUsers, setAutoCreateUsers] = useState(false);
  const [mappings, setMappings] = useState<GroupMapping[]>([]);

  const [showSecret, setShowSecret] = useState(false);
  const [secretRevealed, setSecretRevealed] = useState(false);
  const [showRevealPrompt, setShowRevealPrompt] = useState(false);
  const [revealPassword, setRevealPassword] = useState('');
  const [revealStatus, setRevealStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [revealError, setRevealError] = useState('');

  // Tracks whether we have already auto-enabled OIDC once during this session.
  // Set to true on the first auto-tick OR the first manual toggle, so we never
  // override an explicit admin choice.
  const hasAutoEnabled = useRef(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<string | null>(null);
  const [configured, setConfigured] = useState(false);

  // Whether the secret is a masked value from the server (contains ***)
  const isSecretMasked = clientSecret.includes('***') && !secretRevealed;

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/oidc-settings', { credentials: 'include' });
        const data = await res.json();
        if (data.success && data.config) {
          const cfg = data.config as OidcConfig;
          setEnabled(cfg.enabled ?? false);
          setIssuerUrl(cfg.issuerUrl ?? '');
          setClientId(cfg.clientId ?? '');
          setClientSecret(cfg.clientSecret ?? '');
          setRedirectUri(cfg.redirectUri ?? DEFAULT_REDIRECT_URI);
          setScopes(cfg.scopes ?? DEFAULT_SCOPES);
          setGroupClaim(cfg.groupClaim ?? DEFAULT_GROUP_CLAIM);
          setAutoCreateUsers(cfg.autoCreateUsers ?? false);
          setMappings(recordToMappings(cfg.groupToProfile ?? {}));
          setConfigured(cfg.enabled);
          // If the server returned a non-empty config (issuerUrl or clientId already set),
          // mark hasAutoEnabled so the auto-tick never fires on reload — even if enabled=false.
          // This preserves an admin's deliberate decision to disable OIDC on an existing config.
          if ((cfg.issuerUrl ?? '') !== '' || (cfg.clientId ?? '') !== '') {
            hasAutoEnabled.current = true;
          }
        }
      } catch {
        // Not configured yet — leave defaults
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function recordToMappings(record: Record<string, string>): GroupMapping[] {
    return Object.entries(record).map(([group, profile]) => ({ group, profile }));
  }

  function mappingsToRecord(list: GroupMapping[]): Record<string, string> {
    return list.reduce<Record<string, string>>((acc, { group, profile }) => {
      if (group.trim()) acc[group.trim()] = profile.trim();
      return acc;
    }, {});
  }

  const addMapping = () => setMappings((prev) => [...prev, { group: '', profile: '' }]);

  const removeMapping = (index: number) =>
    setMappings((prev) => prev.filter((_, i) => i !== index));

  const updateMapping = (index: number, field: keyof GroupMapping, value: string) =>
    setMappings((prev) => prev.map((m, i) => (i === index ? { ...m, [field]: value } : m)));

  const handleRevealSecret = async () => {
    if (!revealPassword) return;
    setRevealStatus('loading');
    setRevealError('');
    try {
      const res = await fetch('/api/oidc-settings/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password: revealPassword }),
      });
      const data = await res.json();
      if (data.success) {
        setClientSecret(data.clientSecret);
        setSecretRevealed(true);
        setShowSecret(true);
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

  const buildPayload = () => ({
    enabled,
    issuerUrl,
    clientId,
    clientSecret,
    redirectUri,
    scopes,
    groupClaim,
    autoCreateUsers,
    groupToProfile: mappingsToRecord(mappings),
  });

  const handleSave = async () => {
    if (!enabled && issuerUrl.trim() !== '' && clientId.trim() !== '') {
      const confirmed = window.confirm(
        'OIDC is configured but the Enabled toggle is OFF — users will not be able to sign in via SSO.\n\nSave anyway?',
      );
      if (!confirmed) return;
    }

    setSaving(true);
    setSaveResult(null);
    try {
      const res = await fetch('/api/oidc-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(buildPayload()),
      });
      const data = await res.json();
      if (data.success) {
        setSaveResult('Saved successfully.');
        setConfigured(enabled);
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

  if (loading) {
    return <div className="text-gray-400 text-sm">Loading OIDC settings...</div>;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="heading-md">OIDC / SSO Settings</h2>
            <HelpTip
              content="OpenID Connect (OIDC) lets your users sign in through an external identity provider (Keycloak, Azure AD, Google Workspace, etc.) without creating a local account."
              position="right"
              maxWidth={300}
            />
          </div>
          <p className="text-sm text-gray-500 mt-1">
            Configure Single Sign-On via OpenID Connect.
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

      {/* Enable OIDC toggle */}
      <div className="flex items-center justify-between card-primary p-4">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-gray-200">Enable OIDC</p>
            <HelpTip
              content="Enables SSO authentication. Users will see a sign-in button via your identity provider. Local authentication remains available when SSO is disabled."
              position="right"
              maxWidth={300}
            />
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            Allow users to sign in with an external identity provider.
          </p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer" htmlFor="oidc-enabled">
          <input
            id="oidc-enabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              hasAutoEnabled.current = true;
              setEnabled(e.target.checked);
            }}
            className="sr-only peer"
          />
          <div className="w-10 h-5 bg-gray-700 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-os-500/30 rounded-full peer peer-checked:after:translate-x-5 peer-checked:bg-os-600 after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all" />
          <span className="sr-only">{enabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      </div>

      {/* Issuer URL */}
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <label htmlFor="oidc-issuer" className="text-sm text-gray-400">
            Issuer URL <span className="text-red-400">*</span>
          </label>
          <HelpTip
            content="OIDC discovery URL of your identity provider. The server will automatically download the configuration from {issuer}/.well-known/openid-configuration. Examples: https://login.microsoftonline.com/{tenant}/v2.0, https://accounts.google.com, https://keycloak.example.com/realms/myrealm."
            position="right"
            maxWidth={340}
          />
        </div>
        <input
          id="oidc-issuer"
          type="text"
          value={issuerUrl}
          onChange={(e) => {
            const newValue = e.target.value;
            setIssuerUrl(newValue);
            if (newValue.trim() !== '' && clientId.trim() !== '' && !hasAutoEnabled.current && !enabled) {
              hasAutoEnabled.current = true;
              setEnabled(true);
            }
          }}
          placeholder="https://login.microsoftonline.com/{tenant}/v2.0"
          className="input-editorial w-full text-sm"
        />
      </div>

      {/* Client ID */}
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <label htmlFor="oidc-client-id" className="text-sm text-gray-400">
            Client ID <span className="text-red-400">*</span>
          </label>
          <HelpTip
            content="Public identifier of the OAuth application registered with your identity provider. Retrieve it from your IdP console (Azure AD, Google Cloud Console, Keycloak Admin, etc.)."
            position="right"
            maxWidth={320}
          />
        </div>
        <input
          id="oidc-client-id"
          type="text"
          value={clientId}
          onChange={(e) => {
            const newValue = e.target.value;
            setClientId(newValue);
            if (newValue.trim() !== '' && issuerUrl.trim() !== '' && !hasAutoEnabled.current && !enabled) {
              hasAutoEnabled.current = true;
              setEnabled(true);
            }
          }}
          placeholder="your-client-id"
          className="input-editorial w-full text-sm"
        />
      </div>

      {/* Client Secret */}
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <label htmlFor="oidc-client-secret" className="text-sm text-gray-400">
            Client Secret
          </label>
          <HelpTip
            content="OAuth secret shared between the application and the identity provider. Stored encrypted on the server — never transmitted in plain text. Click Show to reveal it using your administrator password."
            position="right"
            maxWidth={320}
          />
        </div>
        <div className="relative">
          <input
            id="oidc-client-secret"
            type={showSecret ? 'text' : 'password'}
            value={clientSecret}
            onChange={(e) => {
              setClientSecret(e.target.value);
              setSecretRevealed(true);
            }}
            placeholder="••••••••"
            readOnly={isSecretMasked}
            className={`input-editorial w-full text-sm pr-16 ${isSecretMasked ? 'cursor-pointer' : ''}`}
            onClick={() => {
              if (isSecretMasked) setShowRevealPrompt(true);
            }}
          />
          <button
            type="button"
            onClick={() => {
              if (isSecretMasked) {
                setShowRevealPrompt(true);
              } else {
                setShowSecret(!showSecret);
              }
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-gray-300"
          >
            {isSecretMasked ? 'Show' : showSecret ? 'Hide' : 'Show'}
          </button>
        </div>

        {/* Admin password prompt to reveal client secret */}
        {showRevealPrompt && (
          <div className="mt-2 p-3 rounded-lg border border-os-600/40 bg-os-900/20 space-y-2">
            <p className="text-xs text-gray-300">
              Enter your admin password to reveal the client secret.
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
                  if (e.key === 'Enter') handleRevealSecret();
                }}
              />
              <button
                type="button"
                onClick={handleRevealSecret}
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
            {revealStatus === 'error' && (
              <p className="text-xs text-red-400">{revealError}</p>
            )}
          </div>
        )}

        {!showRevealPrompt && (
          <p className="text-xs text-gray-600 mt-1">
            {isSecretMasked
              ? 'Click "Show" to reveal with admin password.'
              : 'If left unchanged, the existing secret is kept on the server.'}
          </p>
        )}
      </div>

      {/* Redirect URI */}
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <label htmlFor="oidc-redirect-uri" className="text-sm text-gray-400">
            Redirect URI
          </label>
          <HelpTip
            content="Callback URL to which the identity provider redirects after authentication. You must register this exact URL in the allowed redirect list of your OAuth application."
            position="right"
            maxWidth={320}
          />
        </div>
        <input
          id="oidc-redirect-uri"
          type="text"
          value={redirectUri}
          onChange={(e) => setRedirectUri(e.target.value)}
          placeholder={DEFAULT_REDIRECT_URI}
          className="input-editorial w-full text-sm"
        />
        <p className="text-xs text-gray-600 mt-1">
          Register this URI in your identity provider's allowed redirect URIs.
        </p>
      </div>

      {/* Scopes */}
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <label htmlFor="oidc-scopes" className="text-sm text-gray-400">
            Scopes
          </label>
          <HelpTip
            content="OIDC permissions requested at sign-in, space-separated. openid is required; profile and email retrieve the user's name and address. Add groups or a custom scope if your IdP requires it to expose group membership."
            position="right"
            maxWidth={340}
          />
        </div>
        <input
          id="oidc-scopes"
          type="text"
          value={scopes}
          onChange={(e) => setScopes(e.target.value)}
          placeholder={DEFAULT_SCOPES}
          className="input-editorial w-full text-sm"
        />
      </div>

      {/* Group Claim */}
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <label htmlFor="oidc-group-claim" className="text-sm text-gray-400">
            Group Claim
          </label>
          <HelpTip
            content="Name of the claim in the JWT or userinfo response that contains the user's group list. Common values: groups (Azure AD, Keycloak), roles (Keycloak), teams (GitHub). Check your IdP documentation or inspect a decoded token at jwt.io."
            position="right"
            maxWidth={340}
          />
        </div>
        <input
          id="oidc-group-claim"
          type="text"
          value={groupClaim}
          onChange={(e) => setGroupClaim(e.target.value)}
          placeholder={DEFAULT_GROUP_CLAIM}
          className="input-editorial w-full text-sm"
        />
        <p className="text-xs text-gray-600 mt-1">
          JWT claim name that contains the user's group list.
        </p>
      </div>

      {/* Auto-create Users */}
      <div className="flex items-center justify-between card-primary p-4">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-gray-200">Auto-create Users</p>
            <HelpTip
              content="When enabled, a local account is automatically created on the first SSO sign-in of an unknown user. When disabled, only accounts pre-created by an administrator can sign in via SSO."
              position="right"
              maxWidth={320}
            />
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            Automatically create a Calame account on first SSO login.
          </p>
        </div>
        <label
          className="relative inline-flex items-center cursor-pointer"
          htmlFor="oidc-auto-create"
        >
          <input
            id="oidc-auto-create"
            type="checkbox"
            checked={autoCreateUsers}
            onChange={(e) => setAutoCreateUsers(e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-10 h-5 bg-gray-700 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-os-500/30 rounded-full peer peer-checked:after:translate-x-5 peer-checked:bg-os-600 after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all" />
          <span className="sr-only">{autoCreateUsers ? 'Enabled' : 'Disabled'}</span>
        </label>
      </div>

      {/* Group → Profile Mapping */}
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <p className="text-sm text-gray-400 flex items-center gap-1.5">
            Group to Profile Mapping
            <HelpTip
              content="Map SSO groups to Calame connection profiles. When a user signs in, their groups are read from the claim configured above, and each group is translated into a database profile. A user in multiple groups inherits all corresponding profiles."
              position="right"
              maxWidth={340}
            />
          </p>
        </div>
        <p className="text-xs text-gray-600 mb-3">
          Map SSO group names to Calame connection profiles.
        </p>
        <div className="space-y-2">
          {mappings.map((m, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                value={m.group}
                onChange={(e) => updateMapping(i, 'group', e.target.value)}
                placeholder="SSO group name"
                aria-label={`SSO group name for mapping ${i + 1}`}
                className="flex-1 px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
              />
              <span className="text-gray-500 select-none" aria-hidden="true">
                →
              </span>
              {availableProfiles.length > 0 ? (
                <select
                  value={m.profile}
                  onChange={(e) => updateMapping(i, 'profile', e.target.value)}
                  aria-label={`Calame profile for mapping ${i + 1}`}
                  className="input-editorial flex-1 text-sm"
                >
                  <option value="" className="bg-gray-800">Select a profile...</option>
                  {availableProfiles.map((p) => (
                    <option key={p} value={p} className="bg-gray-800">{p}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={m.profile}
                  onChange={(e) => updateMapping(i, 'profile', e.target.value)}
                  placeholder="Calame profile"
                  aria-label={`Calame profile for mapping ${i + 1}`}
                  className="input-editorial flex-1 text-sm"
                />
              )}
              <button
                type="button"
                onClick={() => removeMapping(i)}
                aria-label={`Remove mapping ${i + 1}`}
                className="text-red-400 hover:text-red-300 text-sm leading-none px-1 transition-colors duration-150"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addMapping}
          className="mt-2 text-xs text-os-400 hover:text-os-300 transition-colors duration-150"
        >
          + Add mapping
        </button>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          title="Enregistre la configuration OIDC sur le serveur. Les modifications prennent effet immédiatement pour les nouvelles connexions."
          className="px-4 py-2 rounded-lg bg-os-700 hover:bg-os-600 text-white text-sm font-medium transition-all duration-200 disabled:opacity-50 shadow-md shadow-os-900/20"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>

        {saveResult && <span className="text-sm text-green-400">{saveResult}</span>}
      </div>
    </div>
  );
}
