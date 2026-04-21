import { describe, it, expect } from 'vitest';
import { OidcProvider } from '../oidc.js';
import type { OidcConfig } from '../oidc.js';

const baseConfig: OidcConfig = {
  issuerUrl: 'https://sso.example.com',
  clientId: 'test-client-id',
  clientSecret: 'test-secret',
  redirectUri: 'http://localhost:4567/api/auth/oidc/callback',
  scopes: 'openid profile email',
  groupClaim: 'groups',
  groupToProfile: {
    'engineering': 'dev',
    'finance': 'finance-profile',
  },
  autoCreateUsers: true,
};

describe('OidcProvider', () => {
  describe('constructor', () => {
    it('should construct without throwing', () => {
      expect(() => new OidcProvider(baseConfig)).not.toThrow();
    });

    it('should construct with minimal config (no clientSecret)', () => {
      const cfg: OidcConfig = { ...baseConfig, clientSecret: undefined };
      expect(() => new OidcProvider(cfg)).not.toThrow();
    });
  });

  describe('generateCodeVerifier', () => {
    it('should return a non-empty string', () => {
      const provider = new OidcProvider(baseConfig);
      const verifier = provider.generateCodeVerifier();
      expect(typeof verifier).toBe('string');
      expect(verifier.length).toBeGreaterThan(0);
    });

    it('should return a base64url-encoded string (no padding, no +/)', () => {
      const provider = new OidcProvider(baseConfig);
      const verifier = provider.generateCodeVerifier();
      // base64url must not contain +, /, or =
      expect(verifier).not.toMatch(/[+/=]/);
    });

    it('should return a different verifier each time', () => {
      const provider = new OidcProvider(baseConfig);
      const v1 = provider.generateCodeVerifier();
      const v2 = provider.generateCodeVerifier();
      expect(v1).not.toBe(v2);
    });

    it('should return a verifier of sufficient length (>= 40 chars)', () => {
      const provider = new OidcProvider(baseConfig);
      const verifier = provider.generateCodeVerifier();
      // 32 random bytes -> base64url ~= 43 chars
      expect(verifier.length).toBeGreaterThanOrEqual(40);
    });
  });

  describe('getGroups', () => {
    const provider = new OidcProvider(baseConfig);

    it('should return an array when groups claim is an array', () => {
      const payload = { sub: 'u1', groups: ['engineering', 'finance'] };
      expect(provider.getGroups(payload)).toEqual(['engineering', 'finance']);
    });

    it('should return a single-element array when groups claim is a string', () => {
      const payload = { sub: 'u1', groups: 'engineering' };
      expect(provider.getGroups(payload)).toEqual(['engineering']);
    });

    it('should return an empty array when groups claim is missing', () => {
      const payload = { sub: 'u1' };
      expect(provider.getGroups(payload)).toEqual([]);
    });

    it('should return an empty array when groups claim is a number', () => {
      const payload = { sub: 'u1', groups: 42 };
      expect(provider.getGroups(payload)).toEqual([]);
    });

    it('should use the configured groupClaim key', () => {
      const customProvider = new OidcProvider({ ...baseConfig, groupClaim: 'roles' });
      const payload = { sub: 'u1', roles: ['admin'], groups: ['other'] };
      expect(customProvider.getGroups(payload)).toEqual(['admin']);
    });
  });

  describe('mapGroupsToProfiles', () => {
    const provider = new OidcProvider(baseConfig);

    it('should map known groups to profile names', () => {
      const profiles = provider.mapGroupsToProfiles(['engineering', 'finance']);
      expect(profiles).toEqual(['dev', 'finance-profile']);
    });

    it('should ignore unknown groups', () => {
      const profiles = provider.mapGroupsToProfiles(['engineering', 'unknown-group']);
      expect(profiles).toEqual(['dev']);
    });

    it('should return empty array when no groups match', () => {
      const profiles = provider.mapGroupsToProfiles(['no-match', 'also-no-match']);
      expect(profiles).toEqual([]);
    });

    it('should return empty array for empty input', () => {
      const profiles = provider.mapGroupsToProfiles([]);
      expect(profiles).toEqual([]);
    });

    it('should return empty array when groupToProfile mapping is empty', () => {
      const emptyProvider = new OidcProvider({ ...baseConfig, groupToProfile: {} });
      expect(emptyProvider.mapGroupsToProfiles(['engineering'])).toEqual([]);
    });

    it('should map groups case-insensitively (different case in JWT vs config)', () => {
      const provider = new OidcProvider({ ...baseConfig, groupToProfile: { 'engineering': 'dev' } });
      const profiles = provider.mapGroupsToProfiles(['Engineering']);
      expect(profiles).toEqual(['dev']);
    });

    it('should map groups case-insensitively (mixed case both sides)', () => {
      const provider = new OidcProvider({ ...baseConfig, groupToProfile: { 'Comptabilite': 'finance' } });
      const profiles = provider.mapGroupsToProfiles(['comptabilite']);
      expect(profiles).toEqual(['finance']);
    });
  });
});
