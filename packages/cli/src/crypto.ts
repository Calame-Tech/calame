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
