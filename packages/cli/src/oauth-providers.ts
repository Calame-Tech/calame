/**
 * Pre-configured OAuth 2.0 provider endpoints for per-profile authentication.
 * Supports GitHub, Google, GitLab (hosted or self-hosted), and fully custom providers.
 */

export interface OAuthProviderConfig {
  name: string;
  authorizationUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scopes: string;
  /** Field in the userinfo response that contains the unique user identifier. */
  userIdField: string;
  /** Field in the userinfo response that contains the email address. */
  emailField: string;
  /** Field in the userinfo response that contains the display name. */
  nameField: string;
}

/** Pre-configured provider definitions for well-known OAuth providers. */
export const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  github: {
    name: 'GitHub',
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userinfoUrl: 'https://api.github.com/user',
    scopes: 'read:user user:email',
    userIdField: 'id',
    emailField: 'email',
    nameField: 'name',
  },
  google: {
    name: 'Google',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userinfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
    scopes: 'openid email profile',
    userIdField: 'sub',
    emailField: 'email',
    nameField: 'name',
  },
  gitlab: {
    name: 'GitLab',
    authorizationUrl: 'https://gitlab.com/oauth/authorize',
    tokenUrl: 'https://gitlab.com/oauth/token',
    userinfoUrl: 'https://gitlab.com/api/v4/user',
    scopes: 'read_user',
    userIdField: 'id',
    emailField: 'email',
    nameField: 'name',
  },
};

/**
 * Resolve a provider config by name, optionally overriding URLs for self-hosted instances.
 *
 * For the `custom` provider, all three URL fields are required.
 * For `gitlab`, individual URLs can be overridden to point to a self-hosted instance.
 * For `github` and `google`, URL overrides are accepted but rarely needed.
 *
 * @throws {Error} When provider is `custom` and required URLs are missing.
 * @throws {Error} When the provider name is not recognized.
 */
export function getOAuthProvider(
  provider: string,
  custom?: {
    authorizationUrl?: string;
    tokenUrl?: string;
    userinfoUrl?: string;
  },
): OAuthProviderConfig {
  if (provider === 'custom') {
    if (!custom?.authorizationUrl || !custom?.tokenUrl || !custom?.userinfoUrl) {
      throw new Error(
        'Custom OAuth provider requires authorizationUrl, tokenUrl, and userinfoUrl',
      );
    }
    return {
      name: 'Custom',
      authorizationUrl: custom.authorizationUrl,
      tokenUrl: custom.tokenUrl,
      userinfoUrl: custom.userinfoUrl,
      scopes: 'openid email profile',
      userIdField: 'sub',
      emailField: 'email',
      nameField: 'name',
    };
  }

  const base = OAUTH_PROVIDERS[provider];
  if (!base) {
    throw new Error(`Unknown OAuth provider: ${provider}`);
  }

  // Clone to avoid mutating the shared constant — allow URL overrides for self-hosted variants.
  const config: OAuthProviderConfig = { ...base };
  if (custom?.authorizationUrl) config.authorizationUrl = custom.authorizationUrl;
  if (custom?.tokenUrl) config.tokenUrl = custom.tokenUrl;
  if (custom?.userinfoUrl) config.userinfoUrl = custom.userinfoUrl;

  return config;
}
