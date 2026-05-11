import crypto from 'crypto';
import type { Database, Statement } from 'better-sqlite3';
import type { CalameDatabase } from './database.js';
import { hashToken, verifyTokenHash, hashPassword, verifyPassword, encrypt, decrypt, getSecretKey } from './crypto.js';
import { DEFAULT_TENANT_ID } from './tenancy.js';

export type UserRole = 'admin' | 'user';
export type UserStatus = 'active' | 'disabled' | 'invited';
export type AccessMode = 'mcp' | 'chat' | 'both';

/** Per-profile permissions for a user. */
export interface UserProfileAccess {
  profileName: string;
  allowedTables: string[] | null;
  allowedTools: string[] | null;
  accessMode: AccessMode;
}

export interface UserEntry {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  /** List of profile accesses — one user can access multiple MCP servers. */
  profiles: UserProfileAccess[];
  tokenHash: string;
  /** Token encrypted with CALAME_SECRET_KEY — allows the user to retrieve it from their dashboard. */
  tokenEncrypted: string | null;
  /** PBKDF2 hash of the user's password. Null until the user sets it via onboarding. */
  passwordHash: string | null;
  createdAt: string;
  lastActiveAt: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
  /** One-time onboarding code (cleared after first use). */
  onboardingCode: string | null;
  /** Expiration timestamp for the onboarding code. */
  onboardingExpiresAt: string | null;
  /** OIDC subject identifier (sub claim). Null for password-only users. */
  oidcSubject: string | null;
  /** Arbitrary key-value attributes for data scoping (e.g. {"client_id": "CLT-00042"}). */
  customAttributes: Record<string, string> | null;
}

export interface UserStore {
  users: UserEntry[];
}

/** Row shape from the users table. */
interface UserRow {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  token_hash: string;
  token_encrypted: string | null;
  password_hash: string | null;
  created_at: string;
  last_active_at: string | null;
  disabled_at: string | null;
  disabled_reason: string | null;
  onboarding_code: string | null;
  onboarding_expires_at: string | null;
  oidc_subject: string | null;
  custom_attributes: string | null;
}

/** Row shape from the user_profile_access table. */
interface ProfileAccessRow {
  id: number;
  user_id: string;
  profile_name: string;
  allowed_tables: string | null;
  allowed_tools: string | null;
  access_mode: AccessMode;
}

/** Encrypt a token for storage (recoverable by the user). Returns null if no secret key. */
function encryptToken(token: string): string | null {
  const secret = getSecretKey();
  if (!secret) return null;
  return encrypt(token, secret);
}

/** Decrypt a stored token. Returns null if decryption fails or no secret key. */
function decryptToken(encrypted: string): string | null {
  const secret = getSecretKey();
  if (!secret) return null;
  try {
    return decrypt(encrypted, secret);
  } catch {
    return null;
  }
}

function profileAccessFromRow(row: ProfileAccessRow): UserProfileAccess {
  return {
    profileName: row.profile_name,
    allowedTables: row.allowed_tables ? JSON.parse(row.allowed_tables) as string[] : null,
    allowedTools: row.allowed_tools ? JSON.parse(row.allowed_tools) as string[] : null,
    accessMode: row.access_mode,
  };
}

export class UserManager {
  private db: Database;

  // Prepared statements
  private stmtInsertUser: Statement;
  private stmtUpdateUser: Statement;
  private stmtDeleteUser: Statement;
  private stmtSelectById: Statement;
  private stmtSelectByEmail: Statement;
  private stmtSelectByOnboarding: Statement;
  private stmtSelectAll: Statement;
  private stmtSelectActive: Statement;
  private stmtInsertProfile: Statement;
  private stmtDeleteProfiles: Statement;
  private stmtDeleteProfile: Statement;
  private stmtSelectProfiles: Statement;
  private stmtUpdateLastActive: Statement;
  private stmtHasAdmin: Statement;

  constructor(database: CalameDatabase) {
    this.db = database.raw;

    this.stmtInsertUser = this.db.prepare(`
      INSERT INTO users (id, name, email, role, status, token_hash, token_encrypted, password_hash,
        created_at, last_active_at, disabled_at, disabled_reason, onboarding_code, onboarding_expires_at,
        tenant_id)
      VALUES (@id, @name, @email, @role, @status, @token_hash, @token_encrypted, @password_hash,
        @created_at, @last_active_at, @disabled_at, @disabled_reason, @onboarding_code, @onboarding_expires_at,
        @tenant_id)
    `);

    this.stmtUpdateUser = this.db.prepare(`
      UPDATE users SET name=@name, email=@email, role=@role, status=@status,
        token_hash=@token_hash, token_encrypted=@token_encrypted, password_hash=@password_hash,
        last_active_at=@last_active_at, disabled_at=@disabled_at, disabled_reason=@disabled_reason,
        onboarding_code=@onboarding_code, onboarding_expires_at=@onboarding_expires_at
      WHERE id=@id
    `);

    this.stmtDeleteUser = this.db.prepare(`DELETE FROM users WHERE id = ?`);
    this.stmtSelectById = this.db.prepare(`SELECT * FROM users WHERE id = ?`);
    this.stmtSelectByEmail = this.db.prepare(`SELECT * FROM users WHERE email = ? COLLATE NOCASE`);
    this.stmtSelectByOnboarding = this.db.prepare(
      `SELECT * FROM users WHERE onboarding_code = ? AND onboarding_expires_at > ?`,
    );
    this.stmtSelectAll = this.db.prepare(`SELECT * FROM users`);
    this.stmtSelectActive = this.db.prepare(`SELECT * FROM users WHERE status = 'active'`);
    this.stmtInsertProfile = this.db.prepare(`
      INSERT OR REPLACE INTO user_profile_access (user_id, profile_name, allowed_tables, allowed_tools, access_mode)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.stmtDeleteProfiles = this.db.prepare(`DELETE FROM user_profile_access WHERE user_id = ?`);
    this.stmtDeleteProfile = this.db.prepare(
      `DELETE FROM user_profile_access WHERE user_id = ? AND profile_name = ?`,
    );
    this.stmtSelectProfiles = this.db.prepare(`SELECT * FROM user_profile_access WHERE user_id = ?`);
    this.stmtUpdateLastActive = this.db.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`);
    this.stmtHasAdmin = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin' AND status = 'active' AND password_hash IS NOT NULL`,
    );
  }

  /** Assemble a UserEntry from a UserRow + its profile access rows. */
  private buildEntry(row: UserRow): UserEntry {
    const profileRows = this.stmtSelectProfiles.all(row.id) as ProfileAccessRow[];
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      status: row.status,
      profiles: profileRows.map(profileAccessFromRow),
      tokenHash: row.token_hash,
      tokenEncrypted: row.token_encrypted,
      passwordHash: row.password_hash,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
      disabledAt: row.disabled_at,
      disabledReason: row.disabled_reason,
      onboardingCode: row.onboarding_code,
      onboardingExpiresAt: row.onboarding_expires_at,
      // oidc_subject may be absent if migration v3 has not yet run — default to null
      oidcSubject: row.oidc_subject ?? null,
      // custom_attributes may be absent if migration v5 has not yet run, or may contain invalid JSON
      customAttributes: (() => {
        if (!row.custom_attributes) return null;
        try { return JSON.parse(row.custom_attributes) as Record<string, string>; }
        catch { return null; }
      })(),
    };
  }

  /** Convert a UserEntry to the named params for stmtUpdateUser. */
  private toParams(entry: UserEntry): Record<string, unknown> {
    return {
      id: entry.id,
      name: entry.name,
      email: entry.email,
      role: entry.role,
      status: entry.status,
      token_hash: entry.tokenHash,
      token_encrypted: entry.tokenEncrypted,
      password_hash: entry.passwordHash,
      created_at: entry.createdAt,
      last_active_at: entry.lastActiveAt,
      disabled_at: entry.disabledAt,
      disabled_reason: entry.disabledReason,
      onboarding_code: entry.onboardingCode,
      onboarding_expires_at: entry.onboardingExpiresAt,
      // oidc_subject is not in the INSERT statement (added by migration v3) — do not include here
    };
  }

  /**
   * INSERT-only params. Adds `tenant_id` on top of `toParams` since the
   * UPDATE statement does NOT carry that column (it's append-only at the
   * INSERT boundary in Phase A) — better-sqlite3 binds named params
   * strictly, so the two statements need distinct shapes.
   *
   * Phase A multi-tenancy — `UserManager` doesn't have an Express request
   * in scope (it's called from /api/users which already resolved auth), so
   * every fresh user lands under the literal default. Phase B will surface
   * a per-request tenant via the route layer.
   */
  private toInsertParams(entry: UserEntry): Record<string, unknown> {
    return { ...this.toParams(entry), tenant_id: DEFAULT_TENANT_ID };
  }

  /** Sync profile access rows for a user (delete all, re-insert). */
  private syncProfiles(userId: string, profiles: UserProfileAccess[]): void {
    this.stmtDeleteProfiles.run(userId);
    for (const p of profiles) {
      this.stmtInsertProfile.run(
        userId,
        p.profileName,
        p.allowedTables ? JSON.stringify(p.allowedTables) : null,
        p.allowedTools ? JSON.stringify(p.allowedTools) : null,
        p.accessMode,
      );
    }
  }

  /** No-op — kept for backward compatibility. */
  async load(): Promise<void> {}

  /** No-op — kept for backward compatibility. */
  async save(): Promise<void> {}

  createUser(params: {
    name: string;
    email: string;
    role: UserRole;
    profiles: UserProfileAccess[];
    customAttributes?: Record<string, string> | null;
  }): UserEntry & { _plaintextToken: string } {
    // Check for duplicate email
    const existing = this.stmtSelectByEmail.get(params.email) as UserRow | undefined;
    if (existing) {
      throw new Error(`A user with email "${params.email}" already exists.`);
    }

    if (params.profiles.length === 0) {
      throw new Error('At least one profile access is required.');
    }

    const id = crypto.randomUUID();
    const plaintextToken = 'fmcp_' + crypto.randomBytes(24).toString('hex');
    const onboardingCode = crypto.randomBytes(16).toString('hex');
    const now = new Date().toISOString();
    const onboardingExpiry = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

    const entry: UserEntry = {
      id,
      name: params.name,
      email: params.email,
      role: params.role,
      status: 'invited',
      profiles: params.profiles,
      tokenHash: hashToken(plaintextToken),
      tokenEncrypted: encryptToken(plaintextToken),
      passwordHash: null,
      createdAt: now,
      lastActiveAt: null,
      disabledAt: null,
      disabledReason: null,
      onboardingCode,
      onboardingExpiresAt: onboardingExpiry,
      oidcSubject: null,
      customAttributes: params.customAttributes ?? null,
    };

    const insertAll = this.db.transaction(() => {
      this.stmtInsertUser.run(this.toInsertParams(entry));
      if (entry.customAttributes) {
        this.setCustomAttributes(id, entry.customAttributes);
      }
      this.syncProfiles(id, params.profiles);
    });
    insertAll();

    return { ...entry, _plaintextToken: plaintextToken };
  }

  verifyToken(token: string): UserEntry | null {
    const rows = this.stmtSelectActive.all() as UserRow[];
    for (const row of rows) {
      if (verifyTokenHash(token, row.token_hash)) {
        const now = new Date().toISOString();
        this.stmtUpdateLastActive.run(now, row.id);
        const entry = this.buildEntry(row);
        entry.lastActiveAt = now;
        return entry;
      }
    }
    return null;
  }

  getUserProfileAccess(user: UserEntry, profileName: string): UserProfileAccess | null {
    return user.profiles.find((p) => p.profileName === profileName) ?? null;
  }

  getUserToken(id: string): string | null {
    const row = this.stmtSelectById.get(id) as UserRow | undefined;
    if (!row || !row.token_encrypted) return null;
    return decryptToken(row.token_encrypted);
  }

  setPassword(id: string, password: string): boolean {
    const row = this.stmtSelectById.get(id) as UserRow | undefined;
    if (!row) return false;
    if (password.length < 8) {
      throw new Error('Password must be at least 8 characters.');
    }
    this.db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(password), id);
    return true;
  }

  authenticateByEmail(email: string, password: string): UserEntry | null {
    const row = this.stmtSelectByEmail.get(email) as UserRow | undefined;
    if (!row) return null;
    if (row.status === 'disabled') return null;
    if (!row.password_hash) return null;
    if (!verifyPassword(password, row.password_hash)) return null;
    const now = new Date().toISOString();
    this.stmtUpdateLastActive.run(now, row.id);
    const entry = this.buildEntry(row);
    entry.lastActiveAt = now;
    return entry;
  }

  getUserById(id: string): UserEntry | null {
    const row = this.stmtSelectById.get(id) as UserRow | undefined;
    return row ? this.buildEntry(row) : null;
  }

  getUserByEmail(email: string): UserEntry | null {
    const row = this.stmtSelectByEmail.get(email) as UserRow | undefined;
    return row ? this.buildEntry(row) : null;
  }

  getUserByOnboardingCode(code: string): UserEntry | null {
    const now = new Date().toISOString();
    const row = this.stmtSelectByOnboarding.get(code, now) as UserRow | undefined;
    return row ? this.buildEntry(row) : null;
  }

  listUsers(filters?: {
    profileName?: string;
    role?: UserRole;
    status?: UserStatus;
    search?: string;
  }): UserEntry[] {
    // Build dynamic query
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters?.role) {
      conditions.push('u.role = ?');
      params.push(filters.role);
    }
    if (filters?.status) {
      conditions.push('u.status = ?');
      params.push(filters.status);
    }
    if (filters?.search) {
      conditions.push('(LOWER(u.name) LIKE ? OR LOWER(u.email) LIKE ?)');
      const q = `%${filters.search.toLowerCase()}%`;
      params.push(q, q);
    }
    if (filters?.profileName) {
      conditions.push('u.id IN (SELECT user_id FROM user_profile_access WHERE profile_name = ?)');
      params.push(filters.profileName);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM users u ${where}`).all(...params) as UserRow[];
    return rows.map((r) => this.buildEntry(r));
  }

  disableUser(id: string, reason?: string): UserEntry | null {
    const row = this.stmtSelectById.get(id) as UserRow | undefined;
    if (!row) return null;
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE users SET status='disabled', disabled_at=?, disabled_reason=? WHERE id=?`,
    ).run(now, reason ?? null, id);
    return this.getUserById(id);
  }

  enableUser(id: string): (UserEntry & { _plaintextToken: string }) | null {
    const row = this.stmtSelectById.get(id) as UserRow | undefined;
    if (!row) return null;
    const plaintextToken = 'fmcp_' + crypto.randomBytes(24).toString('hex');
    this.db.prepare(
      `UPDATE users SET status='active', token_hash=?, token_encrypted=?, disabled_at=NULL, disabled_reason=NULL WHERE id=?`,
    ).run(hashToken(plaintextToken), encryptToken(plaintextToken), id);
    const entry = this.getUserById(id)!;
    return { ...entry, _plaintextToken: plaintextToken };
  }

  regenerateToken(id: string): (UserEntry & { _plaintextToken: string }) | null {
    const row = this.stmtSelectById.get(id) as UserRow | undefined;
    if (!row) return null;
    const plaintextToken = 'fmcp_' + crypto.randomBytes(24).toString('hex');
    this.db.prepare(
      `UPDATE users SET token_hash=?, token_encrypted=? WHERE id=?`,
    ).run(hashToken(plaintextToken), encryptToken(plaintextToken), id);
    const entry = this.getUserById(id)!;
    return { ...entry, _plaintextToken: plaintextToken };
  }

  updateUser(
    id: string,
    updates: Partial<Pick<UserEntry, 'name' | 'email' | 'role' | 'profiles' | 'customAttributes'>>,
  ): UserEntry | null {
    const row = this.stmtSelectById.get(id) as UserRow | undefined;
    if (!row) return null;

    // Check email uniqueness if changing
    if (updates.email && updates.email.toLowerCase() !== row.email.toLowerCase()) {
      const existingEmail = this.stmtSelectByEmail.get(updates.email) as UserRow | undefined;
      if (existingEmail) {
        throw new Error(`A user with email "${updates.email}" already exists.`);
      }
    }

    const doUpdate = this.db.transaction(() => {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (updates.name !== undefined) { sets.push('name = ?'); params.push(updates.name); }
      if (updates.email !== undefined) { sets.push('email = ?'); params.push(updates.email); }
      if (updates.role !== undefined) { sets.push('role = ?'); params.push(updates.role); }

      if (sets.length > 0) {
        params.push(id);
        this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      }

      if (updates.profiles !== undefined) {
        this.syncProfiles(id, updates.profiles);
      }

      if (updates.customAttributes !== undefined) {
        this.setCustomAttributes(id, updates.customAttributes);
      }
    });
    doUpdate();

    return this.getUserById(id);
  }

  addProfileAccess(id: string, access: UserProfileAccess): UserEntry | null {
    const row = this.stmtSelectById.get(id) as UserRow | undefined;
    if (!row) return null;
    this.stmtInsertProfile.run(
      id,
      access.profileName,
      access.allowedTables ? JSON.stringify(access.allowedTables) : null,
      access.allowedTools ? JSON.stringify(access.allowedTools) : null,
      access.accessMode,
    );
    return this.getUserById(id);
  }

  removeProfileAccess(id: string, profileName: string): UserEntry | null {
    const row = this.stmtSelectById.get(id) as UserRow | undefined;
    if (!row) return null;
    this.stmtDeleteProfile.run(id, profileName);
    return this.getUserById(id);
  }

  hasAdminUser(): boolean {
    const { cnt } = this.stmtHasAdmin.get() as { cnt: number };
    return cnt > 0;
  }

  createAdminAccount(params: {
    name: string;
    email: string;
    password: string;
  }): UserEntry & { _plaintextToken: string } {
    if (this.hasAdminUser()) {
      throw new Error('An admin account already exists. Setup is not allowed.');
    }

    if (params.password.length < 8) {
      throw new Error('Password must be at least 8 characters.');
    }

    const id = crypto.randomUUID();
    const plaintextToken = 'fmcp_' + crypto.randomBytes(24).toString('hex');
    const now = new Date().toISOString();

    const entry: UserEntry = {
      id,
      name: params.name,
      email: params.email,
      role: 'admin',
      status: 'active',
      profiles: [],
      tokenHash: hashToken(plaintextToken),
      tokenEncrypted: encryptToken(plaintextToken),
      passwordHash: hashPassword(params.password),
      createdAt: now,
      lastActiveAt: now,
      disabledAt: null,
      disabledReason: null,
      onboardingCode: null,
      onboardingExpiresAt: null,
      oidcSubject: null,
      customAttributes: null,
    };

    this.stmtInsertUser.run(this.toInsertParams(entry));
    return { ...entry, _plaintextToken: plaintextToken };
  }

  /**
   * Set custom attributes on a user (for data scoping).
   * Pass null to clear all custom attributes.
   */
  setCustomAttributes(userId: string, attrs: Record<string, string> | null): void {
    try {
      this.db
        .prepare('UPDATE users SET custom_attributes = ? WHERE id = ?')
        .run(attrs ? JSON.stringify(attrs) : null, userId);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (!msg.includes('no such column')) throw err;
      // Column may not exist if migration v5 has not run yet — silently ignore
    }
  }

  /**
   * Find a user by their OIDC subject identifier (sub claim).
   * Returns null if no user is linked to this subject or if the column does not yet exist.
   */
  getUserByOidcSubject(subject: string): UserEntry | null {
    try {
      const row = this.db
        .prepare('SELECT * FROM users WHERE oidc_subject = ?')
        .get(subject) as UserRow | undefined;
      return row ? this.buildEntry(row) : null;
    } catch {
      // Column may not exist if migration v3 has not run yet
      return null;
    }
  }

  /**
   * Link an OIDC subject to an existing user account.
   * No-op if the column does not exist (migration v3 not yet applied).
   */
  setOidcSubject(userId: string, subject: string): void {
    try {
      this.db
        .prepare('UPDATE users SET oidc_subject = ? WHERE id = ?')
        .run(subject, userId);
    } catch {
      // Column may not exist if migration v3 has not run yet — silently ignore
    }
  }

  deleteUser(id: string): boolean {
    const result = this.stmtDeleteUser.run(id);
    return result.changes > 0;
  }

  consumeOnboardingCode(code: string): UserEntry | null {
    const user = this.getUserByOnboardingCode(code);
    if (!user) return null;
    this.db.prepare(
      `UPDATE users SET status='active', onboarding_code=NULL, onboarding_expires_at=NULL WHERE id=?`,
    ).run(user.id);
    return this.getUserById(user.id);
  }

  /**
   * Regenerate the onboarding code for a user. Useful when resending an invitation.
   * Returns the updated user entry, or null if the user was not found.
   */
  regenerateOnboardingCode(id: string): UserEntry | null {
    const row = this.stmtSelectById.get(id) as UserRow | undefined;
    if (!row) return null;
    const newCode = crypto.randomBytes(16).toString('hex');
    const expiry = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
    this.db
      .prepare(
        `UPDATE users SET onboarding_code = ?, onboarding_expires_at = ?, status = 'invited' WHERE id = ?`,
      )
      .run(newCode, expiry, id);
    return this.getUserById(id);
  }

  /**
   * Migrate existing tokens from the legacy token store.
   * This is a no-op when using SQLite — migration is handled by migration.ts.
   * Kept for backward compatibility with app.ts startup code.
   */
  async migrateFromTokens(_tokensFilePath: string): Promise<number> {
    return 0;
  }
}
