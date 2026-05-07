import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits
const AUTH_TAG_LENGTH = 16; // 128 bits
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;

/**
 * Derive a 256-bit AES key from the secret using PBKDF2.
 * A per-value salt ensures identical plaintexts produce different ciphertexts.
 */
function deriveKey(secret: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(secret, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 *
 * Returns a base64-encoded string in the format: salt:iv:authTag:ciphertext
 * Each component is hex-encoded before joining.
 */
export function encrypt(plaintext: string, secret: string): string {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(secret, salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    salt.toString('hex'),
    iv.toString('hex'),
    authTag.toString('hex'),
    encrypted.toString('hex'),
  ].join(':');
}

/**
 * Decrypt a string that was encrypted with `encrypt()`.
 *
 * Expects the format: salt:iv:authTag:ciphertext (all hex-encoded, colon-separated).
 */
export function decrypt(encoded: string, secret: string): string {
  const parts = encoded.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted value format');
  }

  const [saltHex, ivHex, authTagHex, ciphertextHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  const key = deriveKey(secret, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf-8');
}

/**
 * Check whether a string looks like an encrypted value (salt:iv:tag:data format).
 */
export function isEncrypted(value: string): boolean {
  const parts = value.split(':');
  if (parts.length !== 4) return false;
  // Each part should be valid hex
  return parts.every((p) => /^[0-9a-f]+$/i.test(p));
}

/**
 * Read the encryption secret from the environment.
 * Returns null if not set.
 */
export function getSecretKey(): string | null {
  return process.env.CALAME_SECRET_KEY ?? null;
}

/**
 * Hash a token using SHA-256 for storage.
 * Uses constant-time comparison for verification.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time comparison of two token hashes to prevent timing attacks.
 */
export function verifyTokenHash(token: string, storedHash: string): boolean {
  const incomingHash = hashToken(token);
  const a = Buffer.from(incomingHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Hash a password using PBKDF2 with a random salt.
 * Returns "salt:hash" (both hex-encoded).
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(32);
  const hash = crypto.pbkdf2Sync(password, salt, 100_000, 64, 'sha512');
  return salt.toString('hex') + ':' + hash.toString('hex');
}

/**
 * Verify a password against a stored "salt:hash" string.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const storedHash = Buffer.from(hashHex, 'hex');
  const incomingHash = crypto.pbkdf2Sync(password, salt, 100_000, 64, 'sha512');
  if (storedHash.length !== incomingHash.length) return false;
  return crypto.timingSafeEqual(storedHash, incomingHash);
}

// ---------------------------------------------------------------------------
// Symmetric AES-256-GCM with a caller-provided 32-byte key.
//
// Used by features that need to encrypt structured payloads (e.g. RAG source
// configs) at rest, where the host already holds a derived key in memory and
// passes it explicitly. Distinct from `encrypt()` / `decrypt()` above — those
// take a string secret and derive a fresh key per call via PBKDF2, which is
// expensive when called per row.
// ---------------------------------------------------------------------------

const GCM_ALGORITHM = 'aes-256-gcm';
const GCM_KEY_LENGTH = 32; // 256 bits
const GCM_IV_LENGTH = 12; // 96 bits — recommended for GCM
const GCM_AUTH_TAG_LENGTH = 16; // 128 bits

/**
 * Encrypt a UTF-8 string with AES-256-GCM under the supplied 32-byte key.
 *
 * Output format: `<iv>:<tag>:<ciphertext>` — each segment is base64-encoded
 * and concatenated with a colon separator. Each call uses a fresh random IV,
 * so encrypting the same plaintext twice produces different ciphertexts.
 */
export function encryptString(plaintext: string, key: Buffer): string {
  if (key.length !== GCM_KEY_LENGTH) {
    throw new Error(`encryptString: key must be ${GCM_KEY_LENGTH} bytes, got ${key.length}`);
  }
  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv(GCM_ALGORITHM, key, iv, {
    authTagLength: GCM_AUTH_TAG_LENGTH,
  });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

/**
 * Decrypt a value produced by {@link encryptString}.
 *
 * Throws on malformed input, unknown encoding, or authentication tag mismatch
 * (which indicates either a wrong key or tampering).
 */
export function decryptString(ciphertext: string, key: Buffer): string {
  if (key.length !== GCM_KEY_LENGTH) {
    throw new Error(`decryptString: key must be ${GCM_KEY_LENGTH} bytes, got ${key.length}`);
  }
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('decryptString: invalid format — expected "iv:tag:ciphertext" in base64');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64!, 'base64');
  const tag = Buffer.from(tagB64!, 'base64');
  const data = Buffer.from(dataB64!, 'base64');
  if (iv.length !== GCM_IV_LENGTH) {
    throw new Error(`decryptString: invalid IV length ${iv.length}, expected ${GCM_IV_LENGTH}`);
  }
  if (tag.length !== GCM_AUTH_TAG_LENGTH) {
    throw new Error(
      `decryptString: invalid auth tag length ${tag.length}, expected ${GCM_AUTH_TAG_LENGTH}`,
    );
  }
  const decipher = crypto.createDecipheriv(GCM_ALGORITHM, key, iv, {
    authTagLength: GCM_AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString('utf-8');
}

/**
 * Derive a 32-byte AES key from `process.env.CALAME_ENCRYPTION_KEY`.
 *
 * Behavior:
 *  - If the env var is set, returns SHA-256 of its UTF-8 bytes (stable, idempotent).
 *  - If absent and `NODE_ENV === 'production'`, throws — the operator must set
 *    the variable explicitly (preferably to 32 random bytes, hex- or
 *    base64-encoded).
 *  - If absent and not in production, falls back to a deterministic dev key
 *    derived from a fixed sentinel and emits a `console.warn`. Calls in
 *    tests or local development do NOT need to set the variable.
 */
export function deriveKeyFromEnv(): Buffer {
  const raw = process.env.CALAME_ENCRYPTION_KEY;
  if (raw && raw.length > 0) {
    return crypto.createHash('sha256').update(raw, 'utf-8').digest();
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'CALAME_ENCRYPTION_KEY is not set. ' +
        'Set it to a strong secret (32+ random bytes, e.g. `openssl rand -hex 32`) ' +
        'before starting Calame in production.',
    );
  }
  // Dev fallback — deterministic so encrypted blobs survive restarts in dev.
  console.warn(
    '[calame] CALAME_ENCRYPTION_KEY is not set — using a deterministic dev key. ' +
      'Do NOT use this in production.',
  );
  return crypto.createHash('sha256').update('calame-dev-default-key', 'utf-8').digest();
}
