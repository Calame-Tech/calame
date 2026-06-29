// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, vi } from 'vitest';

import { RateLimiter, DEFAULT_LIMITS, type RateLimitAuditEntry } from '../rate-limiter.js';

/**
 * Build a RateLimiter pre-wired with a fake clock + fake sleep. The fake clock
 * is advanced explicitly by tests; the fake sleep is just "advance the clock
 * by `ms`". This lets the limiter's `setTimeout`-based wait collapse to a
 * synchronous step without relying on `vi.useFakeTimers()`, which doesn't
 * compose cleanly with the per-bucket promise chain used inside the limiter.
 */
function makeLimiterWithFakeClock(deps: ConstructorParameters<typeof RateLimiter>[0] = {}) {
  let nowMs = 1_000_000_000_000; // arbitrary fixed epoch
  const limiter = new RateLimiter(deps);
  limiter.__installFakeClock(
    () => nowMs,
    async (ms: number) => {
      nowMs += ms;
    },
  );
  const advance = (ms: number): void => {
    nowMs += ms;
  };
  return { limiter, advance, getNow: () => nowMs };
}

describe('RateLimiter', () => {
  it('returns waitMs=0 when the bucket has enough tokens', async () => {
    const { limiter } = makeLimiterWithFakeClock();
    // notion default: capacity=9, refill=3/sec
    const waitMs = await limiter.acquire('notion', 'cred-A');
    expect(waitMs).toBe(0);

    const inspected = limiter.inspect('notion', 'cred-A');
    expect(inspected).not.toBeNull();
    expect(inspected!.tokens).toBe(8); // 9 - 1
    expect(inspected!.capacity).toBe(9);
    expect(inspected!.refillPerSec).toBe(3);
  });

  it('drains the bucket then waits for refill on the next acquire', async () => {
    const { limiter, advance } = makeLimiterWithFakeClock();
    // cohere default: capacity=5, refill=1/sec
    for (let i = 0; i < 5; i++) {
      const w = await limiter.acquire('cohere', 'cred-B');
      expect(w).toBe(0);
    }

    // 6th acquire: bucket empty, must wait for 1 token. With refill=1/sec
    // the deficit is 1 → expected waitMs = ceil(1000ms).
    const waitMs = await limiter.acquire('cohere', 'cred-B');
    expect(waitMs).toBeGreaterThanOrEqual(1000);
    expect(waitMs).toBeLessThan(1100);

    // And after a real refill window the next call should be immediate.
    advance(2_000);
    const w2 = await limiter.acquire('cohere', 'cred-B');
    expect(w2).toBe(0);
  });

  it('refills proportionally to elapsed time and caps at capacity', async () => {
    const { limiter, advance } = makeLimiterWithFakeClock();
    // notion: capacity=9, refill=3/sec
    // Drain to 0 by acquiring 9 in a row.
    for (let i = 0; i < 9; i++) {
      await limiter.acquire('notion', 'cred-C');
    }
    // Advance 1 second → expect ~3 tokens regenerated.
    advance(1_000);
    const inspected = limiter.inspect('notion', 'cred-C');
    // Inspect refills the bucket synchronously; tokens should be ~3.
    expect(inspected!.tokens).toBeCloseTo(3, 5);

    // Advance well past capacity (10 seconds). Should cap at 9.
    advance(10_000);
    const capped = limiter.inspect('notion', 'cred-C');
    expect(capped!.tokens).toBe(9);
  });

  it('keeps independent buckets per (type, credentialKey)', async () => {
    const { limiter } = makeLimiterWithFakeClock();
    // Drain cred-D entirely.
    for (let i = 0; i < 9; i++) {
      await limiter.acquire('notion', 'cred-D');
    }
    const drained = limiter.inspect('notion', 'cred-D');
    expect(drained!.tokens).toBeCloseTo(0, 5);

    // cred-E shares the same type but its own bucket — full capacity.
    const fresh = await limiter.acquire('notion', 'cred-E');
    expect(fresh).toBe(0);
    const credE = limiter.inspect('notion', 'cred-E');
    expect(credE!.tokens).toBe(8);
  });

  it('applies DEFAULT_LIMITS to known types lazily on first acquire', async () => {
    const { limiter } = makeLimiterWithFakeClock();
    await limiter.acquire('s3', 'cred-F');
    const s3 = limiter.inspect('s3', 'cred-F');
    expect(s3!.capacity).toBe(DEFAULT_LIMITS.s3!.capacity);
    expect(s3!.refillPerSec).toBe(DEFAULT_LIMITS.s3!.refillPerSec);

    await limiter.acquire('sharepoint', 'cred-G');
    const sp = limiter.inspect('sharepoint', 'cred-G');
    expect(sp!.capacity).toBe(DEFAULT_LIMITS.sharepoint!.capacity);
  });

  it('falls back to a generous default for unknown types', async () => {
    const { limiter } = makeLimiterWithFakeClock();
    await limiter.acquire('totally-new-type', 'cred-H');
    const bucket = limiter.inspect('totally-new-type', 'cred-H');
    // Fallback is 100/sec capacity=100 — see FALLBACK_LIMIT.
    expect(bucket!.capacity).toBe(100);
    expect(bucket!.refillPerSec).toBe(100);
  });

  it('emits a rate_limit.throttled audit event when a wait was required', async () => {
    const events: RateLimitAuditEntry[] = [];
    const { limiter } = makeLimiterWithFakeClock({
      onAudit: (e) => events.push(e),
    });
    // Drain cohere (cap=5).
    for (let i = 0; i < 5; i++) {
      await limiter.acquire('cohere', 'cred-I');
    }
    expect(events).toHaveLength(0);

    // This one throttles → exactly one audit event.
    await limiter.acquire('cohere', 'cred-I');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('rate_limit.throttled');
    expect(events[0]?.payload.connectorType).toBe('cohere');
    expect(typeof events[0]?.payload.waitMs).toBe('number');
    // Hash, not the raw credential.
    expect(events[0]?.payload.credentialKeyHash).not.toBe('cred-I');
    expect(typeof events[0]?.payload.credentialKeyHash).toBe('string');
  });

  it('reset() clears every bucket and queue', async () => {
    const { limiter } = makeLimiterWithFakeClock();
    await limiter.acquire('notion', 'cred-J');
    expect(limiter.inspect('notion', 'cred-J')).not.toBeNull();
    limiter.reset();
    expect(limiter.inspect('notion', 'cred-J')).toBeNull();
  });

  it('respects per-type overrides passed via constructor', async () => {
    const { limiter } = makeLimiterWithFakeClock({
      limits: { notion: { capacity: 2, refillPerSec: 1 } },
    });
    const bucket = (await limiter.acquire('notion', 'cred-K'), limiter.inspect('notion', 'cred-K'));
    expect(bucket!.capacity).toBe(2);
    expect(bucket!.refillPerSec).toBe(1);
  });

  it('serializes parallel acquires on the same bucket in FIFO order', async () => {
    const { limiter } = makeLimiterWithFakeClock({
      limits: { custom: { capacity: 3, refillPerSec: 10 } },
    });
    // Fire 5 concurrent acquires. With capacity=3 the first 3 resolve
    // immediately (waitMs=0). The 4th and 5th must each wait — and they
    // must resolve in the order they were issued.
    const labels: number[] = [];
    const inflight = [0, 1, 2, 3, 4].map((i) =>
      limiter.acquire('custom', 'cred-L').then((w) => {
        labels.push(i);
        return w;
      }),
    );
    const waits = await Promise.all(inflight);
    expect(waits.slice(0, 3)).toEqual([0, 0, 0]);
    expect(waits[3]).toBeGreaterThan(0);
    expect(waits[4]).toBeGreaterThan(0);
    expect(labels).toEqual([0, 1, 2, 3, 4]);
  });

  it('n=0 (or negative) is a no-op and never throttles', async () => {
    const { limiter } = makeLimiterWithFakeClock();
    // Drain notion first.
    for (let i = 0; i < 9; i++) await limiter.acquire('notion', 'cred-M');
    // A subsequent n=0 call must NOT block.
    const start = Date.now();
    const w = await limiter.acquire('notion', 'cred-M', 0);
    expect(w).toBe(0);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('inspect() reflects up-to-date bucket state including pending refill', async () => {
    const { limiter, advance } = makeLimiterWithFakeClock();
    await limiter.acquire('s3', 'cred-N');
    const before = limiter.inspect('s3', 'cred-N');
    expect(before!.tokens).toBe(DEFAULT_LIMITS.s3!.capacity - 1);
    advance(100); // 100ms × 50/sec = 5 tokens — capped at capacity (100).
    const after = limiter.inspect('s3', 'cred-N');
    // We're already 1 token below capacity; +5 caps at capacity.
    expect(after!.tokens).toBe(DEFAULT_LIMITS.s3!.capacity);
  });

  it('uses real setTimeout when no fake clock is installed', async () => {
    // This test guards the production wiring — without it we'd only ever
    // exercise the fake clock branch.
    const limiter = new RateLimiter({
      limits: { tiny: { capacity: 1, refillPerSec: 100 } }, // 1 token / 10ms
    });
    // Burn the lone token.
    await limiter.acquire('tiny', 'cred-O');
    // The next call must wait ~10ms.
    const start = Date.now();
    await limiter.acquire('tiny', 'cred-O');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(5); // allow scheduling slack
    expect(elapsed).toBeLessThan(200);
    vi.useRealTimers();
  });
});
