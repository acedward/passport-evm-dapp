// One `open_swap_shielded_with_evm` call, as the browser signs it and the relay checks it (plan
// L-TRD: makes and takes). The browser builds the OpenSwapShielded typed data from the call's
// arguments and the account's public state and asks the wallet for ONE signature; the relay
// rebuilds the same digest from the same arguments (never trusting a digest it is sent), recovers
// the device's point and checks it is a live device of the account, exactly as for the other
// gated calls (./gated.ts). Both sides build everything with the vendored OpenSwapShielded codec
// (./vendor/offer-codec.ts, byte-for-byte upstream offer.ts sections 1, 2 and 6), whose challenge
// comes from the CONTRACT's own pure circuit, so the wallet shows what the circuit verifies.
//
// Only the OPEN shape is built here (recipient kind 0: anyone may take it), and the coin the give
// is paid from is part of the challenge (AUTH-10), `mt_index` included.

import type { ShieldedCoin, QualifiedCoin } from '../../../../vendor/passport/contract/src/wallet/contract.js';
import { bytesToHex, hexToBytes, normaliseHex32 } from '../hex.js';
import type { OpenSwapPayload } from '../trade.js';
import type { GatedCall, GatedContext } from './gated.js';
import {
  RECIPIENT_OPEN,
  buildOpenSwapTypedData,
  openSwapChallenge,
  openSwapDigest,
  openSwapMessage,
  type OfferCallArgs,
} from './vendor/offer-codec.js';

/** The circuit's eight leading arguments and the coin the give is paid from, from a payload. */
export function openSwapArgs(p: OpenSwapPayload): { call: OfferCallArgs; coin: QualifiedCoin } {
  const want: ShieldedCoin = {
    nonce: hexToBytes(normaliseHex32(p.wantNonce), 32),
    color: hexToBytes(normaliseHex32(p.wantColor), 32),
    value: BigInt(p.wantAmount),
  };
  return {
    call: {
      giveColor: hexToBytes(normaliseHex32(p.giveColor), 32),
      giveAmount: BigInt(p.giveAmount),
      recipientKind: RECIPIENT_OPEN,
      recipient: new Uint8Array(32),
      want,
      wantEntry: hexToBytes(p.wantEntry, 192),
      changeEntry: hexToBytes(p.changeEntry, 192),
      validUntil: BigInt(p.validUntil),
    },
    coin: {
      nonce: hexToBytes(normaliseHex32(p.coin.nonce), 32),
      color: hexToBytes(normaliseHex32(p.coin.color), 32),
      value: BigInt(p.coin.value),
      mt_index: BigInt(p.coin.mtIndex),
    },
  };
}

/** The OpenSwapShielded typed data the device signs for `p`, and its digest. */
export function openSwapGatedCall(ctx: GatedContext, owner: string, p: OpenSwapPayload): GatedCall {
  const account = hexToBytes(normaliseHex32(ctx.account), 32);
  const salt = hexToBytes(normaliseHex32(ctx.evmDomainSalt), 32);
  const ownerBytes = hexToBytes(owner.toLowerCase(), 20);
  const { call, coin } = openSwapArgs(p);
  const challenge = openSwapChallenge(account, ownerBytes, ctx.authNonce, call, coin);
  const message = openSwapMessage(account, ownerBytes, ctx.authNonce, call, challenge);
  const typedData = buildOpenSwapTypedData(salt, message);
  const { digest } = openSwapDigest(salt, message);
  return {
    typedData: typedData as unknown as GatedCall['typedData'],
    digest,
    digestHex: bytesToHex(digest, true),
    challenge,
  };
}
