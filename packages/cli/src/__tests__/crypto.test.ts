import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, isEncrypted, hashToken, verifyTokenHash } from '../crypto.js';

describe('encrypt / decrypt', () => {
  const secret = 'my-super-secret-key-for-testing';

  it('round-trips a simple string', () => {
    const plaintext = 'postgresql://user:pass@localhost:5432/mydb';
    const encrypted = encrypt(plaintext, secret);
    const decrypted = decrypt(encrypted, secret);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertexts for the same input (random salt/IV)', () => {
    const plaintext = 'same-input';
    const a = encrypt(plaintext, secret);
    const b = encrypt(plaintext, secret);
    expect(a).not.toBe(b);
  });

  it('handles empty string', () => {
    const encrypted = encrypt('', secret);
    const decrypted = decrypt(encrypted, secret);
    expect(decrypted).toBe('');
  });

  it('handles unicode characters', () => {
    const plaintext = 'mot de passe: café ☕ 日本語';
    const encrypted = encrypt(plaintext, secret);
    const decrypted = decrypt(encrypted, secret);
    expect(decrypted).toBe(plaintext);
  });

  it('fails to decrypt with wrong secret', () => {
    const encrypted = encrypt('secret-data', secret);
    expect(() => decrypt(encrypted, 'wrong-key')).toThrow();
  });

  it('fails to decrypt corrupted data', () => {
    const encrypted = encrypt('data', secret);
    const corrupted = encrypted.slice(0, -4) + 'ffff';
    expect(() => decrypt(corrupted, secret)).toThrow();
  });

  it('throws on invalid format (missing parts)', () => {
    expect(() => decrypt('not:enough:parts', secret)).toThrow('Invalid encrypted value format');
  });
});

describe('isEncrypted', () => {
  const secret = 'test-key';

  it('returns true for encrypted values', () => {
    const encrypted = encrypt('hello', secret);
    expect(isEncrypted(encrypted)).toBe(true);
  });

  it('returns false for plaintext connection strings', () => {
    expect(isEncrypted('postgresql://user:pass@localhost:5432/mydb')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isEncrypted('')).toBe(false);
  });

  it('returns false for values with non-hex characters', () => {
    expect(isEncrypted('ab:cd:ef:zz')).toBe(false);
  });
});

describe('hashToken', () => {
  it('produces a 64-char hex string (SHA-256)', () => {
    const hash = hashToken('fmcp_abc123');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic', () => {
    const a = hashToken('fmcp_test');
    const b = hashToken('fmcp_test');
    expect(a).toBe(b);
  });

  it('produces different hashes for different tokens', () => {
    const a = hashToken('fmcp_token1');
    const b = hashToken('fmcp_token2');
    expect(a).not.toBe(b);
  });
});

describe('verifyTokenHash', () => {
  it('returns true for matching token and hash', () => {
    const token = 'fmcp_mytoken123';
    const hash = hashToken(token);
    expect(verifyTokenHash(token, hash)).toBe(true);
  });

  it('returns false for non-matching token', () => {
    const hash = hashToken('fmcp_real');
    expect(verifyTokenHash('fmcp_fake', hash)).toBe(false);
  });

  it('is constant-time (does not throw on length mismatch)', () => {
    // A very short hash should still return false, not crash
    expect(verifyTokenHash('fmcp_x', 'ab'.repeat(32))).toBe(false);
  });
});
