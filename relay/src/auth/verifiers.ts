// How a state-changing request proves who asked for it. Every action route declares one of two
// kinds, and the route refuses the request unless it verifies (plan P1.3, spec FR-013).
//
// 1. `relay-action`: a RelayAction EIP-712 signature (packages/core/src/auth.ts) over the action,
//    network, owner, account, a hash of the body, a relay-issued single-use nonce and an expiry.
//    Registration uses it, and it doubles as the enrolment (the device point is recovered from it),
//    so registering is one prompt.
//
// 2. `passport-call`: the gated call's OWN Passport EIP-712 signature (WithdrawShielded,
//    OpenSwapShielded, BridgeDepositStart, …), which the contract verifies anyway. Accepting it
//    here keeps every gated action to ONE wallet prompt (spec: "the customer signs once"). Its
//    replay protection is the account's on-chain `auth_nonce`: the relay checks that the signed
//    nonce is the current one and that the signer is a live device of the account, before it
//    spends a proof on the call, and remembers digests it has accepted until they are consumed.
//    The lanes supply each call's digest builder and the chain reads; until a lane does, an
//    action keeps `relay-action`.

import { recoverAddress, getAddress } from 'ethers';
import { verifyRelayAction, type AuthFailureCode, type RelayActionName } from '@mnbank/core';

import type { NonceStore } from './nonces.js';

export type AuthKind = 'relay-action' | 'passport-call';

export type VerifyOutcome =
  | { ok: true; signer: string; kind: AuthKind; account?: string }
  | { ok: false; code: AuthFailureCode | 'not-supported'; reason: string };

export interface RelayActionContext {
  action: RelayActionName;
  network: string;
  chainId: number;
  account?: string;
  payload: unknown;
  maxTtlSeconds: number;
  nonces: NonceStore;
  now?: number;
}

export function verifyRelayActionRequest(auth: unknown, ctx: RelayActionContext): VerifyOutcome {
  const r = verifyRelayAction(auth, {
    expectedAction: ctx.action,
    network: ctx.network,
    chainId: ctx.chainId,
    expectedAccount: ctx.account,
    payload: ctx.payload,
    maxTtlSeconds: ctx.maxTtlSeconds,
    now: ctx.now,
    consumeNonce: (nonce) => ctx.nonces.consume(nonce),
  });
  if (!r.ok) return r;
  return { ok: true, signer: r.signer, kind: 'relay-action', account: ctx.account };
}

// ── passport-call ───────────────────────────────────────────────────────────

/** What a lane provides to verify one gated call from its own request body. */
export interface PassportCallDigest {
  /** The Passport account (64 hex). */
  account: string;
  /** The EIP-712 digest the device signed, recomputed by the relay from the call arguments. */
  digest: Uint8Array;
  /** The `authNonce` the signed challenge binds (pre-increment). */
  authNonce: bigint;
}

/** Chain reads the passport-call check needs; the lanes implement them over the indexer. */
export interface AccountDirectory {
  isLiveDevice(account: string, evmAddress: string): Promise<boolean>;
  currentAuthNonce(account: string): Promise<bigint>;
}

/** Remembers accepted digests until their call lands (or a TTL), so a replay cannot queue a
 *  second proof of the same call. */
export class DigestReplayGuard {
  private readonly seen = new Map<string, number>();
  constructor(
    private readonly ttlSeconds: number,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}
  /** True if the digest was new (and is now remembered). */
  claim(digestHex: string): boolean {
    const now = this.now();
    for (const [d, exp] of this.seen) if (exp <= now) this.seen.delete(d);
    if (this.seen.has(digestHex)) return false;
    this.seen.set(digestHex, now + this.ttlSeconds);
    return true;
  }
}

const hex = (b: Uint8Array) => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;

export async function verifyPassportCall(
  input: { signature: unknown; expectedAccount?: string },
  digestOf: () => PassportCallDigest,
  directory: AccountDirectory,
  replay: DigestReplayGuard,
): Promise<VerifyOutcome> {
  if (typeof input.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(input.signature)) {
    return { ok: false, code: 'malformed', reason: 'the Passport authorisation is missing or malformed' };
  }
  let call: PassportCallDigest;
  try {
    call = digestOf();
  } catch {
    return { ok: false, code: 'malformed', reason: 'the call arguments do not form a valid Passport call' };
  }
  const account = call.account.replace(/^0x/, '').toLowerCase();
  if (input.expectedAccount !== undefined && input.expectedAccount.replace(/^0x/, '').toLowerCase() !== account) {
    return { ok: false, code: 'wrong-account', reason: 'signed for another account' };
  }
  let signer: string;
  try {
    signer = getAddress(recoverAddress(hex(call.digest), input.signature));
  } catch {
    return { ok: false, code: 'bad-signature', reason: 'the signature is not valid' };
  }
  if (!(await directory.isLiveDevice(account, signer))) {
    return { ok: false, code: 'wrong-signer', reason: 'the signer is not a live device of this account' };
  }
  if ((await directory.currentAuthNonce(account)) !== call.authNonce) {
    return { ok: false, code: 'expired', reason: 'the authorisation is for an older account state; sign again' };
  }
  if (!replay.claim(hex(call.digest)))
    return { ok: false, code: 'replayed', reason: 'this authorisation was already used' };
  return { ok: true, signer, kind: 'passport-call', account };
}
