import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSession,
  validateSession,
  destroySession,
  isRateLimited,
  recordFailedAttempt,
  clearFailedAttempts,
} from '../session.js';

describe('Session management', () => {
  it('createSession returns a 64-char hex string', () => {
    const id = createSession();
    expect(id).toMatch(/^[a-f0-9]{64}$/);
  });

  it('validateSession returns session for valid ID', () => {
    const id = createSession();
    const session = validateSession(id);
    expect(session).not.toBeNull();
    expect(session!.id).toBe(id);
  });

  it('validateSession returns null for unknown ID', () => {
    expect(validateSession('nonexistent')).toBeNull();
  });

  it('destroySession invalidates the session', () => {
    const id = createSession();
    expect(validateSession(id)).not.toBeNull();

    destroySession(id);
    expect(validateSession(id)).toBeNull();
  });

  it('each createSession produces a unique ID', () => {
    const a = createSession();
    const b = createSession();
    expect(a).not.toBe(b);
  });
});

describe('Rate limiting', () => {
  const testIp = '192.168.1.' + Math.floor(Math.random() * 255);

  beforeEach(() => {
    clearFailedAttempts(testIp);
  });

  it('is not rate limited initially', () => {
    expect(isRateLimited(testIp)).toBe(false);
  });

  it('is not rate limited after fewer than 5 attempts', () => {
    for (let i = 0; i < 4; i++) {
      recordFailedAttempt(testIp);
    }
    expect(isRateLimited(testIp)).toBe(false);
  });

  it('is rate limited after 5 failed attempts', () => {
    for (let i = 0; i < 5; i++) {
      recordFailedAttempt(testIp);
    }
    expect(isRateLimited(testIp)).toBe(true);
  });

  it('clearFailedAttempts resets the counter', () => {
    for (let i = 0; i < 5; i++) {
      recordFailedAttempt(testIp);
    }
    expect(isRateLimited(testIp)).toBe(true);

    clearFailedAttempts(testIp);
    expect(isRateLimited(testIp)).toBe(false);
  });
});
