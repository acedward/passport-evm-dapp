// A Passport account's shielded coins, as the browser keeps them (spec FR-005, FR-006, Q9).
//
// Two public facts about a coin can be computed from its description alone, with no secret:
//
//   - its COMMITMENT, the leaf the ledger inserts into the Zswap commitment tree when the coin
//     is created. The ledger reports every leaf it inserts, with its exact position (`mt_index`),
//     as a `zswapOutput` event. Matching the commitment finds the coin's position EXACTLY, before
//     any signature (plan L-ACC.4): the signed challenge covers `mt_index`, so a guessed position
//     would cost one wallet prompt per guess.
//   - its NULLIFIER, which the ledger reports as a `zswapInput` event when the coin is spent.
//     A contract-owned coin's nullifier depends only on the coin and the contract's address
//     (the ledger's `SenderEvidence::Contract`), so the browser can tell which of its coins
//     are already spent.
//
// Both are SHA-256 over the ledger's binary hash representation (midnight-ledger
// `coin-structure/src/coin.rs`, `Info::commitment` / `Info::nullifier`, ledger 9.1.0.0-rc.3):
//
//   domain ‖ nonce(32) ‖ colour(32) ‖ value (u128 little-endian, 16) ‖ is_user (1 byte) ‖ address(32)
//
// with domain `midnight:zswap-cc[v1]` (commitment) or `midnight:zswap-cn[v1]` (nullifier), and
// is_user = 0 for a contract. relay/test/coins-ledger.test.ts checks the commitment against the
// ledger's own WASM (`ZswapOutput.newContractOwned(...).commitment`).

import { sha256 } from '@noble/hashes/sha2.js';

import { MAX_UINT128 } from './amount.js';
import { bytesToHex, hexToBytes, normaliseHex32 } from './hex.js';

const COMMITMENT_DOMAIN = new TextEncoder().encode('midnight:zswap-cc[v1]');
const NULLIFIER_DOMAIN = new TextEncoder().encode('midnight:zswap-cn[v1]');

/** A shielded coin's description, as JSON: hex strings and a decimal value. */
export interface CoinInfo {
  /** 32-byte nonce, 64 hex. */
  nonce: string;
  /** 32-byte colour (raw token type), 64 hex. */
  color: string;
  /** Base units, decimal string. */
  value: string;
}

/** A coin whose position in the commitment tree is known: what a spend's witness needs. */
export interface QualifiedCoinInfo extends CoinInfo {
  /** The leaf index in the Zswap commitment tree, decimal string. */
  mtIndex: string;
}

function u128le(value: bigint): Uint8Array {
  if (value < 0n || value > MAX_UINT128) throw new RangeError('coin value does not fit 128 bits');
  const out = new Uint8Array(16);
  let v = value;
  for (let i = 0; i < 16; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function contractCoinHash(domain: Uint8Array, coin: CoinInfo, contractAddress: string): string {
  const parts = [
    domain,
    hexToBytes(coin.nonce, 32),
    hexToBytes(coin.color, 32),
    u128le(BigInt(coin.value)),
    Uint8Array.of(0), // Recipient::Contract / SenderEvidence::Contract
    hexToBytes(contractAddress, 32),
  ];
  const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return bytesToHex(sha256(buf));
}

/** The commitment of a coin owned by a contract (64 hex, lowercase). */
export function contractCoinCommitment(coin: CoinInfo, contractAddress: string): string {
  return contractCoinHash(COMMITMENT_DOMAIN, coin, contractAddress);
}

/** The nullifier of a coin owned by a contract (64 hex, lowercase). */
export function contractCoinNullifier(coin: CoinInfo, contractAddress: string): string {
  return contractCoinHash(NULLIFIER_DOMAIN, coin, contractAddress);
}

// ── Chain facts the relay serves (public) ─────────────────────────────────────

/** A leaf the ledger inserted for a coin owned by the account. */
export interface OwnedOutput {
  commitment: string;
  mtIndex: string;
  txHash: string;
  blockHeight: number;
}

/** A coin of the account that was spent. */
export interface OwnedInput {
  nullifier: string;
  txHash: string;
  blockHeight: number;
}

// ── The browser's coin list ───────────────────────────────────────────────────

/** Where the browser learned about a coin. */
export type CoinOrigin = 'inbox' | 'change' | 'local';

/** One coin as the browser stores it. */
export interface StoredCoin extends CoinInfo {
  /** Known once the coin's commitment was matched against the ledger's outputs. */
  mtIndex: string | null;
  /** The commitment (derived; stored so the list is readable without recomputing). */
  commitment: string;
  origin: CoinOrigin;
  /** True once an inbox entry describes this coin (chain-recoverable, FR-005). */
  inInbox: boolean;
  /** The inbox entry's index, when the coin came from the inbox. */
  inboxIndex?: string;
  /** The transaction that created the coin, when known. */
  createdTx?: string;
  /** Spent, from the ledger's nullifiers; kept for the record until pruned. */
  spent: boolean;
  spentTx?: string;
}

export interface ReconcileInput {
  account: string;
  /** Coins opened from the inbox with the account's secret, in inbox order. */
  inbox: Array<CoinInfo & { inboxIndex: string }>;
  /** Every Zswap output the ledger reports for the account. */
  outputs: readonly OwnedOutput[];
  /** Every Zswap input (spend) the ledger reports for the account. */
  inputs: readonly OwnedInput[];
  /** What the browser already had (coins with no inbox entry live only here). */
  previous: readonly StoredCoin[];
}

const coinKey = (c: Pick<CoinInfo, 'nonce' | 'color'>) => `${normaliseHex32(c.color)}:${normaliseHex32(c.nonce)}`;

/**
 * Rebuild the account's coin list from chain facts and what the browser already knew.
 *
 * - Every coin found in the inbox is kept, with `inInbox`.
 * - Every coin the browser knew without an inbox entry (a withdrawal's change, Q13) is kept.
 * - Each coin's `mtIndex` is the position of the leaf whose commitment equals the coin's own:
 *   exact, never a guess. A coin whose leaf is not (yet) reported keeps `mtIndex: null` and
 *   cannot be spent until it is.
 * - A coin whose nullifier the ledger reports is marked spent.
 */
export function reconcileCoins(input: ReconcileInput): StoredCoin[] {
  const account = normaliseHex32(input.account);
  const leaves = new Map(input.outputs.map((o) => [normaliseHex32(o.commitment), o]));
  const spends = new Map(input.inputs.map((i) => [normaliseHex32(i.nullifier), i]));
  const byKey = new Map<string, StoredCoin>();

  const settle = (c: StoredCoin): StoredCoin => {
    const leaf = leaves.get(c.commitment);
    const spend = spends.get(contractCoinNullifier(c, account));
    return {
      ...c,
      mtIndex: leaf ? leaf.mtIndex : c.mtIndex,
      ...(leaf ? { createdTx: leaf.txHash } : {}),
      spent: !!spend || c.spent,
      ...(spend ? { spentTx: spend.txHash } : {}),
    };
  };

  for (const p of input.previous) byKey.set(coinKey(p), settle({ ...p }));
  for (const c of input.inbox) {
    const coin: CoinInfo = {
      nonce: normaliseHex32(c.nonce),
      color: normaliseHex32(c.color),
      value: BigInt(c.value).toString(10),
    };
    const key = coinKey(coin);
    const known = byKey.get(key);
    byKey.set(
      key,
      settle({
        ...coin,
        mtIndex: known?.mtIndex ?? null,
        commitment: contractCoinCommitment(coin, account),
        origin: known?.origin ?? 'inbox',
        inInbox: true,
        inboxIndex: c.inboxIndex,
        spent: known?.spent ?? false,
        ...(known?.createdTx ? { createdTx: known.createdTx } : {}),
        ...(known?.spentTx ? { spentTx: known.spentTx } : {}),
      }),
    );
  }
  return [...byKey.values()].sort((a, b) =>
    a.color === b.color
      ? BigInt(b.value) > BigInt(a.value)
        ? 1
        : BigInt(b.value) < BigInt(a.value)
          ? -1
          : 0
      : a.color < b.color
        ? -1
        : 1,
  );
}

/** A coin the browser just learned about without an inbox entry (a withdrawal's change). */
export function localCoin(
  coin: CoinInfo,
  account: string,
  origin: CoinOrigin = 'change',
  createdTx?: string,
): StoredCoin {
  const c: CoinInfo = {
    nonce: normaliseHex32(coin.nonce),
    color: normaliseHex32(coin.color),
    value: BigInt(coin.value).toString(10),
  };
  return {
    ...c,
    mtIndex: null,
    commitment: contractCoinCommitment(c, account),
    origin,
    inInbox: false,
    spent: false,
    ...(createdTx ? { createdTx } : {}),
  };
}

// ── Balances and the coin a payment uses (Q9: one coin per payment) ─────────────

export interface ColourHolding {
  color: string;
  /** Sum of the unspent coins, base units. */
  total: bigint;
  /** The largest single payment: the biggest unspent, positioned coin (Q9). */
  largest: bigint;
  coins: number;
  /** Unspent coins whose position is not known yet (not spendable until it is). */
  unpositioned: number;
  /** Unspent coins with no inbox entry (recoverable only from this browser, Q13). */
  notInInbox: number;
}

export function holdingsByColour(coins: readonly StoredCoin[]): ColourHolding[] {
  const out = new Map<string, ColourHolding>();
  for (const c of coins) {
    if (c.spent) continue;
    const h = out.get(c.color) ?? {
      color: c.color,
      total: 0n,
      largest: 0n,
      coins: 0,
      unpositioned: 0,
      notInInbox: 0,
    };
    const v = BigInt(c.value);
    h.total += v;
    h.coins += 1;
    if (c.mtIndex === null) h.unpositioned += 1;
    else if (v > h.largest) h.largest = v;
    if (!c.inInbox) h.notInInbox += 1;
    out.set(c.color, h);
  }
  return [...out.values()].sort((a, b) => (a.color < b.color ? -1 : 1));
}

export class CoinChoiceError extends Error {
  override name = 'CoinChoiceError';
}

/**
 * The coin a payment of `amount` spends (plan L-ACC.5, Q9). The account has no coin merge, so a
 * payment is paid from ONE coin: the smallest unspent, positioned coin that covers it (least
 * change left behind). Throws with the largest single payment when none covers it.
 */
export function chooseCoin(
  coins: readonly StoredCoin[],
  color: string,
  amount: bigint,
): StoredCoin & { mtIndex: string } {
  const colour = normaliseHex32(color);
  const candidates = coins
    .filter((c) => !c.spent && c.color === colour && c.mtIndex !== null && BigInt(c.value) >= amount)
    .sort((a, b) => (BigInt(a.value) < BigInt(b.value) ? -1 : BigInt(a.value) > BigInt(b.value) ? 1 : 0));
  const pick = candidates[0];
  if (!pick) {
    const largest = coins
      .filter((c) => !c.spent && c.color === colour && c.mtIndex !== null)
      .reduce((m, c) => (BigInt(c.value) > m ? BigInt(c.value) : m), 0n);
    throw new CoinChoiceError(
      largest === 0n
        ? 'the account holds no spendable coin of this token'
        : `no single coin covers this amount; the largest single payment is ${largest.toString(10)} base units`,
    );
  }
  return pick as StoredCoin & { mtIndex: string };
}
