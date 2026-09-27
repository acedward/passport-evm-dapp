// What the Markets page shows, as plain text per cell: a pure function of the feed's state, so
// the wording ("no liquidity", "exchange unavailable", "no bids") is unit-tested in one place.
// Wording follows the MN Bank mockup (P0.6); the styling waits for its approval (Q16).

import {
  type BookEntry,
  type FeedState,
  type LastTrade,
  type Market,
  type Ratio,
  type TokenRegistry,
  formatPrice,
  formatUnits,
} from '@mnbank/core';

export type MarketStatus = 'two-sided' | 'bids-only' | 'asks-only' | 'no-liquidity' | 'unavailable' | 'loading';

export const STATUS_TEXT: Record<MarketStatus, string> = {
  'two-sided': 'Two-sided',
  'bids-only': 'Bids only',
  'asks-only': 'Asks only',
  'no-liquidity': 'No liquidity',
  unavailable: 'Exchange unavailable',
  loading: 'Loading…',
};

export interface MarketRowView {
  /** The stock's Midnight name (wStkA). */
  stock: string;
  /** Its Sepolia symbol (stkA), for "bridged from Sepolia". */
  symbol: string;
  colour: string;
  bestBid: string;
  bestAsk: string;
  lastTrade: string;
  lastTradeAt: string | null;
  bids: string;
  asks: string;
  status: MarketStatus;
}

/** Asks round up, bids down: a shown price never flatters the offer. */
export const askText = (r: Ratio) => formatPrice(r, { round: 'up' }).text;
export const bidText = (r: Ratio) => formatPrice(r, { round: 'down' }).text;

export function lastTradeText(t: LastTrade): string {
  if (t.state === 'trade') return formatPrice(t.price, { round: 'nearest' }).text;
  return t.state === 'none' ? 'no trades yet' : '—';
}

/** "2026-09-27 11:00 UTC" (the kernel's fill time is UTC). */
export function whenText(iso: string | null): string | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function marketStatus(m: Market): MarketStatus {
  if (m.status === 'no-liquidity') return 'no-liquidity';
  if (m.bids.count > 0 && m.asks.count > 0) return 'two-sided';
  return m.bids.count > 0 ? 'bids-only' : 'asks-only';
}

export function marketRow(m: Market): MarketRowView {
  return {
    stock: m.stock.midnightName,
    symbol: m.stock.symbol,
    colour: m.stock.midnightColour,
    bestBid: m.bids.best ? bidText(m.bids.best.price) : 'no bids',
    bestAsk: m.asks.best ? askText(m.asks.best.price) : 'no asks',
    lastTrade: lastTradeText(m.lastTrade),
    lastTradeAt: m.lastTrade.state === 'trade' ? whenText(m.lastTrade.at) : null,
    bids: String(m.bids.count),
    asks: String(m.asks.count),
    status: marketStatus(m),
  };
}

/** One row per stock in the registry, whatever the feed's state. */
export function marketRows(state: FeedState, registry: TokenRegistry): MarketRowView[] {
  if (state.status === 'ready') return state.snapshot.markets.map(marketRow);
  const status: MarketStatus = state.status === 'unavailable' ? 'unavailable' : 'loading';
  return registry.stocks().map((s) => ({
    stock: s.midnightName,
    symbol: s.symbol,
    colour: s.midnightColour,
    bestBid: '—',
    bestAsk: '—',
    lastTrade: '—',
    lastTradeAt: null,
    bids: '—',
    asks: '—',
    status,
  }));
}

export interface BookLineView {
  offerId: string;
  price: string;
  /** Stock quantity, whole tokens. */
  quantity: string;
  /** USDC paid (asks) or received (bids), whole tokens. */
  total: string;
}

export function bookLines(m: Market, side: 'asks' | 'bids'): BookLineView[] {
  const fmt = (e: BookEntry): BookLineView => ({
    offerId: e.offerId,
    price: side === 'asks' ? askText(e.price) : bidText(e.price),
    quantity: formatUnits(e.stockRaw, m.stock.decimals, { minFractionDigits: 2, grouping: true }),
    total: formatUnits(e.usdcRaw, m.usdc.decimals, { minFractionDigits: 2, grouping: true }),
  });
  return m[side].entries.map(fmt);
}

/** Best ask minus best bid, when both exist (exact; shown rounded up). */
export function spreadText(m: Market): string | null {
  const a = m.asks.best?.price;
  const b = m.bids.best?.price;
  if (!a || !b) return null;
  const num = a.num * b.den - b.num * a.den;
  const den = a.den * b.den;
  if (num < 0n) return `-${formatPrice({ num: -num, den }, { round: 'up' }).text}`; // a crossed book
  return formatPrice({ num, den }, { round: 'up' }).text;
}

/** The amount side of a depth line: "30.00 wStkA for 32.50 wUSDC". */
export function depthText(m: Market, side: 'asks' | 'bids'): string {
  const s = m[side];
  const stock = formatUnits(s.depthStockRaw, m.stock.decimals, { minFractionDigits: 2, grouping: true });
  const usdc = formatUnits(s.depthUsdcRaw, m.usdc.decimals, { minFractionDigits: 2, grouping: true });
  return `${stock} ${m.stock.midnightName} for ${usdc} ${m.usdc.midnightName}`;
}

/** "N offers on the exchange are not USDC against one stock" (baskets, stock-to-stock, …). */
export function ignoredText(state: FeedState): string | null {
  if (state.status !== 'ready') return null;
  const n = Object.values(state.snapshot.ignored).reduce((t, x) => t + (x ?? 0), 0);
  if (n === 0) return null;
  return `${n} other ${n === 1 ? 'offer' : 'offers'} with a USDC leg ${n === 1 ? 'is' : 'are'} not USDC against one stock (a basket, an unshielded leg or an unlisted token) and ${n === 1 ? 'is' : 'are'} not shown.`;
}
