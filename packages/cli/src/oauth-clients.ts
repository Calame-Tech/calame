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

/** Bounds on the number of registered clients (see `OAuthClientStore.register`). */
export interface OAuthClientLimits {
  /** Maximum number of registered clients per tenant. */
  maxClientsPerTenant: number;
  /** Never-used clients older than this are purged on the next registration. */
  staleAfterMs: number;
  /** A never-used client younger than this is never purged to make room. */
  purgeMinAgeMs: number;
}

export const OAUTH_CLIENT_LIMITS: OAuthClientLimits = {
  maxClientsPerTenant: 200,
  staleAfterMs: 30 * 24 * 60 * 60 * 1000,
  purgeMinAgeMs: 60 * 60 * 1000,
};

/** Limits enforced on POST /register metadata (RFC 7591). */
export const REGISTER_LIMITS = {
  /** Serialized size of the registration request body. */
  maxBodyBytes: 32 * 1024,
  maxRedirectUris: 10,
  maxRedirectUriLength: 2048,
  maxClientNameLength: 200,
};

/** Hosts for which a plain-http redirect URI is accepted (exact match, RFC 8252 §7.3). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Return why `uri` is not an acceptable redirect URI, or null when it is.
 *
 * Accepted: absolute https URLs, and http URLs whose host is exactly
 * localhost, 127.0.0.1 or [::1] (optionally with a port). The host is checked
 * on the raw string, not only on the WHATWG-normalized URL, so look-alike
 * spellings that normalize to a loopback host (127.1, 0x7f000001,
 * LOCALHOST, localhost., [0:0:0:0:0:0:0:1]...) are refused too. Fragments,
 * user credentials, whitespace, control characters and backslashes are
 * refused (the URL parser would otherwise silently rewrite them).
 */
function redirectUriProblem(uri: string): string | null {
  if (uri.length === 0) return 'must not be empty';
  if (uri.length > REGISTER_LIMITS.maxRedirectUriLength) {
    return `must be at most ${REGISTER_LIMITS.maxRedirectUriLength} characters`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s\\\u0000-\u001f\u007f]/.test(uri)) {
    return 'must not contain whitespace, control characters or backslashes';
  }
  if (uri.includes('#')) return 'must not contain a fragment (#)';
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'must be an absolute URL';
  }
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?]*)/.exec(uri);
  if (!match) return 'must be an absolute URL with a host';
  const scheme = match[1].toLowerCase();
  const authority = match[2];
  if (authority.includes('@') || url.username || url.password) {
    return 'must not contain user credentials';
  }
  if (scheme === 'https') return url.hostname ? null : 'must include a host';
  if (scheme === 'http') {
    const host = authority.replace(/:\d*$/, '');
    if (LOOPBACK_HOSTS.has(host) && url.hostname === host) return null;
    return 'must use https (http is only allowed for the exact hosts localhost, 127.0.0.1 and [::1])';
  }
  return `scheme "${scheme}:" is not allowed; use https (http only for localhost, 127.0.0.1 or [::1])`;
}

export type ClientMetadataResult =
  | { ok: true; redirectUris: string[]; clientName: string | null }
  | { ok: false; error: 'invalid_redirect_uri' | 'invalid_client_metadata'; description: string };

/**
 * Validate a POST /register body (RFC 7591 §2, §3.2.2). Pure: nothing is
 * written before this returns ok.
 */
export function validateClientMetadata(body: unknown): ClientMetadataResult {
  const invalid = (
    error: 'invalid_redirect_uri' | 'invalid_client_metadata',
    description: string,
  ): ClientMetadataResult => ({ ok: false, error, description });

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return invalid('invalid_client_metadata', 'The registration body must be a JSON object.');
  }
  if (Buffer.byteLength(JSON.stringify(body)) > REGISTER_LIMITS.maxBodyBytes) {
    return invalid(
      'invalid_client_metadata',
      `The registration body must be at most ${REGISTER_LIMITS.maxBodyBytes} bytes.`,
    );
  }
  const { redirect_uris, client_name } = body as Record<string, unknown>;

  if (redirect_uris === undefined || redirect_uris === null) {
    return invalid('invalid_redirect_uri', 'redirect_uris is required.');
  }
  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return invalid('invalid_redirect_uri', 'redirect_uris must be a non-empty array of URLs.');
  }
  if (redirect_uris.length > REGISTER_LIMITS.maxRedirectUris) {
    return invalid(
      'invalid_redirect_uri',
      `redirect_uris must contain at most ${REGISTER_LIMITS.maxRedirectUris} URLs.`,
    );
  }
  for (let i = 0; i < redirect_uris.length; i++) {
    const uri: unknown = redirect_uris[i];
    if (typeof uri !== 'string') {
      return invalid('invalid_redirect_uri', `redirect_uris[${i}] must be a string.`);
    }
    const problem = redirectUriProblem(uri);
    if (problem) return invalid('invalid_redirect_uri', `redirect_uris[${i}] ${problem}.`);
  }

  let clientName: string | null = null;
  if (client_name !== undefined && client_name !== null) {
    if (typeof client_name !== 'string') {
      return invalid('invalid_client_metadata', 'client_name must be a string.');
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(client_name)) {
      return invalid('invalid_client_metadata', 'client_name must not contain control characters.');
    }
    if (client_name.length > REGISTER_LIMITS.maxClientNameLength) {
      return invalid(
        'invalid_client_metadata',
        `client_name must be at most ${REGISTER_LIMITS.maxClientNameLength} characters.`,
      );
    }
    clientName = client_name.trim() || null;
  }

  return { ok: true, redirectUris: [...new Set(redirect_uris as string[])], clientName };
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

  private readonly limits: OAuthClientLimits;

  /** `getDb` is read on every call: the app database may be opened lazily. */
  constructor(
    private readonly getDb: () => CalameDatabase | null,
    limits: Partial<OAuthClientLimits> = {},
  ) {
    this.limits = { ...OAUTH_CLIENT_LIMITS, ...limits };
  }

  private db(): CalameDatabase | null {
    const db = this.getDb();
    return db?.raw.open ? db : null;
  }

  /**
   * Register a client, keeping the tenant under `maxClientsPerTenant`.
   *
   * Purge policy, applied atomically with the insert (one IMMEDIATE
   * transaction, so concurrent registrations — even from another connection
   * on the same database — cannot overshoot the cap):
   *   1. never-used clients older than `staleAfterMs` are always deleted;
   *   2. if the tenant is still full, the oldest never-used clients older
   *      than `purgeMinAgeMs` are deleted to make room.
   * A client that was used at least once (`last_used_at` set) is never
   * purged, nor is a recent one (it may be in the middle of its first
   * authorization). When nothing is purgeable the registration is refused:
   * returns `{ client: null }`.
   */
  register(client: Omit<OAuthClient, 'createdAt' | 'lastUsedAt'>): {
    client: OAuthClient | null;
    purged: number;
  } {
    const now = Date.now();
    const stored: OAuthClient = {
      ...client,
      createdAt: new Date(now).toISOString(),
      lastUsedAt: null,
    };
    const staleBefore = new Date(now - this.limits.staleAfterMs).toISOString();
    const purgeableBefore = new Date(now - this.limits.purgeMinAgeMs).toISOString();
    const cap = this.limits.maxClientsPerTenant;
    const db = this.db();
    if (!db) return this.registerInMemory(stored, staleBefore, purgeableBefore);

    const raw = db.raw;
    const tx = raw.transaction(() => {
      let purged = raw
        .prepare(
          'DELETE FROM oauth_clients WHERE tenant_id = ? AND last_used_at IS NULL AND created_at < ?',
        )
        .run(stored.tenantId, staleBefore).changes;
      const count = (
        raw
          .prepare('SELECT COUNT(*) AS n FROM oauth_clients WHERE tenant_id = ?')
          .get(stored.tenantId) as { n: number }
      ).n;
      const excess = count - cap + 1;
      if (excess > 0) {
        purged += raw
          .prepare(
            `DELETE FROM oauth_clients WHERE client_id IN (
               SELECT client_id FROM oauth_clients
               WHERE tenant_id = ? AND last_used_at IS NULL AND created_at < ?
               ORDER BY created_at ASC LIMIT ?)`,
          )
          .run(stored.tenantId, purgeableBefore, excess).changes;
        if (count - purged >= cap) return { client: null, purged };
      }
      raw
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
      return { client: stored, purged };
    });
    return tx.immediate();
  }

  private registerInMemory(
    stored: OAuthClient,
    staleBefore: string,
    purgeableBefore: string,
  ): { client: OAuthClient | null; purged: number } {
    let purged = 0;
    const tenantClients = () =>
      [...this.memory.values()].filter((c) => c.tenantId === stored.tenantId);
    for (const c of tenantClients()) {
      if (c.lastUsedAt === null && c.createdAt < staleBefore) {
        this.memory.delete(c.clientId);
        purged++;
      }
    }
    const remaining = tenantClients();
    let excess = remaining.length - this.limits.maxClientsPerTenant + 1;
    for (const c of remaining
      .filter((c) => c.lastUsedAt === null && c.createdAt < purgeableBefore)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (excess <= 0) break;
      this.memory.delete(c.clientId);
      purged++;
      excess--;
    }
    if (excess > 0) return { client: null, purged };
    this.memory.set(stored.clientId, stored);
    return { client: stored, purged };
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
