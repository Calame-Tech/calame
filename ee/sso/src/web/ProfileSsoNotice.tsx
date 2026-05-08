// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Inline notice rendered on the profile editor when the selected authMode is 'sso'.
 * Reminds the admin that this profile relies on the global OIDC configuration.
 */
export default function ProfileSsoNotice() {
  return (
    <p className="mt-2 text-xs text-gray-500">
      Uses the global OIDC/SSO configuration from Settings. Make sure OIDC is configured.
    </p>
  );
}
