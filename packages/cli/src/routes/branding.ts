import { Router, type Express, type Request, type Response } from 'express';
import type { AppState } from '../state.js';
import { parseCookies } from '../utils/cookies.js';
import { validateSession } from '../session.js';
import { getTenantId } from '../tenancy.js';

const ADMIN_COOKIE = 'calame_session';

/** ~1.5 MB cap on inline data-URL images to keep the single JSON row small. */
const MAX_IMAGE_LEN = 1_500_000;

type ValidationError = { error: string };
function isError(v: unknown): v is ValidationError {
  return typeof v === 'object' && v !== null && 'error' in v;
}

/**
 * Logo / favicon must be a self-contained base64 `data:` URL of a raster image
 * type, or null. External http(s) URLs are rejected on purpose: the value is
 * rendered in <img> on the public, pre-login pages, so an external URL would be
 * a tracking/phishing beacon. SVG is excluded because an SVG data URL can carry
 * script (stored-XSS vector). The settings UI only ever produces data URLs.
 */
const ALLOWED_IMAGE_TYPES =
  /^data:image\/(png|jpe?g|gif|webp|x-icon|vnd\.microsoft\.icon);base64,/i;
function validateImage(value: unknown, field: string): string | null | ValidationError {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return { error: `${field} must be a string or null` };
  if (value.length > MAX_IMAGE_LEN) return { error: `${field} is too large (max ~1.5 MB)` };
  if (!ALLOWED_IMAGE_TYPES.test(value)) {
    return { error: `${field} must be a base64 data:image URL (png, jpeg, gif, webp, or ico)` };
  }
  return value;
}

/** Resolve the active admin user from the session cookie, or null. */
function getAdminUser(req: Request, state: AppState) {
  const sessionId = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
  const session = sessionId ? validateSession(sessionId) : null;
  const user = session?.userId ? state.userManager?.getUserById(session.userId) : null;
  return user && user.role === 'admin' && user.status === 'active' ? user : null;
}

/** Accent color must be a `#rgb` or `#rrggbb` hex string, or null. */
const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
function validateColor(value: unknown, field: string): string | null | ValidationError {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return { error: `${field} must be a string or null` };
  if (!HEX_COLOR.test(value)) {
    return { error: `${field} must be a hex color like #5c7cfa` };
  }
  return value;
}

/** Font family is a free-form CSS font-family value (name, optionally with fallbacks). */
const MAX_FONT_LEN = 200;
function validateFont(value: unknown, field: string): string | null | ValidationError {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return { error: `${field} must be a string or null` };
  if (value.length > MAX_FONT_LEN) return { error: `${field} is too long (max ${MAX_FONT_LEN})` };
  return value;
}

const EMPTY = {
  logo: null,
  favicon: null,
  accentColor: null,
  fontFamily: null,
  updatedAt: null,
} as const;

/**
 * /api/branding
 * GET  — public: returns the current tenant's branding (logo is needed pre-login).
 * POST — admin only: updates the current tenant's branding.
 *
 * Registered before the global `/api` admin middleware so GET stays public; the
 * POST handler therefore enforces the admin session itself.
 */
export function registerBrandingRoutes(app: Express, state: AppState) {
  const router = Router();

  router.get('/', (req: Request, res: Response) => {
    const db = state.db?.raw;
    if (!db) return res.json(EMPTY);
    const tenantId = getTenantId(req);
    const row = db.prepare('SELECT value FROM branding WHERE key = ?').get(tenantId) as
      | { value: string }
      | undefined;
    if (!row) return res.json(EMPTY);
    try {
      const data = JSON.parse(row.value) as Partial<typeof EMPTY>;
      res.json({
        logo: data.logo ?? null,
        favicon: data.favicon ?? null,
        accentColor: data.accentColor ?? null,
        fontFamily: data.fontFamily ?? null,
        updatedAt: data.updatedAt ?? null,
      });
    } catch {
      res.json(EMPTY);
    }
  });

  router.post('/', (req: Request, res: Response) => {
    // Admin auth — this route is mounted before the global /api admin middleware.
    if (!getAdminUser(req, state)) {
      const authenticated = Boolean(parseCookies(req.headers.cookie)[ADMIN_COOKIE]);
      return res
        .status(authenticated ? 403 : 401)
        .json({ error: authenticated ? 'Admin access required.' : 'Authentication required.' });
    }

    const db = state.db?.raw;
    if (!db) return res.status(500).json({ error: 'Database not available' });

    const body = (req.body ?? {}) as {
      logo?: unknown;
      favicon?: unknown;
      accentColor?: unknown;
      fontFamily?: unknown;
    };

    const logo = validateImage(body.logo, 'logo');
    if (isError(logo)) return res.status(400).json(logo);
    const favicon = validateImage(body.favicon, 'favicon');
    if (isError(favicon)) return res.status(400).json(favicon);
    const accentColor = validateColor(body.accentColor, 'accentColor');
    if (isError(accentColor)) return res.status(400).json(accentColor);
    const fontFamily = validateFont(body.fontFamily, 'fontFamily');
    if (isError(fontFamily)) return res.status(400).json(fontFamily);

    const tenantId = getTenantId(req);
    const updatedAt = new Date().toISOString();
    const payload = { logo, favicon, accentColor, fontFamily, updatedAt };
    db.prepare('INSERT OR REPLACE INTO branding (key, value) VALUES (?, ?)').run(
      tenantId,
      JSON.stringify(payload),
    );
    res.json(payload);
  });

  app.use('/api/branding', router);
}
