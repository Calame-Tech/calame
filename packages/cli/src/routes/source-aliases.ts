import type { RequestHandler } from 'express';

/**
 * Sunset date for the legacy `/api/connections/*` and `/api/rag/*` path prefixes.
 * These paths will be redirected to `/api/sources/db/connections/*` and
 * `/api/sources/rag/*` respectively once Phase 3 reorganises the route files.
 *
 * TODO(Phase 3): flip this middleware from logger-only to actual path rewriting
 * once the canonical `/api/sources/<kind>/*` route handlers exist.
 */
const SUNSET_DATE = '2026-12-31';

/**
 * De-duplication set: each unique `METHOD:path` combination is logged exactly
 * once per process lifetime, not per request. This avoids log spam when a
 * client makes repeated calls to a deprecated path.
 */
const seenPaths = new Set<string>();

/**
 * Legacy path deprecation middleware.
 *
 * Phase 2 behaviour (logger-only):
 *  - Sets `Sunset: <date>` response header on requests to deprecated paths.
 *  - Logs a deprecation warning once per unique `METHOD:path` combination.
 *  - Passes the request through to today's handler unchanged.
 *
 * The canonical paths (`/api/sources/db/connections/*`, `/api/sources/rag/*`)
 * do not exist yet — actual URL rewriting is deferred to Phase 3.
 *
 * Deprecated paths monitored:
 *  - /api/connections/* → future: /api/sources/db/connections/*
 *  - /api/rag/*         → future: /api/sources/rag/*
 */
export function legacyPathDeprecationMiddleware(): RequestHandler {
  return (req, res, next) => {
    const isLegacy =
      req.path.startsWith('/api/connections') || req.path.startsWith('/api/rag/');

    if (isLegacy) {
      res.setHeader('Sunset', SUNSET_DATE);

      const key = `${req.method}:${req.path}`;
      if (!seenPaths.has(key)) {
        seenPaths.add(key);
        // eslint-disable-next-line no-console
        console.warn(
          `[source-aliases] Deprecated route used: ${key}. ` +
            `Migrate to /api/sources/* (Sunset: ${SUNSET_DATE}).`,
        );
      }
    }

    next();
  };
}

/** Visible for testing only — clears the de-duplication set between test runs. */
export function _resetSeenPaths(): void {
  seenPaths.clear();
}
