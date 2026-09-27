// The bridge service's links to the Passport runtime: re-verifying a start's own signature when
// its turn comes, and checking that a resume comes from a device of the account.

import type { BridgeDepositPayload, BridgeWithdrawPayload } from '@mnbank/core';

import { checkGatedCall } from '../passport/gated-verify.js';
import type { PassportRuntime } from '../passport/runtime.js';
import { PublicError } from '../queue/jobs.js';
import type { VerifiedStart } from './service.js';

/**
 * A start was verified when it was accepted; by the time its lane frees up, the account may have
 * made another gated call (the signed auth nonce is then stale, and the circuit would refuse it).
 * Checked again here, before any proof is spent.
 */
export function gatedStartVerifier(runtime: () => PassportRuntime | null) {
  const verify = async <A extends 'bridge-deposit' | 'bridge-withdraw', P>(
    action: A,
    raw: unknown,
  ): Promise<VerifiedStart<P>> => {
    const rt = runtime();
    if (!rt)
      throw new PublicError('not-available', 'the bank cannot run account operations right now (no prover keys)');
    const body = raw as { account?: string; passportAuth?: unknown };
    const { account: _a, passportAuth: _p, signer: _s, auth: _auth, ...payload } = raw as Record<string, unknown>;
    const check = await checkGatedCall(rt, action, body.account, payload, body.passportAuth);
    if (!check.ok) {
      throw new PublicError(
        check.code === 'expired' ? 'stale-authorisation' : 'unauthorised',
        check.code === 'expired'
          ? 'your account made another signed call since you signed this one: sign it again'
          : check.reason,
      );
    }
    return {
      account: check.account,
      payload: check.payload as unknown as P,
      auth: check.auth,
      digestHex: check.digestHex,
    };
  };
  return {
    deposit: (raw: unknown) => verify<'bridge-deposit', BridgeDepositPayload>('bridge-deposit', raw),
    withdraw: (raw: unknown) => verify<'bridge-withdraw', BridgeWithdrawPayload>('bridge-withdraw', raw),
  };
}

/** Whether `signer` is a live device of `account` (any use counter). */
export function deviceChecker(runtime: () => PassportRuntime | null) {
  return async (account: string, signer: string): Promise<boolean> => {
    const rt = runtime();
    if (!rt) return false;
    const l = await rt.ledgerState(account);
    if (!l || !l.booted) return false;
    const core = await import('@mnbank/core/passport/gated');
    const devices = [...l.devices].map((d) => Buffer.from(d).toString('hex'));
    return core.findEvmUseCounter(devices, account, signer, l.device_epoch) !== null;
  };
}
