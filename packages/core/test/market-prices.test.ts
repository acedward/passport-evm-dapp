// Plan L-MKT.2: the price derivation, over fixtures. Every expected price is written out by
// hand (whole USDC per whole stock), never computed by the code under test.

import { describe, expect, it } from 'vitest';

import {
  type BookOfferInput,
  type MarketsSnapshot,
  type Ratio,
  classifyOffer,
  deriveLastTrade,
  deriveMarkets,
  formatPrice,
  parseDecimalRatio,
  parseOffersPage,
  registryFromConfig,
  stagenetRegistry,
  valueHolding,
  valueHoldings,
  wholeFromRaw,
  PairsSchema,
  ChartStatsSchema,
} from '../src/index.js';
import { BOOK, COLOUR, EXPECTED, PAIRS, STATS, leg, offerRow, type WireOffer } from './fixtures/kernel/book.js';

const registry = stagenetRegistry();
const rows = (offers: WireOffer[]): BookOfferInput[] => parseOffersPage({ offers, nextCursor: null }).offers;
const price = (r: Ratio | undefined, round: 'down' | 'up' | 'nearest' = 'down') =>
  r === undefined ? null : formatPrice(r, { round }).text;
const pairs = PairsSchema.parse(PAIRS);
const stats = (k: keyof typeof STATS) => ChartStatsSchema.parse(STATS[k]);
const market = (snap: MarketsSnapshot, name: string) => snap.markets.find((m) => m.stock.midnightName === name)!;

describe('classifying one live offer', () => {
  const one = (o: WireOffer) => classifyOffer(rows([o])[0]!, registry);

  it('an ask gives a stock and wants USDC, priced want ÷ give', () => {
    const c = one(offerRow(1, [leg(COLOUR.wStkA, 10_000_000)], [leg(COLOUR.wUSDC, 10_500_000)]));
    expect(c.kind).toBe('priced');
    if (c.kind !== 'priced') return;
    expect(c.entry.side).toBe('ask');
    expect(c.stock.midnightName).toBe('wStkA');
    expect([c.entry.stockRaw, c.entry.usdcRaw]).toEqual([10_000_000n, 10_500_000n]);
    expect(price(c.entry.price)).toBe('1.05');
  });

  it('a bid gives USDC and wants a stock, priced give ÷ want', () => {
    const c = one(offerRow(2, [leg(COLOUR.wUSDC, 9_500_000)], [leg(COLOUR.wStkA, 10_000_000)]));
    expect(c.kind === 'priced' && c.entry.side).toBe('bid');
    if (c.kind === 'priced') expect(price(c.entry.price)).toBe('0.95');
  });

  it.each([
    ['basket', offerRow(8, [leg(COLOUR.wStkB, 1), leg(COLOUR.wStkC, 1)], [leg(COLOUR.wUSDC, 2)])],
    ['basket', offerRow(8, [leg(COLOUR.wUSDC, 2)], [leg(COLOUR.wStkB, 1), leg(COLOUR.wStkB, 1)])],
    ['stock-to-stock', offerRow(7, [leg(COLOUR.wStkA, 5)], [leg(COLOUR.wStkB, 5)])],
    ['unshielded', offerRow(9, [leg(COLOUR.wStkB, 1)], [leg(COLOUR.wUSDC, 1, 'UNSHIELDED')])],
    ['unshielded', offerRow(9, [leg(COLOUR.wStkB, 1, 'UNSHIELDED')], [leg(COLOUR.wUSDC, 1)])],
    ['unshielded', offerRow(11, [leg(COLOUR.NIGHT, 1, 'UNSHIELDED')], [leg(COLOUR.wUSDC, 1)])],
    ['unknown-token', offerRow(10, [leg(COLOUR.wStkB, 1)], [leg(COLOUR.TWUSDC, 1)])],
    ['unknown-token', offerRow(10, [leg(COLOUR.TWUSDC, 1)], [leg(COLOUR.wStkA, 1)])],
    ['unknown-token', offerRow(10, [leg('not-a-colour', 1)], [leg(COLOUR.wStkA, 1)])],
    ['not-a-pair', offerRow(12, [leg(COLOUR.wUSDC, 1)], [leg(COLOUR.wUSDC, 2)])],
    ['zero-amount', offerRow(13, [leg(COLOUR.wStkA, 0)], [leg(COLOUR.wUSDC, 1)])],
    ['zero-amount', offerRow(13, [leg(COLOUR.wUSDC, 1)], [leg(COLOUR.wStkA, 0)])],
    ['one-sided', offerRow(14, [leg(COLOUR.wStkA, 1)], [])],
    ['one-sided', offerRow(14, [], [leg(COLOUR.wUSDC, 1)])],
  ] as const)('ignores %s offers', (reason, o) => {
    expect(one(o)).toEqual({ kind: 'ignored', reason });
  });

  it('reads colours in any case (the kernel serves lowercase; the registry normalises)', () => {
    const c = one(offerRow(1, [leg(COLOUR.wStkA.toUpperCase(), 1_000_000)], [leg(COLOUR.wUSDC, 2_000_000)]));
    expect(c.kind === 'priced' && price(c.entry.price)).toBe('2.00');
  });
});

describe('the markets from a book (spec US3, SC-002)', () => {
  const snap = deriveMarkets(rows(BOOK), registry, (s) => ({
    pairs,
    stats: stats(s.midnightName as keyof typeof STATS),
  }));

  it('lists every stock against USDC, in registry order', () => {
    expect(snap.markets.map((m) => [m.stock.midnightName, m.usdc.midnightName])).toEqual([
      ['wStkA', 'wUSDC'],
      ['wStkB', 'wUSDC'],
      ['wStkC', 'wUSDC'],
      ['TBILL', 'wUSDC'],
      ['TB13W', 'wUSDC'],
      ['TB26W', 'wUSDC'],
      ['TB52W', 'wUSDC'],
    ]);
  });

  it('both sides: best ask is the lowest ask, best bid the highest bid, with counts and depth', () => {
    const a = market(snap, 'wStkA');
    expect(a.status).toBe('live');
    expect(price(a.asks.best?.price, 'up')).toBe(EXPECTED.wStkA.bestAsk);
    expect(price(a.bids.best?.price)).toBe(EXPECTED.wStkA.bestBid);
    expect([a.bids.count, a.asks.count]).toEqual([EXPECTED.wStkA.bids, EXPECTED.wStkA.asks]);
    expect(a.asks.entries.map((e) => price(e.price, 'up'))).toEqual(['1.05', '1.10']);
    expect(a.bids.entries.map((e) => price(e.price))).toEqual(['0.95', '0.90']);
    expect([a.asks.depthStockRaw, a.asks.depthUsdcRaw]).toEqual([30_000_000n, 32_500_000n]);
    expect([a.bids.depthStockRaw, a.bids.depthUsdcRaw]).toEqual([15_000_000n, 14_000_000n]);
  });

  it('asks only: the ask shows and there is no bid (US3 scenario 1)', () => {
    const c = market(snap, 'wStkC');
    expect(c.status).toBe('live');
    expect(price(c.asks.best?.price, 'up')).toBe(EXPECTED.wStkC.bestAsk);
    expect(c.bids.best).toBeNull();
    expect([c.bids.count, c.asks.count]).toEqual([0, 2]);
  });

  it('bids only: the bid shows and there is no ask', () => {
    const s = deriveMarkets(
      rows([offerRow(1, [leg(COLOUR.wUSDC, 3_000_000)], [leg(COLOUR.wStkB, 4_000_000)])]),
      registry,
    );
    const b = market(s, 'wStkB');
    expect(price(b.bids.best?.price)).toBe('0.75');
    expect(b.asks.best).toBeNull();
    expect(b.status).toBe('live');
  });

  it('a pair with no live offer has no liquidity, whatever else is on the exchange', () => {
    const b = market(snap, 'wStkB');
    expect(b.status).toBe('no-liquidity');
    expect(b.asks.count + b.bids.count).toBe(0);
    expect(deriveMarkets([], registry).markets.every((m) => m.status === 'no-liquidity')).toBe(true);
  });

  it('counts what it ignored, and never prices it', () => {
    expect(snap.ignored).toEqual({ 'stock-to-stock': 1, basket: 1, unshielded: 2, 'unknown-token': 1 });
    expect(snap.offersSeen).toBe(BOOK.length);
  });

  it('counts a repeated offer once', () => {
    const s = deriveMarkets(rows([BOOK[BOOK.length - 1]!, BOOK[BOOK.length - 1]!]), registry);
    expect(market(s, 'wStkA').asks.count).toBe(1);
    expect(s.ignored.duplicate).toBe(1);
  });

  it('orders equal prices by offer id, so the book is stable', () => {
    const s = deriveMarkets(
      rows([
        offerRow(21, [leg(COLOUR.wStkA, 2_000_000)], [leg(COLOUR.wUSDC, 2_000_000)]),
        offerRow(20, [leg(COLOUR.wStkA, 1_000_000)], [leg(COLOUR.wUSDC, 1_000_000)]),
      ]),
      registry,
    );
    const ids = market(s, 'wStkA').asks.entries.map((e) => e.offerId);
    expect(ids).toEqual([...ids].sort());
  });
});

describe('6- and 18-decimal maths', () => {
  const colour = (c: string) => c.repeat(64);
  const reg = registryFromConfig('undeployed', {
    tokens: [
      { symbol: 'USDC', midnightName: 'wUSDC', role: 'usdc', decimals: 6, midnightColour: colour('c') },
      { symbol: 'ETHS', midnightName: 'wETHS', role: 'stock', decimals: 18, midnightColour: colour('a') },
      { symbol: 'TINY', midnightName: 'wTINY', role: 'stock', decimals: 0, midnightColour: colour('e') },
    ],
  });
  const reg18 = registryFromConfig('undeployed', {
    tokens: [
      // USDC's colour sorts first here, so the kernel would orient this pair with USDC as the base.
      { symbol: 'USDC', midnightName: 'wUSDC18', role: 'usdc', decimals: 18, midnightColour: colour('1') },
      { symbol: 'STK', midnightName: 'wStk6', role: 'stock', decimals: 6, midnightColour: colour('a') },
    ],
  });

  it('prices an 18-decimal stock against 6-decimal USDC exactly', () => {
    // 2 whole (2e18 base units) for 3000 USDC (3e9 base units) = 1500 USDC each.
    const s = deriveMarkets(
      rows([offerRow(1, [leg(colour('a'), 2n * 10n ** 18n)], [leg(colour('c'), 3_000_000_000n)])]),
      reg,
    );
    expect(price(market(s, 'wETHS').asks.best?.price, 'up')).toBe('1,500.00');
    // 0.000000000000000001 of it (1 base unit) wanted for 0.000001 USDC: 10^12 USDC each.
    const t = deriveMarkets(rows([offerRow(2, [leg(colour('c'), 1)], [leg(colour('a'), 1)])]), reg);
    expect(market(t, 'wETHS').bids.best?.price).toEqual({ num: 10n ** 12n, den: 1n });
  });

  it('prices a 6-decimal stock against 18-decimal USDC exactly', () => {
    // 10 stock (10e6) for 10.5 USDC (10.5e18) = 1.05.
    const s = deriveMarkets(
      rows([offerRow(1, [leg(colour('a'), 10_000_000)], [leg(colour('1'), 105n * 10n ** 17n)])]),
      reg18,
    );
    expect(price(market(s, 'wStk6').asks.best?.price, 'up')).toBe('1.05');
  });

  it('prices a 0-decimal stock', () => {
    const s = deriveMarkets(rows([offerRow(1, [leg(colour('e'), 3)], [leg(colour('c'), 1_000_000)])]), reg);
    expect(price(market(s, 'wTINY').asks.best?.price, 'up')).toBe('0.333334');
    expect(price(market(s, 'wTINY').asks.best?.price, 'down')).toBe('0.333333');
  });

  it('converts a raw last-trade ratio with each side’s decimals, in both orientations', () => {
    // 18-dp stock at 1500 USDC: raw ratio USDC/stock = 1.5e-9, as a JSON number from chart stats.
    const lt = deriveLastTrade(reg.byMidnightName('wETHS')!, reg.usdc(), {
      pairs: [
        {
          pair_key: 'x',
          base_color: colour('a'),
          quote_color: colour('c'),
          trade_count: 1,
          last_price: '0.0000000015',
          last_traded_at: null,
          open_count: 0,
        },
      ],
      stats: ChartStatsSchema.parse({ base: colour('a'), quote: colour('c'), last: 1.5e-9, volume_base: 1 }),
    });
    expect(lt).toMatchObject({ state: 'trade', source: 'chart-stats', price: { num: 1500n, den: 1n } });
    // The same from the pair list alone, and from a pair oriented the other way (USDC as base).
    const pairOnly = deriveLastTrade(reg.byMidnightName('wETHS')!, reg.usdc(), {
      pairs: [
        {
          pair_key: 'x',
          base_color: colour('a'),
          quote_color: colour('c'),
          trade_count: 1,
          last_price: '0.0000000015',
          last_traded_at: null,
          open_count: 0,
        },
      ],
      stats: null,
    });
    expect(pairOnly).toMatchObject({ state: 'trade', source: 'pairs', price: { num: 1500n, den: 1n } });
    const flipped = deriveLastTrade(reg18.byMidnightName('wStk6')!, reg18.usdc(), {
      pairs: [
        {
          pair_key: 'x',
          base_color: colour('1'), // LEAST colour: USDC is the base, so last_price = stock raw ÷ USDC raw
          quote_color: colour('a'),
          trade_count: 2,
          last_price: '0.00000000000095238095238095238095', // 10e6 stock per 10.5e18 USDC
          last_traded_at: null,
          open_count: 0,
        },
      ],
      stats: null,
    });
    expect(flipped.state === 'trade' && formatPrice(flipped.price, { round: 'nearest' }).text).toBe('1.05');
  });
});

describe('the last trade (FR-007: fills only, never the book)', () => {
  const [A, B, C] = registry.stocks();
  const usdc = registry.usdc();

  it('takes the chart stats, already oriented to the stock', () => {
    expect(deriveLastTrade(A, usdc, { pairs, stats: stats('wStkA') })).toEqual({
      state: 'trade',
      price: { num: 51n, den: 50n },
      source: 'chart-stats',
      at: '2026-09-27T11:00:00.000Z',
    });
  });

  it('falls back to the pair list, re-oriented when USDC is the base (colour order)', () => {
    const lt = deriveLastTrade(B, usdc, { pairs, stats: null });
    expect(lt.state === 'trade' && lt.source).toBe('pairs');
    // 1 ÷ 102.04081632653061224490 (Postgres cut it at 20 decimals): 0.0098 to the nearest.
    expect(lt.state === 'trade' && formatPrice(lt.price, { round: 'nearest' }).text).toBe('0.0098');
    // With the stats available, the same trade reads exactly.
    const exact = deriveLastTrade(B, usdc, { pairs, stats: stats('wStkB') });
    expect(exact.state === 'trade' && formatPrice(exact.price).text).toBe('0.0098');
  });

  it('never shows the kernel’s open-book mid as a trade', () => {
    // wStkC never filled: the pair list says so, and the stats' `last` (0.0104) is the mid.
    expect(deriveLastTrade(C, usdc, { pairs, stats: stats('wStkC') })).toEqual({ state: 'none' });
    // Without the pair list, a zero-volume stats `last` proves nothing.
    expect(deriveLastTrade(C, usdc, { pairs: null, stats: stats('wStkC') })).toEqual({ state: 'unknown' });
    // … but 24 h volume does.
    expect(deriveLastTrade(A, usdc, { pairs: null, stats: stats('wStkA') })).toMatchObject({ state: 'trade' });
  });

  it('a pair the kernel has never seen has no trade; no data at all is unknown', () => {
    expect(deriveLastTrade(A, usdc, { pairs: [], stats: null })).toEqual({ state: 'none' });
    expect(deriveLastTrade(A, usdc, { pairs: null, stats: null })).toEqual({ state: 'unknown' });
  });

  it('reads the staging kernel’s captured "no data" answers as no trade', async () => {
    const { readFile } = await import('node:fs/promises');
    const dir = new URL('./fixtures/kernel/staging-2026-09-27/', import.meta.url);
    const p = PairsSchema.parse(JSON.parse(await readFile(new URL('pairs.json', dir), 'utf8')));
    const s = ChartStatsSchema.parse(JSON.parse(await readFile(new URL('chart-stats-wstka-wusdc.json', dir), 'utf8')));
    expect(deriveLastTrade(A, usdc, { pairs: p, stats: s })).toEqual({ state: 'none' });
    expect(deriveLastTrade(A, usdc, { pairs: null, stats: s })).toEqual({ state: 'unknown' });
  });
});

describe('decimal parsing and display', () => {
  it('parses the kernel’s decimal texts exactly', () => {
    expect(parseDecimalRatio('1.05000000000000000000')).toEqual({ num: 21n, den: 20n });
    expect(parseDecimalRatio('0.0104')).toEqual({ num: 13n, den: 1250n });
    expect(parseDecimalRatio('1.5e-9')).toEqual({ num: 3n, den: 2_000_000_000n });
    expect(parseDecimalRatio('12')).toEqual({ num: 12n, den: 1n });
    expect(parseDecimalRatio('2E+3')).toEqual({ num: 2000n, den: 1n });
    expect(parseDecimalRatio('0')).toEqual({ num: 0n, den: 1n });
    for (const bad of ['', '-1', '1.', '.5', 'NaN', 'Infinity', '1,5', '0x10', '1e']) {
      expect(() => parseDecimalRatio(bad), bad).toThrow(RangeError);
    }
  });

  it('rounds asks up, bids down and last trades to the nearest', () => {
    const third = { num: 1n, den: 3n };
    const twoThirds = { num: 2n, den: 3n };
    expect(formatPrice(third, { round: 'up' })).toEqual({ text: '0.333334', exact: false });
    expect(formatPrice(third, { round: 'down' })).toEqual({ text: '0.333333', exact: false });
    expect(formatPrice(twoThirds, { round: 'nearest' }).text).toBe('0.666667');
    expect(formatPrice({ num: 21n, den: 20n }, { round: 'up' })).toEqual({ text: '1.05', exact: true });
    expect(formatPrice({ num: 1234567n, den: 1n })).toEqual({ text: '1,234,567.00', exact: true });
    expect(formatPrice({ num: 1n, den: 3n }, { maxDigits: 2, round: 'up' }).text).toBe('0.34');
  });

  it('converts raw ratios with decimals', () => {
    expect(wholeFromRaw({ num: 3n, den: 2_000_000_000n }, 18, 6)).toEqual({ num: 1500n, den: 1n });
  });
});

describe('valuation at the best bid (spec US2, assumptions)', () => {
  const snap = deriveMarkets(rows(BOOK), registry, () => ({ pairs, stats: null }));
  const A = COLOUR.wStkA;

  it('values a stock at the best bid, rounded down, and USDC at face value', () => {
    // 12.345678 wStkA at 0.95 = 11.7283941 → 11.728394 USDC.
    expect(valueHolding(snap, registry, A, 12_345_678n)).toEqual({
      kind: 'priced',
      usdcRaw: 11_728_394n,
      price: { num: 19n, den: 20n },
      offerId: market(snap, 'wStkA').bids.best!.offerId,
    });
    expect(valueHolding(snap, registry, COLOUR.wUSDC, 7_000_000n)).toEqual({ kind: 'usdc', usdcRaw: 7_000_000n });
  });

  it('a stock with no bid is "no liquidity", even when asks exist', () => {
    expect(valueHolding(snap, registry, COLOUR.wStkC, 1n)).toEqual({ kind: 'no-liquidity' });
    expect(valueHolding(snap, registry, COLOUR.wStkB, 1n)).toEqual({ kind: 'no-liquidity' });
  });

  it('the exchange unavailable, or an unlisted colour, is said so', () => {
    expect(valueHolding(null, registry, A, 1n)).toEqual({ kind: 'unavailable' });
    expect(valueHolding(null, registry, COLOUR.wUSDC, 5n)).toEqual({ kind: 'usdc', usdcRaw: 5n });
    expect(valueHolding(snap, registry, COLOUR.TWUSDC, 1n)).toEqual({ kind: 'unknown-token' });
  });

  it('totals only what has a value, and counts what it left out (US2 scenario 2)', () => {
    const v = valueHoldings(snap, registry, [
      { colour: COLOUR.wStkA, amountRaw: 100_000_000n }, // 100 × 0.95 = 95
      { colour: COLOUR.wStkB, amountRaw: 50_000_000n }, // no bid: excluded
      { colour: COLOUR.wStkC, amountRaw: 0n }, // nothing held: not "excluded"
      { colour: COLOUR.wUSDC, amountRaw: 2_500_000n }, // 2.5 at face value
    ]);
    expect(v.totalUsdcRaw).toBe(97_500_000n);
    expect(v.excluded).toBe(1);
    expect(v.items.map((i) => i.valuation.kind)).toEqual(['priced', 'no-liquidity', 'no-liquidity', 'usdc']);
  });
});
