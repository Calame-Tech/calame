import type { Request } from 'express';
import type { AppState } from '../../state.js';
import type { UserIdentity } from '@calame/core';
import { INTERNAL_CHAT_SECRET } from '../../chat-engine.js';
import { DEFAULT_TENANT_ID } from '../../tenancy.js';

/** Result returned by verifyBearerToken. */
export interface BearerAuthResult {
  profileName?: string;
  allowedTables: string[] | null;
  allowedTools: string[] | null;
  rateLimitId?: string;
  rateLimitRpm?: number;
  error?: string;
  status: number;
  /** Resolved user identity for data scoping. Null for legacy tokens or admin. */
  userIdentity?: UserIdentity | null;
  /** Human-readable label of the legacy token used, if any. */
  tokenLabel?: string;
}

/**
 * Verify a Bearer token against both the user manager and the legacy token manager.
 * Returns a structured result so callers can handle errors uniformly.
 *
 * The `tenantId` parameter is the tenant resolved from the MCP URL. When set,
 * legacy tokens are required to match (tokens carry their owning tenant in the
 * `tokens.tenant_id` column). User-manager tokens are not yet tenant-tagged at
 * the row level (Phase B did not migrate `users.tenant_id` into the verify
 * path), so they pass through unchanged — this matches the existing semantics
 * where any active admin can hit any profile.
 */
export async function verifyBearerToken(
  bearerToken: string,
  profileName: string,
  state: AppState,
  req: Request,
  tenantId: string = DEFAULT_TENANT_ID,
): Promise<BearerAuthResult> {
  const tokenManager = state.tokenManager;
  if (!tokenManager) {
    return {
      error: 'Token manager not initialized.',
      status: 500,
      allowedTables: null,
      allowedTools: null,
    };
  }

  let authenticatedProfileName: string | undefined;
  let userAllowedTables: string[] | null = null;
  let userAllowedTools: string[] | null = null;
  let rateLimitId: string | undefined;
  let rateLimitRpm: number | undefined;
  let userIdentity: UserIdentity | null = null;

  const userManager = state.userManager;
  if (userManager) {
    const user = userManager.verifyToken(bearerToken);
    if (user) {
      if (user.status !== 'active') {
        return {
          error: 'Your access has been disabled. Contact your administrator.',
          status: 403,
          allowedTables: null,
          allowedTools: null,
        };
      }
      if (user.role === 'admin') {
        authenticatedProfileName = profileName;
        // Admin: no scoping (userIdentity stays null)
      } else {
        const profileAccess = userManager.getUserProfileAccess(user, profileName);
        if (!profileAccess) {
          return {
            error: `Your account is not authorized for profile "${profileName}".`,
            status: 403,
            allowedTables: null,
            allowedTools: null,
          };
        }
        if (profileAccess.accessMode === 'chat') {
          const internalSecret = req.headers['x-calame-internal'];
          if (internalSecret !== INTERNAL_CHAT_SECRET) {
            return {
              error: 'Your account only has chat access, not MCP access.',
              status: 403,
              allowedTables: null,
              allowedTools: null,
            };
          }
        }
        authenticatedProfileName = profileAccess.profileName;
        userAllowedTables = profileAccess.allowedTables;
        userAllowedTools = profileAccess.allowedTools;

        // Build user identity for data scoping
        userIdentity = {
          email: user.email,
          userId: user.id,
          externalId: user.oidcSubject ?? undefined,
          customAttributes: user.customAttributes ?? undefined,
        };
      }
      rateLimitId = user.id;
      const dbRow = state.db?.raw
        .prepare('SELECT rate_limit_rpm FROM users WHERE id = ?')
        .get(user.id) as { rate_limit_rpm: number | null } | undefined;
      if (dbRow?.rate_limit_rpm != null) {
        rateLimitRpm = dbRow.rate_limit_rpm;
      }
      await userManager.save();
    }
  }

  // Fall back to legacy token auth if user auth didn't match
  if (!authenticatedProfileName) {
    const tokenEntry = tokenManager.verifyToken(bearerToken);
    if (!tokenEntry) {
      return { error: 'Invalid token.', status: 401, allowedTables: null, allowedTools: null };
    }
    if (tokenEntry.profileName !== profileName) {
      return {
        error: `Token is not authorized for profile "${profileName}".`,
        status: 403,
        allowedTables: null,
        allowedTools: null,
      };
    }
    // Cross-tenant token replay guard. The legacy `tokens` table carries
    // `tenant_id` since Phase A — when the row's tenant doesn't match the
    // URL's tenant we surface a 403 rather than authorising a request that
    // could otherwise serve another tenant's profile rows.
    //
    // Tokens issued before Phase A landed have `tenant_id = 'default'` (the
    // column default), so `/mcp/<profile>` requests with such tokens keep
    // working unchanged.
    const tokenTenant = tokenEntry.tenantId ?? DEFAULT_TENANT_ID;
    if (tokenTenant !== tenantId) {
      return {
        error: `Token is not authorized for profile "${profileName}".`,
        status: 403,
        allowedTables: null,
        allowedTools: null,
      };
    }
    authenticatedProfileName = tokenEntry.profileName;
    rateLimitId = tokenEntry.id;
    await tokenManager.save();
    return {
      profileName: authenticatedProfileName,
      allowedTables: userAllowedTables,
      allowedTools: userAllowedTools,
      rateLimitId,
      rateLimitRpm,
      userIdentity,
      tokenLabel: tokenEntry.label,
      status: 200,
    };
  }

  return {
    profileName: authenticatedProfileName,
    allowedTables: userAllowedTables,
    allowedTools: userAllowedTools,
    rateLimitId,
    rateLimitRpm,
    userIdentity,
    status: 200,
  };
}
