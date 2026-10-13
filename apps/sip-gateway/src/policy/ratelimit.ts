import type { Clock } from '@winsendotai/ovo-contracts';

/** A token bucket: `rate` tokens per second, at most `burst` saved up. */
export class TokenBucket {
  private tokens: number;
  private at: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly clock: Clock,
  ) {
    this.tokens = burst;
    this.at = clock.now();
  }

  take(cost = 1): boolean {
    const now = this.clock.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/**
 * Buckets per key (source address, trunk id). Idle keys are forgotten after a minute, and the map
 * is capped so a spray of sources cannot grow it without bound.
 */
export class KeyedBuckets {
  private readonly buckets = new Map<string, { bucket: TokenBucket; seen: number }>();

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly clock: Clock,
    private readonly maxKeys = 10_000,
  ) {}

  take(key: string): boolean {
    const now = this.clock.now();
    let entry = this.buckets.get(key);
    if (!entry) {
      if (this.buckets.size >= this.maxKeys) this.prune(now);
      if (this.buckets.size >= this.maxKeys) return false;
      entry = { bucket: new TokenBucket(this.rate, this.burst, this.clock), seen: now };
      this.buckets.set(key, entry);
    }
    entry.seen = now;
    return entry.bucket.take();
  }

  private prune(now: number): void {
    for (const [key, entry] of this.buckets)
      if (now - entry.seen > 60_000) this.buckets.delete(key);
  }
}

/** §4.7 defaults: INVITE 5/s burst 10 and all requests 50/s per source. */
export function sourceLimits(clock: Clock) {
  return {
    invite: new KeyedBuckets(5, 10, clock),
    all: new KeyedBuckets(50, 100, clock),
  };
}
