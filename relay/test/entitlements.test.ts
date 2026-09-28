// Security review F-B3: the single-use entitlements that `append-inbox` needs (relay/src/actions/
// entitlements.ts). The route-level tests are in routes-production.test.ts and gated-verify.test.ts.

import { describe, expect, it } from 'vitest';

import { AppendEntitlements, entitlementKey } from '../src/actions/entitlements.js';
import { testEntitlements } from './harness.js';

const ACC = 'a1'.repeat(32);

describe('append-inbox entitlements', () => {
  it('verifies only its own tokens, for their account, until they expire', () => {
    let now = 1_000;
    const e = testEntitlements({ ttlSeconds: 3600, now: () => now });
    const token = e.issue(ACC, 'withdraw:tx');
    expect(token).toMatch(/^ae1\.[0-9a-f]{64}\.[0-9a-f]{64}\.4600\.[0-9a-f]{64}$/);
    expect(e.verify(token, ACC)).toMatchObject({ ok: true, expiresAt: 4600 });
    expect(e.verify(token, `0x${ACC}`)).toMatchObject({ ok: true });
    expect(e.verify(token, 'b2'.repeat(32))).toMatchObject({ ok: false });
    expect(e.verify(token.replace('.4600.', '.9999.'), ACC)).toMatchObject({ ok: false }); // expiry is MACed
    expect(e.verify(undefined, ACC)).toMatchObject({ ok: false });
    expect(e.verify('ae1.junk', ACC)).toMatchObject({ ok: false });
    // another network, or another key: not ours
    expect(testEntitlements({ network: 'stagenet', now: () => now }).verify(token, ACC)).toMatchObject({ ok: false });
    expect(testEntitlements({ key: new Uint8Array(32), now: () => now }).verify(token, ACC)).toMatchObject({
      ok: false,
    });
    now = 4600;
    expect(e.verify(token, ACC)).toMatchObject({ ok: false, reason: 'the entitlement has expired' });
  });

  it('is single use: held while its append runs, given back when it fails, spent when it lands', () => {
    const e = testEntitlements();
    const token = e.issue(ACC, 'withdraw:tx');
    const first = e.admit(token, ACC);
    expect(first.ok).toBe(true);
    expect(e.admit(token, ACC)).toMatchObject({ ok: false, status: 403, code: 'no-entitlement' });
    e.release(token);
    expect(e.admit(token, ACC).ok).toBe(true);
    e.spend(token);
    expect(e.admit(token, ACC)).toMatchObject({ ok: false, code: 'no-entitlement' });
    // Two tokens for the same operation are one entitlement.
    expect(e.admit(e.issue(ACC, 'withdraw:tx'), ACC)).toMatchObject({ ok: false });
    // A queue refusal hands it back through the admission's own release.
    const other = e.issue(ACC, 'withdraw:tx-2');
    const a = e.admit(other, ACC);
    if (a.ok) a.release?.();
    expect(e.admit(other, ACC).ok).toBe(true);
  });

  it('caps admitted appends per account in any rolling 24 hours', () => {
    let now = 10_000;
    const e = testEntitlements({ maxPerAccountPerDay: 2, now: () => now });
    expect(e.admit(e.issue(ACC, 'a'), ACC).ok).toBe(true);
    expect(e.admit(e.issue(ACC, 'b'), ACC).ok).toBe(true);
    expect(e.admit(e.issue(ACC, 'c'), ACC)).toMatchObject({ ok: false, status: 429, code: 'append-budget' });
    expect(e.admit(e.issue('c3'.repeat(32), 'd'), 'c3'.repeat(32)).ok).toBe(true); // per account
    now += 86_400;
    expect(e.admit(e.issue(ACC, 'e'), ACC).ok).toBe(true);
  });

  it("counts only QUEUED appends: an admission's release gives the day's charge back, once (F-B7)", () => {
    let now = 50_000;
    const e = testEntitlements({ maxPerAccountPerDay: 2, now: () => now });
    const token = e.issue(ACC, 'withdraw:busy');
    // Refused after admission (a full queue), five times: nothing charged.
    for (let i = 0; i < 5; i++) {
      const a = e.admit(token, ACC);
      expect(a.ok).toBe(true);
      if (a.ok) {
        a.release?.();
        a.release?.(); // idempotent: a second call gives back nothing more
      }
    }
    // The full allowance is there: this one is queued, and its job fails later.
    const queued = e.admit(token, ACC);
    expect(queued.ok).toBe(true);
    e.release(token); // the job failed: the entitlement comes back, the charge stays
    expect(e.admit(token, ACC).ok).toBe(true); // the retry, queued: the second charge
    const over = e.admit(e.issue(ACC, 'withdraw:other'), ACC);
    expect(over).toMatchObject({ ok: false, status: 429, code: 'append-budget' });
    if (!over.ok) {
      expect(over.reason).toContain('2 inbox appends queued');
      expect(over.reason).toContain('about 24 hours');
      expect(over.reason).not.toMatch(/filed/);
    }
    now += 86_400 - 3_599;
    const soon = e.admit(e.issue(ACC, 'withdraw:third'), ACC);
    expect(soon.ok).toBe(false);
    if (!soon.ok) expect(soon.reason).toMatch(/about 1 hour$/);
    now += 3_600;
    expect(e.admit(e.issue(ACC, 'withdraw:fourth'), ACC).ok).toBe(true);
  });

  it('derives its key from the sponsor seed, so tokens survive a restart', () => {
    const seed = 'fa'.repeat(32);
    const before = new AppendEntitlements({
      key: entitlementKey(seed),
      network: 'n',
      ttlSeconds: 60,
      maxPerAccountPerDay: 1,
    });
    const after = new AppendEntitlements({
      key: entitlementKey(seed),
      network: 'n',
      ttlSeconds: 60,
      maxPerAccountPerDay: 1,
    });
    expect(after.verify(before.issue(ACC, 'x'), ACC).ok).toBe(true);
    expect(Buffer.from(entitlementKey(seed)).toString('hex')).not.toContain(seed);
    const random = new AppendEntitlements({
      key: entitlementKey(null),
      network: 'n',
      ttlSeconds: 60,
      maxPerAccountPerDay: 1,
    });
    expect(random.verify(before.issue(ACC, 'x'), ACC).ok).toBe(false);
  });
});
