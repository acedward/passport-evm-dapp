// The `passport-call` authorisation for the account's gated actions (withdraw, append-inbox, and
// the two bridge starts, plan L-BRG):
// the customer signs ONLY the call's own EIP-712 typed data, and that one signature both
// authorises the relay to spend DUST on the call and becomes the circuit's signature argument
// (spec: one prompt per action; plan P1.3, L-ACC.4).
//
// The relay never trusts a digest it is sent. It reads the account's public state, rebuilds the
// digest from the call's arguments with the shared builder (@mnbank/core/passport, the pinned
// client's own code), recovers the signer's public point, and checks that:
//   - the signer is the `owner` the typed data names;
//   - the owner's rolling device entry at the given use counter is live on the account (so the
//     signer is a device of THIS account, and the counter is the one the circuit will consume);
//   - the signed auth nonce is the account's current one (a signature for an older state is
//     refused before any proof is spent on it; a used one can never verify again on chain);
//   - the digest has not been accepted already (a replay guard, released if the job fails).
// The executors run the same check again when the job starts, against the state at that moment.

import {
  AppendInboxPayloadSchema,
  BridgeDepositPayloadSchema,
  BridgeWithdrawPayloadSchema,
  PassportAuthSchema,
  WithdrawPayloadSchema,
  type AppendInboxPayload,
  type BridgeDepositPayload,
  type BridgeWithdrawPayload,
  type PassportAuth,
  type RelayActionName,
  type WithdrawPayload,
} from '@mnbank/core';

import type { AccountLedger, PassportRuntime } from './runtime.js';

export type GatedAction = Extract<RelayActionName, 'withdraw' | 'append-inbox' | 'bridge-deposit' | 'bridge-withdraw'>;

/** Every action a gated call's own Passport signature authorises. */
export const GATED_ACTIONS: readonly GatedAction[] = ['withdraw', 'append-inbox', 'bridge-deposit', 'bridge-withdraw'];

export const isGatedAction = (a: string): a is GatedAction => (GATED_ACTIONS as readonly string[]).includes(a);

export type GatedPayload<A extends GatedAction> = A extends 'withdraw'
  ? WithdrawPayload
  : A extends 'append-inbox'
    ? AppendInboxPayload
    : A extends 'bridge-deposit'
      ? BridgeDepositPayload
      : BridgeWithdrawPayload;

const SCHEMAS = {
  withdraw: WithdrawPayloadSchema,
  'append-inbox': AppendInboxPayloadSchema,
  'bridge-deposit': BridgeDepositPayloadSchema,
  'bridge-withdraw': BridgeWithdrawPayloadSchema,
} as const;

export interface GatedCheckOk<A extends GatedAction = GatedAction> {
  ok: true;
  account: string;
  signer: string;
  payload: GatedPayload<A>;
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

export interface GatedCheckFail {
  ok: false;
  code: 'malformed' | 'wrong-account' | 'wrong-signer' | 'expired' | 'bad-signature' | 'not-supported';
  reason: string;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Parse a gated action's body; null when it is not the action's shape. */
export function parseGatedPayload<A extends GatedAction>(action: A, payload: unknown): GatedPayload<A> | null {
  const r = SCHEMAS[action].safeParse(payload);
  return r.success ? (r.data as GatedPayload<A>) : null;
}

export async function checkGatedCall<A extends GatedAction>(
  runtime: PassportRuntime,
  action: A,
  accountRaw: string | undefined,
  payloadRaw: unknown,
  passportRaw: unknown,
): Promise<GatedCheckOk<A> | GatedCheckFail> {
  const account = (accountRaw ?? '').replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(account)) return { ok: false, code: 'malformed', reason: 'this action needs an account' };
  const payload = parseGatedPayload(action, payloadRaw);
  if (!payload) return { ok: false, code: 'malformed', reason: 'the action arguments are not valid' };
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

  const core = await import('@mnbank/core/passport/gated');
  const sigMod = await import('../../../vendor/passport/contract/src/wallet/evm-signature.js');
  const ctx = { account, authNonce: ledger.auth_nonce, evmDomainSalt: hex(ledger.evm_domain_salt) };
  let request;
  try {
    request =
      action === 'withdraw'
        ? core.withdrawRequest(payload as WithdrawPayload)
        : action === 'append-inbox'
          ? core.appendInboxRequest(payload as AppendInboxPayload)
          : action === 'bridge-deposit'
            ? core.bridgeDepositStartRequest(payload as BridgeDepositPayload)
            : core.bridgeWithdrawStartRequest(payload as BridgeWithdrawPayload);
  } catch {
    return { ok: false, code: 'malformed', reason: 'the call arguments do not form a valid Passport call' };
  }
  const call = core.gatedCall(ctx, passport.owner, request);

  let point: { x: bigint; y: bigint; identity: false };
  let sig: { r: bigint; s: bigint };
  try {
    const parsed = sigMod.lowS(sigMod.parseSignature(Buffer.from(passport.signature.slice(2), 'hex')));
    const p = sigMod.recoverPoint(call.digest, parsed);
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
    digestHex: call.digestHex,
    ledger,
  };
}
