// The `passport-call` authorisation of the two trade actions (plan L-TRD): `open-swap` (make) and
// `take`. Both are one `open_swap_shielded_with_evm` call, signed by the customer as the contract's
// own OpenSwapShielded typed data, so every trade is ONE wallet prompt; that signature both
// authorises the relay to prove the call and becomes the circuit's signature argument.
//
// The same rules as the other gated calls (../passport/gated-verify.ts): the digest is rebuilt from
// the arguments and the account's CURRENT public state (never trusted from the request), the signer
// must be the named owner, the owner's rolling device entry at the given use counter must be live,
// and the signed auth nonce must be the account's current one. A replay guard sits on top
// (../auth/passport-call.ts).

import {
  OpenSwapPayloadSchema,
  PassportAuthSchema,
  TakePayloadSchema,
  type OpenSwapPayload,
  type PassportAuth,
  type TakePayload,
} from '@mnbank/core';

import type { GatedCheckFail } from '../passport/gated-verify.js';
import type { AccountLedger, PassportRuntime } from '../passport/runtime.js';

export type TradeAction = 'open-swap' | 'take';

export const isTradeAction = (a: string): a is TradeAction => a === 'open-swap' || a === 'take';

export type TradePayload<A extends TradeAction> = A extends 'take' ? TakePayload : OpenSwapPayload;

export interface TradeCheckOk<A extends TradeAction = TradeAction> {
  ok: true;
  account: string;
  signer: string;
  payload: TradePayload<A>;
  passport: PassportAuth;
  /** The circuit's trailing authorisation arguments (`pk`, `use_counter`, `sig`). */
  auth: {
    arm: 'evm';
    pk: { x: bigint; y: bigint; identity: false };
    use_counter: bigint;
    sig: { r: bigint; s: bigint };
  };
  digestHex: string;
  ledger: AccountLedger;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

export function parseTradePayload<A extends TradeAction>(action: A, payload: unknown): TradePayload<A> | null {
  const r = (action === 'take' ? TakePayloadSchema : OpenSwapPayloadSchema).safeParse(payload);
  return r.success ? (r.data as TradePayload<A>) : null;
}

export async function checkTradeCall<A extends TradeAction>(
  runtime: PassportRuntime,
  action: A,
  accountRaw: string | undefined,
  payloadRaw: unknown,
  passportRaw: unknown,
): Promise<TradeCheckOk<A> | GatedCheckFail> {
  const account = (accountRaw ?? '').replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(account)) return { ok: false, code: 'malformed', reason: 'this action needs an account' };
  const payload = parseTradePayload(action, payloadRaw);
  if (!payload) return { ok: false, code: 'malformed', reason: 'the offer arguments are not valid' };
  if (BigInt(payload.giveAmount) <= 0n || BigInt(payload.wantAmount) <= 0n) {
    return { ok: false, code: 'malformed', reason: 'an offer needs two non-zero legs' };
  }
  if (payload.giveColor.replace(/^0x/, '').toLowerCase() === payload.wantColor.replace(/^0x/, '').toLowerCase()) {
    return { ok: false, code: 'malformed', reason: 'an offer swaps two different tokens' };
  }
  const pa = PassportAuthSchema.safeParse(passportRaw);
  if (!pa.success)
    return { ok: false, code: 'malformed', reason: 'the Passport authorisation is missing or malformed' };
  const passport = pa.data;

  const ledger = await runtime.ledgerState(account);
  if (!ledger || !ledger.booted)
    return { ok: false, code: 'wrong-account', reason: 'no active account at this address' };
  if (ledger.auth_nonce !== BigInt(payload.authNonce)) {
    return { ok: false, code: 'expired', reason: 'the authorisation is for an older account state; sign again' };
  }

  const core = await import('@mnbank/core/passport');
  const sigMod = await import('../../../vendor/passport/contract/src/wallet/evm-signature.js');
  const ctx = { account, authNonce: ledger.auth_nonce, evmDomainSalt: hex(ledger.evm_domain_salt) };
  let digest: Uint8Array;
  let digestHex: string;
  try {
    const call = core.openSwapGatedCall(ctx, passport.owner, payload);
    digest = call.digest;
    digestHex = call.digestHex;
  } catch {
    return { ok: false, code: 'malformed', reason: 'the call arguments do not form a valid Passport call' };
  }

  let point: { x: bigint; y: bigint; identity: false };
  let sig: { r: bigint; s: bigint };
  try {
    const parsed = sigMod.lowS(sigMod.parseSignature(Buffer.from(passport.signature.slice(2), 'hex')));
    const p = sigMod.recoverPoint(digest, parsed);
    point = { x: p.x, y: p.y, identity: false };
    sig = { r: parsed.r, s: parsed.s };
  } catch {
    return { ok: false, code: 'bad-signature', reason: 'the signature is not valid' };
  }
  const recovered = `0x${hex(sigMod.ethereumAddress(point))}`;
  if (recovered !== passport.owner.toLowerCase()) {
    return { ok: false, code: 'wrong-signer', reason: 'the signature is not from the named device' };
  }
  const entry = core.evmDeviceEntry(account, passport.owner, ledger.device_epoch, BigInt(passport.useCounter));
  if (!ledger.devices.member(Uint8Array.from(Buffer.from(entry, 'hex')))) {
    return {
      ok: false,
      code: 'wrong-signer',
      reason: 'the signer is not a live device of this account at that counter',
    };
  }
  return {
    ok: true,
    account,
    signer: recovered,
    payload,
    passport,
    auth: {
      arm: 'evm',
      pk: { x: point.x, y: point.y, identity: false },
      use_counter: BigInt(passport.useCounter),
      sig,
    },
    digestHex,
    ledger,
  };
}
