// One gated Passport call, as the browser signs it and the relay checks it (plan L-ACC.4, P1.3's
// `passport-call` authorisation).
//
// The browser builds the call's EIP-712 typed data from the call's arguments and the account's
// public state, asks the wallet for ONE `eth_signTypedData_v4` signature, and sends the
// arguments, the signature and the device's use counter. The relay rebuilds the same digest
// from the same arguments (never trusting a digest it is sent), recovers the device's public
// point from the signature, and checks the device is live at that counter. Both sides use
// exactly this module, which builds everything with the pinned Passport client's own code
// (`evmChallengeFor`, `evmTypedMessage`, `buildTypedData`, `computeDigest`), so the wallet shows
// what the circuit will verify.
//
// The coin a spend consumes is part of the signed challenge (AUTH-10), `mt_index` included, so
// the browser resolves the coin's exact position BEFORE it builds the call (../coins.ts).

import type { AppendInboxPayload, WithdrawPayload } from '../accounts.js';
import type { BridgeDepositPayload, BridgeWithdrawPayload, EvmTxParamsJson } from '../bridge.js';
import { bytesToHex, hexToBytes, normaliseHex32 } from '../hex.js';
import {
  buildTypedData,
  computeDigest,
  type TypedDataV4,
} from '../../../../vendor/passport/contract/src/wallet/eip712.js';
import {
  evmChallengeFor,
  evmTypedMessage,
  type AuthRequest,
  type CallContext,
} from '../../../../vendor/passport/contract/src/wallet/signer.js';
import { pureCircuits } from '../../../../vendor/passport/contract/src/wallet/contract.js';

/** The account state a gated call is built against (all public). */
export interface GatedContext {
  /** The account's contract address, 64 hex. */
  account: string;
  /** The auth nonce the call executes against. */
  authNonce: bigint;
  /** The account's sealed EIP-712 domain salt, 64 hex. */
  evmDomainSalt: string;
}

export interface GatedCall {
  typedData: TypedDataV4;
  digest: Uint8Array;
  /** 0x-prefixed lowercase digest. */
  digestHex: string;
  challenge: Uint8Array;
}

const callContext = (ctx: GatedContext): CallContext => ({
  contractAddress: hexToBytes(normaliseHex32(ctx.account), 32),
  authNonce: ctx.authNonce,
  evmDomainSalt: hexToBytes(normaliseHex32(ctx.evmDomainSalt), 32),
});

/** Build the typed data a device signs for `request`, and its digest. */
export function gatedCall(ctx: GatedContext, owner: string, request: AuthRequest): GatedCall {
  const cc = callContext(ctx);
  const ownerBytes = hexToBytes(owner.toLowerCase(), 20);
  const challenge = evmChallengeFor(cc, ownerBytes, request);
  const { op, message } = evmTypedMessage(cc, ownerBytes, request, challenge);
  const salt = cc.evmDomainSalt!;
  const typedData = buildTypedData(cc.contractAddress, salt, op, message);
  const { digest } = computeDigest(cc.contractAddress, salt, op, message);
  return { typedData, digest, digestHex: bytesToHex(digest, true), challenge };
}

/** The AuthRequest of a `withdraw` action body. */
export function withdrawRequest(p: WithdrawPayload): AuthRequest {
  return {
    op: 'withdrawShielded',
    recipient: hexToBytes(normaliseHex32(p.recipient), 32),
    color: hexToBytes(normaliseHex32(p.color), 32),
    amount: BigInt(p.amount),
    coin: {
      nonce: hexToBytes(normaliseHex32(p.coin.nonce), 32),
      color: hexToBytes(normaliseHex32(p.coin.color), 32),
      value: BigInt(p.coin.value),
      mt_index: BigInt(p.coin.mtIndex),
    },
  };
}

/** The AuthRequest of an `append-inbox` action body. */
export function appendInboxRequest(p: AppendInboxPayload): AuthRequest {
  return { op: 'appendInbox', entry: hexToBytes(p.entry, 192) };
}

const evmTxParams = (e: EvmTxParamsJson) => ({
  nonce: BigInt(e.nonce),
  gasLimit: BigInt(e.gasLimit),
  maxFeePerGas: BigInt(e.maxFeePerGas),
  maxPriorityFeePerGas: BigInt(e.maxPriorityFeePerGas),
  keyVersion: BigInt(e.keyVersion),
});

const evmAddressBytes = (a: string) => hexToBytes(a.toLowerCase(), 20);

/** The AuthRequest of a `bridge-deposit` action body (`bridge_deposit_start_with_evm`). */
export function bridgeDepositStartRequest(p: BridgeDepositPayload): AuthRequest {
  return {
    op: 'bridgeDepositStart',
    erc20: evmAddressBytes(p.erc20),
    amount: BigInt(p.amount),
    evm: evmTxParams(p.evm),
  };
}

/** The AuthRequest of a `bridge-withdraw` action body (`bridge_withdraw_start_with_evm`). The change
 *  inbox entry is deliberately not part of it: the challenge does not bind it (upstream Q46). */
export function bridgeWithdrawStartRequest(p: BridgeWithdrawPayload): AuthRequest {
  return {
    op: 'bridgeWithdrawStart',
    dest: evmAddressBytes(p.dest),
    color: hexToBytes(normaliseHex32(p.color), 32),
    amount: BigInt(p.amount),
    erc20: evmAddressBytes(p.erc20),
    coin: {
      nonce: hexToBytes(normaliseHex32(p.coin.nonce), 32),
      color: hexToBytes(normaliseHex32(p.coin.color), 32),
      value: BigInt(p.coin.value),
      mt_index: BigInt(p.coin.mtIndex),
    },
    evm: evmTxParams(p.evm),
  };
}

/** A device's rolling entry at (account, epoch, counter): `derive_device_entry_with_evm`. */
export function evmDeviceEntry(account: string, owner: string, epoch: bigint, counter: bigint): string {
  return bytesToHex(
    pureCircuits.derive_device_entry_with_evm(
      { bytes: hexToBytes(normaliseHex32(account), 32) },
      hexToBytes(owner.toLowerCase(), 20),
      epoch,
      counter,
    ),
  );
}

/**
 * The device's current use counter (MIP-0013 S11): the counter whose entry is a live member of
 * the account's device set. Starts at the browser's remembered counter (a hint) and scans
 * forward; null when no entry within `limit` is live (not a device of this account).
 */
export function findEvmUseCounter(
  devices: readonly string[],
  account: string,
  owner: string,
  epoch: bigint,
  hint = 0n,
  limit = 4096n,
): bigint | null {
  const live = new Set(devices.map((d) => d.toLowerCase()));
  if (live.has(evmDeviceEntry(account, owner, epoch, hint))) return hint;
  for (let k = 0n; k < limit; k++) if (live.has(evmDeviceEntry(account, owner, epoch, k))) return k;
  return null;
}
