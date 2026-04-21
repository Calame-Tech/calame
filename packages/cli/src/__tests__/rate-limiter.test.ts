import { describe, it, expect, beforeEach } from 'vitest';
import { TokenRateLimiter } from '../rate-limiter.js';

describe('TokenRateLimiter', () => {
  let limiter: TokenRateLimiter;

  beforeEach(() => {
    limiter = new TokenRateLimiter();
  });

  describe('unlimited mode (limitRpm = 0)', () => {
    it('always allows when limitRpm is 0', () => {
      const result = limiter.check('user-1', 0);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(Infinity);
      expect(result.retryAfterMs).toBe(0);
    });

    it('always allows when limitRpm is undefined', () => {
      const result = limiter.check('user-1', undefined);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(Infinity);
      expect(result.retryAfterMs).toBe(0);
    });

    it('always allows repeated calls when limitRpm is 0', () => {
      for (let i = 0; i < 100; i++) {
        const result = limiter.check('user-1', 0);
        expect(result.allowed).toBe(true);
      }
    });
  });

  describe('sliding window enforcement', () => {
    it('allows requests up to the limit', () => {
      const limit = 5;
      for (let i = 0; i < limit; i++) {
        const result = limiter.check('user-1', limit);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(limit - i - 1);
      }
    });

    it('rejects the request that exceeds the limit', () => {
      const limit = 3;
      for (let i = 0; i < limit; i++) {
        limiter.check('user-1', limit);
      }
      const result = limiter.check('user-1', limit);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it('tracks different token IDs independently', () => {
      const limit = 2;
      // Exhaust user-1
      limiter.check('user-1', limit);
      limiter.check('user-1', limit);
      const blockedResult = limiter.check('user-1', limit);
      expect(blockedResult.allowed).toBe(false);

      // user-2 should still be allowed
      const allowedResult = limiter.check('user-2', limit);
      expect(allowedResult.allowed).toBe(true);
    });

    it('returns retryAfterMs > 0 when blocked', () => {
      const limit = 1;
      limiter.check('user-1', limit);
      const result = limiter.check('user-1', limit);
      expect(result.retryAfterMs).toBeGreaterThan(0);
      // Should not exceed the window (60s = 60_000ms)
      expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);
    });
  });

  describe('clear()', () => {
    it('removes tracking for a specific token', () => {
      const limit = 1;
      limiter.check('user-1', limit);
      // Blocked
      expect(limiter.check('user-1', limit).allowed).toBe(false);

      // After clearing, should be allowed again
      limiter.clear('user-1');
      expect(limiter.check('user-1', limit).allowed).toBe(true);
    });

    it('does not affect other tokens', () => {
      const limit = 1;
      limiter.check('user-1', limit);
      limiter.check('user-2', limit);

      limiter.clear('user-1');

      // user-2 is still tracked and blocked
      expect(limiter.check('user-2', limit).allowed).toBe(false);
    });
  });

  describe('clearAll()', () => {
    it('removes all tracking state', () => {
      const limit = 1;
      limiter.check('user-1', limit);
      limiter.check('user-2', limit);

      limiter.clearAll();

      expect(limiter.check('user-1', limit).allowed).toBe(true);
      expect(limiter.check('user-2', limit).allowed).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles limitRpm of 1 correctly (single request allowed)', () => {
      expect(limiter.check('user-x', 1).allowed).toBe(true);
      expect(limiter.check('user-x', 1).allowed).toBe(false);
    });

    it('remaining count decrements correctly', () => {
      const limit = 4;
      expect(limiter.check('u', limit).remaining).toBe(3);
      expect(limiter.check('u', limit).remaining).toBe(2);
      expect(limiter.check('u', limit).remaining).toBe(1);
      expect(limiter.check('u', limit).remaining).toBe(0);
    });
  });
});
