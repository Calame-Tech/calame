import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
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

/** In-memory session store. Cleared on process restart (intentional — forces re-login). */
const sessions = new Map<string, Session>();

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
  sessions.set(id, {
    id,
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
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    return null;
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
  sessions.delete(sessionId);
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

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    maxAge: SESSION_TTL_MS,
    path: '/',
  };
}

export function setSessionCookie(res: Response, sessionId: string): void {
  res.cookie(ADMIN_COOKIE, sessionId, cookieOptions());
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
