import * as jose from 'jose';

export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string;
  groupClaim: string;
  groupToProfile: Record<string, string>;
  autoCreateUsers: boolean;
  /** Map SSO token claims to user customAttributes for data scoping. */
  claimsToAttributes?: Record<string, string>;
}

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

export class OidcProvider {
  private config: OidcConfig;
  private discovery: OidcDiscovery | null = null;
  private jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;

  constructor(config: OidcConfig) {
    this.config = config;
  }

  /** Fetch OIDC discovery document from issuer */
  async discover(): Promise<OidcDiscovery> {
    if (this.discovery) return this.discovery;
    const url = `${this.config.issuerUrl}/.well-known/openid-configuration`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
    this.discovery = (await res.json()) as OidcDiscovery;
    return this.discovery;
  }

  /** Build the authorization URL with PKCE */
  async getAuthorizationUrl(state: string, codeVerifier: string): Promise<string> {
    const disc = await this.discover();
    const codeChallenge = await this.generateCodeChallenge(codeVerifier);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${disc.authorization_endpoint}?${params.toString()}`;
  }

  /** Exchange authorization code for tokens */
  async exchangeCode(
    code: string,
    codeVerifier: string,
  ): Promise<{ idToken: string; accessToken: string }> {
    const disc = await this.discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: codeVerifier,
    });
    if (this.config.clientSecret) {
      body.set('client_secret', this.config.clientSecret);
    }
    const res = await fetch(disc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
    const data = (await res.json()) as { id_token: string; access_token: string };
    return { idToken: data.id_token, accessToken: data.access_token };
  }

  /** Verify and decode the ID token */
  async verifyIdToken(idToken: string): Promise<jose.JWTPayload> {
    const disc = await this.discover();
    if (!this.jwks) {
      this.jwks = jose.createRemoteJWKSet(new URL(disc.jwks_uri));
    }
    const { payload } = await jose.jwtVerify(idToken, this.jwks, {
      issuer: disc.issuer,
      audience: this.config.clientId,
    });
    return payload;
  }

  /** Extract groups from token claims */
  getGroups(payload: jose.JWTPayload): string[] {
    const groups = payload[this.config.groupClaim];
    if (Array.isArray(groups)) return groups as string[];
    if (typeof groups === 'string') return [groups];
    return [];
  }

  /** Return the group-to-profile mapping for IdP scope computation. */
  getGroupToProfile(): Record<string, string> {
    return this.config.groupToProfile;
  }

  /** Map SSO groups to Calame profile names (case-insensitive key comparison) */
  mapGroupsToProfiles(groups: string[]): string[] {
    const lowercaseMap = Object.entries(this.config.groupToProfile).reduce<Record<string, string>>(
      (acc, [k, v]) => {
        acc[k.toLowerCase()] = v;
        return acc;
      },
      {},
    );
    return groups
      .map((g) => lowercaseMap[g.toLowerCase()])
      .filter((p): p is string => !!p);
  }

  /**
   * Extract custom attributes from token claims using the claimsToAttributes mapping.
   * Returns null if no mapping is configured or no claims match.
   */
  extractCustomAttributes(payload: jose.JWTPayload): Record<string, string> | null {
    if (!this.config.claimsToAttributes) return null;
    const attrs: Record<string, string> = {};
    let hasAny = false;
    for (const [claimName, attrKey] of Object.entries(this.config.claimsToAttributes)) {
      const value = payload[claimName];
      if (value !== undefined && value !== null) {
        attrs[attrKey] = String(value);
        hasAny = true;
      }
    }
    return hasAny ? attrs : null;
  }

  /** Generate PKCE code verifier (random string) */
  generateCodeVerifier(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Buffer.from(array).toString('base64url');
  }

  /** Generate S256 code challenge from verifier */
  private async generateCodeChallenge(verifier: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return Buffer.from(digest).toString('base64url');
  }
}
