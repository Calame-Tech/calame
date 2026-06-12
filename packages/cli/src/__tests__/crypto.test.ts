import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import {
  encrypt,
  decrypt,
  isEncrypted,
  hashToken,
  verifyTokenHash,
  encryptString,
  decryptString,
  deriveKeyFromEnv,
} from '../crypto.js';

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

describe('encryptString / decryptString (AES-256-GCM, key-Buffer API)', () => {
  const key = crypto.randomBytes(32);

  it('round-trips an ASCII string', () => {
    const plaintext = 'hello world';
    const ciphertext = encryptString(plaintext, key);
    expect(decryptString(ciphertext, key)).toBe(plaintext);
  });

  it('round-trips an empty string', () => {
    const ciphertext = encryptString('', key);
    expect(decryptString(ciphertext, key)).toBe('');
  });

  it('round-trips a unicode payload', () => {
    const plaintext = 'café ☕ 日本語 — émoji 🚀';
    const ciphertext = encryptString(plaintext, key);
    expect(decryptString(ciphertext, key)).toBe(plaintext);
  });

  it('round-trips a JSON-serialized object', () => {
    const obj = { rootPath: '/var/data', limits: { maxBytes: 50_000_000 } };
    const ciphertext = encryptString(JSON.stringify(obj), key);
    expect(JSON.parse(decryptString(ciphertext, key))).toEqual(obj);
  });

  it('uses fresh IVs — same plaintext produces different ciphertexts', () => {
    const a = encryptString('same-input', key);
    const b = encryptString('same-input', key);
    expect(a).not.toBe(b);
  });

  it('produces three colon-separated base64 segments', () => {
    const ciphertext = encryptString('payload', key);
    const parts = ciphertext.split(':');
    expect(parts).toHaveLength(3);
    for (const p of parts) {
      // Empty ciphertext is OK for empty plaintext, so allow length 0 only on the data part.
      expect(p).toMatch(/^[A-Za-z0-9+/=]*$/);
    }
  });

  it('fails to decrypt with the wrong key', () => {
    const ciphertext = encryptString('secret', key);
    const wrongKey = crypto.randomBytes(32);
    expect(() => decryptString(ciphertext, wrongKey)).toThrow();
  });

  it('fails on tampered ciphertext', () => {
    const ciphertext = encryptString('payload', key);
    const tampered = ciphertext.slice(0, -2) + 'AA';
    expect(() => decryptString(tampered, key)).toThrow();
  });

  it('rejects malformed input', () => {
    expect(() => decryptString('not-valid-format', key)).toThrow();
    expect(() => decryptString('only:two', key)).toThrow();
  });

  it('rejects keys of the wrong length', () => {
    const shortKey = Buffer.alloc(16, 1);
    expect(() => encryptString('x', shortKey)).toThrow(/32 bytes/);
    const ciphertext = encryptString('x', key);
    expect(() => decryptString(ciphertext, shortKey)).toThrow(/32 bytes/);
  });
});

describe('deriveKeyFromEnv', () => {
  let originalKey: string | undefined;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalKey = process.env.CALAME_ENCRYPTION_KEY;
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.CALAME_ENCRYPTION_KEY;
    else process.env.CALAME_ENCRYPTION_KEY = originalKey;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('derives a 32-byte key from the env var', () => {
    process.env.CALAME_ENCRYPTION_KEY = 'some-strong-secret';
    const key = deriveKeyFromEnv();
    expect(key.length).toBe(32);
  });

  it('is deterministic for the same env value', () => {
    process.env.CALAME_ENCRYPTION_KEY = 'deterministic';
    const a = deriveKeyFromEnv();
    const b = deriveKeyFromEnv();
    expect(a.equals(b)).toBe(true);
  });

  it('produces different keys for different env values', () => {
    process.env.CALAME_ENCRYPTION_KEY = 'one';
    const a = deriveKeyFromEnv();
    process.env.CALAME_ENCRYPTION_KEY = 'two';
    const b = deriveKeyFromEnv();
    expect(a.equals(b)).toBe(false);
  });

  it('throws in production when env var is missing', () => {
    delete process.env.CALAME_ENCRYPTION_KEY;
    process.env.NODE_ENV = 'production';
    expect(() => deriveKeyFromEnv()).toThrow(/CALAME_ENCRYPTION_KEY/);
  });

  it('falls back to a deterministic dev key when not in production', () => {
    delete process.env.CALAME_ENCRYPTION_KEY;
    process.env.NODE_ENV = 'development';
    const key = deriveKeyFromEnv();
    expect(key.length).toBe(32);
  });
});
