import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { AppState } from '../state.js';
import type { UserRole, AccessMode, UserProfileAccess } from '../user.js';
import { EmailService } from '../email.js';
import { getTenantId } from '../tenancy.js';

/**
 * Accepted shape for a user `:id` path param. Intentionally narrow
 * (letters, digits, underscore, hyphen) — rejects path-traversal
 * sequences and oversized inputs as defence-in-depth before the value
 * is bound into any statement. Bounded to 64 chars — comfortably above
 * the 36-char UUIDs we issue, well below anything pathological.
 */
const USER_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Lightweight HTTP error carrying a status code. Thrown by the route
 * guards below and translated to a JSON response by {@link handleGuardError}.
 */
class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Resolve the request tenant for a per-id, tenant-scoped route.
 *
 * Single-tenant compatibility (Phase B): a missing / malformed
 * `X-Tenant-Id` falls back to the implicit `'default'` tenant rather than
 * a `403`. This keeps the admin UI working in normal single-tenant mode
 * (the web client only sends the header for non-default tenants) while
 * {@link assertUserInTenant} still blocks cross-tenant access — a forged
 * or default request can never reach a row tagged with another tenant.
 *
 * Phase C (auth-derived tenant) will reintroduce a strict `403` once the
 * tenant comes from the session rather than a forgeable header.
 */
function requireTenantId(req: Request): string {
  return getTenantId(req);
}

/** Validate a `:id` path param against {@link USER_ID_RE} (400 on miss). */
function validateUserId(id: string): string {
  if (!USER_ID_RE.test(id)) throw new HttpError(400, 'Invalid user id.');
  return id;
}

/**
 * Assert that the target user exists within the caller's tenant. Throws
 * a `404` (never leaking the existence of a foreign-tenant row) when the
 * user is absent or belongs to another tenant.
 */
function assertUserInTenant(state: AppState, id: string, tenantId: string): void {
  const userRow = state.db?.raw
    .prepare<[string, string], { tenant_id: string }>(
      'SELECT tenant_id FROM users WHERE id = ? AND tenant_id = ?',
    )
    .get(id, tenantId);
  if (!userRow) throw new HttpError(404, 'User not found.');
}

/**
 * Translate a guard error ({@link HttpError}) to a JSON response. Returns
 * `true` when it handled the error so the caller's `catch` can early-return;
 * `false` for any other error, leaving the existing fallback handling intact.
 */
function handleGuardError(res: Response, error: unknown): boolean {
  if (error instanceof HttpError) {
    res.status(error.status).json({ success: false, message: error.message });
    return true;
  }
  return false;
}

const accessModeEnum = z.enum(['mcp', 'chat', 'both']);

/** Zod schema for the scalars of POST /api/users (profiles logic stays manual due to dual legacy/multi format). */
const createUserScalarsSchema = z.object({
  name: z.string().min(1, 'name is required'),
  email: z.string().email('A valid email is required'),
  role: z.enum(['admin', 'user'], { error: 'role must be "admin" or "user"' }),
  sendInvitation: z.boolean().optional(),
});

const addProfileSchema = z.object({
  profileName: z.string().min(1, 'profileName is required'),
  accessMode: accessModeEnum.default('both'),
  allowedTables: z.array(z.string()).nullable().optional(),
  allowedTools: z.array(z.string()).nullable().optional(),
});

const importUsersSchema = z.object({
  users: z.array(z.unknown()).min(1, 'users array must not be empty'),
  profileName: z.string().optional(),
  accessMode: accessModeEnum.optional(),
});

/** Build the base URL of the current request (protocol + host). */
function buildBaseUrl(req: Request): string {
  const proto = req.secure ? 'https' : 'http';
  const host = req.headers.host ?? `localhost:4567`;
  return `${proto}://${host}`;
}

export function registerUsersRoute(app: Express, state: AppState): void {
  /**
   * GET /api/users — List all users with optional filters.
   * Query params: profileName, role, status, search
   */
  app.get('/api/users', async (req, res) => {
    try {
      const userManager = state.userManager;
      if (!userManager) {
        res.status(500).json({ success: false, message: 'User manager not initialized.' });
        return;
      }

      const { profileName, role, status, search } = req.query as Record<string, string | undefined>;
      // Phase B multi-tenancy — pass the resolved tenant so the listing
      // is scoped to the caller. Cross-tenant users never surface here.
      const users = userManager.listUsers(
        {
          profileName,
          role: role as UserRole | undefined,
          status: status as 'active' | 'disabled' | 'invited' | undefined,
          search,
        },
        getTenantId(req),
      );

      // Return users without sensitive fields
      const sanitized = users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        status: u.status,
        profiles: u.profiles,
        createdAt: u.createdAt,
        lastActiveAt: u.lastActiveAt,
        disabledAt: u.disabledAt,
        disabledReason: u.disabledReason,
        onboardingCode: u.onboardingCode,
        onboardingExpiresAt: u.onboardingExpiresAt,
        customAttributes: u.customAttributes,
      }));

      res.json({ success: true, users: sanitized });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, message });
    }
  });

  /**
   * GET /api/users/:id — Get a single user.
   */
  app.get('/api/users/:id', async (req, res) => {
    try {
      const userManager = state.userManager;
      if (!userManager) {
        res.status(500).json({ success: false, message: 'User manager not initialized.' });
        return;
      }

      const tenantId = requireTenantId(req);
      const userId = validateUserId(req.params.id);
      assertUserInTenant(state, userId, tenantId);

      const user = userManager.getUserById(userId);
      if (!user) {
        res.status(404).json({ success: false, message: 'User not found.' });
        return;
      }

      res.json({
        success: true,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          status: user.status,
          profiles: user.profiles,
          createdAt: user.createdAt,
          lastActiveAt: user.lastActiveAt,
          disabledAt: user.disabledAt,
          disabledReason: user.disabledReason,
          onboardingCode: user.onboardingCode,
          onboardingExpiresAt: user.onboardingExpiresAt,
          customAttributes: user.customAttributes,
        },
      });
    } catch (error: unknown) {
      if (handleGuardError(res, error)) return;
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, message });
    }
  });

  /**
   * POST /api/users — Create a new user.
   * Body: { name, email, role, profiles: [{ profileName, accessMode, allowedTables?, allowedTools? }] }
   * Also supports legacy single-profile: { name, email, role, profileName, accessMode }
   */
  app.post('/api/users', async (req, res) => {
    try {
      const userManager = state.userManager;
      if (!userManager) {
        res.status(500).json({ success: false, message: 'User manager not initialized.' });
        return;
      }

      const scalarsParsed = createUserScalarsSchema.safeParse(req.body);
      if (!scalarsParsed.success) {
        res.status(400).json({
          success: false,
          message: scalarsParsed.error.issues[0]?.message ?? 'Invalid request body',
          errors: scalarsParsed.error.issues,
        });
        return;
      }

      const { name, email, role, sendInvitation } = scalarsParsed.data;

      // Build profiles array — support both new multi-profile and legacy single-profile format
      let profiles: UserProfileAccess[];

      if (Array.isArray(req.body.profiles) && req.body.profiles.length > 0) {
        // New format: profiles array
        profiles = (req.body.profiles as Array<Record<string, unknown>>).map((p) => {
          if (!p.profileName || typeof p.profileName !== 'string') {
            throw new Error('Each profile must have a profileName.');
          }
          const am = (p.accessMode as string) ?? 'both';
          if (!['mcp', 'chat', 'both'].includes(am)) {
            throw new Error('accessMode must be "mcp", "chat", or "both".');
          }
          return {
            profileName: p.profileName as string,
            allowedTables: (p.allowedTables as string[] | null) ?? null,
            allowedTools: (p.allowedTools as string[] | null) ?? null,
            accessMode: am as AccessMode,
          };
        });
      } else if (req.body.profileName) {
        // Legacy single-profile format
        const profileName = req.body.profileName as string;
        const accessMode = (req.body.accessMode as string) ?? 'both';
        if (!['mcp', 'chat', 'both'].includes(accessMode)) {
          res.status(400).json({ success: false, message: 'accessMode must be "mcp", "chat", or "both".' });
          return;
        }
        profiles = [{
          profileName,
          allowedTables: (req.body.allowedTables as string[] | null) ?? null,
          allowedTools: (req.body.allowedTools as string[] | null) ?? null,
          accessMode: accessMode as AccessMode,
        }];
      } else {
        res.status(400).json({ success: false, message: 'profiles array or profileName is required.' });
        return;
      }

      const entry = userManager.createUser({
        name,
        email,
        role: role as UserRole,
        profiles,
        customAttributes: req.body.customAttributes ?? null,
        // Phase B multi-tenancy — stamp the new user with the caller's
        // tenant so it lands in the right workspace (not the implicit default).
        tenantId: getTenantId(req),
      });
      await userManager.save();

      // Resolve email service — use state.emailService, or create one on the fly from SmtpConfigManager
      const resolvedEmailService = state.emailService ?? (() => {
        const smtpConfig = state.smtpConfigManager?.getConfig();
        return smtpConfig?.host ? EmailService.fromSmtpConfig(smtpConfig) : null;
      })();

      // Send invitation email if requested and email service is available
      if (sendInvitation === true && resolvedEmailService && entry.onboardingCode) {
        try {
          const onboardingUrl = `${buildBaseUrl(req)}/onboarding/${entry.onboardingCode}`;
          await resolvedEmailService.sendInvitation({
            email: entry.email,
            name: entry.name,
            onboardingUrl,
            profileNames: entry.profiles.map((p) => p.profileName),
          });
        } catch (emailErr: unknown) {
          const emailMsg = emailErr instanceof Error ? emailErr.message : 'Unknown error';
          // Log the error but don't fail the user creation
          state.logger?.warn(`Failed to send invitation email to ${entry.email}: ${emailMsg}`, {
            component: 'users',
          });
        }
      }

      res.json({
        success: true,
        user: {
          id: entry.id,
          name: entry.name,
          email: entry.email,
          role: entry.role,
          status: entry.status,
          profiles: entry.profiles,
          createdAt: entry.createdAt,
        },
        plaintextToken: entry._plaintextToken,
        onboardingCode: entry.onboardingCode,
        invitationSent: sendInvitation === true && !!resolvedEmailService,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, message });
    }
  });

  /**
   * PUT /api/users/:id — Update user fields.
   */
  app.put('/api/users/:id', async (req, res) => {
    try {
      const userManager = state.userManager;
      if (!userManager) {
        res.status(500).json({ success: false, message: 'User manager not initialized.' });
        return;
      }

      const tenantId = requireTenantId(req);
      const userId = validateUserId(req.params.id);
      assertUserInTenant(state, userId, tenantId);

      const user = userManager.updateUser(userId, req.body);
      if (!user) {
        res.status(404).json({ success: false, message: 'User not found.' });
        return;
      }

      await userManager.save();
      res.json({ success: true, user });
    } catch (error: unknown) {
      if (handleGuardError(res, error)) return;
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, message });
    }
  });

  /**
   * POST /api/users/:id/profiles — Add or update a profile access for a user.
   * Body: { profileName, accessMode, allowedTables?, allowedTools? }
   */
  app.post('/api/users/:id/profiles', async (req, res) => {
    try {
      const userManager = state.userManager;
      if (!userManager) {
        res.status(500).json({ success: false, message: 'User manager not initialized.' });
        return;
      }

      const profileParsed = addProfileSchema.safeParse(req.body);
      if (!profileParsed.success) {
        res.status(400).json({
          success: false,
          message: profileParsed.error.issues[0]?.message ?? 'Invalid request body',
          errors: profileParsed.error.issues,
        });
        return;
      }

      const tenantId = requireTenantId(req);
      const userId = validateUserId(req.params.id);
      assertUserInTenant(state, userId, tenantId);

      const { profileName, accessMode, allowedTables, allowedTools } = profileParsed.data;

      const user = userManager.addProfileAccess(userId, {
        profileName,
        allowedTables: allowedTables ?? null,
        allowedTools: allowedTools ?? null,
        accessMode: accessMode as AccessMode,
      });

      if (!user) {
        res.status(404).json({ success: false, message: 'User not found.' });
        return;
      }

      await userManager.save();
      res.json({ success: true, user });
    } catch (error: unknown) {
      if (handleGuardError(res, error)) return;
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, message });
    }
  });

  /**
   * DELETE /api/users/:id/profiles/:profileName — Remove a profile access from a user.
   */
  app.delete('/api/users/:id/profiles/:profileName', async (req, res) => {
    try {
      const userManager = state.userManager;
      if (!userManager) {
        res.status(500).json({ success: false, message: 'User manager not initialized.' });
        return;
      }

      const tenantId = requireTenantId(req);
      const userId = validateUserId(req.params.id);
      assertUserInTenant(state, userId, tenantId);

      const user = userManager.removeProfileAccess(userId, req.params.profileName);
      if (!user) {
        res.status(404).json({ success: false, message: 'User not found.' });
        return;
      }

      await userManager.save();
      res.json({ success: true, user });
    } catch (error: unknown) {
      if (handleGuardError(res, error)) return;
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, message });
    }
  });

  /**
   * POST /api/users/:id/disable — Disable a user.
   */
  app.post('/api/users/:id/disable', async (req, res) => {
    try {
      const userManager = state.userManager;
      if (!userManager) {
        res.status(500).json({ success: false, message: 'User manager not initialized.' });
        return;
      }

      const tenantId = requireTenantId(req);
      const userId = validateUserId(req.params.id);
      assertUserInTenant(state, userId, tenantId);

      const { reason } = req.body as { reason?: string };
      const user = userManager.disableUser(userId, reason);
      if (!user) {
        res.status(404).json({ success: false, message: 'User not found.' });
        return;
      }

      await userManager.save();
      res.json({ success: true, user });
    } catch (error: unknown) {
      if (handleGuardError(res, error)) return;
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, message });
    }
  });

  /**
   * POST /api/users/:id/enable — Re-enable a disabled user (new token generated).
   */
  app.post('/api/users/:id/enable', async (req, res) => {
    try {
      const userManager = state.userManager;
      if (!userManager) {
        res.status(500).json({ success: false, message: 'User manager not initialized.' });
        return;
      }

      const tenantId = requireTenantId(req);
      const userId = validateUserId(req.params.id);
      assertUserInTenant(state, userId, tenantId);

      const result = userManager.enableUser(userId);
      if (!result) {
        res.status(404).json({ success: false, message: 'User not found.' });
        return;
      }

      await userManager.save();
      res.json({
        success: true,
        user: {
          id: result.id,
          name: result.name,
          email: result.email,
          status: result.status,
        },
        plaintextToken: result._plaintextToken,
      });
    } catch (error: unknown) {
      if (handleGuardError(res, error)) return;
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, message });
    }
  });

  /**
   * POST /api/users/:id/regenerate-token — Regenerate a user's token.
   */
  app.post('/api/users/:id/regenerate-token', async (req, res) => {
    try {
      const userManager = state.userManager;
      if (!userManager) {
        res.status(500).json({ success: false, message: 'User manager not initialized.' });
        return;
      }

      const tenantId = requireTenantId(req);
      const userId = validateUserId(req.params.id);
      assertUserInTenant(state, userId, tenantId);

      const result = userManager.regenerateToken(userId);
      if (!result) {
        res.status(404).json({ success: false, message: 'User not found.' });
        return;
      }

      await userManager.save();
      res.json({
        success: true,
        plaintextToken: result._plaintextToken,
      });
    } catch (error: unknown) {
      if (handleGuardError(res, error)) return;
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, message });
    }
  });

  /**
   * POST /api/users/:id/resend-invitation — Regenerate onboarding code and send invitation email.
   * Requires email service to be configured (CALAME_SMTP_HOST).
   */
  app.post('/api/users/:id/resend-invitation', async (req, res) => {
    try {
      const userManager = state.userManager;
      if (!userManager) {
        res.status(500).json({ success: false, message: 'User manager not initialized.' });
        return;
      }

      // Resolve email service — use state.emailService, or create one on the fly from SmtpConfigManager
      const resolvedEmailService = state.emailService ?? (() => {
        const smtpConfig = state.smtpConfigManager?.getConfig();
        return smtpConfig?.host ? EmailService.fromSmtpConfig(smtpConfig) : null;
      })();

      if (!resolvedEmailService) {
        res.status(503).json({
          success: false,
          message: 'Email service is not configured. Configure SMTP settings to enable email invitations.',
        });
        return;
      }

      const tenantId = requireTenantId(req);
      const userId = validateUserId(req.params.id);
      assertUserInTenant(state, userId, tenantId);

      const user = userManager.getUserById(userId);
      if (!user) {
        res.status(404).json({ success: false, message: 'User not found.' });
        return;
      }

      // Regenerate the onboarding code
      const updated = userManager.regenerateOnboardingCode(userId);
      if (!updated || !updated.onboardingCode) {
        res.status(500).json({ success: false, message: 'Failed to regenerate onboarding code.' });
        return;
      }
      await userManager.save();

      const onboardingUrl = `${buildBaseUrl(req)}/onboarding/${updated.onboardingCode}`;
      await resolvedEmailService.sendInvitation({
        email: updated.email,
        name: updated.name,
        onboardingUrl,
        profileNames: updated.profiles.map((p) => p.profileName),
      });

      res.json({ success: true, onboardingCode: updated.onboardingCode });
    } catch (error: unknown) {
      if (handleGuardError(res, error)) return;
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, message });
    }
  });

  /**
   * DELETE /api/users/:id — Permanently delete a user.
   */
  app.delete('/api/users/:id', async (req, res) => {
    try {
      const userManager = state.userManager;
      if (!userManager) {
        res.status(500).json({ success: false, message: 'User manager not initialized.' });
        return;
      }

      const tenantId = requireTenantId(req);
      const userId = validateUserId(req.params.id);
      assertUserInTenant(state, userId, tenantId);

      const deleted = userManager.deleteUser(userId);
      if (!deleted) {
        res.status(404).json({ success: false, message: 'User not found.' });
        return;
      }

      await userManager.save();

      if (state.auditLog) {
        state.auditLog.addEntry({
          profileName: '_admin',
          toolName: 'delete_user',
          toolArgs: { userId },
          result: 'success',
          resultSummary: `User ${userId} deleted`,
          durationMs: 0,
        });
        await state.auditLog.save();
      }

      res.json({ success: true });
    } catch (error: unknown) {
      if (handleGuardError(res, error)) return;
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, message });
    }
  });

  /**
   * POST /api/users/import — Bulk import/update users from CSV-like JSON array.
   * Admin only. Expects: { users: [{ email, name?, customAttributes?: {...} }] }
   * Upserts by email: creates new users or updates customAttributes of existing ones.
   */
  app.post('/api/users/import', async (req, res) => {
    try {
      const userManager = state.userManager;
      if (!userManager) {
        res.status(500).json({ success: false, message: 'User manager not initialized.' });
        return;
      }

      // Resolve the caller's tenant up front so every upsert below is
      // scoped to it — without this guard the route resolved users by a
      // global email lookup, allowing cross-tenant writes (IDOR).
      const tenantId = requireTenantId(req);

      const importParsed = importUsersSchema.safeParse(req.body);
      if (!importParsed.success) {
        res.status(400).json({
          success: false,
          message: importParsed.error.issues[0]?.message ?? 'Invalid request body',
          errors: importParsed.error.issues,
        });
        return;
      }

      const { users: importList, profileName, accessMode: rawAccessMode } = importParsed.data;

      if (importList.length > 10000) {
        res.status(400).json({ success: false, message: 'Maximum 10,000 users per import.' });
        return;
      }

      const accessMode: AccessMode = (rawAccessMode ?? 'both') as AccessMode;

      let created = 0;
      let updated = 0;
      const errors: Array<{ index: number; email?: string; reason: string }> = [];

      for (let i = 0; i < importList.length; i++) {
        const row = importList[i] as Record<string, unknown>;
        const email = typeof row.email === 'string' ? row.email.trim() : '';
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          errors.push({ index: i, email: email || undefined, reason: 'Invalid or missing email.' });
          continue;
        }

        const name = typeof row.name === 'string' ? row.name.trim() : email.split('@')[0];
        const customAttributes = (typeof row.customAttributes === 'object' && row.customAttributes !== null && !Array.isArray(row.customAttributes))
          ? row.customAttributes as Record<string, string>
          : null;

        try {
          // Tenant guard: email is globally unique, so an address owned by
          // another tenant must never be updated (or re-created) from here.
          const ownerTenant = userManager.getTenantIdByEmail(email);
          if (ownerTenant !== null && ownerTenant !== tenantId) {
            errors.push({ index: i, email, reason: 'Email belongs to another tenant.' });
            continue;
          }

          const existing = ownerTenant === tenantId ? userManager.getUserByEmail(email) : null;
          if (existing) {
            // Update customAttributes only
            userManager.updateUser(existing.id, { customAttributes });
            updated++;
          } else {
            // Create new user with the specified profile, scoped to the tenant
            const profiles: UserProfileAccess[] = profileName
              ? [{ profileName, allowedTables: null, allowedTools: null, accessMode }]
              : [];
            userManager.createUser({ name, email, role: 'user', profiles, customAttributes, tenantId });
            created++;
          }
        } catch (err) {
          errors.push({ index: i, email, reason: (err as Error).message });
        }
      }

      await userManager.save();
      res.json({ success: true, created, updated, errors });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, message });
    }
  });
}
