import { useState, useEffect, useCallback } from 'react';
import { apiFetch, getCurrentTenant } from '../lib/api.js';
import type { Profile, TokenEntry } from '../types/schema.js';
import { buildMcpPath } from '../lib/mcp-url.js';
import HelpTip from './HelpTip.js';

interface TokenManagerProps {
  profiles: Profile[];
  port: number;
}

export default function TokenManager({ profiles, port }: TokenManagerProps) {
  const [tokens, setTokens] = useState<TokenEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Generate token form state
  const [generatingFor, setGeneratingFor] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [generating, setGenerating] = useState(false);

  // Newly generated token (shown once)
  const [newlyGenerated, setNewlyGenerated] = useState<{
    token: string;
    profileName: string;
  } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Revoke confirmation
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  // Reveal token state
  const [revealingTokenId, setRevealingTokenId] = useState<string | null>(null);
  const [revealPassword, setRevealPassword] = useState('');
  const [revealError, setRevealError] = useState('');
  const [revealedTokens, setRevealedTokens] = useState<Record<string, string>>({});

  const fetchTokens = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/tokens');
      const data = await res.json();
      if (data.success !== false) {
        setTokens(data.tokens ?? []);
      } else {
        setError(data.message || 'Failed to load tokens.');
      }
    } catch {
      setError('Network error loading tokens.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTokens();
  }, [fetchTokens]);

  const handleGenerate = async (profileName: string) => {
    if (!newLabel.trim()) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await apiFetch('/api/tokens/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileName, label: newLabel.trim() }),
      });
      const data = await res.json();
      if (data.success !== false && data.token) {
        // API returns token object with plaintextToken (shown once) or legacy format
        const tokenStr =
          data.token?.plaintextToken ??
          (typeof data.token === 'string' ? data.token : (data.token?.token ?? ''));
        setNewlyGenerated({ token: tokenStr, profileName });
        setGeneratingFor(null);
        setNewLabel('');
        fetchTokens();
      } else {
        setError(data.message || 'Failed to generate token.');
      }
    } catch {
      setError('Network error generating token.');
    } finally {
      setGenerating(false);
    }
  };

  const handleReveal = async (tokenId: string) => {
    setRevealError('');
    try {
      const res = await fetch(`/api/tokens/${encodeURIComponent(tokenId)}/reveal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password: revealPassword }),
      });
      const data = await res.json();
      if (data.success) {
        setRevealedTokens((prev) => ({ ...prev, [tokenId]: data.token }));
        setRevealingTokenId(null);
        setRevealPassword('');
      } else {
        setRevealError(data.message || 'Failed to reveal token.');
      }
    } catch {
      setRevealError('Connection error.');
    }
  };

  const handleRevoke = async (id: string) => {
    if (confirmRevoke !== id) {
      setConfirmRevoke(id);
      return;
    }
    setConfirmRevoke(null);
    setError(null);
    try {
      const res = await fetch(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success !== false) {
        setTokens((prev) => prev.filter((t) => t.id !== id));
      } else {
        setError(data.message || 'Failed to revoke token.');
      }
    } catch {
      setError('Network error revoking token.');
    }
  };

  const handleCopy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // noop
    }
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Group tokens by profile
  const tokensByProfile: Record<string, TokenEntry[]> = {};
  for (const profile of profiles) {
    tokensByProfile[profile.name] = tokens.filter((t) => t.profileName === profile.name);
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="p-3 rounded-lg bg-red-950/30 border border-red-800/50 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Newly generated token - show once warning */}
      {newlyGenerated && (
        <div className="p-4 rounded-lg border border-yellow-700/60 bg-yellow-900/20">
          <div className="flex items-start gap-3">
            <svg
              className="w-5 h-5 text-yellow-500 mt-0.5 flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
              />
            </svg>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-yellow-400 mb-1">
                Token generated - copy it now!
              </p>
              <p className="text-xs text-yellow-500/70 mb-3">
                This token will only be shown once. Store it securely.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 rounded bg-gray-900 border border-gray-700 text-sm text-gray-100 font-mono truncate">
                  {newlyGenerated.token}
                </code>
                <button
                  onClick={() => handleCopy(newlyGenerated.token, 'new-token')}
                  className="px-3 py-2 rounded-lg bg-os-700 hover:bg-os-600 text-white text-sm font-medium transition-all duration-200 flex-shrink-0"
                >
                  {copied === 'new-token' ? 'Copied!' : 'Copy'}
                </button>
              </div>

              {/* MCP URL for claude.ai (token in query param).
                  Tenant-qualified when the current workspace is non-default
                  so external clients (which cannot inject X-Tenant-Id) reach
                  the right tenant via the URL alone. */}
              {(() => {
                const tenant = getCurrentTenant();
                const mcpPath = buildMcpPath(newlyGenerated.profileName, tenant);
                const mcpUrl = `${window.location.origin}${mcpPath}?token=${newlyGenerated.token}`;
                const mcpServerUrl = `http://localhost:${port}${mcpPath}`;
                return (
                  <>
                    <div className="mt-3">
                      <p className="text-xs text-gray-400 mb-1">
                        claude.ai (paste this URL in Settings &gt; Integrations):
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 px-3 py-2 rounded bg-gray-900 border border-gray-700 text-xs text-os-400 font-mono truncate">
                          {mcpUrl}
                        </code>
                        <button
                          onClick={() => handleCopy(mcpUrl, 'mcp-url')}
                          className="px-3 py-2 rounded-lg bg-os-700 hover:bg-os-600 text-white text-xs font-medium transition-all duration-200 flex-shrink-0"
                        >
                          {copied === 'mcp-url' ? 'Copied!' : 'Copy URL'}
                        </button>
                      </div>
                      <p className="text-xs text-gray-600 mt-1">
                        For remote access, expose via ngrok:{' '}
                        <code className="text-gray-500">ngrok http {port}</code> then replace the
                        origin.
                      </p>
                    </div>

                    {/* MCP client config for Claude Desktop */}
                    <div className="mt-3">
                      <p className="text-xs text-gray-400 mb-1">Claude Desktop / Cursor config:</p>
                      <div className="relative">
                        <pre className="p-3 rounded bg-gray-900 border border-gray-700 text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre">{`{
  "mcpServers": {
    "forge-${newlyGenerated.profileName}": {
      "url": "${mcpServerUrl}",
      "headers": {
        "Authorization": "Bearer ${newlyGenerated.token}"
      }
    }
  }
}`}</pre>
                        <button
                          onClick={() =>
                            handleCopy(
                              JSON.stringify(
                                {
                                  mcpServers: {
                                    [`forge-${newlyGenerated.profileName}`]: {
                                      url: mcpServerUrl,
                                      headers: { Authorization: `Bearer ${newlyGenerated.token}` },
                                    },
                                  },
                                },
                                null,
                                2,
                              ),
                              'config-snippet',
                            )
                          }
                          className="absolute top-2 right-2 px-2 py-1 text-xs rounded border border-gray-600 text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors"
                        >
                          {copied === 'config-snippet' ? 'Copied!' : 'Copy'}
                        </button>
                      </div>
                    </div>
                  </>
                );
              })()}

              <button
                onClick={() => setNewlyGenerated(null)}
                className="mt-3 text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-8 text-gray-500 text-sm">Loading tokens...</div>
      ) : (
        profiles.map((profile) => {
          const profileTokens = tokensByProfile[profile.name] ?? [];
          return (
            <div key={profile.name} className="card-primary">
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium text-gray-200">{profile.label}</h3>
                  <span className="text-xs text-gray-500 font-mono">({profile.name})</span>
                  <span className="px-2 py-0.5 rounded-full text-xs bg-gray-700 text-gray-400">
                    {profileTokens.length} token{profileTokens.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => {
                      if (generatingFor === profile.name) {
                        setGeneratingFor(null);
                        setNewLabel('');
                      } else {
                        setGeneratingFor(profile.name);
                        setNewLabel('');
                      }
                    }}
                    className="px-4 py-2 rounded-lg bg-os-700 hover:bg-os-600 text-white text-sm font-medium transition-all duration-200"
                  >
                    Generate Token
                  </button>
                  <HelpTip
                    content="Generate a new API access token for this profile. The token will only be displayed once."
                    position="left"
                    maxWidth={280}
                    size="xs"
                  />
                </div>
              </div>

              {/* Generate token form */}
              {generatingFor === profile.name && (
                <div className="px-4 py-3 border-b border-white/5 bg-gray-800/30">
                  <div className="flex items-end gap-3">
                    <div className="flex-1">
                      <label className="block eyebrow mb-1">Token Label</label>
                      <input
                        type="text"
                        value={newLabel}
                        onChange={(e) => setNewLabel(e.target.value)}
                        placeholder="e.g. Claude Desktop, CI/CD..."
                        className="input-editorial w-full text-sm"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleGenerate(profile.name);
                          if (e.key === 'Escape') {
                            setGeneratingFor(null);
                            setNewLabel('');
                          }
                        }}
                        autoFocus
                      />
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => handleGenerate(profile.name)}
                        disabled={generating || !newLabel.trim()}
                        className="px-4 py-2 rounded-lg bg-os-700 hover:bg-os-600 text-white text-sm font-medium transition-all duration-200 disabled:opacity-50"
                      >
                        {generating ? 'Generating...' : 'Create'}
                      </button>
                      <HelpTip
                        content="Create the token with the given label. This token will authenticate a specific MCP client."
                        position="top"
                        size="xs"
                      />
                    </div>
                    <button
                      onClick={() => {
                        setGeneratingFor(null);
                        setNewLabel('');
                      }}
                      className="px-3 py-2 rounded-lg border border-white/10 text-gray-400 hover:text-gray-200 text-sm transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Token list */}
              {profileTokens.length > 0 ? (
                <div className="divide-y divide-white/5">
                  {profileTokens.map((tok) => (
                    <div key={tok.id ?? tok.tokenHash} className="px-4 py-3">
                      <div className="flex items-center gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-sm text-gray-200 font-medium">{tok.label}</span>
                            <code className="text-xs text-gray-500 font-mono">{tok.tokenHash}</code>
                            {!revealedTokens[tok.id] && (
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => {
                                    setRevealingTokenId(
                                      revealingTokenId === tok.id ? null : tok.id,
                                    );
                                    setRevealPassword('');
                                    setRevealError('');
                                  }}
                                  className="text-xs text-os-400 hover:text-os-300 transition-colors"
                                >
                                  Reveal
                                </button>
                                <HelpTip
                                  content="Reveal the full token value (admin password required)"
                                  position="top"
                                  size="xs"
                                />
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-3 text-xs text-gray-500">
                            <span>Created {formatDate(tok.createdAt)}</span>
                            {tok.lastUsedAt && <span>Last used {formatDate(tok.lastUsedAt)}</span>}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => handleRevoke(tok.id)}
                            className={`px-3 py-1.5 rounded-lg text-sm transition-all duration-200 ${
                              confirmRevoke === tok.id
                                ? 'bg-red-600 text-white hover:bg-red-500'
                                : 'bg-red-600/20 text-red-400 hover:bg-red-600/30'
                            }`}
                          >
                            {confirmRevoke === tok.id ? 'Confirm Revoke' : 'Revoke'}
                          </button>
                          <HelpTip
                            content={
                              confirmRevoke === tok.id
                                ? 'Cliquer une seconde fois pour confirmer la révocation définitive de ce token.'
                                : "Révoquer ce token — les clients qui l'utilisent seront immédiatement déconnectés."
                            }
                            position="left"
                            maxWidth={280}
                            size="xs"
                          />
                        </div>
                      </div>

                      {/* Inline admin password prompt */}
                      {revealingTokenId === tok.id && !revealedTokens[tok.id] && (
                        <div className="mt-2 p-3 rounded-lg border border-os-600/40 bg-os-900/20 space-y-2">
                          <p className="text-xs text-gray-300">
                            Enter admin password to reveal this API key.
                          </p>
                          <div className="flex gap-2">
                            <input
                              type="password"
                              value={revealPassword}
                              onChange={(e) => setRevealPassword(e.target.value)}
                              placeholder="Admin password"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleReveal(tok.id);
                                if (e.key === 'Escape') {
                                  setRevealingTokenId(null);
                                  setRevealPassword('');
                                  setRevealError('');
                                }
                              }}
                              className="input-editorial flex-1 text-xs"
                            />
                            <button
                              onClick={() => handleReveal(tok.id)}
                              className="px-3 py-1 text-xs rounded-lg bg-os-700 hover:bg-os-600 text-white transition-all duration-200"
                            >
                              OK
                            </button>
                            <button
                              onClick={() => {
                                setRevealingTokenId(null);
                                setRevealPassword('');
                                setRevealError('');
                              }}
                              className="px-3 py-1 text-xs rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                          {revealError && <p className="text-xs text-red-400">{revealError}</p>}
                        </div>
                      )}

                      {/* Revealed token display */}
                      {revealedTokens[tok.id] && (
                        <div className="mt-2 p-3 rounded-lg border border-green-700/30 bg-green-900/10">
                          <div className="flex items-center gap-2">
                            <code className="text-xs font-mono text-green-400 flex-1 break-all">
                              {revealedTokens[tok.id]}
                            </code>
                            <button
                              onClick={() => handleCopy(revealedTokens[tok.id], `reveal-${tok.id}`)}
                              title="Copier le token dans le presse-papiers"
                              className="text-xs text-gray-400 hover:text-gray-200 transition-colors flex-shrink-0"
                            >
                              {copied === `reveal-${tok.id}` ? 'Copied!' : 'Copy'}
                            </button>
                            <button
                              onClick={() =>
                                setRevealedTokens((prev) => {
                                  const next = { ...prev };
                                  delete next[tok.id];
                                  return next;
                                })
                              }
                              className="text-xs text-gray-500 hover:text-gray-300 transition-colors flex-shrink-0"
                            >
                              Hide
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="px-4 py-6 text-center text-gray-500 text-sm">
                  No tokens for this profile. Generate one to connect MCP clients.
                </div>
              )}
            </div>
          );
        })
      )}

      {/* Endpoint URL reference */}
      <div className="card-primary p-4">
        <h3 className="eyebrow mb-2">MCP Endpoints</h3>
        <p className="text-xs text-gray-500 mb-3">
          Each profile has its own MCP endpoint
          {getCurrentTenant() !== 'default' && (
            <>
              {' '}
              — URLs include the workspace id (
              <code className="text-os-400">{getCurrentTenant()}</code>) so external MCP clients
              reach the right tenant
            </>
          )}
          :
        </p>
        <div className="space-y-1">
          {profiles.map((profile) => {
            const path = buildMcpPath(profile.name, getCurrentTenant());
            const url = `http://localhost:${port}${path}`;
            return (
              <div key={profile.name} className="flex items-center gap-2">
                <code className="text-xs text-os-400 font-mono">{url}</code>
                <button
                  onClick={() => handleCopy(url, `url-${profile.name}`)}
                  title="Copier l'URL de l'endpoint MCP dans le presse-papiers"
                  className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                >
                  {copied === `url-${profile.name}` ? 'Copied!' : 'Copy'}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
