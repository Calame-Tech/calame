// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Chat-page SSO login screen — rendered when a profile has authMode === 'sso'.
 *
 * Kept generic on the profile shape (only `name` and `label` are used) so this
 * BUSL component does not have to import host types.
 */
interface ChatSsoLoginProps {
  profile: { name: string; label?: string };
}

export default function ChatSsoLogin({ profile }: ChatSsoLoginProps) {
  const redirectUrl = `/chat/${encodeURIComponent(profile.name)}`;

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="card-primary max-w-md w-full p-8 text-center">
        <img src="/logo.png" alt="Calame" className="h-8 w-8 object-contain mb-4 mx-auto" />
        <h1 className="text-xl font-semibold text-gray-100 mb-1">
          {profile.label || profile.name}
        </h1>
        <p className="text-sm text-gray-500 mb-8">Sign in with your company account.</p>

        <a
          href={`/api/auth/oidc/login?redirect=${encodeURIComponent(redirectUrl)}`}
          className="inline-flex items-center justify-center w-full py-2.5 px-4 rounded-lg bg-os-700 hover:bg-os-600 text-sm font-medium text-white transition-colors focus:outline-none focus:ring-2 focus:ring-os-500"
        >
          Sign in with SSO
        </a>
      </div>
    </div>
  );
}
