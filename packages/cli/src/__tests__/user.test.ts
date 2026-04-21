import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { UserManager } from '../user.js';
import { CalameDatabase } from '../database.js';

describe('UserManager', () => {
  let tmpDir: string;
  let db: CalameDatabase;
  let manager: UserManager;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `calame-user-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    db = new CalameDatabase(tmpDir);
    manager = new UserManager(db);
  });

  afterEach(async () => {
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('createUser', () => {
    it('creates a user with multiple profiles', () => {
      const entry = manager.createUser({
        name: 'Jean Dupont',
        email: 'jean@example.com',
        role: 'user',
        profiles: [
          { profileName: 'prod', accessMode: 'both', allowedTables: null, allowedTools: null },
          { profileName: 'compta', accessMode: 'chat', allowedTables: ['factures'], allowedTools: ['describe'] },
        ],
      });

      expect(entry.name).toBe('Jean Dupont');
      expect(entry.profiles).toHaveLength(2);
      expect(entry.profiles[0].profileName).toBe('prod');
      expect(entry.profiles[1].profileName).toBe('compta');
      expect(entry.profiles[1].allowedTables).toEqual(['factures']);
      expect(entry._plaintextToken.startsWith('fmcp_')).toBe(true);
      expect(entry.status).toBe('invited');
    });

    it('rejects duplicate emails', () => {
      manager.createUser({
        name: 'Jean',
        email: 'jean@example.com',
        role: 'user',
        profiles: [{ profileName: 'prod', accessMode: 'both', allowedTables: null, allowedTools: null }],
      });

      expect(() =>
        manager.createUser({
          name: 'Jean 2',
          email: 'JEAN@example.com',
          role: 'user',
          profiles: [{ profileName: 'prod', accessMode: 'both', allowedTables: null, allowedTools: null }],
        }),
      ).toThrow('already exists');
    });

    it('rejects empty profiles array', () => {
      expect(() =>
        manager.createUser({
          name: 'Jean',
          email: 'jean@example.com',
          role: 'user',
          profiles: [],
        }),
      ).toThrow('At least one profile');
    });
  });

  describe('verifyToken', () => {
    it('returns user for valid token of active user', () => {
      const entry = manager.createUser({
        name: 'Jean',
        email: 'jean@example.com',
        role: 'user',
        profiles: [{ profileName: 'prod', accessMode: 'both', allowedTables: null, allowedTools: null }],
      });
      const enabled = manager.enableUser(entry.id)!;
      const verified = manager.verifyToken(enabled._plaintextToken);
      expect(verified).not.toBeNull();
      expect(verified!.name).toBe('Jean');
    });

    it('returns null for disabled users', () => {
      const entry = manager.createUser({
        name: 'Jean',
        email: 'jean@example.com',
        role: 'user',
        profiles: [{ profileName: 'prod', accessMode: 'both', allowedTables: null, allowedTools: null }],
      });
      const enabled = manager.enableUser(entry.id)!;
      manager.disableUser(entry.id, 'Left company');
      expect(manager.verifyToken(enabled._plaintextToken)).toBeNull();
    });

    it('returns null for invalid token', () => {
      expect(manager.verifyToken('fmcp_fake')).toBeNull();
    });
  });

  describe('getUserProfileAccess', () => {
    it('returns profile access for authorized profile', () => {
      const entry = manager.createUser({
        name: 'Jean',
        email: 'jean@example.com',
        role: 'user',
        profiles: [
          { profileName: 'prod', accessMode: 'mcp', allowedTables: null, allowedTools: null },
          { profileName: 'compta', accessMode: 'chat', allowedTables: ['factures'], allowedTools: null },
        ],
      });

      const access = manager.getUserProfileAccess(entry, 'compta');
      expect(access).not.toBeNull();
      expect(access!.accessMode).toBe('chat');
      expect(access!.allowedTables).toEqual(['factures']);
    });

    it('returns null for unauthorized profile', () => {
      const entry = manager.createUser({
        name: 'Jean',
        email: 'jean@example.com',
        role: 'user',
        profiles: [{ profileName: 'prod', accessMode: 'both', allowedTables: null, allowedTools: null }],
      });
      expect(manager.getUserProfileAccess(entry, 'compta')).toBeNull();
    });
  });

  describe('addProfileAccess / removeProfileAccess', () => {
    it('adds a new profile to an existing user', () => {
      const entry = manager.createUser({
        name: 'Jean',
        email: 'jean@example.com',
        role: 'user',
        profiles: [{ profileName: 'prod', accessMode: 'both', allowedTables: null, allowedTools: null }],
      });

      manager.addProfileAccess(entry.id, {
        profileName: 'compta',
        accessMode: 'chat',
        allowedTables: ['factures'],
        allowedTools: null,
      });

      const user = manager.getUserById(entry.id)!;
      expect(user.profiles).toHaveLength(2);
      expect(user.profiles[1].profileName).toBe('compta');
    });

    it('replaces an existing profile access', () => {
      const entry = manager.createUser({
        name: 'Jean',
        email: 'jean@example.com',
        role: 'user',
        profiles: [{ profileName: 'prod', accessMode: 'both', allowedTables: null, allowedTools: null }],
      });

      manager.addProfileAccess(entry.id, {
        profileName: 'prod',
        accessMode: 'mcp',
        allowedTables: ['users'],
        allowedTools: null,
      });

      const user = manager.getUserById(entry.id)!;
      expect(user.profiles).toHaveLength(1);
      expect(user.profiles[0].accessMode).toBe('mcp');
      expect(user.profiles[0].allowedTables).toEqual(['users']);
    });

    it('removes a profile from a user', () => {
      const entry = manager.createUser({
        name: 'Jean',
        email: 'jean@example.com',
        role: 'user',
        profiles: [
          { profileName: 'prod', accessMode: 'both', allowedTables: null, allowedTools: null },
          { profileName: 'compta', accessMode: 'chat', allowedTables: null, allowedTools: null },
        ],
      });

      manager.removeProfileAccess(entry.id, 'prod');
      const user = manager.getUserById(entry.id)!;
      expect(user.profiles).toHaveLength(1);
      expect(user.profiles[0].profileName).toBe('compta');
    });
  });

  describe('disableUser / enableUser', () => {
    it('disableUser sets status and reason', () => {
      const entry = manager.createUser({
        name: 'Jean',
        email: 'jean@example.com',
        role: 'user',
        profiles: [{ profileName: 'prod', accessMode: 'both', allowedTables: null, allowedTools: null }],
      });
      const disabled = manager.disableUser(entry.id, 'Quit');
      expect(disabled!.status).toBe('disabled');
      expect(disabled!.disabledReason).toBe('Quit');
    });

    it('enableUser resets status and generates new token', () => {
      const entry = manager.createUser({
        name: 'Jean',
        email: 'jean@example.com',
        role: 'user',
        profiles: [{ profileName: 'prod', accessMode: 'both', allowedTables: null, allowedTools: null }],
      });
      manager.disableUser(entry.id);
      const enabled = manager.enableUser(entry.id);
      expect(enabled!.status).toBe('active');
      expect(enabled!._plaintextToken.startsWith('fmcp_')).toBe(true);
    });
  });

  describe('regenerateToken', () => {
    it('old token no longer works after regeneration', () => {
      const entry = manager.createUser({
        name: 'Jean',
        email: 'jean@example.com',
        role: 'user',
        profiles: [{ profileName: 'prod', accessMode: 'both', allowedTables: null, allowedTools: null }],
      });
      manager.enableUser(entry.id);
      const newResult = manager.regenerateToken(entry.id)!;
      expect(manager.verifyToken(entry._plaintextToken)).toBeNull();
      expect(manager.verifyToken(newResult._plaintextToken)).not.toBeNull();
    });
  });

  describe('listUsers', () => {
    it('filters by profileName across multi-profile users', () => {
      manager.createUser({
        name: 'A',
        email: 'a@x.com',
        role: 'user',
        profiles: [
          { profileName: 'prod', accessMode: 'both', allowedTables: null, allowedTools: null },
          { profileName: 'compta', accessMode: 'chat', allowedTables: null, allowedTools: null },
        ],
      });
      manager.createUser({
        name: 'B',
        email: 'b@x.com',
        role: 'user',
        profiles: [{ profileName: 'dev', accessMode: 'both', allowedTables: null, allowedTools: null }],
      });

      const comptaUsers = manager.listUsers({ profileName: 'compta' });
      expect(comptaUsers).toHaveLength(1);
      expect(comptaUsers[0].name).toBe('A');

      const prodUsers = manager.listUsers({ profileName: 'prod' });
      expect(prodUsers).toHaveLength(1);
    });
  });

  describe('persistence', () => {
    it('data persists across manager instances on same DB', () => {
      const entry = manager.createUser({
        name: 'Jean',
        email: 'jean@example.com',
        role: 'user',
        profiles: [
          { profileName: 'prod', accessMode: 'both', allowedTables: null, allowedTools: null },
          { profileName: 'compta', accessMode: 'chat', allowedTables: ['factures'], allowedTools: null },
        ],
      });
      manager.enableUser(entry.id);

      const manager2 = new UserManager(db);
      const users = manager2.listUsers();
      expect(users).toHaveLength(1);
      expect(users[0].profiles).toHaveLength(2);
      expect(users[0].profiles[1].allowedTables).toEqual(['factures']);
    });
  });

  describe('onboarding', () => {
    it('consumeOnboardingCode activates user and clears code', () => {
      const entry = manager.createUser({
        name: 'Jean',
        email: 'jean@example.com',
        role: 'user',
        profiles: [{ profileName: 'prod', accessMode: 'both', allowedTables: null, allowedTools: null }],
      });
      const consumed = manager.consumeOnboardingCode(entry.onboardingCode!);
      expect(consumed!.status).toBe('active');
      expect(consumed!.onboardingCode).toBeNull();
    });
  });

  describe('deleteUser', () => {
    it('removes user permanently', () => {
      const entry = manager.createUser({
        name: 'Jean',
        email: 'jean@example.com',
        role: 'user',
        profiles: [{ profileName: 'prod', accessMode: 'both', allowedTables: null, allowedTools: null }],
      });
      expect(manager.deleteUser(entry.id)).toBe(true);
      expect(manager.getUserById(entry.id)).toBeNull();
    });
  });
});
