import crypto from 'crypto';
import type { Database } from 'better-sqlite3';
import type { Request, Response, NextFunction } from 'express';
import type { CalameDatabase } from './database.js';
import { hashToken } from './crypto.js';
import type { UserManager } from './user.js';
import { parseCookies } from './utils/cookies.js';

export interface Session {
  id: string;
  /** User ID if this is a user session. Null for legacy admin sessions. */
  userId: string | null;
  createdAt: number;
  expiresAt: number;
}

const ADMIN_COOKIE = 'calame_session';
const USER_COOKIE = 'calame_user_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
/**
 * Absolute lifetime of a session, whatever its renewals: past this point the
 * user must log in again even if the app was opened every day.
 */
const SESSION_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Session store. Without a database (unit tests, early boot) sessions live in
 * memory only. Once {@link configureSessionStore} is called they are persisted
 * in the `auth_sessions` table so they survive a server restart — the desktop
 * app restarts its sidecar on every launch. Only the SHA-256 hash of the
 * session ID is stored: the raw ID exists solely in the httpOnly cookie.
 */
interface StoredSession {
  userId: string | null;
  createdAt: number;
  expiresAt: number;
}

const memorySessions = new Map<string, StoredSession>();
let sessionDb: Database | null = null;

/** The configured database while it is still open, else null (in-memory). */
function store(): Database | null {
  return sessionDb?.open ? sessionDb : null;
}

/** Persist sessions in `database` (or back to in-memory only with `null`). */
export function configureSessionStore(database: CalameDatabase | null): void {
  sessionDb = database?.raw ?? null;
  if (sessionDb) {
    sessionDb.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(Date.now());
  }
}

function readStored(idHash: string): StoredSession | null {
  const db = store();
  if (!db) return memorySessions.get(idHash) ?? null;
  const row = db
    .prepare('SELECT user_id, created_at, expires_at FROM auth_sessions WHERE id_hash = ?')
    .get(idHash) as { user_id: string | null; created_at: number; expires_at: number } | undefined;
  return row ? { userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at } : null;
}

function writeStored(idHash: string, stored: StoredSession): void {
  const db = store();
  if (!db) {
    memorySessions.set(idHash, stored);
    return;
  }
  db.prepare(
    `INSERT OR REPLACE INTO auth_sessions (id_hash, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
  ).run(idHash, stored.userId, stored.createdAt, stored.expiresAt);
}

function deleteStored(idHash: string): void {
  const db = store();
  if (!db) {
    memorySessions.delete(idHash);
    return;
  }
  db.prepare('DELETE FROM auth_sessions WHERE id_hash = ?').run(idHash);
}

/** Brute-force protection: track failed login attempts by IP. */
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 1000; // 1 minute

/**
 * @deprecated Admin auth now uses accounts stored in calame-users.json.
 * Kept temporarily for deprecation warning at startup.
 */
export function getAdminPassword(): string | null {
  return process.env.CALAME_ADMIN_PASSWORD ?? null;
}

/**
 * Create a new session. Pass userId for user sessions, omit for admin sessions.
 */
export function createSession(userId?: string): string {
  const id = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  writeStored(hashToken(id), {
    userId: userId ?? null,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });
  return id;
}

/**
 * Validate a session ID.
 */
export function validateSession(sessionId: string): Session | null {
  const idHash = hashToken(sessionId);
  const stored = readStored(idHash);
  if (!stored) return null;
  if (Date.now() > stored.expiresAt) {
    deleteStored(idHash);
    return null;
  }
  return { id: sessionId, ...stored };
}

/**
 * Sliding renewal: push a valid session's expiry back to a full TTL, capped
 * at {@link SESSION_MAX_LIFETIME_MS} after its creation. Returns the renewed
 * session, or null when it is unknown, expired or revoked.
 */
export function renewSession(sessionId: string): Session | null {
  const session = validateSession(sessionId);
  if (!session) return null;
  const expiresAt = Math.min(
    Date.now() + SESSION_TTL_MS,
    session.createdAt + SESSION_MAX_LIFETIME_MS,
  );
  if (expiresAt > session.expiresAt) {
    writeStored(hashToken(sessionId), {
      userId: session.userId,
      createdAt: session.createdAt,
      expiresAt,
    });
    return { ...session, expiresAt };
  }
  return session;
}

/**
 * Validate a user session (must have userId).
 */
export function validateUserSession(sessionId: string): Session | null {
  const session = validateSession(sessionId);
  if (!session || !session.userId) return null;
  return session;
}

/**
 * Destroy a session.
 */
export function destroySession(sessionId: string): void {
  deleteStored(hashToken(sessionId));
}

/**
 * Revoke every session of `userId` (e.g. after a password change), except
 * the optional `keepSessionId` the caller is currently using.
 */
export function destroyUserSessions(userId: string, keepSessionId?: string): void {
  const keepHash = keepSessionId ? hashToken(keepSessionId) : null;
  const db = store();
  if (!db) {
    for (const [idHash, stored] of memorySessions) {
      if (stored.userId === userId && idHash !== keepHash) memorySessions.delete(idHash);
    }
    return;
  }
  db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND id_hash IS NOT ?').run(
    userId,
    keepHash,
  );
}

// --- Rate limiting ---

export function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || now > record.resetAt) return false;
  return record.count >= MAX_ATTEMPTS;
}

export function recordFailedAttempt(ip: string): void {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || now > record.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    record.count++;
  }
}

export function clearFailedAttempts(ip: string): void {
  loginAttempts.delete(ip);
}

// --- Cookie helpers ---

function cookieOptions(maxAge = SESSION_TTL_MS) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    maxAge,
    path: '/',
  };
}

export function setSessionCookie(res: Response, sessionId: string, expiresAt?: number): void {
  const maxAge = expiresAt === undefined ? SESSION_TTL_MS : Math.max(0, expiresAt - Date.now());
  res.cookie(ADMIN_COOKIE, sessionId, cookieOptions(maxAge));
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(ADMIN_COOKIE, cookieOptions());
}

export function setUserSessionCookie(res: Response, sessionId: string): void {
  res.cookie(USER_COOKIE, sessionId, cookieOptions());
}

export function clearUserSessionCookie(res: Response): void {
  res.clearCookie(USER_COOKIE, cookieOptions());
}

// --- Middleware ---

/**
 * Factory that creates the admin session middleware.
 * Requires a valid session with an active admin user.
 * Excludes: /api/auth/*, /mcp/*, /welcome/*, /api/onboarding/*
 */
export function createAdminSessionMiddleware(userManager: UserManager) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const path = req.path;
    if (
      path.startsWith('/api/auth/') ||
      path.startsWith('/mcp/') ||
      path.startsWith('/welcome/') ||
      path.startsWith('/api/onboarding/') ||
      path.startsWith('/api/chat-profile/') ||
      path.startsWith('/api/chat-auth/')
    ) {
      next();
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[ADMIN_COOKIE];
    if (!sessionId) {
      res.status(401).json({ success: false, message: 'Authentication required.' });
      return;
    }

    const session = validateSession(sessionId);
    if (!session) {
      res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
      return;
    }

    // Verify the session belongs to an active admin user
    if (!session.userId) {
      res.status(401).json({ success: false, message: 'Invalid session. Please log in again.' });
      return;
    }

    const user = userManager.getUserById(session.userId);
    if (!user || user.role !== 'admin' || user.status !== 'active') {
      res.status(403).json({ success: false, message: 'Admin access required.' });
      return;
    }

    next();
  };
}

/**
 * @deprecated Use createAdminSessionMiddleware instead.
 */
export function requireAdminSession(req: Request, res: Response, next: NextFunction): void {
  // Legacy fallback — should not be used
  next();
}
