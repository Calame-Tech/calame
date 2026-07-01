import { describe, it, expect } from 'vitest';
import { slugifyProfileName } from './profiles.js';

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
