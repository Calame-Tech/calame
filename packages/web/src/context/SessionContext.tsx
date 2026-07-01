// Session / auth context (Phase 3 #15). Owns the admin+user authentication
// state, the RAG availability flags (from /health), the onboarding flag and the
// `dataVersion` refresh counter — everything the old App god-component tracked
// as top-level auth state. Extracting it into a provider lets the per-domain
// pages (#14) read session state via `useSession()` instead of prop-drilling.

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { apiFetch } from '../lib/api.js';
import { resolveLocationRoutes } from '../router/index.js';

/** Logged-in admin user info (email + role) shown in the Sidebar footer. */
export interface SessionUser {
  email: string;
  role: string;
}

/** Everything exposed by {@link useSession}. */
export interface SessionState {
  /** True once the initial auth/health probe has resolved. */
  authChecked: boolean;
  /** Admin authenticated. */
  authenticated: boolean;
  /** Whether the backend requires admin auth at all. */
  authRequired: boolean;
  /** First-run: no admin account exists yet. */
  needsSetup: boolean;
  /** Show the onboarding wizard. */
  showOnboarding: boolean;
  /** End-user (non-admin) authenticated — for /account and /login. */
  userAuthenticated: boolean;
  /** Admin user info for the Sidebar footer (null until known). */
  currentUser: SessionUser | null;
  /** RAG runtime available on this instance (from /health). */
  ragEnabled: boolean;
  /** Human-readable reason when RAG is unavailable (null when enabled). */
  ragDisabledReason: string | null;
  /** Bumped to force a data reload across the app. */
  dataVersion: number;
  setAuthenticated: Dispatch<SetStateAction<boolean>>;
  setAuthRequired: Dispatch<SetStateAction<boolean>>;
  setNeedsSetup: Dispatch<SetStateAction<boolean>>;
  setShowOnboarding: Dispatch<SetStateAction<boolean>>;
  setUserAuthenticated: Dispatch<SetStateAction<boolean>>;
  /** Increment `dataVersion` to trigger a global reload. */
  bumpDataVersion: () => void;
  /** POST /api/auth/logout then clear the admin session. */
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

/**
 * Provides {@link SessionState}. Runs the mount-time auth + health probe once,
 * skipping it on the URL-driven public pages (/welcome, /chat) which handle
 * their own auth.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [ragEnabled, setRagEnabled] = useState(false);
  const [ragDisabledReason, setRagDisabledReason] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);
  const [userAuthenticated, setUserAuthenticated] = useState(false);
  const [currentUser, setCurrentUser] = useState<SessionUser | null>(null);

  // Check auth status on mount.
  useEffect(() => {
    const { welcomeMatch, chatMatch } = resolveLocationRoutes();
    if (welcomeMatch || chatMatch) {
      setAuthChecked(true);
      return;
    }
    (async () => {
      try {
        // Always check both admin and user auth status and health (for ragEnabled).
        const [adminRes, userRes, healthRes] = await Promise.all([
          apiFetch('/api/auth/status', { credentials: 'include' }),
          apiFetch('/api/auth/user-status', { credentials: 'include' }),
          apiFetch('/health').catch(() => null),
        ]);

        if (healthRes?.ok) {
          try {
            const healthData = (await healthRes.json()) as {
              ragEnabled?: boolean;
              ragDisabledReason?: string | null;
            };
            setRagEnabled(healthData.ragEnabled === true);
            setRagDisabledReason(healthData.ragDisabledReason ?? null);
          } catch {
            // Ignore parse errors — ragEnabled stays false.
          }
        }
        const adminData = await adminRes.json();
        const userData = await userRes.json();

        if (adminData.success) {
          setAuthenticated(adminData.authenticated);
          setAuthRequired(adminData.authRequired);
          setNeedsSetup(!!adminData.needsSetup);
        }
        if (userData.success) {
          setUserAuthenticated(userData.authenticated);
          // Populate the Sidebar user info when the admin is authenticated
          if (userData.authenticated && userData.user) {
            const u = userData.user as { email?: string; role?: string };
            setCurrentUser({
              email: u.email ?? '',
              role: u.role ?? 'admin',
            });
          }
        }
      } catch {
        // Network error — keep defaults (not authenticated)
      } finally {
        setAuthChecked(true);
      }
    })();
  }, []);

  const bumpDataVersion = useCallback(() => setDataVersion((v) => v + 1), []);

  /** Logout handler — POST then clear the admin session (Sidebar footer). */
  const logout = useCallback(async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      /* ignore network errors */
    }
    setAuthenticated(false);
  }, []);

  const value: SessionState = {
    authChecked,
    authenticated,
    authRequired,
    needsSetup,
    showOnboarding,
    userAuthenticated,
    currentUser,
    ragEnabled,
    ragDisabledReason,
    dataVersion,
    setAuthenticated,
    setAuthRequired,
    setNeedsSetup,
    setShowOnboarding,
    setUserAuthenticated,
    bumpDataVersion,
    logout,
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Access the session state. Throws when used outside a {@link SessionProvider}. */
export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error('useSession must be used within a SessionProvider');
  }
  return ctx;
}
