import type { CalameDatabase } from './database.js';

/**
 * Store for OAuth clients registered dynamically via POST /register (RFC 7591).
 *
 * With a database the `oauth_clients` table (migration v19) is the source of
 * truth: every lookup reads it, so a client is usable right after registration
 * AND after a restart / re-creation of the routes on the same database.
 * Without a database (unit tests, early boot) clients live in memory only,
 * like the session store.
 *
 * Clients are scoped by tenant: a lookup only matches a client registered
 * under the same tenant id, so a client_id never resolves across tenants.
 *
 * `last_used_at` is set ONLY when an authorization code issued to the client
 * is successfully redeemed at /token (PKCE + redirect_uri checks passed).
 * Registrations, /authorize hits and any failed attempt leave it untouched.
 */
export interface OAuthClient {
  clientId: string;
  tenantId: string;
  redirectUris: string[];
  clientName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

interface OAuthClientRow {
  client_id: string;
  tenant_id: string;
  redirect_uris: string;
  client_name: string | null;
  created_at: string;
  last_used_at: string | null;
}

function parseRedirectUris(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

export class OAuthClientStore {
  private readonly memory = new Map<string, OAuthClient>();

  /** `getDb` is read on every call: the app database may be opened lazily. */
  constructor(private readonly getDb: () => CalameDatabase | null) {}

  private db(): CalameDatabase | null {
    const db = this.getDb();
    return db?.raw.open ? db : null;
  }

  register(client: Omit<OAuthClient, 'createdAt' | 'lastUsedAt'>): OAuthClient {
    const stored: OAuthClient = {
      ...client,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    const db = this.db();
    if (!db) {
      this.memory.set(stored.clientId, stored);
      return stored;
    }
    db.raw
      .prepare(
        `INSERT INTO oauth_clients (client_id, tenant_id, redirect_uris, client_name, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        stored.clientId,
        stored.tenantId,
        JSON.stringify(stored.redirectUris),
        stored.clientName,
        stored.createdAt,
      );
    return stored;
  }

  /** Return the client registered under `tenantId`, or null (unknown or other tenant). */
  get(clientId: string, tenantId: string): OAuthClient | null {
    const db = this.db();
    if (!db) {
      const client = this.memory.get(clientId);
      return client && client.tenantId === tenantId ? client : null;
    }
    const row = db.raw
      .prepare('SELECT * FROM oauth_clients WHERE client_id = ? AND tenant_id = ?')
      .get(clientId, tenantId) as OAuthClientRow | undefined;
    if (!row) return null;
    return {
      clientId: row.client_id,
      tenantId: row.tenant_id,
      redirectUris: parseRedirectUris(row.redirect_uris),
      clientName: row.client_name,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    };
  }

  /** Record a successful use (code redeemed at /token). */
  markUsed(clientId: string): void {
    const now = new Date().toISOString();
    const db = this.db();
    if (!db) {
      const client = this.memory.get(clientId);
      if (client) client.lastUsedAt = now;
      return;
    }
    db.raw
      .prepare('UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?')
      .run(now, clientId);
  }
}
