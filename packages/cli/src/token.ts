import crypto from 'crypto';
import type { Database, Statement } from 'better-sqlite3';
import type { CalameDatabase } from './database.js';
import { hashToken, verifyTokenHash, encrypt, getSecretKey } from './crypto.js';
import { DEFAULT_TENANT_ID } from './tenancy.js';

export interface TokenEntry {
  id: string;
  /** SHA-256 hash of the token. Never store plaintext. */
  tokenHash: string;
  profileName: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  /**
   * Tenant id that owns this token. Populated by `verifyToken` so a caller
   * (e.g. the MCP route handler) can compare it to the tenant carried in
   * the URL and reject the request when they don't match.
   */
  tenantId?: string;
}

export interface TokenStore {
  tokens: TokenEntry[];
}

/** Row shape returned by better-sqlite3 for tokens queries. */
interface TokenRow {
  id: string;
  token_hash: string;
  profile_name: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  token_encrypted: string | null;
  tenant_id: string | null;
}

function rowToEntry(row: TokenRow): TokenEntry {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    profileName: row.profile_name,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
    tenantId: row.tenant_id ?? undefined,
  };
}

export class TokenManager {
  private db: Database;

  private stmtInsert: Statement;
  private stmtSelectAll: Statement;
  private stmtSelectAllForVerify: Statement;
  private stmtSelectByProfile: Statement;
  private stmtUpdateLastUsed: Statement;
  private stmtDelete: Statement;
  private stmtSelectEncryptedById: Statement;

  constructor(database: CalameDatabase) {
    this.db = database.raw;

    // Phase B multi-tenancy: every read path binds `tenant_id`. Token
    // verification is a special case — incoming MCP requests carry the
    // bearer token but cannot trivially carry an `X-Tenant-Id` header,
    // so `verifyToken` scans the full table by hash and returns the
    // owner tenant from the row itself. CRUD operations (generate, list,
    // revoke) accept the tenant explicitly from the route handler.
    this.stmtInsert = this.db.prepare(
      `INSERT INTO tokens (id, token_hash, profile_name, label, created_at,
                           last_used_at, token_encrypted, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtSelectAll = this.db.prepare(
      `SELECT * FROM tokens WHERE tenant_id = ?`,
    );
    /**
     * Tenant-agnostic full scan used by `verifyToken` only. Bearer-token
     * authentication doesn't know the tenant upfront — the token row IS
     * the source of truth for which tenant owns the request.
     */
    this.stmtSelectAllForVerify = this.db.prepare(`SELECT * FROM tokens`);
    this.stmtSelectByProfile = this.db.prepare(
      `SELECT * FROM tokens WHERE profile_name = ? AND tenant_id = ?`,
    );
    this.stmtUpdateLastUsed = this.db.prepare(`UPDATE tokens SET last_used_at = ? WHERE id = ?`);
    this.stmtDelete = this.db.prepare(
      `DELETE FROM tokens WHERE id = ? AND tenant_id = ?`,
    );
    this.stmtSelectEncryptedById = this.db.prepare(
      `SELECT token_encrypted FROM tokens WHERE id = ? AND tenant_id = ?`,
    );
  }

  /** No-op — kept for backward compatibility. */
  async load(): Promise<void> {}

  /** No-op — kept for backward compatibility. */
  async save(): Promise<void> {}

  /**
   * Generate a new token for a profile.
   * Returns the entry with the plaintext token set on `_plaintextToken`.
   * The plaintext is NEVER persisted — only the hash is stored.
   *
   * Phase B multi-tenancy: the row's `tenant_id` defaults to the
   * implicit default so existing callers (boot tooling, tests) keep
   * working unchanged. Route handlers thread the resolved tenant
   * through explicitly.
   */
  generateToken(
    profileName: string,
    label: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): TokenEntry & { _plaintextToken: string } {
    const id = crypto.randomBytes(8).toString('hex');
    const plaintextToken = 'fmcp_' + crypto.randomBytes(24).toString('hex');
    const entry: TokenEntry = {
      id,
      tokenHash: hashToken(plaintextToken),
      profileName,
      label,
      createdAt: new Date().toISOString(),
    };

    const secretKey = getSecretKey();
    const tokenEncrypted = secretKey ? encrypt(plaintextToken, secretKey) : null;

    this.stmtInsert.run(
      entry.id,
      entry.tokenHash,
      entry.profileName,
      entry.label,
      entry.createdAt,
      null,
      tokenEncrypted,
      tenantId,
    );
    return { ...entry, _plaintextToken: plaintextToken };
  }

  /**
   * Return the raw encrypted token value for a given token ID.
   * Returns null if the token does not exist or was created before encryption was enabled.
   */
  getEncryptedToken(id: string, tenantId: string = DEFAULT_TENANT_ID): string | null {
    const row = this.stmtSelectEncryptedById.get(id, tenantId) as
      | Pick<TokenRow, 'token_encrypted'>
      | undefined;
    return row?.token_encrypted ?? null;
  }

  /**
   * Verify an incoming token against stored hashes.
   * Uses constant-time comparison to prevent timing attacks.
   *
   * Bearer-token authentication doesn't carry a tenant header, so this
   * lookup is intentionally tenant-agnostic — the row itself carries
   * the `tenant_id` of the issuing tenant. Downstream consumers can
   * read it back via the returned entry once we surface it (Phase C).
   */
  verifyToken(token: string): TokenEntry | null {
    const rows = this.stmtSelectAllForVerify.all() as TokenRow[];
    for (const row of rows) {
      if (verifyTokenHash(token, row.token_hash)) {
        const now = new Date().toISOString();
        this.stmtUpdateLastUsed.run(now, row.id);
        const entry = rowToEntry(row);
        entry.lastUsedAt = now;
        return entry;
      }
    }
    return null;
  }

  revokeToken(id: string, tenantId: string = DEFAULT_TENANT_ID): boolean {
    const result = this.stmtDelete.run(id, tenantId);
    return result.changes > 0;
  }

  getTokensForProfile(profileName: string, tenantId: string = DEFAULT_TENANT_ID): TokenEntry[] {
    const rows = this.stmtSelectByProfile.all(profileName, tenantId) as TokenRow[];
    return rows.map(rowToEntry);
  }

  getAllTokens(tenantId: string = DEFAULT_TENANT_ID): TokenEntry[] {
    const rows = this.stmtSelectAll.all(tenantId) as TokenRow[];
    return rows.map((row) => {
      const entry = rowToEntry(row);
      // Return masked hash prefix for display purposes
      entry.tokenHash = entry.tokenHash.substring(0, 8) + '...';
      return entry;
    });
  }
}
