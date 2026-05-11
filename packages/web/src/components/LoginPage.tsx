import { useState } from 'react';
import { apiFetch } from '../lib/api.js';
import { SsoLoginButton } from '@calame-ee/sso/web';

interface LoginPageProps {
  onAdminLogin: () => void;
  onUserLogin: () => void;
}

export default function LoginPage({ onAdminLogin, onUserLogin }: LoginPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // Try admin login first
      const adminRes = await apiFetch('/api/auth/login', {
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
        const userRes = await apiFetch('/api/auth/user-login', {
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
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="card-primary p-6 w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-3 mb-2">
            <img src="/logo.png" alt="Calame" className="h-10 w-10 object-contain" />
            <h1 className="heading-lg">Calame</h1>
          </div>
          <p className="text-gray-400 mt-2">Sign in to your account</p>
        </div>

        {/* SSO button — self-hides when OIDC is not configured */}
        <SsoLoginButton />

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
              className="input-editorial w-full"
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
              className="input-editorial w-full"
              placeholder="Enter your password"
              required
            />
          </div>

          {error && (
            <div className="bg-red-950/30 border border-red-800/50 rounded-lg p-3 text-red-400 text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !email || !password}
            className="w-full py-2 px-4 bg-os-700 hover:bg-os-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
