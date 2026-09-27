// The route-level `passport-call` authoriser (see ../passport/gated-verify.ts): a gated action is
// accepted when its own Passport signature verifies against the account's current state, and
// its digest has not been accepted before. The executor checks again when the job starts.

import type { ActionRequest } from '@mnbank/core';

import type { ActionDefinition } from '../actions/catalogue.js';
import { checkGatedCall } from '../passport/gated-verify.js';
import type { PassportRuntime } from '../passport/runtime.js';
import type { DigestReplayGuard, VerifyOutcome } from './verifiers.js';

export function passportCallAuthoriser(
  runtime: () => PassportRuntime | null,
  replay: DigestReplayGuard,
): (def: ActionDefinition, request: ActionRequest) => Promise<VerifyOutcome> {
  return async (def, request) => {
    if (def.action !== 'withdraw' && def.action !== 'append-inbox') {
      return { ok: false, code: 'not-supported', reason: 'this action is not authorised by a Passport signature' };
    }
    const rt = runtime();
    if (!rt) return { ok: false, code: 'not-supported', reason: 'the bank cannot verify account calls right now' };
    const r = await checkGatedCall(rt, def.action, request.account, request.payload, request.passportAuth);
    if (!r.ok) return r;
    if (!replay.claim(r.digestHex))
      return { ok: false, code: 'replayed', reason: 'this authorisation was already used' };
    return { ok: true, signer: r.signer, kind: 'passport-call', account: r.account };
  };
}
