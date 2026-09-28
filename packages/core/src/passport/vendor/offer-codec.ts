// VENDORED from acedward/passport @ 51c1fb4ad164af034c8ed60fbb047e43cdd509f5
//   contract/src/wallet/offer.ts, sections 1, 2 and 6 (lines 52-265 and 678-803):
//   the pure OpenSwapShielded codec, the change-coin prediction, and evm signing.
//
// WHY: upstream offer.ts cannot load in a browser. It imports node:crypto and node:fs at module
// scope, and inbox.ts, whose module-scope Buffer.from throws without node:buffer (plan 00039
// P0.4). Client-only shim under questions Q12 (option C allowed for shims) and Q18 (option B).
//
// CHANGES from upstream, and nothing else:
//   - imports point at the submodule (vendor/passport) instead of sibling files;
//   - `freshWantNonce` draws from WebCrypto instead of node:crypto's randomBytes;
//   - `offerInboxEntries` (node:crypto, via inbox.ts) is replaced by the async
//     `offerInboxEntriesPortable` (sealEntryPortable), which P0.4 proved interoperable;
//   - the envelope (section 3), imbalance reading (4) and the ledger-v9 builder (5) are left
//     out: they are relay-side and keep using upstream offer.ts directly.
//
// DROP this file when upstream ships a browser-safe codec (the Q18 request to the PR #4
// workstream). packages/core/test/vendored-vs-upstream.test.ts compares every export here with
// upstream offer.ts on Node, so drift fails CI.
/* eslint-disable */

import {
  DOMAIN_NAME,
  DOMAIN_VERSION,
  EIP712_DOMAIN_FIELDS,
  addressWord,
  bytes32Word,
  concat,
  domainSeparator,
  eip712Digest,
  keccak,
  toHex,
  uintWord,
  utf8,
  type FieldDefinition,
} from '../../../../../vendor/passport/contract/src/wallet/eip712.js';
import { pureCircuits, type QualifiedCoin, type ShieldedCoin } from '../../../../../vendor/passport/contract/src/wallet/contract.js';
import { sealEntryPortable } from '../../../../../vendor/passport/contract/src/wallet/deposit.js';
import { bytesToHex } from '../../../../../vendor/passport/contract/src/wallet/hex.js';
import { EvmDevice, type CallContext } from '../../../../../vendor/passport/contract/src/wallet/signer.js';
import {
  ethereumAddress,
  lowS,
  parseSignature,
  recoverPoint,
  type EvmPoint,
} from '../../../../../vendor/passport/contract/src/wallet/evm-signature.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. The eighth type: OpenSwapShielded
// ─────────────────────────────────────────────────────────────────────────────

/** Recipient shapes the circuit accepts. Kind 2 (a contract taker) exists in the numbering and is
 *  refused by `assert_open_swap_terms` — see the note there for why it cannot work at all. */
export const RECIPIENT_OPEN = 0n;
export const RECIPIENT_NAMED_COIN_KEY = 1n;
export const RECIPIENT_CONTRACT_REFUSED = 2n;

export const OPEN_SWAP_PRIMARY_TYPE = 'OpenSwapShielded' as const;

/** The frozen field list, in encoding order. The frame is the byte contract's — `account`, `owner`,
 *  `authNonce`, the action fields, `challenge` — and the action fields are everything a
 *  counterparty reads off the offer. */
export const OPEN_SWAP_FIELDS: readonly FieldDefinition[] = [
  { name: 'account', type: 'bytes32' },
  { name: 'owner', type: 'address' },
  { name: 'authNonce', type: 'uint64' },
  { name: 'giveColor', type: 'bytes32' },
  { name: 'giveAmount', type: 'uint128' },
  { name: 'recipientKind', type: 'uint8' as any },
  { name: 'recipient', type: 'bytes32' },
  { name: 'wantNonce', type: 'bytes32' },
  { name: 'wantColor', type: 'bytes32' },
  { name: 'wantAmount', type: 'uint128' },
  { name: 'validUntil', type: 'uint64' },
  { name: 'challenge', type: 'bytes32' },
] as const;

export const OPEN_SWAP_ENCODE_TYPE = `${OPEN_SWAP_PRIMARY_TYPE}(${OPEN_SWAP_FIELDS.map(
  (f) => `${f.type} ${f.name}`,
).join(',')})`;

export const OPEN_SWAP_TYPE_HASH = keccak(utf8(OPEN_SWAP_ENCODE_TYPE));

/** A `uint8` enum in a 32-byte word. `eip712.ts`'s `uintWord` takes 64 or 128 bits only;
 *  `recipientKind` is the contract's one small enumeration and the only field that needs this. */
export function uint8Word(value: bigint, label = 'recipientKind'): Uint8Array {
  if (value < 0n || value > 0xffn) throw new RangeError(`${label} does not fit uint8`);
  const out = new Uint8Array(32);
  out[31] = Number(value);
  return out;
}

export interface OpenSwapMessage {
  account: Uint8Array;
  owner: Uint8Array;
  authNonce: bigint;
  giveColor: Uint8Array;
  giveAmount: bigint;
  recipientKind: bigint;
  recipient: Uint8Array;
  wantNonce: Uint8Array;
  wantColor: Uint8Array;
  wantAmount: bigint;
  validUntil: bigint;
  challenge: Uint8Array;
}

function openSwapWords(m: OpenSwapMessage): Uint8Array[] {
  return [
    bytes32Word(m.account, 'account'),
    addressWord(m.owner, 'owner'),
    uintWord(m.authNonce, 64, 'authNonce'),
    bytes32Word(m.giveColor, 'giveColor'),
    uintWord(m.giveAmount, 128, 'giveAmount'),
    uint8Word(m.recipientKind),
    bytes32Word(m.recipient, 'recipient'),
    bytes32Word(m.wantNonce, 'wantNonce'),
    bytes32Word(m.wantColor, 'wantColor'),
    uintWord(m.wantAmount, 128, 'wantAmount'),
    uintWord(m.validUntil, 64, 'validUntil'),
    bytes32Word(m.challenge, 'challenge'),
  ];
}

/** The 416-byte struct preimage: the type hash followed by one word per field. */
export function encodeOpenSwapStruct(m: OpenSwapMessage): Uint8Array {
  return concat(OPEN_SWAP_TYPE_HASH, ...openSwapWords(m));
}

export function openSwapStructHash(m: OpenSwapMessage): Uint8Array {
  return keccak(encodeOpenSwapStruct(m));
}

export interface OpenSwapHashes {
  domainSeparator: Uint8Array;
  structHash: Uint8Array;
  digest: Uint8Array;
}

/** Everything the circuit recomputes in-circuit, from the same inputs. */
export function openSwapDigest(salt: Uint8Array, m: OpenSwapMessage): OpenSwapHashes {
  const separator = domainSeparator(m.account, salt);
  const hash = openSwapStructHash(m);
  return { domainSeparator: separator, structHash: hash, digest: eip712Digest(separator, hash) };
}

/** The exact JSON handed to `eth_signTypedData_v4` / ethers' `signTypedData`. */
export function buildOpenSwapTypedData(salt: Uint8Array, m: OpenSwapMessage) {
  const message: Record<string, string> = {};
  for (const field of OPEN_SWAP_FIELDS) {
    const value = (m as unknown as Record<string, Uint8Array | bigint>)[field.name];
    if (value === undefined) throw new TypeError(`missing field ${field.name}`);
    if (typeof value === 'bigint') {
      message[field.name] = value.toString(10);
    } else if (field.type === 'address') {
      message[field.name] = toHex(value);
    } else {
      message[field.name] = toHex(bytes32Word(value, field.name));
    }
  }
  return {
    types: { EIP712Domain: EIP712_DOMAIN_FIELDS, [OPEN_SWAP_PRIMARY_TYPE]: OPEN_SWAP_FIELDS },
    primaryType: OPEN_SWAP_PRIMARY_TYPE,
    domain: {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      verifyingContract: toHex(keccak(bytes32Word(m.account, 'account')).slice(12)),
      salt: toHex(bytes32Word(salt, 'salt')),
    },
    message,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Client-side pieces of the call
// ─────────────────────────────────────────────────────────────────────────────

/** The surviving change coin of an offer, predicted BEFORE the call.
 *
 *  An offer's change entry is an ARGUMENT — it is appended inside the same call and bound in the
 *  challenge — so the maker cannot read the coin off the result the way every other spend does. The
 *  nonce comes from the contract's own free oracle rather than a TypeScript transcription of the
 *  standard library's rule (questions file, Q34). */
export function predictChangeCoin(coin: QualifiedCoin, giveAmount: bigint): ShieldedCoin | null {
  if (coin.value < giveAmount) {
    throw new RangeError('held coin is smaller than the give amount');
  }
  const value = coin.value - giveAmount;
  if (value === 0n) return null;
  return {
    nonce: (pureCircuits as any).swap_change_nonce(coin.nonce) as Uint8Array,
    color: coin.color,
    value,
  };
}

/** A fresh 32-byte want nonce. Client randomness, never derived from public data: it is what makes
 *  the wanted coin's commitment unpredictable to anyone but the maker until the offer is published. */
export const freshWantNonce = (): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(32)); // VENDOR CHANGE: WebCrypto

export interface OfferCallArgs {
  giveColor: Uint8Array;
  giveAmount: bigint;
  recipientKind: bigint;
  recipient: Uint8Array;
  want: ShieldedCoin;
  wantEntry: Uint8Array;
  changeEntry: Uint8Array;
  validUntil: bigint;
}

/** The eight leading circuit arguments, in declaration order. The auth arguments follow. */
export const offerCircuitArgs = (a: OfferCallArgs): unknown[] => [
  a.giveColor,
  a.giveAmount,
  a.recipientKind,
  a.recipient,
  a.want,
  a.wantEntry,
  a.changeEntry,
  a.validUntil,
];

/**
 * Both inbox entries for an offer, sealed to the account's encryption key.
 *
 * The change entry is REQUIRED even when there is no change: it is a circuit argument, so some 192
 * bytes must be passed, and the circuit appends it only when change exists. Passing an entry that
 * describes the (nonexistent) zero-value change coin would put a decryptable lie in the maker's own
 * store if the rule ever changed, so the no-change case passes an all-zero container instead —
 * indistinguishable from any other ciphertext to an observer, and never appended.
 */
export async function offerInboxEntriesPortable( // VENDOR CHANGE: portable (async) sealing
  encPublicKey: Uint8Array,
  want: ShieldedCoin,
  change: ShieldedCoin | null,
): Promise<{ wantEntry: Uint8Array; changeEntry: Uint8Array }> {
  return {
    wantEntry: await sealEntryPortable(encPublicKey, want),
    changeEntry: change ? await sealEntryPortable(encPublicKey, change) : new Uint8Array(192),
  };
}

/** First coin of `color` in the store with `value >= give`. There is no in-circuit merge in
 *  stateless custody, so a client that holds only smaller coins must merge them itself first (two
 *  ordinary spends); refusing here is the honest answer rather than proving something unsettleable. */
export function selectGiveCoin(
  coins: Iterable<QualifiedCoin>,
  color: Uint8Array,
  give: bigint,
): QualifiedCoin {
  const wanted = bytesToHex(color);
  for (const c of coins) {
    if (bytesToHex(c.color) === wanted && c.value >= give) return c;
  }
  throw new Error(
    `no held coin of colour ${wanted} with value >= ${give}; stateless custody has no in-circuit ` +
      'merge, so the client must combine coins first',
  );
}


/** The ledger's hard cap on an intent's lifetime (upstream section 3). */
export const TTL_CAP_SECONDS = 3600;

// ─────────────────────────────────────────────────────────────────────────────
// 6. Signing an offer with an `evm` device
// ─────────────────────────────────────────────────────────────────────────────
//
// `EvmDevice` (in `signer.ts`) already owns everything about an `evm` device that is not
// operation-specific: the 20-byte identity, the rolling entry, the boot commitment, the point cache
// and its address check, and the three backends (raw key, ethers wallet, EIP-1193). What it cannot
// know is the EIGHTH operation, because its `AuthRequest` union is a closed type in a file this line
// of work does not own (questions file, Q36).
//
// So the offer supplies exactly the missing piece — the typed data and the digest — and hands them to
// the device's own backend. The device is otherwise driven as it is everywhere else, and when the two
// lines merge this becomes one more member of that union and one more case in `evmTypedMessage`.

// (section 6's imports are hoisted to the top of this file)

export interface OpenSwapAuthorisation {
  arm: 'evm';
  pk: { x: bigint; y: bigint; identity: false };
  use_counter: bigint;
  sig: { r: bigint; s: bigint };
  /** Exactly what the wallet was shown and signed, kept so an audit log or a conformance test can
   *  replay the approval rather than reconstruct it. Neither field is a circuit argument. */
  typedData: ReturnType<typeof buildOpenSwapTypedData>;
  hashes: OpenSwapHashes;
}

/** The `OpenSwapShielded` message for one call, built from the same object the challenge is. */
export function openSwapMessage(
  accountAddress: Uint8Array,
  owner: Uint8Array,
  authNonce: bigint,
  call: OfferCallArgs,
  challenge: Uint8Array,
): OpenSwapMessage {
  return {
    account: accountAddress,
    owner,
    authNonce,
    giveColor: call.giveColor,
    giveAmount: call.giveAmount,
    recipientKind: call.recipientKind,
    recipient: call.recipient,
    wantNonce: call.want.nonce,
    wantColor: call.want.color,
    wantAmount: call.want.value,
    validUntil: call.validUntil,
    challenge,
  };
}

/** The offer's challenge core, from the CONTRACT's own pure circuit. */
export function openSwapChallenge(
  accountAddress: Uint8Array,
  owner: Uint8Array,
  authNonce: bigint,
  call: OfferCallArgs,
  coin: QualifiedCoin,
): Uint8Array {
  return (pureCircuits as any).challenge_open_swap_shielded_with_evm(
    { bytes: accountAddress },
    owner,
    call.giveColor,
    call.giveAmount,
    call.recipientKind,
    call.recipient,
    call.want,
    call.wantEntry,
    call.changeEntry,
    call.validUntil,
    coin,
    authNonce,
  ) as Uint8Array;
}

/**
 * Authorise one offer with an `evm` device: build the challenge, wrap it in `OpenSwapShielded`, have
 * the wallet sign the digest, normalise S, and recover the point the circuit will be handed.
 *
 * The recovered point is checked against the device's enrolled address here, exactly as
 * `EvmDevice.sign` does for the other seven operations — a backend that signs as somebody else is
 * caught in the client rather than by a failed proof.
 */
export async function signOpenSwapOffer(
  device: EvmDevice,
  ctx: CallContext & { evmDomainSalt?: Uint8Array },
  call: OfferCallArgs,
  coin: QualifiedCoin,
  useCounter: bigint,
): Promise<OpenSwapAuthorisation> {
  const salt = ctx.evmDomainSalt;
  if (!salt || salt.length !== 32) {
    throw new Error("an evm offer needs the account's 32-byte evm_domain_salt in the call context");
  }
  const challenge = openSwapChallenge(ctx.contractAddress, device.address, ctx.authNonce, call, coin);
  const message = openSwapMessage(ctx.contractAddress, device.address, ctx.authNonce, call, challenge);
  const typedData = buildOpenSwapTypedData(salt, message);
  const hashes = openSwapDigest(salt, message);
  const signature = lowS(parseSignature(await device.backend.signTypedData({
    typedData: typedData as any,
    digest: hashes.digest,
  })));
  const point: EvmPoint = recoverPoint(hashes.digest, signature);
  const derived = toHex(ethereumAddress(point));
  if (derived !== toHex(device.address)) {
    throw new Error(`the offer signature belongs to ${derived}, not to this device (${toHex(device.address)})`);
  }
  return {
    arm: 'evm',
    pk: { x: point.x, y: point.y, identity: false },
    use_counter: useCounter,
    sig: { r: signature.r, s: signature.s },
    typedData,
    hashes,
  };
}

/** The trailing circuit arguments an `evm` offer authorisation expands to. */
export const offerAuthArgs = (a: OpenSwapAuthorisation): unknown[] => [a.pk, a.use_counter, a.sig];
