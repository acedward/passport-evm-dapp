// USDC prices for each stock, derived ONLY from the exchange's live offers (spec FR-007, Q3).
//
// - Kept: offers with exactly one leg on each side, both SHIELDED, of USDC against ONE stock
//   (the registry's roles). Baskets, stock-to-stock, unshielded legs and unknown colours are
//   ignored (counted, never priced).
// - An ASK gives a stock and wants USDC; a BID gives USDC and wants a stock. Both are priced in
//   whole tokens as USDC ÷ stock: an ask at want ÷ give, a bid at give ÷ want.
// - Best ask = the lowest ask; best bid = the highest bid. A pair with no live offer has
//   "no liquidity". Nothing is interpolated or invented: no mid, no reference price.
// - The last trade is the newest FILL: `/v1/chart/stats?base=<stock>&quote=<USDC>` (already
//   oriented to the stock), with `/v1/pairs` (oriented by colour hex) as the fallback. Both are
//   raw base-unit ratios; they are converted with each token's decimals. The kernel answers the
//   open-book MID as `last` for a pair that never filled, so a stats `last` counts only when a
//   fill is proven (the pair's `trade_count` > 0, or 24 h volume).
//
// All amounts are bigint base units and all prices exact rationals (`Ratio`); no floats.

import { type Ratio, compareRatio, formatUnits, priceRatio, quoteForBase } from '../amount.js';
import type { TokenEntry, TokenRegistry } from '../tokens/registry.js';
import type { ChartStats, OfferLeg, Pair } from './wire.js';

/** The fields of an offer the derivation reads (an `OfferRow` has them). */
export interface BookOfferInput {
  offerId: string;
  computed: {
    gives: readonly OfferLeg[];
    wants: readonly OfferLeg[];
    expiresAt?: string | null;
    firstSeenAt?: string | null;
  };
}

export type IgnoreReason =
  /** a side with no leg */
  | 'one-sided'
  /** more than one leg on a side */
  | 'basket'
  /** a leg that is not SHIELDED */
  | 'unshielded'
  /** a colour the bank does not list */
  | 'unknown-token'
  /** two stocks, no USDC */
  | 'stock-to-stock'
  /** USDC for USDC, or the same colour both ways */
  | 'not-a-pair'
  /** a zero amount: no price */
  | 'zero-amount'
  /** the same offer id twice */
  | 'duplicate';

export type Side = 'ask' | 'bid';

export interface BookEntry {
  offerId: string;
  side: Side;
  /** The stock leg, in the stock's base units. */
  stockRaw: bigint;
  /** The USDC leg, in USDC base units. */
  usdcRaw: bigint;
  /** Whole USDC per whole stock. */
  price: Ratio;
  expiresAt: string | null;
  firstSeenAt: string | null;
}

export type Classified =
  { kind: 'priced'; stock: TokenEntry; entry: BookEntry } | { kind: 'ignored'; reason: IgnoreReason };

/** Classify one live offer against the registry. */
export function classifyOffer(offer: BookOfferInput, registry: TokenRegistry): Classified {
  const { gives, wants } = offer.computed;
  if (gives.length === 0 || wants.length === 0) return { kind: 'ignored', reason: 'one-sided' };
  if (gives.length > 1 || wants.length > 1) return { kind: 'ignored', reason: 'basket' };
  const give = gives[0]!;
  const want = wants[0]!;
  if (give.type !== 'SHIELDED' || want.type !== 'SHIELDED') return { kind: 'ignored', reason: 'unshielded' };
  const g = registry.byColour(give.token);
  const w = registry.byColour(want.token);
  if (!g || !w) return { kind: 'ignored', reason: 'unknown-token' };
  if (g.role === 'stock' && w.role === 'stock') return { kind: 'ignored', reason: 'stock-to-stock' };
  if (!registry.isTradablePair(g.midnightColour, w.midnightColour)) return { kind: 'ignored', reason: 'not-a-pair' };
  if (give.amount <= 0n || want.amount <= 0n) return { kind: 'ignored', reason: 'zero-amount' };
  const side: Side = g.role === 'stock' ? 'ask' : 'bid';
  const stock = side === 'ask' ? g : w;
  const usdc = side === 'ask' ? w : g;
  const stockRaw = side === 'ask' ? give.amount : want.amount;
  const usdcRaw = side === 'ask' ? want.amount : give.amount;
  return {
    kind: 'priced',
    stock,
    entry: {
      offerId: offer.offerId,
      side,
      stockRaw,
      usdcRaw,
      price: reduce(priceRatio(usdcRaw, usdc.decimals, stockRaw, stock.decimals)),
      expiresAt: offer.computed.expiresAt ?? null,
      firstSeenAt: offer.computed.firstSeenAt ?? null,
    },
  };
}

// ── Last trade ─────────────────────────────────────────────────────────────

/** Parse a decimal text (as the kernel sends prices: "1.05", "0.0104", "1e-7") exactly. */
export function parseDecimalRatio(text: string): Ratio {
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!m) throw new RangeError(`not a non-negative decimal: "${text}"`);
  const frac = m[2] ?? '';
  let num = BigInt(m[1]! + frac);
  let den = 10n ** BigInt(frac.length);
  const exp = Number(m[3] ?? '0');
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 400) throw new RangeError(`exponent out of range: "${text}"`);
  if (exp > 0) num *= 10n ** BigInt(exp);
  if (exp < 0) den *= 10n ** BigInt(-exp);
  return reduce({ num, den });
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** The ratio in lowest terms (display and equality are easier; comparisons never need it). */
export function reduce(r: Ratio): Ratio {
  if (r.num === 0n) return { num: 0n, den: 1n };
  const g = gcd(r.num, r.den);
  return { num: r.num / g, den: r.den / g };
}

/** A raw base-unit ratio quote ÷ base, as whole quote tokens per whole base token. */
export function wholeFromRaw(raw: Ratio, baseDecimals: number, quoteDecimals: number): Ratio {
  return reduce({ num: raw.num * 10n ** BigInt(baseDecimals), den: raw.den * 10n ** BigInt(quoteDecimals) });
}

export type LastTrade =
  /** The newest fill, whole USDC per whole stock. */
  | { state: 'trade'; price: Ratio; source: 'chart-stats' | 'pairs'; at: string | null }
  /** The pair has never filled. */
  | { state: 'none' }
  /** The exchange's trade data could not be read, or does not prove a fill. */
  | { state: 'unknown' };

export interface TradeData {
  /** `/v1/pairs`, or null when it failed. */
  pairs: readonly Pair[] | null;
  /** `/v1/chart/stats?base=<stock>&quote=<USDC>` for this stock, or null when it failed. */
  stats: ChartStats | null;
}

/** The last trade of `stock` against `usdc`, from the kernel's fill data, never from the book. */
export function deriveLastTrade(stock: TokenEntry, usdc: TokenEntry, data: TradeData): LastTrade {
  const s = stock.midnightColour;
  const u = usdc.midnightColour;
  const pair =
    data.pairs?.find(
      (p) => (p.base_color === s && p.quote_color === u) || (p.base_color === u && p.quote_color === s),
    ) ?? null;
  const at = pair?.last_traded_at ?? null;

  // Is a fill proven?
  let filled: boolean | null;
  if (data.pairs !== null) filled = pair !== null && pair.trade_count > 0 && pair.last_price !== null;
  // Without the pair list, only 24 h volume proves a fill (a zero-volume `last` may be the mid).
  else if (data.stats !== null) filled = (safeRatio(data.stats.volume_base)?.num ?? 0n) > 0n ? true : null;
  else filled = null;
  if (filled === false) return { state: 'none' };
  if (filled === null) return { state: 'unknown' };

  // Primary: chart stats, oriented to the stock by the kernel.
  if (data.stats !== null && data.stats.base === s && data.stats.quote === u) {
    const raw = safeRatio(data.stats.last);
    if (raw && raw.num > 0n) {
      return { state: 'trade', price: wholeFromRaw(raw, stock.decimals, usdc.decimals), source: 'chart-stats', at };
    }
  }
  // Fallback: the pair row, oriented by colour hex (LEAST = base); re-orient to the stock.
  if (pair !== null && pair.last_price !== null) {
    const raw = safeRatio(pair.last_price);
    if (raw && raw.num > 0n) {
      const usdcPerStockRaw = pair.base_color === s ? raw : { num: raw.den, den: raw.num };
      return {
        state: 'trade',
        price: wholeFromRaw(usdcPerStockRaw, stock.decimals, usdc.decimals),
        source: 'pairs',
        at,
      };
    }
  }
  return { state: 'unknown' };
}

function safeRatio(text: string): Ratio | null {
  try {
    return parseDecimalRatio(text);
  } catch {
    return null;
  }
}

// ── Markets ────────────────────────────────────────────────────────────────

export interface SideSummary {
  /** Best first: asks ascending, bids descending; ties by offer id. */
  entries: BookEntry[];
  best: BookEntry | null;
  count: number;
  /** Sum of the stock legs, stock base units. */
  depthStockRaw: bigint;
  /** Sum of the USDC legs, USDC base units. */
  depthUsdcRaw: bigint;
}

export interface Market {
  stock: TokenEntry;
  usdc: TokenEntry;
  asks: SideSummary;
  bids: SideSummary;
  lastTrade: LastTrade;
  /** 'no-liquidity' when the pair has no live offer at all. */
  status: 'live' | 'no-liquidity';
}

export interface MarketsSnapshot {
  /** One per stock, in registry order. */
  markets: Market[];
  /** Offers seen but not priced, by reason. */
  ignored: Partial<Record<IgnoreReason, number>>;
  /** Live offers read from the exchange (priced + ignored). */
  offersSeen: number;
}

function summarise(entries: BookEntry[], side: Side): SideSummary {
  const sorted = [...entries].sort((a, b) => {
    const c = compareRatio(a.price, b.price);
    if (c !== 0) return side === 'ask' ? c : -c;
    return a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0;
  });
  return {
    entries: sorted,
    best: sorted[0] ?? null,
    count: sorted.length,
    depthStockRaw: sorted.reduce((t, e) => t + e.stockRaw, 0n),
    depthUsdcRaw: sorted.reduce((t, e) => t + e.usdcRaw, 0n),
  };
}

/**
 * Every stock's market against USDC, from the live offers and the fill data.
 * `trade(stock)` gives the fill data for one stock (null fields when the requests failed).
 */
export function deriveMarkets(
  offers: readonly BookOfferInput[],
  registry: TokenRegistry,
  trade: (stock: TokenEntry) => TradeData = () => ({ pairs: null, stats: null }),
): MarketsSnapshot {
  const usdc = registry.usdc();
  const byStock = new Map<string, { asks: BookEntry[]; bids: BookEntry[] }>();
  for (const s of registry.stocks()) byStock.set(s.midnightColour, { asks: [], bids: [] });
  const ignored: Partial<Record<IgnoreReason, number>> = {};
  const seen = new Set<string>();
  for (const offer of offers) {
    const id = offer.offerId.toLowerCase();
    if (seen.has(id)) {
      ignored.duplicate = (ignored.duplicate ?? 0) + 1;
      continue;
    }
    seen.add(id);
    const c = classifyOffer(offer, registry);
    if (c.kind === 'ignored') {
      ignored[c.reason] = (ignored[c.reason] ?? 0) + 1;
      continue;
    }
    const book = byStock.get(c.stock.midnightColour)!;
    (c.entry.side === 'ask' ? book.asks : book.bids).push(c.entry);
  }
  const markets = registry.stocks().map((stock): Market => {
    const book = byStock.get(stock.midnightColour)!;
    const asks = summarise(book.asks, 'ask');
    const bids = summarise(book.bids, 'bid');
    return {
      stock,
      usdc,
      asks,
      bids,
      lastTrade: deriveLastTrade(stock, usdc, trade(stock)),
      status: asks.count + bids.count === 0 ? 'no-liquidity' : 'live',
    };
  });
  return { markets, ignored, offersSeen: seen.size };
}

// ── Valuation (the holdings view, spec US2) ─────────────────────────────────

export type Valuation =
  /** USDC itself, at face value. */
  | { kind: 'usdc'; usdcRaw: bigint }
  /** A stock valued at the best live bid. */
  | { kind: 'priced'; usdcRaw: bigint; price: Ratio; offerId: string }
  /** A stock with no live bid: "no liquidity", left out of the total. */
  | { kind: 'no-liquidity' }
  /** The exchange could not be read: left out of the total. */
  | { kind: 'unavailable' }
  /** A colour the bank does not list. */
  | { kind: 'unknown-token' };

/** Value `amountRaw` of `colour` in USDC base units at the best bid (rounded down). Pass
 *  `snapshot` = null when the exchange is unavailable or not loaded yet. */
export function valueHolding(
  snapshot: MarketsSnapshot | null,
  registry: TokenRegistry,
  colour: string,
  amountRaw: bigint,
): Valuation {
  const token = registry.byColour(colour);
  if (!token) return { kind: 'unknown-token' };
  if (token.role === 'usdc') return { kind: 'usdc', usdcRaw: amountRaw };
  if (snapshot === null) return { kind: 'unavailable' };
  const market = snapshot.markets.find((m) => m.stock.midnightColour === token.midnightColour);
  const best = market?.bids.best ?? null;
  if (!market || !best) return { kind: 'no-liquidity' };
  return {
    kind: 'priced',
    usdcRaw: quoteForBase(amountRaw, token.decimals, best.price, market.usdc.decimals),
    price: best.price,
    offerId: best.offerId,
  };
}

export interface HoldingsValuation {
  items: Array<{ colour: string; amountRaw: bigint; valuation: Valuation }>;
  /** The sum of every USDC and priced item, USDC base units. */
  totalUsdcRaw: bigint;
  /** Items left out of the total ("no liquidity", unavailable or unknown), so the UI can say so. */
  excluded: number;
}

/** Value a list of holdings; the total leaves out what has no price and says how many. */
export function valueHoldings(
  snapshot: MarketsSnapshot | null,
  registry: TokenRegistry,
  holdings: ReadonlyArray<{ colour: string; amountRaw: bigint }>,
): HoldingsValuation {
  let total = 0n;
  let excluded = 0;
  const items = holdings.map((h) => {
    const valuation = valueHolding(snapshot, registry, h.colour, h.amountRaw);
    if (valuation.kind === 'usdc' || valuation.kind === 'priced') total += valuation.usdcRaw;
    else if (h.amountRaw > 0n) excluded++;
    return { colour: h.colour, amountRaw: h.amountRaw, valuation };
  });
  return { items, totalUsdcRaw: total, excluded };
}

// ── Display ────────────────────────────────────────────────────────────────

/**
 * Format a price (whole USDC per whole stock) with up to `maxDigits` decimals (at least 2).
 * Asks round UP and bids DOWN (the default), so a shown price never flatters the offer; a last
 * trade, which nobody can deal at, rounds to the NEAREST (half up). `exact` says whether
 * rounding happened.
 */
export function formatPrice(
  r: Ratio,
  opts: { maxDigits?: number; round?: 'down' | 'up' | 'nearest' } = {},
): { text: string; exact: boolean } {
  if (r.den <= 0n || r.num < 0n) throw new RangeError('a price is a non-negative ratio');
  const digits = opts.maxDigits ?? 6;
  const scaledNum = r.num * 10n ** BigInt(digits);
  let q = scaledNum / r.den;
  const exact = q * r.den === scaledNum;
  if (!exact && opts.round === 'up') q += 1n;
  if (!exact && opts.round === 'nearest') q = (2n * scaledNum + r.den) / (2n * r.den);
  return { text: formatUnits(q, digits, { minFractionDigits: 2, grouping: true }), exact };
}
