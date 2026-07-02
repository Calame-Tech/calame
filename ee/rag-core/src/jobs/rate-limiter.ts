// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { createHash } from 'node:crypto';

/**
 * Per-(type, credentialKey) rate parameters for the token bucket. `capacity`
 * is the maximum burst the bucket can hold; `refillPerSec` is the steady-state
 * fill rate. Together they encode a token-bucket configuration:
 *
 *   - allow up to `capacity` requests instantaneously,
 *   - then sustain `refillPerSec` requests/second.
 */
export interface RateLimit {
  capacity: number;
  refillPerSec: number;
}

/**
 * Audit hook entry shape — mirrors {@link import('./poll-scheduler.js').PollAuditEntry}
 * so the host can pipe rate-limit events through the same audit surface as the
 * other jobs.
 */
export interface RateLimitAuditEntry {
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

/**
 * Dependencies for the {@link RateLimiter}.
 *
 * `limits` lets the host override the defaults from {@link DEFAULT_LIMITS}.
 * Keys are the connector `type` strings (`'s3'`, `'gdrive'`, `'notion'`,
 * `'sharepoint'`, `'http'`, `'cohere'`). Unknown types fall back to a generous
 * `100/sec` so a new connector never silently saturates an upstream quota
 * because we forgot to add it here.
 *
 * `onAudit` is invoked whenever a call had to wait (i.e. `waitMs > 0`).
 * The payload includes the (hashed) credential key so operators can tell
 * which tenant / account is being throttled without leaking secrets.
 */
export interface RateLimiterDeps {
  /** Per-type override map. Merged with {@link DEFAULT_LIMITS}. */
  limits?: Partial<Record<string, RateLimit>>;
  /** Audit hook fired whenever a call had to wait for tokens. */
  onAudit?: (event: RateLimitAuditEntry) => void;
}

/** Internal bucket state for a single `(type, credentialKey)` pair. */
interface Bucket {
  tokens: number;
  capacity: number;
  refillPerSec: number;
  lastRefillMs: number;
}

/**
 * Sensible per-API defaults based on the providers' published quotas. These
 * are deliberately conservative — they leave plenty of headroom for the host
 * server's own traffic patterns. Admins can override via env vars or by
 * passing custom `limits` to the constructor.
 *
 * Quotas referenced (May 2026 — verify before changing):
 *   - Notion:     3 req/sec average, occasional spike tolerance (capacity=9).
 *                 https://developers.notion.com/reference/request-limits
 *   - Cohere:     trial keys are 10 req/min; production keys are 1000+/min.
 *                 Defaulting to 1/sec keeps trial keys safe and is well below
 *                 any prod ceiling. https://docs.cohere.com/docs/rate-limits
 *   - SharePoint: 10 000 requests per 10 minutes per app per tenant
 *                 (≈ 16.6/sec). We default a touch under, with a small burst.
 *                 https://learn.microsoft.com/graph/throttling-limits
 *   - GDrive:     1000 queries per 100s per user (= 10/sec). Default 8/sec
 *                 leaves room for the SDK's own bookkeeping requests.
 *                 https://developers.google.com/drive/api/guides/limits
 *   - GSheets:    Sheets API allows 60 read requests per minute per user
 *                 (= 1/sec) by default. We share the bucket between Sheets +
 *                 Drive calls inside the connector since both APIs draw
 *                 against the same per-project ceiling.
 *                 https://developers.google.com/sheets/api/limits
 *   - S3:         no documented per-API hard limit, but per-partition caps of
 *                 ~3500 PUT/COPY/POST/DELETE and ~5500 GET/sec apply.
 *                 50/sec is a conservative default for a single source.
 *                 https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html
 *   - HTTP:       generic. 5/sec per host is polite for arbitrary third-party
 *                 servers; admins can lift it per-source via env override.
 */
export const DEFAULT_LIMITS: Record<string, RateLimit> = {
  notion: { capacity: 9, refillPerSec: 3 },
  cohere: { capacity: 5, refillPerSec: 1 },
  sharepoint: { capacity: 50, refillPerSec: 15 },
  gdrive: { capacity: 20, refillPerSec: 8 },
  gsheets: { capacity: 6, refillPerSec: 1 },
  s3: { capacity: 100, refillPerSec: 50 },
  http: { capacity: 10, refillPerSec: 5 },
};

/** Fallback for unknown types — generous enough to not surprise a new connector. */
const FALLBACK_LIMIT: RateLimit = { capacity: 100, refillPerSec: 100 };

/**
 * Hash a credential key so the audit log can identify the throttled
 * (type, credential) pair without leaking the credential itself. We keep the
 * first 12 hex chars of the SHA-256 — enough to disambiguate in practice but
 * useless for reconstructing the secret.
 */
function hashCredentialKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/**
 * Token-bucket rate limiter for outbound API calls made by connectors.
 *
 * **Model**: independent buckets keyed by `(type, credentialKey)`. Two S3
 * sources with different access keys get separate buckets and thus don't
 * compete for tokens; two HTTP sources hitting the same host share one (when
 * the connector passes the host as the credentialKey — see `HttpConnector`).
 *
 * **Algorithm** (`acquire(type, key, n)`):
 *   1. Look up or lazily create the bucket for `(type, key)`. Lazy creation
 *      consults `limits[type]` (constructor override) → `DEFAULT_LIMITS[type]`
 *      → `FALLBACK_LIMIT`.
 *   2. Refill: `tokens += (now - lastRefillMs) * refillPerSec / 1000`,
 *      capped at `capacity`. Update `lastRefillMs = now`.
 *   3. If `tokens >= n`: consume `n` tokens, return 0 (no wait).
 *   4. Otherwise: compute the wait time needed for `n - tokens` tokens to
 *      regenerate at `refillPerSec`, sleep that long via `setTimeout`, then
 *      refill+consume and return the (positive) `waitMs` for observability.
 *
 * **Concurrency**: multiple parallel `acquire` calls on the same bucket are
 * serialized via a tiny per-bucket FIFO promise chain. This guarantees fair
 * ordering — a caller that arrives first gets tokens first — without any
 * external locks. The chain is per-bucket so unrelated buckets never block
 * each other.
 *
 * **Cost**: O(1) per acquire after the bucket exists. The first acquire on a
 * fresh `(type, key)` pair allocates one `Bucket` record (~5 numbers).
 *
 * **No persistence**: state lives only in memory, like `SyncQueue` and the
 * other in-process job primitives. Restart resets every bucket.
 *
 * **Not distributed**: a future multi-process deployment would need a Redis-
 * backed limiter to honor the upstream API quotas globally. Single-process is
 * sufficient for the MVP.
 */
export class RateLimiter {
  #buckets: Map<string, Bucket> = new Map();
  #queues: Map<string, Promise<void>> = new Map();
  readonly #limits: Partial<Record<string, RateLimit>>;
  readonly #onAudit: ((event: RateLimitAuditEntry) => void) | undefined;
  /** Injectable clock for tests — defaults to `Date.now`. */
  #now: () => number;
  /** Injectable timer for tests — defaults to `setTimeout`. */
  #sleep: (ms: number) => Promise<void>;

  constructor(deps: RateLimiterDeps = {}) {
    this.#limits = deps.limits ?? {};
    this.#onAudit = deps.onAudit;
    this.#now = () => Date.now();
    this.#sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Acquire `n` tokens for the given `(type, credentialKey)` bucket. Awaits
   * until enough tokens are available; resolves to the wait time in ms (0 if
   * none was needed) for observability.
   *
   * Parallel `acquire` calls on the same bucket are serialized FIFO — the
   * first caller to invoke `acquire` is the first to actually consume
   * tokens, even if other callers arrive while it's awaiting.
   *
   * `n` defaults to 1. Callers that issue batch operations (e.g. a single
   * Graph request that returns a 200-item page) can request more tokens to
   * model the upstream cost more accurately, but the default suffices for
   * the per-API-call pattern.
   */
  async acquire(type: string, credentialKey: string, n: number = 1): Promise<number> {
    if (n <= 0) return 0;
    const bucketKey = `${type} ${credentialKey}`;

    // Serialize per-bucket so parallel callers see FIFO ordering. A no-op
    // `prev` is used when the bucket has no in-flight queue.
    const prev = this.#queues.get(bucketKey) ?? Promise.resolve();

    // `next` resolves when *this* call has actually finished acquiring its
    // tokens (including any sleep). We expose its waitMs via the outer
    // promise; the queue itself stores a void-typed promise so it can be
    // awaited from the next call without leaking the wait time.
    let waitMs = 0;
    const next = prev.then(async () => {
      waitMs = await this.#tryAcquire(type, credentialKey, n);
    });

    this.#queues.set(bucketKey, next);
    // Clean up the queue entry once *we* are the tail — keeps the map small
    // and avoids retaining promises forever for buckets that go quiet.
    next
      .finally(() => {
        if (this.#queues.get(bucketKey) === next) {
          this.#queues.delete(bucketKey);
        }
      })
      .catch(() => undefined); // safety against unhandled-rejection warnings

    await next;
    return waitMs;
  }

  /**
   * Test-only: peek at the current state of a bucket. Returns `null` if the
   * bucket has never been touched.
   */
  inspect(type: string, credentialKey: string): Bucket | null {
    const bucketKey = `${type} ${credentialKey}`;
    const bucket = this.#buckets.get(bucketKey);
    if (!bucket) return null;
    // Force a refill so callers see an up-to-date snapshot.
    this.#refill(bucket);
    return { ...bucket };
  }

  /** Reset all buckets and queues. Used by tests for isolation. */
  reset(): void {
    this.#buckets.clear();
    this.#queues.clear();
  }

  /**
   * Test-only: install a fake clock + sleep so the suite can drive timing
   * deterministically without `vi.useFakeTimers()` (which doesn't compose
   * cleanly with the per-bucket promise chain).
   */
  __installFakeClock(now: () => number, sleep: (ms: number) => Promise<void>): void {
    this.#now = now;
    this.#sleep = sleep;
  }

  // -- internals -----------------------------------------------------------

  #getOrCreateBucket(type: string, credentialKey: string): Bucket {
    const bucketKey = `${type} ${credentialKey}`;
    const existing = this.#buckets.get(bucketKey);
    if (existing) return existing;
    const limit = this.#limits[type] ?? DEFAULT_LIMITS[type] ?? FALLBACK_LIMIT;
    const bucket: Bucket = {
      tokens: limit.capacity,
      capacity: limit.capacity,
      refillPerSec: limit.refillPerSec,
      lastRefillMs: this.#now(),
    };
    this.#buckets.set(bucketKey, bucket);
    return bucket;
  }

  #refill(bucket: Bucket): void {
    const now = this.#now();
    const elapsedMs = now - bucket.lastRefillMs;
    if (elapsedMs <= 0) return;
    const added = (elapsedMs * bucket.refillPerSec) / 1000;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + added);
    bucket.lastRefillMs = now;
  }

  async #tryAcquire(type: string, credentialKey: string, n: number): Promise<number> {
    const bucket = this.#getOrCreateBucket(type, credentialKey);
    this.#refill(bucket);

    if (bucket.tokens >= n) {
      bucket.tokens -= n;
      return 0;
    }

    // Need to wait for `(n - tokens)` more tokens at refillPerSec.
    const deficit = n - bucket.tokens;
    // Avoid divide-by-zero on a misconfigured zero-refill bucket — treat
    // it as "wait forever, but capped at a few seconds" to surface the
    // misconfig without freezing the worker.
    const safeRefill = bucket.refillPerSec > 0 ? bucket.refillPerSec : 1;
    const waitMs = Math.ceil((deficit / safeRefill) * 1000);

    // Emit the audit event BEFORE sleeping so operators see the throttle
    // in real time, not after the wait clears.
    this.#onAudit?.({
      type: 'rate_limit.throttled',
      payload: {
        connectorType: type,
        credentialKeyHash: hashCredentialKey(credentialKey),
        waitMs,
        requestedTokens: n,
        availableTokens: bucket.tokens,
        capacity: bucket.capacity,
        refillPerSec: bucket.refillPerSec,
      },
      timestamp: new Date().toISOString(),
    });

    await this.#sleep(waitMs);

    // Refill + consume. After the sleep we should have at least `n` tokens
    // unless someone reset the bucket — defensive clamp to 0 if so.
    this.#refill(bucket);
    bucket.tokens = Math.max(0, bucket.tokens - n);
    return waitMs;
  }
}
