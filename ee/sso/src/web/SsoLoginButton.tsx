// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { useState, useEffect } from 'react';

/**
 * SSO sign-in button for the global login page.
 *
 * Self-contained: queries `/api/auth/oidc/config` to decide whether to render.
 * Returns `null` when OIDC is not configured, so callers can drop it into the
 * login layout unconditionally.
 */
export default function SsoLoginButton() {
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

  if (!oidcEnabled) return null;

  return (
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
          <div className="w-full border-t border-white/5" />
        </div>
        <div className="relative flex justify-center text-sm">
          <span className="px-2 bg-gray-900/40 text-gray-500">or sign in with email</span>
        </div>
      </div>
    </div>
  );
}
