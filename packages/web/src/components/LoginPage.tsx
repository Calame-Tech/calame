import { useEffect, useState, lazy, Suspense } from 'react';
import { useTranslations } from 'use-intl/react';
import { apiFetch } from '../lib/api.js';
import { useBranding, DEFAULT_LOGO_SRC } from '../lib/branding.js';

/**
 * Lazy-loaded SSO login button. Deferred so the Apache bundle never statically
 * imports the BUSL chunk. Renders nothing when the ee package is absent.
 */
const SsoLoginButton = lazy(() =>
  import('@calame-ee/sso/web')
    .then((m) => ({ default: m.SsoLoginButton }))
    .catch(() => ({
      // The real component self-hides when OIDC is not configured; the
      // fallback matches that contract. Returns a Fragment (not `null`)
      // so the type matches React.lazy's expected ComponentType.
      default: function SsoLoginButtonUnavailable() {
        return <></>;
      },
    })),
);

/** Read-only facts from GET /api/auth/recovery-help (null until loaded). */
interface RecoveryHelp {
  desktop: boolean;
  dataDirLabel: string | null;
}

/**
 * "Forgotten admin account" help. Purely informational: there is no reset
 * action here (native or HTTP). The folder path comes from the server, and is
 * only shown for the packaged desktop app, along with its tray-only native
 * reset (apps/desktop/src-tauri/src/recovery.rs, which leaves a custom
 * CALAME_DATA_DIR alone); any other deployment gets generic help.
 */
function RecoveryHelpPanel({ onClose }: { onClose: () => void }) {
  const t = useTranslations('setupLogin.loginPage.recovery');
  const [help, setHelp] = useState<RecoveryHelp | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/auth/recovery-help')
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((data: (RecoveryHelp & { success?: boolean }) | null) => {
        if (cancelled) return;
        setHelp({
          desktop: data?.desktop === true,
          dataDirLabel: typeof data?.dataDirLabel === 'string' ? data.dataDirLabel : null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section
      aria-labelledby="login-recovery-title"
      className="mt-6 rounded-lg border border-gray-700 bg-gray-900/60 p-4 text-sm text-gray-300 space-y-3"
    >
      <h2 id="login-recovery-title" className="text-base font-medium text-gray-100">
        {t('title')}
      </h2>
      <p>{t('intro')}</p>
      {!help ? (
        <p>{t('loading')}</p>
      ) : help.desktop ? (
        <>
          {help.dataDirLabel ? (
            <p>
              {t('desktopFolder')}{' '}
              <code className="break-all rounded bg-gray-800 px-1 py-0.5 text-gray-100">
                {help.dataDirLabel}
              </code>
            </p>
          ) : (
            <p>{t('desktopFolderCustom')}</p>
          )}
          {help.dataDirLabel && <p>{t('desktopTray')}</p>}
          <p className="font-medium text-gray-200">{t('desktopStepsTitle')}</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>{t('desktopStep1')}</li>
            <li>{t('desktopStep2')}</li>
            <li>{t('desktopStep3')}</li>
            <li>{t('desktopStep4')}</li>
          </ol>
        </>
      ) : (
        <>
          <p>{t('serverText')}</p>
          <p className="font-medium text-gray-200">{t('serverStepsTitle')}</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>{t('serverStep1')}</li>
            <li>{t('serverStep2')}</li>
            <li>{t('serverStep3')}</li>
          </ol>
        </>
      )}
      <p className="text-amber-300">{t('losses')}</p>
      <button type="button" onClick={onClose} className="text-os-400 hover:text-os-300 underline">
        {t('close')}
      </button>
    </section>
  );
}

interface LoginPageProps {
  onAdminLogin: () => void;
  onUserLogin: () => void;
}

export default function LoginPage({ onAdminLogin, onUserLogin }: LoginPageProps) {
  const t = useTranslations('setupLogin.loginPage');
  const branding = useBranding();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);

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

        setError(userData.message || t('errors.invalidCredentials'));
        return;
      }

      setError(adminData.message || t('errors.invalidCredentials'));
    } catch {
      setError(t('errors.connectionError'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="card-primary p-6 w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-3 mb-2">
            <img
              src={branding.logo || DEFAULT_LOGO_SRC}
              alt="Calame"
              className="h-10 w-10 object-contain"
            />
            <h1 className="heading-lg">Calame</h1>
          </div>
          <p className="text-gray-400 mt-2">{t('subtitle')}</p>
        </div>

        {/* SSO button — self-hides when OIDC is not configured */}
        <Suspense fallback={null}>
          <SsoLoginButton />
        </Suspense>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-300 mb-1">
              {t('form.emailLabel')} <span className="text-red-400">*</span>
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input-editorial w-full"
              placeholder={t('form.emailPlaceholder')}
              autoFocus
              required
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-300 mb-1">
              {t('form.passwordLabel')} <span className="text-red-400">*</span>
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-editorial w-full"
              placeholder={t('form.passwordPlaceholder')}
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
            {loading ? t('form.submitLoading') : t('form.submitButton')}
          </button>
        </form>

        {showRecovery ? (
          <RecoveryHelpPanel onClose={() => setShowRecovery(false)} />
        ) : (
          <div className="mt-4 text-center">
            <button
              type="button"
              onClick={() => setShowRecovery(true)}
              className="text-sm text-os-400 hover:text-os-300 underline"
            >
              {t('recovery.toggle')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
