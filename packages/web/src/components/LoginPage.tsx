import { useState, useEffect } from 'react';

interface LoginPageProps {
  onAdminLogin: () => void;
  onUserLogin: () => void;
}

export default function LoginPage({ onAdminLogin, onUserLogin }: LoginPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [oidcProviderName, setOidcProviderName] = useState('');

  useEffect(() => {
    fetch('/api/auth/oidc/config')
      .then((r) => r.json())
      .then((data: { enabled?: boolean; providerName?: string }) => {
        if (data.enabled) {
          setOidcEnabled(true);
          setOidcProviderName(data.providerName || 'SSO');
        }
      })
      .catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // Try admin login first
      const adminRes = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      const adminData = await adminRes.json();

      if (adminData.success) {
        onAdminLogin();
        return;
      }

      // If not admin (403), try user login
      if (adminRes.status === 403 || adminRes.status === 401) {
        const userRes = await fetch('/api/auth/user-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, password }),
        });
        const userData = await userRes.json();

        if (userData.success) {
          onUserLogin();
          return;
        }

        setError(userData.message || 'Invalid email or password.');
        return;
      }

      setError(adminData.message || 'Invalid email or password.');
    } catch {
      setError('Connection error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center">
      <div className="bg-gray-800 rounded-lg shadow-xl p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-3 mb-2">
            <img src="/logo.png" alt="Calame" className="h-10 w-10 object-contain" />
            <h1 className="text-3xl font-bold text-gray-100">Calame</h1>
          </div>
          <p className="text-gray-400 mt-2">Sign in to your account</p>
        </div>

        {/* SSO button — shown only when OIDC is configured */}
        {oidcEnabled && (
          <div className="mb-6">
            <a
              href="/api/auth/oidc/login"
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-os-700 hover:bg-os-600 text-white font-medium transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-os-500"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"
                />
              </svg>
              Sign in with {oidcProviderName}
            </a>

            <div className="relative my-4">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-700" />
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-2 bg-gray-800 text-gray-500">or sign in with email</span>
              </div>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-300 mb-1">
              Email <span className="text-red-400">*</span>
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-os-500 focus:border-transparent"
              placeholder="your@email.com"
              autoFocus
              required
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-300 mb-1">
              Password <span className="text-red-400">*</span>
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-os-500 focus:border-transparent"
              placeholder="Enter your password"
              required
            />
          </div>

          {error && (
            <div className="bg-red-900/50 border border-red-700 rounded-md p-3 text-red-300 text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !email || !password}
            className="w-full py-2 px-4 bg-os-700 hover:bg-os-600 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium rounded-md transition-colors"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
