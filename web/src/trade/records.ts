// The trades this browser keeps (spec FR-003, Q5): every offer the account made (My offers) and
// every offer it took, under the store's `offer` kind, one record per offer id. Nothing about a
// trade is kept anywhere else: the relay forgets the job after its TTL.

import { type OfferState, type TradeSide, formatUnits, type Ratio, formatPrice } from '@mnbank/core';

import type { LocalStore } from '../store/store.js';
import { recordKey, type WalletScope } from '../store/schema.js';

export interface TradeRecord {
  /** The kernel's id of the offer (the maker's offer, for a take). */
  offerId: string;
  /** `make`: this account's own offer; `take`: an offer this account took. */
  role: 'make' | 'take';
  side: TradeSide;
  /** Stock and USDC colours, and the two legs in base units (decimal strings). */
  stock: string;
  usdc: string;
  stockRaw: string;
  usdcRaw: string;
  /** Human text, e.g. "sell 2.00 wStkA at 1.05". */
  summary: string;
  /** The coin the give is paid from (its commitment). */
  coin: string;
  /** The auth nonce the signature binds (a make stays live only while the account's is this). */
  authNonce: string;
  /** The wanted coin's nonce: when a coin with it reaches the inbox, the offer was filled. */
  wantNonce: string;
  createdAt: number;
  /** Unix ms after which the ledger refuses the offer (intent TTL). */
  expiresAt: number;
  state: OfferState;
  /** The exchange's last word on it. */
  kernelStatus?: string;
  /** The settling transaction, once known. */
  settledTx?: string;
  checkedAt?: number;
}

export const readTrades = (store: LocalStore, scope: WalletScope, account: string): TradeRecord[] => {
  const out: TradeRecord[] = [];
  for (const r of store.list(scope)) {
    if (r.parsed.kind !== 'offer' || r.parsed.scope.global || r.parsed.scope.account !== account || !r.record) continue;
    out.push(r.record.data as TradeRecord);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
};

export const putTrade = (store: LocalStore, scope: WalletScope, account: string, t: TradeRecord) =>
  store.put(scope, 'offer', t, { account, id: `${t.role}-${t.offerId}` });

export const tradeKey = (scope: WalletScope, account: string, t: Pick<TradeRecord, 'role' | 'offerId'>) =>
  recordKey(scope, 'offer', { account, id: `${t.role}-${t.offerId}` });

/** The account's live offer, if any (Q9: at most one). */
export function liveOffer(trades: readonly TradeRecord[], now: number): TradeRecord | null {
  return trades.find((t) => t.role === 'make' && t.state === 'live' && now < t.expiresAt) ?? null;
}

/** "sell 2.00 wStkA at 1.05" */
export function tradeSummary(
  side: TradeSide,
  stockRaw: bigint,
  stock: { midnightName: string; decimals: number },
  price: Ratio,
): string {
  return `${side} ${formatUnits(stockRaw, stock.decimals, { minFractionDigits: 2, grouping: true })} ${stock.midnightName} at ${formatPrice(price, { round: side === 'sell' ? 'up' : 'down' }).text}`;
}
