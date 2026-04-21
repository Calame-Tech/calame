import { useState, useEffect } from 'react';

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

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="bg-gray-800 rounded-lg p-8 max-w-md text-center">
          <div className="text-red-400 text-4xl mb-4">!</div>
          <h1 className="text-xl font-bold text-white mb-2">Invalid Link</h1>
          <p className="text-gray-400">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { user } = data;

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="bg-gray-800 rounded-lg shadow-xl p-8 w-full max-w-2xl">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-white">
            Welcome, {user.name}
          </h1>
        </div>

        {/* Profile access list */}
        <div className="bg-gray-700/50 rounded-lg p-4 mb-6">
          <h2 className="text-white font-medium mb-2">Your Access</h2>
          <div className="space-y-2">
            {user.profiles.map((p) => (
              <div key={p.profileName} className="flex items-center justify-between bg-gray-800/60 rounded px-3 py-2">
                <div>
                  <span className="text-blue-400 font-medium">{p.profileName}</span>
                  <span className="text-xs text-gray-500 ml-2">
                    ({p.accessMode === 'both' ? 'MCP + Chat' : p.accessMode === 'mcp' ? 'MCP only' : 'Chat only'})
                  </span>
                </div>
                {p.tables.length > 0 && (
                  <span className="text-xs text-gray-500">{p.tables.length} table{p.tables.length > 1 ? 's' : ''}</span>
                )}
              </div>
            ))}
          </div>
        </div>

        {!activated ? (
          <div className="bg-gray-700/50 rounded-lg p-6">
            <h2 className="text-white font-medium mb-4 text-center">Set up your account</h2>
            <div className="max-w-sm mx-auto space-y-4">
              <div>
                <label className="block text-sm text-gray-300 mb-1">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-4 py-2 bg-gray-800 border border-gray-600 rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Minimum 8 characters"
                  minLength={8}
                />
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Confirm password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-4 py-2 bg-gray-800 border border-gray-600 rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Repeat your password"
                />
              </div>
              {passwordError && (
                <p className="text-red-400 text-sm">{passwordError}</p>
              )}
              <button
                onClick={handleActivate}
                disabled={!password || !confirmPassword}
                className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium rounded-md transition-colors"
              >
                Activate My Account
              </button>
              <p className="text-gray-500 text-xs text-center">
                You will receive your MCP access token after activation.
              </p>
            </div>
          </div>
        ) : activateResult && (
          <div className="space-y-4">
            {/* Token display */}
            <div className="bg-green-900/30 border border-green-700 rounded-lg p-4">
              <h3 className="text-green-300 font-medium mb-2">Your Access Token</h3>
              <p className="text-gray-400 text-sm mb-2">
                Copy this token now — it will not be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-gray-900 px-3 py-2 rounded text-green-300 text-sm font-mono break-all">
                  {activateResult.plaintextToken}
                </code>
                <button
                  onClick={() => copyToClipboard(activateResult.plaintextToken, 'token')}
                  className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded transition-colors"
                >
                  {copied === 'token' ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>

            {/* MCP endpoints */}
            {activateResult.mcpUrls.length > 0 && (
              <div className="bg-gray-700/50 rounded-lg p-4">
                <h3 className="text-white font-medium mb-2">MCP Endpoints</h3>
                <div className="space-y-2">
                  {activateResult.mcpUrls.map((m) => (
                    <div key={m.profileName} className="flex items-center gap-2">
                      <span className="text-blue-400 text-sm font-medium w-24 flex-shrink-0">{m.profileName}</span>
                      <code className="flex-1 bg-gray-900 px-2 py-1.5 rounded text-blue-300 text-xs font-mono break-all">
                        {m.url}
                      </code>
                      <button
                        onClick={() => copyToClipboard(m.url, m.profileName)}
                        className="px-2 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs rounded transition-colors flex-shrink-0"
                      >
                        {copied === m.profileName ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Config snippets */}
            {activateResult.mcpUrls.length > 0 && (
              <div className="bg-gray-700/50 rounded-lg p-4">
                <h3 className="text-white font-medium mb-2">Configuration</h3>
                <p className="text-gray-400 text-sm mb-3">
                  Add this to your MCP client configuration:
                </p>
                <pre className="bg-gray-900 p-3 rounded text-xs text-gray-300 overflow-x-auto">
{JSON.stringify({
  mcpServers: Object.fromEntries(
    activateResult.mcpUrls.map((m) => [
      m.profileName,
      {
        url: m.url,
        headers: { Authorization: `Bearer ${activateResult.plaintextToken}` },
      },
    ]),
  ),
}, null, 2)}
                </pre>
              </div>
            )}

            {/* Link to account */}
            <div className="text-center pt-2">
              <a
                href="/login"
                className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors inline-block"
              >
                Go to My Account
              </a>
              <p className="text-gray-500 text-xs mt-2">
                You can always sign in later with your email and password.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
