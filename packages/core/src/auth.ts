// The relay's action authorisation: EIP-712 typed data that the customer's EVM wallet signs
// to ask MN Bank's relay to spend its sponsor's DUST on an action (spec FR-013).
//
// A `RelayAction` binds, in one signature:
//   - the ACTION (for example "register") and the request body (`payloadHash`, keccak256 of
//     the canonical JSON of the payload), so a signature cannot be reused with other arguments;
//   - the Midnight NETWORK and, for account actions, the Passport ACCOUNT;
//   - the OWNER, the EVM address that must recover from the signature;
//   - a relay-issued NONCE, single use: the relay remembers every nonce it issued, forgets a
//     nonce the moment it is used, and forgets all of them on restart, so a signature can be
//     accepted at most once, ever;
//   - an EXPIRY (unix seconds); the relay also caps how far ahead it may be.
//
// The domain names the relay ("MN Bank Relay") and Sepolia's chain id; wallets check that the
// connected chain matches, which the dApp switches to first (FR-001).
//
// For registration this signature is also the enrolment: the device's public point is
// recovered from it (`recoverRelayActionPoint`), so registering needs exactly one prompt
// (FR-002). Gated Passport calls carry their own contract-level EIP-712 signature, which the
// relay can accept as the authorisation for those routes (see relay/src/auth/verifiers.ts), so
// every action stays one prompt.

import { SigningKey, TypedDataEncoder, getAddress, keccak256, toUtf8Bytes, verifyTypedData } from 'ethers';
import { z } from 'zod';

import { SEPOLIA_CHAIN_ID } from './network.js';

export const RELAY_DOMAIN_NAME = 'MN Bank Relay';
export const RELAY_DOMAIN_VERSION = '1';
export const RELAY_PRIMARY_TYPE = 'RelayAction';

/** Every action the relay knows. Lanes fill in the executors; the names are the contract. */
export const RELAY_ACTIONS = [
  'register',
  'withdraw',
  'append-inbox',
  'open-swap',
  'take',
  'bridge-deposit',
  'bridge-withdraw',
] as const;
export type RelayActionName = (typeof RELAY_ACTIONS)[number];

export const RELAY_ACTION_FIELDS = [
  { name: 'action', type: 'string' },
  { name: 'network', type: 'string' },
  { name: 'owner', type: 'address' },
  { name: 'account', type: 'bytes32' },
  { name: 'payloadHash', type: 'bytes32' },
  { name: 'nonce', type: 'bytes32' },
  { name: 'expiry', type: 'uint64' },
] as const;

export const RELAY_ACTION_TYPES = { [RELAY_PRIMARY_TYPE]: RELAY_ACTION_FIELDS.map((f) => ({ ...f })) };

const EIP712_DOMAIN_FIELDS = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
];

/** The message as it travels in JSON: every value a string. */
export const RelayActionMessageSchema = z.object({
  action: z.enum(RELAY_ACTIONS),
  network: z.string().min(1).max(32),
  owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  account: z.string().regex(/^0x[0-9a-f]{64}$/),
  payloadHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  nonce: z.string().regex(/^0x[0-9a-f]{64}$/),
  expiry: z.string().regex(/^[0-9]{1,20}$/),
});
export type RelayActionMessage = z.infer<typeof RelayActionMessageSchema>;

export const SignedRelayActionSchema = z.object({
  message: RelayActionMessageSchema,
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});
export type SignedRelayAction = z.infer<typeof SignedRelayActionSchema>;

/** `account` for actions that have no account yet (registration). */
export const NO_ACCOUNT = `0x${'0'.repeat(64)}`;

export function relayDomain(chainId: number = SEPOLIA_CHAIN_ID) {
  return { name: RELAY_DOMAIN_NAME, version: RELAY_DOMAIN_VERSION, chainId };
}

// ── Canonical JSON and the payload hash ──────────────────────────────────────

export class CanonicalJsonError extends Error {
  override name = 'CanonicalJsonError';
}

/**
 * A deterministic JSON rendering: object keys sorted, no whitespace, bigints as decimal
 * strings. Only plain JSON values (and bigints) are allowed: no undefined, functions, NaN,
 * byte arrays or class instances, so the browser and the relay always hash the same bytes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return JSON.stringify(value.toString(10));
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError('non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError('only plain objects can be hashed (encode bytes as hex strings)');
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new CanonicalJsonError(`cannot hash a ${typeof value}`);
  }
}

/** keccak256 of the payload's canonical JSON, 0x-prefixed lowercase hex. */
export function payloadHash(payload: unknown): string {
  return keccak256(toUtf8Bytes(canonicalJson(payload)));
}

// ── Building and signing ─────────────────────────────────────────────────────

export interface RelayActionInput {
  action: RelayActionName;
  network: string;
  owner: string;
  /** Passport account address (64 hex, with or without 0x); omit for registration. */
  account?: string;
  payload: unknown;
  /** Relay-issued nonce (0x + 64 hex). */
  nonce: string;
  /** Unix seconds. */
  expiry: number | bigint;
}

export function buildRelayActionMessage(input: RelayActionInput): RelayActionMessage {
  const account = input.account === undefined ? NO_ACCOUNT : `0x${input.account.replace(/^0x/, '').toLowerCase()}`;
  return RelayActionMessageSchema.parse({
    action: input.action,
    network: input.network,
    owner: getAddress(input.owner),
    account,
    payloadHash: payloadHash(input.payload),
    nonce: input.nonce.toLowerCase(),
    expiry: BigInt(input.expiry).toString(10),
  });
}

/** The exact JSON for `eth_signTypedData_v4` (EIP712Domain included, as the RPC requires). */
export function relayActionTypedData(message: RelayActionMessage, chainId: number = SEPOLIA_CHAIN_ID) {
  return {
    types: { EIP712Domain: EIP712_DOMAIN_FIELDS, ...RELAY_ACTION_TYPES },
    primaryType: RELAY_PRIMARY_TYPE,
    domain: relayDomain(chainId),
    message,
  };
}

/** The EIP-712 digest the wallet signs. */
export function relayActionDigest(message: RelayActionMessage, chainId: number = SEPOLIA_CHAIN_ID): string {
  return TypedDataEncoder.hash(relayDomain(chainId), RELAY_ACTION_TYPES, message);
}

/** The address that signed `message`, or throws on a malformed signature. */
export function recoverRelayActionSigner(
  message: RelayActionMessage,
  signature: string,
  chainId: number = SEPOLIA_CHAIN_ID,
): string {
  return verifyTypedData(relayDomain(chainId), RELAY_ACTION_TYPES, message, signature);
}

/** The signer's uncompressed secp256k1 public key (0x04…): registration's device point. */
export function recoverRelayActionPoint(
  message: RelayActionMessage,
  signature: string,
  chainId: number = SEPOLIA_CHAIN_ID,
): string {
  return SigningKey.recoverPublicKey(relayActionDigest(message, chainId), signature);
}

// ── Verification (the relay side) ────────────────────────────────────────────

export type AuthFailureCode =
  | 'malformed'
  | 'wrong-action'
  | 'wrong-network'
  | 'wrong-account'
  | 'payload-mismatch'
  | 'expired'
  | 'expiry-too-far'
  | 'bad-signature'
  | 'wrong-signer'
  | 'unknown-nonce'
  | 'replayed';

export type AuthResult =
  { ok: true; signer: string; message: RelayActionMessage } | { ok: false; code: AuthFailureCode; reason: string };

export interface VerifyRelayActionOptions {
  expectedAction: RelayActionName;
  network: string;
  chainId?: number;
  /** The account the route acts on (64 hex, optional 0x), or undefined for registration. */
  expectedAccount?: string;
  payload: unknown;
  /** Unix seconds; defaults to the wall clock. */
  now?: number;
  /** The furthest an expiry may be in the future, in seconds. */
  maxTtlSeconds: number;
  /**
   * Consume the nonce: returns 'ok' if the relay issued it and it was unused (and marks it
   * used), 'unknown' if the relay never issued it (or forgot it on restart), 'used' if it was
   * already consumed. Called only after every other check passed.
   */
  consumeNonce(nonce: string, owner: string): 'ok' | 'unknown' | 'used';
}

const fail = (code: AuthFailureCode, reason: string): AuthResult => ({ ok: false, code, reason });

/** Check a signed relay action against the route it arrived on. Pure except `consumeNonce`. */
export function verifyRelayAction(signed: unknown, options: VerifyRelayActionOptions): AuthResult {
  const parsed = SignedRelayActionSchema.safeParse(signed);
  if (!parsed.success) return fail('malformed', 'the authorisation is missing or malformed');
  const { message, signature } = parsed.data;
  if (message.action !== options.expectedAction)
    return fail('wrong-action', `signed for "${message.action}", not "${options.expectedAction}"`);
  if (message.network !== options.network) return fail('wrong-network', `signed for network "${message.network}"`);
  const expectedAccount =
    options.expectedAccount === undefined
      ? NO_ACCOUNT
      : `0x${options.expectedAccount.replace(/^0x/, '').toLowerCase()}`;
  if (message.account !== expectedAccount) return fail('wrong-account', 'signed for another account');
  let hash: string;
  try {
    hash = payloadHash(options.payload);
  } catch {
    return fail('malformed', 'the payload cannot be hashed');
  }
  if (message.payloadHash !== hash) return fail('payload-mismatch', 'the signature does not cover this request body');
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const expiry = Number(message.expiry);
  if (!Number.isSafeInteger(expiry) || expiry <= now) return fail('expired', 'the authorisation has expired');
  if (expiry > now + options.maxTtlSeconds)
    return fail('expiry-too-far', `expiry is more than ${options.maxTtlSeconds} s ahead`);
  let signer: string;
  try {
    signer = recoverRelayActionSigner(message, signature, options.chainId);
  } catch {
    return fail('bad-signature', 'the signature is not valid');
  }
  if (signer !== getAddress(message.owner)) return fail('wrong-signer', 'the signature is not from the owner');
  const nonce = options.consumeNonce(message.nonce, signer);
  if (nonce === 'unknown')
    return fail('unknown-nonce', 'the relay did not issue this nonce (or has restarted); ask for a new one');
  if (nonce === 'used') return fail('replayed', 'this authorisation was already used');
  return { ok: true, signer, message };
}
