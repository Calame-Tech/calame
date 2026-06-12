import { useState, useEffect } from 'react';
import { apiFetch } from '../lib/api.js';
import type { AccessMode } from '../types/schema.js';
import UserChatPanel from './UserChatPanel.js';
import { useBranding, DEFAULT_LOGO_SRC } from '../lib/branding.js';

interface UserProfile {
  profileName: string;
  accessMode: AccessMode;
  allowedTables: string[] | null;
  mcpUrl: string | null;
}

interface UserInfo {
  id: string;
  name: string;
  email: string;
}

type DashboardView = 'chat' | 'profile';

export default function UserDashboard({ onLogout }: { onLogout: () => void }) {
  const branding = useBranding();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [tokenPreview, setTokenPreview] = useState('');
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [showRevealPrompt, setShowRevealPrompt] = useState(false);
  const [revealPassword, setRevealPassword] = useState('');
  const [revealError, setRevealError] = useState('');
  const [revealLoading, setRevealLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [chatEnabled, setChatEnabled] = useState(false);
  const [view, setView] = useState<DashboardView>('chat');

  // Change password state
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwMessage, setPwMessage] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch('/api/auth/user-tokens', { credentials: 'include' });
        const data = await res.json();
        if (data.success) {
          setUser(data.user);
          setProfiles(data.profiles);
          setTokenPreview(data.tokenPreview);
          if (data.chatEnabled) setChatEnabled(true);
        }
      } catch {
        setError('Failed to load account data.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Determine if chat is available
  const chatProfiles = profiles.filter((p) => p.accessMode === 'chat' || p.accessMode === 'both');
  const hasChatAccess = chatEnabled && chatProfiles.length > 0;

  // Default to profile view if no chat access
  useEffect(() => {
    if (!loading && !hasChatAccess) {
      setView('profile');
    }
  }, [loading, hasChatAccess]);

  const handleRevealToken = async () => {
    if (!revealPassword) return;
    setRevealLoading(true);
    setRevealError('');
    try {
      const res = await apiFetch('/api/auth/user-reveal-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password: revealPassword }),
      });
      const data = await res.json();
      if (data.success) {
        setRevealedToken(data.token);
        setShowRevealPrompt(false);
        setRevealPassword('');
      } else {
        setRevealError(data.message || 'Incorrect password.');
      }
    } catch {
      setRevealError('Connection error.');
    } finally {
      setRevealLoading(false);
    }
  };

  const handleRegenerateToken = async () => {
    if (
      !confirm(
        'Regenerate your token? Your current token will stop working immediately. You will need to update your MCP client configuration.',
      )
    )
      return;
    setError('');
    try {
      const res = await apiFetch('/api/auth/user-regenerate-token', {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success) {
        setNewToken(data.plaintextToken);
      } else {
        setError(data.message);
      }
    } catch {
      setError('Failed to regenerate token.');
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwMessage('');
    try {
      const res = await apiFetch('/api/auth/user-change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      });
      const data = await res.json();
      if (data.success) {
        setPwMessage('Password updated successfully.');
        setCurrentPw('');
        setNewPw('');
        setShowChangePassword(false);
      } else {
        setPwMessage(data.message || 'Failed to change password.');
      }
    } catch {
      setPwMessage('Connection error.');
    }
  };

  const handleLogout = async () => {
    await apiFetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    onLogout();
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-gray-900 flex flex-col overflow-hidden">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-3 bg-gray-900/80 flex-shrink-0">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img
              src={branding.logo || DEFAULT_LOGO_SRC}
              alt="Calame"
              className="h-7 w-7 object-contain"
            />
            <div>
              <h1 className="text-lg font-bold tracking-tight text-gray-100">Calame</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* User name button — navigates to profile */}
            <button
              onClick={() => setView(view === 'profile' ? 'chat' : 'profile')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200 flex items-center gap-2 ${
                view === 'profile'
                  ? 'bg-os-700/30 text-os-400 border border-os-600/40'
                  : 'bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700'
              }`}
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"
                />
              </svg>
              {user?.name}
            </button>
            <button
              onClick={handleLogout}
              className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 text-sm rounded-lg transition-colors border border-gray-700"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {error && (
        <div className="max-w-5xl mx-auto w-full px-6 pt-4">
          <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-red-300 text-sm">
            {error}
            <button onClick={() => setError('')} className="ml-2 text-red-400">
              x
            </button>
          </div>
        </div>
      )}

      {/* Chat view — fixed height, fills remaining viewport */}
      {view === 'chat' && hasChatAccess && (
        <main className="flex-1 flex flex-col max-w-5xl mx-auto w-full px-6 py-4 overflow-hidden">
          <UserChatPanel profiles={chatProfiles} />
        </main>
      )}

      {/* Chat not configured message */}
      {view === 'chat' && !hasChatAccess && chatProfiles.length > 0 && (
        <main className="flex-1 flex items-center justify-center p-6">
          <div className="text-center">
            <p className="text-gray-400 mb-2">Chat is not yet configured by the administrator.</p>
            <p className="text-sm text-gray-600">Contact your admin to enable AI chat.</p>
          </div>
        </main>
      )}

      {/* Profile view */}
      {view === 'profile' && (
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto p-6 space-y-6">
            {/* Back to chat button */}
            {hasChatAccess && (
              <button
                onClick={() => setView('chat')}
                className="text-sm text-os-400 hover:text-os-300 transition-colors flex items-center gap-1"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18"
                  />
                </svg>
                Back to chat
              </button>
            )}

            {/* Profile info */}
            <div className="card-primary p-4">
              <h2 className="heading-md mb-3">My Profile</h2>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-gray-500">Name</span>
                  <p className="text-white">{user?.name}</p>
                </div>
                <div>
                  <span className="text-gray-500">Email</span>
                  <p className="text-white">{user?.email}</p>
                </div>
              </div>
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => setShowChangePassword(!showChangePassword)}
                  className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded transition-colors"
                >
                  Change Password
                </button>
              </div>

              {showChangePassword && (
                <form onSubmit={handleChangePassword} className="mt-4 space-y-3 max-w-sm">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Current password</label>
                    <input
                      type="password"
                      value={currentPw}
                      onChange={(e) => setCurrentPw(e.target.value)}
                      className="input-editorial w-full text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">
                      New password (min 8 characters)
                    </label>
                    <input
                      type="password"
                      value={newPw}
                      onChange={(e) => setNewPw(e.target.value)}
                      className="input-editorial w-full text-sm"
                      minLength={8}
                      required
                    />
                  </div>
                  {pwMessage && <p className="text-xs text-yellow-300">{pwMessage}</p>}
                  <button
                    type="submit"
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded"
                  >
                    Update Password
                  </button>
                </form>
              )}
            </div>

            {/* Token section */}
            <div className="card-primary p-4">
              <h2 className="heading-md mb-3">My Token</h2>

              {newToken ? (
                <div className="bg-green-900/30 border border-green-700 rounded-lg p-4 mb-4">
                  <p className="text-green-300 text-sm font-medium mb-2">
                    New token generated — copy it now.
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 bg-gray-900 px-3 py-2 rounded text-green-300 text-sm font-mono break-all">
                      {newToken}
                    </code>
                    <button
                      onClick={() => copyToClipboard(newToken, 'token')}
                      className={`px-3 py-2 ${copied === 'token' ? 'bg-green-700 text-green-200' : 'bg-gray-700 hover:bg-gray-600 text-white'} text-sm rounded transition-colors`}
                    >
                      {copied === 'token' ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mb-3">
                  <div className="flex items-center gap-2">
                    <code className="flex-1 bg-gray-900 px-3 py-2 rounded text-gray-300 text-sm font-mono break-all">
                      {revealedToken ?? tokenPreview}
                    </code>
                    {!revealedToken && (
                      <button
                        onClick={() => setShowRevealPrompt(!showRevealPrompt)}
                        className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded transition-colors flex-shrink-0"
                      >
                        Show
                      </button>
                    )}
                    {revealedToken && (
                      <>
                        <button
                          onClick={() => copyToClipboard(revealedToken, 'token')}
                          className={`px-3 py-2 ${copied === 'token' ? 'bg-green-700 text-green-200' : 'bg-gray-700 hover:bg-gray-600 text-white'} text-sm rounded transition-colors flex-shrink-0`}
                        >
                          {copied === 'token' ? 'Copied!' : 'Copy'}
                        </button>
                        <button
                          onClick={() => setRevealedToken(null)}
                          className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded transition-colors flex-shrink-0"
                        >
                          Hide
                        </button>
                      </>
                    )}
                  </div>

                  {/* Password prompt to reveal token */}
                  {showRevealPrompt && !revealedToken && (
                    <div className="mt-2 p-3 rounded-lg border border-os-600/40 bg-os-900/20 space-y-2">
                      <p className="text-xs text-gray-300">
                        Enter your password to reveal your API key.
                      </p>
                      <div className="flex items-center gap-2">
                        <input
                          type="password"
                          value={revealPassword}
                          onChange={(e) => setRevealPassword(e.target.value)}
                          placeholder="Your password"
                          autoFocus
                          className="input-editorial flex-1 text-sm"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRevealToken();
                          }}
                        />
                        <button
                          onClick={handleRevealToken}
                          disabled={!revealPassword || revealLoading}
                          className="px-3 py-1.5 bg-os-700 hover:bg-os-600 disabled:opacity-50 rounded-lg text-sm font-medium transition-all duration-200"
                        >
                          {revealLoading ? '...' : 'OK'}
                        </button>
                        <button
                          onClick={() => {
                            setShowRevealPrompt(false);
                            setRevealPassword('');
                            setRevealError('');
                          }}
                          className="px-2 py-1.5 text-gray-500 hover:text-gray-300 text-sm"
                        >
                          Cancel
                        </button>
                      </div>
                      {revealError && <p className="text-xs text-red-400">{revealError}</p>}
                    </div>
                  )}
                </div>
              )}

              <div className="mt-4 pt-4 border-t border-white/5">
                <button
                  onClick={handleRegenerateToken}
                  className="text-xs text-gray-400 hover:text-red-400 transition-colors"
                >
                  Regenerate token
                </button>
                {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
              </div>
            </div>

            {/* MCP Access */}
            <div className="card-primary p-4">
              <h2 className="heading-md mb-3">My MCP Servers</h2>

              {profiles.length === 0 ? (
                <p className="text-sm text-gray-500">No MCP servers assigned to your account.</p>
              ) : (
                <div className="space-y-4">
                  {profiles.map((p) => (
                    <div key={p.profileName} className="card-nested px-4 py-3">
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="text-white font-medium">{p.profileName}</h3>
                        <span className="text-xs px-2 py-0.5 rounded bg-blue-900/50 text-blue-300 border border-blue-800">
                          {p.accessMode === 'both'
                            ? 'MCP + Chat'
                            : p.accessMode === 'mcp'
                              ? 'MCP only'
                              : 'Chat only'}
                        </span>
                      </div>

                      {p.mcpUrl && (
                        <div className="mb-3">
                          <p className="text-xs text-gray-500 mb-1">Endpoint</p>
                          <div className="flex items-center gap-2">
                            <code className="flex-1 bg-gray-800 px-2 py-1 rounded text-blue-300 text-xs font-mono break-all">
                              {p.mcpUrl}
                            </code>
                            <button
                              onClick={() => copyToClipboard(p.mcpUrl!, p.profileName + '-url')}
                              className={`px-2 py-1 ${copied === p.profileName + '-url' ? 'bg-green-700 text-green-200' : 'bg-gray-700 hover:bg-gray-600 text-white'} text-xs rounded transition-colors flex-shrink-0`}
                            >
                              {copied === p.profileName + '-url' ? 'Copied!' : 'Copy'}
                            </button>
                          </div>
                        </div>
                      )}

                      {p.allowedTables && (
                        <div className="mb-3">
                          <p className="text-xs text-gray-500 mb-1">Accessible tables</p>
                          <div className="flex flex-wrap gap-1">
                            {p.allowedTables.map((t) => (
                              <span
                                key={t}
                                className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700"
                              >
                                {t}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Config snippet */}
                      {p.mcpUrl && (newToken || tokenPreview) && (
                        <details className="mt-2">
                          <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300">
                            Show configuration snippet
                          </summary>
                          <pre className="mt-2 bg-gray-800 p-3 rounded text-xs text-gray-300 overflow-x-auto">
                            {JSON.stringify(
                              {
                                mcpServers: {
                                  [p.profileName]: {
                                    url: p.mcpUrl,
                                    headers: {
                                      Authorization: `Bearer ${newToken ?? '<your-token>'}`,
                                    },
                                  },
                                },
                              },
                              null,
                              2,
                            )}
                          </pre>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
