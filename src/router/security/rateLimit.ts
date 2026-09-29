/**
 * Per-key request rate limiting.
 *
 * A tunnelled router is on the public internet with real provider spend behind
 * it, and the virtual key is the only thing between a script and the user's
 * credit card. A token bucket is the right size of defence: it bounds the
 * damage a leaked key can do without needing to know who the caller is.
 *
 * Deliberately NOT a quota or a billing system. There is one bucket per
 * virtual key, it is in memory, and it resets on restart. Anything more would
 * be a multi-tenant design, which is explicitly out of scope.
 *
 * In-memory on purpose: a persisted counter means a restart could be used to
 * evade the limit, which is exactly the attack this guards against.
 */

export interface RateLimitOptions {
  /** Sustained requests per minute. */
  perMinute: number;
  /** Bucket depth. Bursts up to this are allowed, then the sustained rate
   * applies. Defaults to the per-minute value, which is the intuitive
   * "one request per second either way" shape. */
  burst?: number;
  /** Injectable clock, so the tests do not sleep. */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = { perMinute: 60 };

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly burst: number;
  private readonly perMs: number;

  constructor(private readonly opts: RateLimitOptions = DEFAULT_RATE_LIMIT) {
    this.now = opts.now ?? Date.now;
    this.burst = opts.burst ?? opts.perMinute;
    this.perMs = opts.perMinute / 60_000;
  }

  /** Tokens added per millisecond, times elapsed, capped at the burst depth. */
  private refill(bucket: Bucket, at: number): void {
    const elapsed = Math.max(0, at - bucket.lastRefillMs);
    bucket.tokens = Math.min(this.burst, bucket.tokens + elapsed * this.perMs);
    bucket.lastRefillMs = at;
  }

  /**
   * Consume one token. Returns whether the request is allowed, plus what the
   * caller should send in `Retry-After`.
   */
  take(key: string, cost = 1): { allowed: boolean; retryAfterSeconds: number; remaining: number } {
    const at = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.burst, lastRefillMs: at };
      this.buckets.set(key, bucket);
    }
    this.refill(bucket, at);

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { allowed: true, retryAfterSeconds: 0, remaining: Math.floor(bucket.tokens) };
    }

    const deficit = cost - bucket.tokens;
    const retryAfterSeconds = Math.max(1, Math.ceil(deficit / this.perMs / 1000));
    return { allowed: false, retryAfterSeconds, remaining: 0 };
  }

  /** Drop buckets for keys that have been idle, so the map cannot grow forever. */
  sweep(idleMs = 600_000): number {
    const at = this.now();
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (at - bucket.lastRefillMs > idleMs) {
        this.buckets.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.buckets.size;
  }
}
