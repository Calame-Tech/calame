/**
 * Sliding-window token rate limiter.
 *
 * Tracks request timestamps in memory per token/user ID.
 * Stale entries (older than the window) are purged on every check.
 */
export class TokenRateLimiter {
  /** Window duration in milliseconds (60 seconds). */
  private readonly windowMs = 60_000;

  /** Map from tokenId to array of request timestamps within the current window. */
  private readonly windows: Map<string, number[]> = new Map();

  /**
   * Check whether a request from `tokenId` is allowed under `limitRpm`.
   *
   * Returns:
   *   - `allowed`       — whether the request should proceed
   *   - `remaining`     — how many requests remain in the current window
   *   - `retryAfterMs`  — milliseconds until the oldest request leaves the window
   *                       (0 when allowed)
   */
  check(
    tokenId: string,
    limitRpm: number | undefined,
  ): { allowed: boolean; remaining: number; retryAfterMs: number } {
    // limitRpm === 0 or undefined means unlimited
    if (!limitRpm || limitRpm <= 0) {
      return { allowed: true, remaining: Infinity, retryAfterMs: 0 };
    }

    const now = Date.now();
    const cutoff = now - this.windowMs;

    // Retrieve and prune old timestamps
    const timestamps = (this.windows.get(tokenId) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= limitRpm) {
      // Oldest timestamp still inside the window — compute when it expires
      const oldestInWindow = timestamps[0];
      const retryAfterMs = oldestInWindow + this.windowMs - now;
      this.windows.set(tokenId, timestamps);
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, retryAfterMs) };
    }

    // Allow: record this request
    timestamps.push(now);
    this.windows.set(tokenId, timestamps);

    return {
      allowed: true,
      remaining: limitRpm - timestamps.length,
      retryAfterMs: 0,
    };
  }

  /** Remove all tracking state for a token (e.g., on token deletion). */
  clear(tokenId: string): void {
    this.windows.delete(tokenId);
  }

  /** Remove all in-memory state (useful in tests). */
  clearAll(): void {
    this.windows.clear();
  }
}
