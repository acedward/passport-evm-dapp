// Relay-issued, single-use nonces for RelayAction authorisations (packages/core/src/auth.ts).
//
// The store lives in memory only. A nonce the relay did not issue, or issued before a restart,
// is unknown and refused, so a signature can be accepted at most once, ever. A used nonce is
// remembered until it would have expired, so a replay is reported as a replay.

import { randomBytes } from 'node:crypto';

export class NonceStore {
  private readonly issued = new Map<string, number>();
  private readonly used = new Map<string, number>();

  constructor(
    private readonly ttlSeconds: number,
    private readonly maxIssued: number,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  issue(): { nonce: string; expiresAt: number } {
    this.sweep();
    while (this.issued.size >= this.maxIssued) {
      const oldest = this.issued.keys().next().value;
      if (oldest === undefined) break;
      this.issued.delete(oldest);
    }
    const nonce = `0x${randomBytes(32).toString('hex')}`;
    const expiresAt = this.now() + this.ttlSeconds;
    this.issued.set(nonce, expiresAt);
    return { nonce, expiresAt };
  }

  consume(nonce: string): 'ok' | 'unknown' | 'used' {
    const key = nonce.toLowerCase();
    const now = this.now();
    if (this.used.has(key)) return 'used';
    const expiresAt = this.issued.get(key);
    if (expiresAt === undefined || expiresAt <= now) {
      this.issued.delete(key);
      return 'unknown';
    }
    this.issued.delete(key);
    this.used.set(key, expiresAt);
    return 'ok';
  }

  get size(): { issued: number; used: number } {
    return { issued: this.issued.size, used: this.used.size };
  }

  sweep(): void {
    const now = this.now();
    for (const [n, exp] of this.issued) if (exp <= now) this.issued.delete(n);
    for (const [n, exp] of this.used) if (exp <= now) this.used.delete(n);
  }
}
