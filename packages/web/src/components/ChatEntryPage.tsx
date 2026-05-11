import { useState, useEffect, useRef } from 'react';
import { apiFetch } from '../lib/api.js';
import type { AuthMode } from '../types/schema.js';
import DarkSelect from './ui/DarkSelect.js';
import { ChatSsoLogin } from '@calame-ee/sso/web';
import { useChatStream } from '../hooks/useChatStream.js';
import type { UsageInfo } from '../hooks/useChatStream.js';
import MarkdownMessage from './MarkdownMessage.js';

interface ChatEntryPageProps {
  profileName: string;
}

interface ChatProfile {
  name: string;
  label: string;
  authMode: AuthMode;
  oauthProvider?: string;
  active: boolean;
  /** AI settings the user can pick from. First entry is the default. */
  aiSettings?: Array<{ name: string; label: string }>;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  usage?: UsageInfo;
}

type PageState =
  | { step: 'loading' }
  | { step: 'error'; message: string }
  | { step: 'login'; profile: ChatProfile }
  | { step: 'denied'; profile: ChatProfile; userEmail?: string }
  | { step: 'chat'; profile: ChatProfile };

// ---------------------------------------------------------------------------
// Inline chat panel — same design as UserChatPanel but bound to one profile
// ---------------------------------------------------------------------------
function InlineChatPanel({
  profileName,
  aiSettings,
}: {
  profileName: string;
  aiSettings?: Array<{ name: string; label: string }>;
}) {
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [selectedAi, setSelectedAi] = useState<string | undefined>(aiSettings?.[0]?.name);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const { isStreaming, currentText, toolStatus, error: streamError, send, abort } = useChatStream();

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [chatMessages, currentText]);

  const handleChatSend = async () => {
    if (!chatInput.trim() || isStreaming) return;

    const userMessage = chatInput.trim();
    setChatInput('');

    setChatMessages((prev) => [
      ...prev,
      { role: 'user', content: userMessage },
      { role: 'assistant', content: '', streaming: true },
    ]);

    await send(
      { message: userMessage, history: chatMessages, profileName, aiSettingName: selectedAi },
      (text) => {
        setChatMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { ...copy[copy.length - 1], content: text };
          return copy;
        });
      },
      (finalText, usageInfo) => {
        setChatMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = {
            role: 'assistant',
            content: finalText || `Error: ${streamError ?? 'could not reach the server.'}`,
            streaming: false,
            usage: usageInfo ?? undefined,
          };
          return copy;
        });
      },
    );
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 card-primary">
      {/* Messages */}
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {chatMessages.length === 0 && (
          <div className="text-center text-gray-500 text-sm mt-16">
            <p className="mb-2">Ask anything about your data</p>
            <div className="space-y-1 text-xs text-gray-600">
              <p>&quot;How many rows are in the users table?&quot;</p>
              <p>&quot;Show me the 5 most recent orders&quot;</p>
              <p>&quot;What tables are available?&quot;</p>
            </div>
          </div>
        )}

        {chatMessages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] px-4 py-2 rounded-lg text-sm ${
                msg.role === 'user'
                  ? 'bg-os-700 text-white rounded-br-sm whitespace-pre-wrap'
                  : 'bg-gray-700/50 text-gray-200 rounded-bl-sm'
              }`}
            >
              {msg.role === 'user' ? (
                msg.content
              ) : (
                <>
                  {msg.streaming && !msg.content && !currentText ? (
                    <span className="inline-flex gap-1 items-center h-4">
                      <span className="w-1 h-1 rounded-full bg-gray-400 animate-bounce [animation-delay:-0.3s]" />
                      <span className="w-1 h-1 rounded-full bg-gray-400 animate-bounce [animation-delay:-0.15s]" />
                      <span className="w-1 h-1 rounded-full bg-gray-400 animate-bounce" />
                    </span>
                  ) : (
                    <MarkdownMessage content={msg.content || (msg.streaming ? currentText : '')} />
                  )}
                  {msg.streaming && toolStatus && (
                    <p className="text-xs text-gray-500 mt-1 italic">{toolStatus}</p>
                  )}
                  {!msg.streaming && msg.usage && (
                    <span className="text-xs text-zinc-500 mt-1 block">
                      {(msg.usage.input + msg.usage.output).toLocaleString()} tokens
                      {msg.usage.cacheRead
                        ? ` · cache ${Math.round((msg.usage.cacheRead / msg.usage.input) * 100)}%`
                        : ''}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* AI selector — shown only when multiple settings are available for this MCP */}
      {aiSettings && aiSettings.length > 1 && (
        <div className="border-t border-white/5 px-3 py-2 flex items-center gap-2">
          <span className="text-xs text-gray-500">AI:</span>
          <DarkSelect
            ariaLabel="AI provider"
            size="xs"
            value={selectedAi ?? ''}
            options={aiSettings.map((s) => ({ value: s.name, label: s.label }))}
            onChange={(v) => setSelectedAi(v || undefined)}
            disabled={isStreaming}
          />
        </div>
      )}

      {/* Input */}
      <div className="border-t border-white/5 p-3 flex gap-2">
        <input
          type="text"
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleChatSend();
            }
          }}
          placeholder="Ask about your data..."
          disabled={isStreaming}
          aria-label="Chat message input"
          className="input-editorial flex-1 text-sm disabled:opacity-50"
        />
        {isStreaming ? (
          <button
            onClick={abort}
            aria-label="Stop generation"
            className="px-4 py-2 bg-red-700 hover:bg-red-600 rounded-lg text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={handleChatSend}
            disabled={!chatInput.trim()}
            aria-label="Send message"
            className="px-4 py-2 bg-os-700 hover:bg-os-600 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-os-500"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auth form — token mode
// ---------------------------------------------------------------------------
function TokenLoginForm({
  profile,
  onSuccess,
}: {
  profile: ChatProfile;
  onSuccess: () => void;
}) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleTokenLogin = async () => {
    if (!token.trim()) return;
    setError('');
    setLoading(true);

    try {
      const res = await apiFetch('/api/chat-auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token: token.trim(), profileName: profile.name }),
      });
      const data = await res.json();

      if (data.success) {
        onSuccess();
      } else {
        setError(data.message || 'Invalid token. Please try again.');
      }
    } catch {
      setError('Connection error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="card-primary max-w-md w-full p-8">
        <div className="mb-6">
          <img src="/logo.png" alt="Calame" className="h-8 w-8 object-contain mb-4" />
          <h1 className="text-xl font-semibold text-gray-100 mb-1">
            {profile.label || profile.name}
          </h1>
          <p className="text-sm text-gray-500">Enter your Calame API key to start chatting.</p>
        </div>

        <div className="space-y-4">
          <div>
            <label
              htmlFor="token-input"
              className="block text-sm font-medium text-gray-300 mb-1.5"
            >
              API Key <span className="text-red-400">*</span>
            </label>
            <input
              id="token-input"
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleTokenLogin();
              }}
              placeholder="fmcp_..."
              autoFocus
              autoComplete="off"
              className="input-editorial w-full text-sm"
            />
          </div>

          {error && (
            <p role="alert" className="text-red-400 text-sm">
              {error}
            </p>
          )}

          <button
            onClick={handleTokenLogin}
            disabled={!token.trim() || loading}
            className="w-full py-2.5 px-4 bg-os-700 hover:bg-os-600 disabled:opacity-50 rounded-lg text-sm font-medium text-white transition-colors focus:outline-none focus:ring-2 focus:ring-os-500"
          >
            {loading ? 'Verifying...' : 'Access Chat'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auth form — calame mode (email + password)
// ---------------------------------------------------------------------------
function CalameLoginForm({
  profile,
  onSuccess,
}: {
  profile: ChatProfile;
  onSuccess: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setError('');
    setLoading(true);

    try {
      const res = await apiFetch('/api/auth/user-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json();

      if (data.success) {
        onSuccess();
      } else {
        setError(data.message || 'Invalid email or password.');
      }
    } catch {
      setError('Connection error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="card-primary max-w-md w-full p-8">
        <div className="mb-6">
          <img src="/logo.png" alt="Calame" className="h-8 w-8 object-contain mb-4" />
          <h1 className="text-xl font-semibold text-gray-100 mb-1">
            {profile.label || profile.name}
          </h1>
          <p className="text-sm text-gray-500">Sign in with your Calame account.</p>
        </div>

        <form onSubmit={handleEmailLogin} className="space-y-4" noValidate>
          <div>
            <label
              htmlFor="email-input"
              className="block text-sm font-medium text-gray-300 mb-1.5"
            >
              Email address <span className="text-red-400">*</span>
            </label>
            <input
              id="email-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email@example.com"
              autoFocus
              autoComplete="email"
              className="input-editorial w-full text-sm"
            />
          </div>

          <div>
            <label
              htmlFor="password-input"
              className="block text-sm font-medium text-gray-300 mb-1.5"
            >
              Password <span className="text-red-400">*</span>
            </label>
            <input
              id="password-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              className="input-editorial w-full text-sm"
            />
          </div>

          {error && (
            <p role="alert" className="text-red-400 text-sm">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!email.trim() || !password || loading}
            className="w-full py-2.5 px-4 bg-os-700 hover:bg-os-600 disabled:opacity-50 rounded-lg text-sm font-medium text-white transition-colors focus:outline-none focus:ring-2 focus:ring-os-500"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auth form — External token mode
// ---------------------------------------------------------------------------
function ExternalLoginForm({
  profile,
  onSuccess,
}: {
  profile: ChatProfile;
  onSuccess: () => void;
}) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!token.trim()) return;
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch('/api/chat-auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token: token.trim(), profileName: profile.name }),
      });
      const data = await res.json();
      if (data.success) {
        onSuccess();
      } else {
        setError(data.message || 'Token validation failed.');
      }
    } catch {
      setError('Connection error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="card-primary max-w-md w-full p-8">
        <div className="mb-6">
          <img src="/logo.png" alt="Calame" className="h-8 w-8 object-contain mb-4" />
          <h1 className="text-xl font-semibold text-gray-100 mb-1">
            {profile.label || profile.name}
          </h1>
          <p className="text-sm text-gray-500">Enter your access token to start chatting.</p>
        </div>

        <div className="space-y-4">
          <div>
            <label
              htmlFor="external-token-input"
              className="block text-sm font-medium text-gray-300 mb-1.5"
            >
              Access token <span className="text-red-400">*</span>
            </label>
            <input
              id="external-token-input"
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleLogin();
              }}
              placeholder="Your access token..."
              autoFocus
              autoComplete="off"
              className="input-editorial w-full text-sm"
            />
          </div>

          {error && (
            <p role="alert" className="text-red-400 text-sm">
              {error}
            </p>
          )}

          <button
            onClick={handleLogin}
            disabled={!token.trim() || loading}
            className="w-full py-2.5 px-4 bg-os-700 hover:bg-os-600 disabled:opacity-50 rounded-lg text-sm font-medium text-white transition-colors focus:outline-none focus:ring-2 focus:ring-os-500"
          >
            {loading ? 'Validating...' : 'Access Chat'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auth form — OAuth mode
// ---------------------------------------------------------------------------
function OAuthLoginForm({ profile }: { profile: ChatProfile }) {
  const redirectUrl = `/chat/${encodeURIComponent(profile.name)}`;
  const providerLabel = profile.oauthProvider || 'OAuth';

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="card-primary max-w-md w-full p-8 text-center">
        <img src="/logo.png" alt="Calame" className="h-8 w-8 object-contain mb-4 mx-auto" />
        <h1 className="text-xl font-semibold text-gray-100 mb-1">
          {profile.label || profile.name}
        </h1>
        <p className="text-sm text-gray-500 mb-8">Sign in to access this chat.</p>

        <a
          href={`/mcp/${encodeURIComponent(profile.name)}/oauth/login?redirect=${encodeURIComponent(redirectUrl)}`}
          className="inline-flex items-center justify-center w-full py-2.5 px-4 rounded-lg bg-gray-700 hover:bg-gray-600 text-sm font-medium text-white transition-colors focus:outline-none focus:ring-2 focus:ring-gray-500"
        >
          Sign in with {providerLabel}
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat view — full-screen once authenticated
// ---------------------------------------------------------------------------
function ChatView({ profile, onLogout }: { profile: ChatProfile; onLogout: () => void }) {
  const handleLogout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      // Ignore errors — clear local state anyway
    }
    onLogout();
  };

  return (
    <div className="h-screen flex flex-col bg-gray-950">
      {/* Minimal header */}
      <header className="flex-shrink-0 border-b border-gray-800/80 px-4 sm:px-6 py-3 bg-gray-900/60 backdrop-blur-sm">
        <div className="flex items-center justify-between max-w-4xl mx-auto w-full">
          <div className="flex items-center gap-3 min-w-0">
            <img src="/logo.png" alt="Calame" className="h-7 w-7 object-contain" />
            <h1 className="text-base font-semibold text-gray-100 truncate">
              {profile.label || profile.name}
            </h1>
          </div>
          {profile.authMode !== 'open' && (
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800/60 transition-all duration-200"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
              </svg>
              Logout
            </button>
          )}
        </div>
      </header>

      {/* Chat panel — fills remaining height */}
      <main className="flex-1 flex flex-col min-h-0 p-4 sm:p-6 max-w-4xl mx-auto w-full">
        <InlineChatPanel profileName={profile.name} aiSettings={profile.aiSettings} />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function ChatEntryPage({ profileName }: ChatEntryPageProps) {
  const [pageState, setPageState] = useState<PageState>({ step: 'loading' });

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      // 1. Fetch the public profile info
      let profile: ChatProfile;
      try {
        const res = await fetch(`/api/chat-profile/${encodeURIComponent(profileName)}`);
        const data = await res.json();

        if (!res.ok || !data.success || !data.profile) {
          if (!cancelled) {
            setPageState({
              step: 'error',
              message: data.message || 'This chat link is not available.',
            });
          }
          return;
        }

        profile = data.profile as ChatProfile;

        if (!profile.active) {
          if (!cancelled) {
            setPageState({ step: 'error', message: 'This chat is currently inactive.' });
          }
          return;
        }
      } catch {
        if (!cancelled) {
          setPageState({ step: 'error', message: 'Could not load the chat profile.' });
        }
        return;
      }

      // 2. Open mode — no auth needed
      if (profile.authMode === 'open') {
        if (!cancelled) setPageState({ step: 'chat', profile });
        return;
      }

      // 2b. Token and External modes — check for ?token= URL parameter for direct access
      if (profile.authMode === 'token' || profile.authMode === 'external') {
        const urlParams = new URLSearchParams(window.location.search);
        const urlToken = urlParams.get('token');
        if (urlToken) {
          try {
            const tokenRes = await apiFetch('/api/chat-auth/token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ token: urlToken, profileName }),
            });
            const tokenData = await tokenRes.json();
            if (tokenData.success) {
              // Remove token from URL for security (don't leave it in browser history)
              window.history.replaceState({}, '', window.location.pathname);
              if (!cancelled) setPageState({ step: 'chat', profile });
              return;
            }
          } catch {
            // Token invalid — fall through to login form
          }
        }
      }

      // 3. Check if already authenticated
      try {
        const statusRes = await apiFetch('/api/auth/user-status', { credentials: 'include' });
        const statusData = await statusRes.json();

        if (statusData.success && statusData.authenticated) {
          // Verify access to this specific profile
          const accessRes = await fetch(
            `/api/auth/user-profile-access?profileName=${encodeURIComponent(profileName)}`,
            { credentials: 'include' },
          );
          const accessData = await accessRes.json();

          if (accessData.success && accessData.hasAccess) {
            if (!cancelled) setPageState({ step: 'chat', profile });
            return;
          }

          // Authenticated but no access — show a clear denied screen instead of
          // falling through to the login form, which would be a dead end for SSO users.
          if (!cancelled) {
            setPageState({
              step: 'denied',
              profile,
              userEmail: statusData.user?.email as string | undefined,
            });
          }
          return;
        }
      } catch {
        // If status check fails, fall through to login
      }

      // 4. Show appropriate login form
      if (!cancelled) setPageState({ step: 'login', profile });
    };

    init();
    return () => {
      cancelled = true;
    };
  }, [profileName]);

  // Loading
  if (pageState.step === 'loading') {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div
          className="h-6 w-6 rounded-full border-2 border-os-500 border-t-transparent animate-spin"
          role="status"
          aria-label="Loading"
        />
      </div>
    );
  }

  // Error
  if (pageState.step === 'error') {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
        <div className="card-primary max-w-md w-full p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-red-900/30 border border-red-800/50 flex items-center justify-center mx-auto mb-4">
            <svg
              className="w-6 h-6 text-red-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
              />
            </svg>
          </div>
          <h1 className="text-lg font-semibold text-gray-100 mb-2">Chat unavailable</h1>
          <p className="text-sm text-gray-400">{pageState.message}</p>
        </div>
      </div>
    );
  }

  // Denied — authenticated user without access to this profile
  if (pageState.step === 'denied') {
    const handleSignOut = async () => {
      try {
        await apiFetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      } catch {
        // Ignore network errors — reload regardless so the user can start fresh
      }
      window.location.reload();
    };

    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
        <div className="max-w-md w-full rounded-xl border border-amber-800/50 bg-gray-800/40 p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-amber-900/30 border border-amber-800/50 flex items-center justify-center mx-auto mb-4">
            <svg
              className="w-6 h-6 text-amber-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
              />
            </svg>
          </div>
          <h1 className="text-lg font-semibold text-gray-100 mb-2">Access denied</h1>
          <p className="text-sm text-gray-400 mb-1">
            {pageState.userEmail ? (
              <>
                You are signed in as{' '}
                <span className="font-medium text-gray-300">{pageState.userEmail}</span>, but your
                account does not have access to{' '}
                <span className="font-medium text-gray-300">{pageState.profile.label}</span>.
              </>
            ) : (
              <>
                Your account does not have access to{' '}
                <span className="font-medium text-gray-300">{pageState.profile.label}</span>.
              </>
            )}
          </p>
          <p className="text-sm text-gray-500 mb-6">
            Contact your administrator to request access.
          </p>
          <button
            type="button"
            onClick={handleSignOut}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-700/30 border border-amber-700/50 text-amber-300 text-sm font-medium hover:bg-amber-700/50 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:ring-offset-gray-900 transition-colors"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15M12 9l-3 3m0 0 3 3m-3-3h12.75"
              />
            </svg>
            Sign out
          </button>
        </div>
      </div>
    );
  }

  const handleLogout = () => {
    // Go back to login step (re-fetch profile to show the right form)
    window.location.reload();
  };

  // Chat — already authenticated
  if (pageState.step === 'chat') {
    return <ChatView profile={pageState.profile} onLogout={handleLogout} />;
  }

  // Login step — dispatch to the correct form
  const { profile } = pageState;

  const handleAuthSuccess = () => {
    setPageState({ step: 'chat', profile });
  };

  switch (profile.authMode) {
    case 'open':
      // Should not reach here, handled above
      return <ChatView profile={profile} onLogout={handleLogout} />;

    case 'token':
      return <TokenLoginForm profile={profile} onSuccess={handleAuthSuccess} />;

    case 'calame':
      return <CalameLoginForm profile={profile} onSuccess={handleAuthSuccess} />;

    case 'sso':
      return <ChatSsoLogin profile={profile} />;

    case 'oauth':
      return <OAuthLoginForm profile={profile} />;

    case 'external':
      return <ExternalLoginForm profile={profile} onSuccess={handleAuthSuccess} />;

    default:
      return <TokenLoginForm profile={profile} onSuccess={handleAuthSuccess} />;
  }
}
