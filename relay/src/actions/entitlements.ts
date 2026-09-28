// Sponsored inbox appends (security review F-B3).
//
// `append-inbox` files a 192-byte entry sealed to the account's own key: the bank cannot read it,
// so it cannot tell a real change coin from junk. It therefore sponsors an append ONLY against a
// single-use ENTITLEMENT it issued itself, when it ran an operation that left a coin of the account
// without a correct inbox entry:
//   - a withdrawal to a wallet with change (`withdraw_shielded_with_evm` files no entry for it);
//   - a bridge withdrawal start with change (it files 192 zero bytes);
//   - a bridge settle whose entry does not describe the coin it minted.
//
// The relay keeps no per-customer record (Q5, FR-003). The entitlement is a token the browser keeps
// with the coin: `ae1.<account>.<op>.<expiry>.<mac>`, where `op` identifies the operation (a hash of
// its kind and transaction id) and `mac` is HMAC-SHA256 over the network, account, op and expiry
// with a key derived from the sponsor seed, so tokens survive a relay restart and cannot be forged.
//
// Single use: an admitted token's op is held while its job runs, marked spent when the append
// succeeds, and released when it fails (so the customer can retry). Spent ops are remembered in
// memory until their token expires. A restart forgets them, so a per-account daily budget of
// admitted appends is the backstop.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { APPEND_ENTITLEMENT_PATTERN } from '@mnbank/core';

import type { AdmissionOutcome } from './admission.js';

export interface AppendEntitlementOptions {
  /** The MAC key (see `entitlementKey`). */
  key: Uint8Array;
  network: string;
  /** How long an issued entitlement stays valid (seconds). */
  ttlSeconds: number;
  /** The most appends admitted per account in any rolling 24 hours (the backstop). */
  maxPerAccountPerDay: number;
  now?: () => number;
}

export type EntitlementCheck = { ok: true; op: string; expiresAt: number } | { ok: false; reason: string };

const DAY = 86_400;
const MAC_LABEL = 'mn-bank relay: append-inbox entitlement v1';

/** The MAC key: derived from the sponsor seed (stable across restarts), or random without one. */
export function entitlementKey(sponsorSeedHex: string | null): Uint8Array {
  if (!sponsorSeedHex) return randomBytes(32);
  return createHmac('sha256', Buffer.from(sponsorSeedHex, 'hex'))
    .update('mn-bank relay: append-inbox entitlement key v1')
    .digest();
}

const normAccount = (a: string | undefined) => (a ?? '').replace(/^0x/, '').toLowerCase();

export class AppendEntitlements {
  private readonly now: () => number;
  /** Ops whose append is queued or running. */
  private readonly pending = new Set<string>();
  /** Ops whose append succeeded → the token's expiry (unix s). */
  private readonly spent = new Map<string, number>();
  /** Account → the unix seconds of each append admitted in the last 24 h. */
  private readonly admitted = new Map<string, number[]>();

  constructor(private readonly opts: AppendEntitlementOptions) {
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private mac(account: string, op: string, expiry: number): string {
    return createHmac('sha256', this.opts.key)
      .update(`${MAC_LABEL}|${this.opts.network}|${account}|${op}|${expiry}`)
      .digest('hex');
  }

  /** Issue the entitlement for one operation of `account` (`source`: its kind and transaction id). */
  issue(account: string, source: string): string {
    const acc = normAccount(account);
    const op = createHash('sha256').update(`${MAC_LABEL}|op|${source}`).digest('hex');
    const expiry = this.now() + this.opts.ttlSeconds;
    return `ae1.${acc}.${op}.${expiry}.${this.mac(acc, op, expiry)}`;
  }

  /** Whether `token` is a valid, unexpired entitlement of `account` (MAC and expiry only). */
  verify(token: unknown, account: string | undefined): EntitlementCheck {
    if (typeof token !== 'string' || !APPEND_ENTITLEMENT_PATTERN.test(token)) {
      return { ok: false, reason: 'no entitlement: the bank files an inbox entry only for change it recorded' };
    }
    const [, acc, op, exp, mac] = token.split('.') as [string, string, string, string, string];
    const expiresAt = Number(exp);
    const want = Buffer.from(this.mac(acc, op, expiresAt), 'hex');
    if (!timingSafeEqual(want, Buffer.from(mac, 'hex'))) {
      return { ok: false, reason: 'the entitlement was not issued by this bank' };
    }
    if (acc !== normAccount(account)) return { ok: false, reason: 'the entitlement is for another account' };
    if (expiresAt <= this.now()) return { ok: false, reason: 'the entitlement has expired' };
    return { ok: true, op, expiresAt };
  }

  /**
   * Admission of an append (before any queue slot, proof or DUST): a valid entitlement of this
   * account, not spent and not already in use, within the account's daily budget. The op is held
   * until `spend` or `release`.
   */
  admit(token: unknown, account: string | undefined): AdmissionOutcome {
    this.sweep();
    const v = this.verify(token, account);
    if (!v.ok) return { ok: false, status: 403, code: 'no-entitlement', reason: v.reason };
    if (this.spent.has(v.op) || this.pending.has(v.op)) {
      return {
        ok: false,
        status: 403,
        code: 'no-entitlement',
        reason: 'this change was already filed (the entitlement is single use)',
      };
    }
    const acc = normAccount(account);
    const times = this.admitted.get(acc) ?? [];
    if (times.length >= this.opts.maxPerAccountPerDay) {
      return {
        ok: false,
        status: 429,
        code: 'append-budget',
        reason: `this account has filed ${times.length} inbox entries in the last 24 hours, the most the bank pays for; try again tomorrow`,
      };
    }
    times.push(this.now());
    this.admitted.set(acc, times);
    this.pending.add(v.op);
    return { ok: true, release: () => this.pending.delete(v.op) };
  }

  /** The op of a well-formed token (no checks), or null. */
  opOf(token: unknown): string | null {
    return typeof token === 'string' && APPEND_ENTITLEMENT_PATTERN.test(token) ? token.split('.')[2]! : null;
  }

  /** The append landed: the token can never be used again (until it expires anyway). */
  spend(token: unknown): void {
    const op = this.opOf(token);
    if (!op) return;
    this.pending.delete(op);
    this.spent.set(op, Number((token as string).split('.')[3]));
  }

  /** The append failed: the customer may try again with the same token. */
  release(token: unknown): void {
    const op = this.opOf(token);
    if (op) this.pending.delete(op);
  }

  private sweep(): void {
    const now = this.now();
    for (const [op, exp] of this.spent) if (exp <= now) this.spent.delete(op);
    for (const [acc, times] of this.admitted) {
      const recent = times.filter((t) => t > now - DAY);
      if (recent.length === 0) this.admitted.delete(acc);
      else if (recent.length !== times.length) this.admitted.set(acc, recent);
    }
  }
}
