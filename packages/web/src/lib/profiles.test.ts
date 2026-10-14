import { describe, it, expect } from 'vitest';
import {
  buildProfilesData,
  createNewProfile,
  NEW_MCP_DEFAULTS,
  slugifyProfileName,
} from './profiles.js';

// The backend chat/auth routes reject any profile name not matching
// /^[a-zA-Z0-9_-]+$/ — every slug produced here must satisfy that.
describe('slugifyProfileName', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugifyProfileName('Profile Test')).toBe('profile-test');
  });

  it('handles the onboarding placeholder', () => {
    expect(slugifyProfileName('My first profile')).toBe('my-first-profile');
  });

  it('strips characters the backend rejects', () => {
    // Stripped chars can leave consecutive hyphens — still backend-valid.
    expect(slugifyProfileName('Café & Co. #1')).toBe('caf--co-1');
  });

  it('trims surrounding whitespace before hyphenating', () => {
    expect(slugifyProfileName('  padded name  ')).toBe('padded-name');
  });

  it('collapses consecutive whitespace into a single hyphen', () => {
    expect(slugifyProfileName('a   b\tc')).toBe('a-b-c');
  });

  it('keeps already-valid slugs unchanged', () => {
    expect(slugifyProfileName('my-profile-2')).toBe('my-profile-2');
  });

  it('returns an empty string when nothing survives (caller must reject)', () => {
    expect(slugifyProfileName('***')).toBe('');
    expect(slugifyProfileName('   ')).toBe('');
  });

  it('always produces a backend-valid name for non-empty results', () => {
    for (const input of ['Profile Test', 'Été 2026 !', 'a_b c', 'ALL CAPS']) {
      const slug = slugifyProfileName(input);
      if (slug) expect(slug).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });
});

describe('new MCP defaults', () => {
  it('never starts open, writable or technical', () => {
    expect(NEW_MCP_DEFAULTS.authMode).toBe('token');
    expect(NEW_MCP_DEFAULTS.responseMode).toBe('friendly');
    expect(NEW_MCP_DEFAULTS.documentWrite.enabled).toBe(false);
  });

  it('builds a new profile carrying the defaults explicitly', () => {
    expect(createNewProfile('first', 'First')).toEqual({
      name: 'first',
      label: 'First',
      authMode: 'token',
      responseMode: 'friendly',
      documentWrite: { enabled: false, sources: {} },
    });
  });

  it('persists the defaults and nothing that would replace masking or scoping', () => {
    const data = buildProfilesData([createNewProfile('first', 'First')]).first;
    expect(data.authMode).toBe('token');
    expect(data.responseMode).toBe('friendly');
    expect(data.documentWrite).toEqual({ enabled: false, sources: {} });
    // Undefined fields are stripped by /api/profiles/save before merging, so
    // they never overwrite stored values.
    expect(data.dataScopeRules).toBeUndefined();
    expect(data.oauthConfig).toBeUndefined();
    expect(data.externalAuthConfig).toBeUndefined();
  });

  it('returns a fresh documentWrite object per profile', () => {
    const a = createNewProfile('a', 'A');
    const b = createNewProfile('b', 'B');
    expect(a.documentWrite).not.toBe(b.documentWrite);
  });
});
