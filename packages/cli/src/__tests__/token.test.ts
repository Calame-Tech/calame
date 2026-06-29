import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { TokenManager } from '../token.js';
import { CalameDatabase } from '../database.js';

describe('TokenManager', () => {
  let tmpDir: string;
  let db: CalameDatabase;
  let manager: TokenManager;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `calame-token-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    db = new CalameDatabase(tmpDir);
    manager = new TokenManager(db);
  });

  afterEach(async () => {
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('generateToken creates a token with fmcp_ prefix', () => {
    const entry = manager.generateToken('profile1', 'My Token');
    expect(entry._plaintextToken.startsWith('fmcp_')).toBe(true);
  });

  it('generateToken adds token to store', () => {
    manager.generateToken('profile1', 'Token A');
    manager.generateToken('profile1', 'Token B');
    const all = manager.getAllTokens();
    expect(all).toHaveLength(2);
  });

  it('verifyToken returns the token entry for valid tokens', () => {
    const entry = manager.generateToken('profile1', 'Test');
    const verified = manager.verifyToken(entry._plaintextToken);
    expect(verified).not.toBeNull();
    expect(verified!.profileName).toBe('profile1');
    expect(verified!.label).toBe('Test');
  });

  it('verifyToken returns null for invalid tokens', () => {
    const result = manager.verifyToken('fmcp_nonexistent');
    expect(result).toBeNull();
  });

  it('verifyToken updates lastUsedAt', () => {
    const entry = manager.generateToken('profile1', 'Test');
    expect(entry.lastUsedAt).toBeUndefined();

    const verified = manager.verifyToken(entry._plaintextToken);
    expect(verified!.lastUsedAt).toBeDefined();
  });

  it('revokeToken removes the token', () => {
    const entry = manager.generateToken('profile1', 'Test');
    const revoked = manager.revokeToken(entry.id);
    expect(revoked).toBe(true);

    const verified = manager.verifyToken(entry._plaintextToken);
    expect(verified).toBeNull();
  });

  it('revokeToken returns false for non-existent id', () => {
    const result = manager.revokeToken('nonexistent_id');
    expect(result).toBe(false);
  });

  it('getTokensForProfile filters correctly', () => {
    manager.generateToken('profile1', 'A');
    manager.generateToken('profile2', 'B');
    manager.generateToken('profile1', 'C');

    const profile1Tokens = manager.getTokensForProfile('profile1');
    expect(profile1Tokens).toHaveLength(2);
    expect(profile1Tokens.every((t) => t.profileName === 'profile1')).toBe(true);

    const profile2Tokens = manager.getTokensForProfile('profile2');
    expect(profile2Tokens).toHaveLength(1);
  });

  it('getAllTokens masks token hash values', () => {
    manager.generateToken('profile1', 'Test');
    const all = manager.getAllTokens();
    expect(all).toHaveLength(1);

    // Masked tokenHash should contain ... and be truncated
    expect(all[0].tokenHash).toContain('...');
  });

  it('stores only hash, never plaintext in SQLite', () => {
    const entry = manager.generateToken('profile1', 'Persisted');

    // Query the raw database to verify no plaintext token
    const row = db.raw.prepare('SELECT * FROM tokens WHERE id = ?').get(entry.id) as Record<
      string,
      unknown
    >;
    expect(row.token_hash).toBeDefined();
    expect(String(row.token_hash)).not.toContain(entry._plaintextToken);
  });

  it('persistence works across manager instances on same db', () => {
    const entry = manager.generateToken('profile1', 'Persisted');

    // Create a new manager pointing to the same database
    const manager2 = new TokenManager(db);

    const tokens = manager2.getAllTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].profileName).toBe('profile1');
    expect(tokens[0].label).toBe('Persisted');

    // Verify with the plaintext token still works
    const verified = manager2.verifyToken(entry._plaintextToken);
    expect(verified).not.toBeNull();
    expect(verified!.label).toBe('Persisted');
  });
});
