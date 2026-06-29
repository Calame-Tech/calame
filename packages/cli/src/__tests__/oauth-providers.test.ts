import { describe, it, expect } from 'vitest';
import { getOAuthProvider, OAUTH_PROVIDERS } from '../oauth-providers.js';

describe('OAUTH_PROVIDERS', () => {
  it('contains entries for github, google, and gitlab', () => {
    expect(Object.keys(OAUTH_PROVIDERS)).toEqual(
      expect.arrayContaining(['github', 'google', 'gitlab']),
    );
  });

  it('each provider has the required fields', () => {
    for (const [, cfg] of Object.entries(OAUTH_PROVIDERS)) {
      expect(cfg.name).toBeTruthy();
      expect(cfg.authorizationUrl).toMatch(/^https?:\/\//);
      expect(cfg.tokenUrl).toMatch(/^https?:\/\//);
      expect(cfg.userinfoUrl).toMatch(/^https?:\/\//);
      expect(cfg.scopes).toBeTruthy();
      expect(cfg.userIdField).toBeTruthy();
      expect(cfg.emailField).toBeTruthy();
      expect(cfg.nameField).toBeTruthy();
    }
  });
});

describe('getOAuthProvider', () => {
  describe('github', () => {
    it('returns the GitHub config', () => {
      const cfg = getOAuthProvider('github');
      expect(cfg.name).toBe('GitHub');
      expect(cfg.authorizationUrl).toBe('https://github.com/login/oauth/authorize');
      expect(cfg.tokenUrl).toBe('https://github.com/login/oauth/access_token');
      expect(cfg.userinfoUrl).toBe('https://api.github.com/user');
      expect(cfg.userIdField).toBe('id');
      expect(cfg.emailField).toBe('email');
      expect(cfg.nameField).toBe('name');
    });

    it('does not mutate the shared constant when URLs are overridden', () => {
      const original = OAUTH_PROVIDERS['github'].authorizationUrl;
      getOAuthProvider('github', {
        authorizationUrl: 'https://github.example.com/login/oauth/authorize',
      });
      expect(OAUTH_PROVIDERS['github'].authorizationUrl).toBe(original);
    });
  });

  describe('google', () => {
    it('returns the Google config', () => {
      const cfg = getOAuthProvider('google');
      expect(cfg.name).toBe('Google');
      expect(cfg.authorizationUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(cfg.tokenUrl).toBe('https://oauth2.googleapis.com/token');
      expect(cfg.userinfoUrl).toBe('https://www.googleapis.com/oauth2/v3/userinfo');
      expect(cfg.userIdField).toBe('sub');
    });
  });

  describe('gitlab', () => {
    it('returns the GitLab config', () => {
      const cfg = getOAuthProvider('gitlab');
      expect(cfg.name).toBe('GitLab');
      expect(cfg.authorizationUrl).toBe('https://gitlab.com/oauth/authorize');
      expect(cfg.tokenUrl).toBe('https://gitlab.com/oauth/token');
      expect(cfg.userinfoUrl).toBe('https://gitlab.com/api/v4/user');
    });

    it('allows overriding URLs for self-hosted GitLab', () => {
      const cfg = getOAuthProvider('gitlab', {
        authorizationUrl: 'https://gitlab.example.com/oauth/authorize',
        tokenUrl: 'https://gitlab.example.com/oauth/token',
        userinfoUrl: 'https://gitlab.example.com/api/v4/user',
      });
      expect(cfg.authorizationUrl).toBe('https://gitlab.example.com/oauth/authorize');
      expect(cfg.tokenUrl).toBe('https://gitlab.example.com/oauth/token');
      expect(cfg.userinfoUrl).toBe('https://gitlab.example.com/api/v4/user');
      // Non-overridden fields remain from the base config
      expect(cfg.userIdField).toBe('id');
    });

    it('allows partial URL overrides', () => {
      const cfg = getOAuthProvider('gitlab', {
        authorizationUrl: 'https://gitlab.example.com/oauth/authorize',
      });
      expect(cfg.authorizationUrl).toBe('https://gitlab.example.com/oauth/authorize');
      // Non-overridden fields keep defaults
      expect(cfg.tokenUrl).toBe('https://gitlab.com/oauth/token');
    });
  });

  describe('custom provider', () => {
    it('returns a custom provider config when all URLs are provided', () => {
      const cfg = getOAuthProvider('custom', {
        authorizationUrl: 'https://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
        userinfoUrl: 'https://auth.example.com/userinfo',
      });
      expect(cfg.name).toBe('Custom');
      expect(cfg.authorizationUrl).toBe('https://auth.example.com/authorize');
      expect(cfg.tokenUrl).toBe('https://auth.example.com/token');
      expect(cfg.userinfoUrl).toBe('https://auth.example.com/userinfo');
      expect(cfg.userIdField).toBe('sub');
      expect(cfg.emailField).toBe('email');
      expect(cfg.nameField).toBe('name');
    });

    it('throws when authorizationUrl is missing', () => {
      expect(() =>
        getOAuthProvider('custom', {
          tokenUrl: 'https://auth.example.com/token',
          userinfoUrl: 'https://auth.example.com/userinfo',
        }),
      ).toThrow('Custom OAuth provider requires authorizationUrl, tokenUrl, and userinfoUrl');
    });

    it('throws when tokenUrl is missing', () => {
      expect(() =>
        getOAuthProvider('custom', {
          authorizationUrl: 'https://auth.example.com/authorize',
          userinfoUrl: 'https://auth.example.com/userinfo',
        }),
      ).toThrow('Custom OAuth provider requires authorizationUrl, tokenUrl, and userinfoUrl');
    });

    it('throws when userinfoUrl is missing', () => {
      expect(() =>
        getOAuthProvider('custom', {
          authorizationUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
        }),
      ).toThrow('Custom OAuth provider requires authorizationUrl, tokenUrl, and userinfoUrl');
    });

    it('throws when called with no custom config', () => {
      expect(() => getOAuthProvider('custom')).toThrow(
        'Custom OAuth provider requires authorizationUrl, tokenUrl, and userinfoUrl',
      );
    });
  });

  describe('unknown provider', () => {
    it('throws for an unrecognized provider name', () => {
      expect(() => getOAuthProvider('bitbucket')).toThrow('Unknown OAuth provider: bitbucket');
    });

    it('throws for an empty string provider', () => {
      expect(() => getOAuthProvider('')).toThrow('Unknown OAuth provider: ');
    });
  });
});
