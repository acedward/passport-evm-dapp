// Token-bucket rate limits, in memory, per key (a client address or an owner address).

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly maxKeys = 100_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Take one token for `key`. When refused, `retryAfterSeconds` says when one is back. */
  take(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const now = this.now();
    const ratePerMs = this.perMinute / 60_000;
    let b = this.buckets.get(key);
    if (b) {
      b.tokens = Math.min(this.perMinute, b.tokens + (now - b.at) * ratePerMs);
      b.at = now;
      this.buckets.delete(key); // re-insert: Map order doubles as least-recently-used order
    } else {
      b = { tokens: this.perMinute, at: now };
      while (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next().value;
        if (oldest === undefined) break;
        this.buckets.delete(oldest);
      }
    }
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - b.tokens) / ratePerMs / 1000)) };
  }

  get size(): number {
    return this.buckets.size;
  }
}
