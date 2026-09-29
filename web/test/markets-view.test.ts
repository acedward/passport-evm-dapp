// Plan L-MKT.3: what the Markets page shows for each state, cell by cell.

import { describe, expect, it } from 'vitest';

import {
  type FeedState,
  ChartStatsSchema,
  PairsSchema,
  deriveMarkets,
  parseOffersPage,
  stagenetRegistry,
} from '@mnbank/core';

import { BOOK, PAIRS, STATS } from '../../packages/core/test/fixtures/kernel/book.js';
import { STATUS_TEXT, bookLines, depthText, ignoredText, marketRows, spreadText } from '../src/market/view.js';

const registry = stagenetRegistry();
const pairs = PairsSchema.parse(PAIRS);
const snapshot = deriveMarkets(parseOffersPage({ offers: BOOK, nextCursor: null }).offers, registry, (s) => ({
  pairs,
  stats: ChartStatsSchema.parse(STATS[s.midnightName as keyof typeof STATS]),
}));
const ready: FeedState = {
  status: 'ready',
  snapshot,
  complete: true,
  skipped: 0,
  tradeDataOk: true,
  updatedAt: 0,
  stream: 'live',
};
const market = (name: string) => snapshot.markets.find((m) => m.stock.midnightName === name)!;

describe('the markets table', () => {
  it('shows bid, ask, last trade, offers per side and status for each stock', () => {
    const rows = marketRows(ready, registry).map(({ colour: _c, symbol: _s, ...r }) => r);
    expect(rows).toEqual([
      {
        stock: 'wStkA',
        bestBid: '0.95',
        bestAsk: '1.05',
        lastTrade: '1.02',
        lastTradeAt: '2026-09-27 11:00 UTC',
        bids: '2',
        asks: '2',
        status: 'two-sided',
      },
      {
        stock: 'wStkB',
        bestBid: 'no bids',
        bestAsk: 'no asks',
        lastTrade: '0.0098',
        lastTradeAt: '2026-09-27 10:00 UTC',
        bids: '0',
        asks: '0',
        status: 'no-liquidity',
      },
      {
        stock: 'wStkC',
        bestBid: 'no bids',
        bestAsk: '0.0104',
        lastTrade: 'no trades yet',
        lastTradeAt: null,
        bids: '0',
        asks: '2',
        status: 'asks-only',
      },
      // The T-bills (PR #4 @ 6c7505a): no offers in this book, no fills.
      ...['TBILL', 'TB13W', 'TB26W', 'TB52W'].map((stock) => ({
        stock,
        bestBid: 'no bids',
        bestAsk: 'no asks',
        lastTrade: 'no trades yet',
        lastTradeAt: null,
        bids: '0',
        asks: '0',
        status: 'no-liquidity',
      })),
    ]);
    expect(STATUS_TEXT['no-liquidity']).toBe('No liquidity');
  });

  it('shows "exchange unavailable" on every row, with no price at all', () => {
    const rows = marketRows(
      { status: 'unavailable', reason: 'the exchange did not answer', since: 0, lastUpdatedAt: 0, stream: 'polling' },
      registry,
    );
    expect(rows.map((r) => r.status)).toEqual(Array.from({ length: 7 }, () => 'unavailable'));
    expect(rows.every((r) => r.bestBid === '—' && r.bestAsk === '—' && r.lastTrade === '—')).toBe(true);
    expect(STATUS_TEXT.unavailable).toBe('Exchange unavailable');
  });

  it('lists the stocks while loading', () => {
    expect(marketRows({ status: 'loading', stream: 'connecting' }, registry).map((r) => [r.stock, r.status])).toEqual([
      ['wStkA', 'loading'],
      ['wStkB', 'loading'],
      ['wStkC', 'loading'],
      ['TBILL', 'loading'],
      ['TB13W', 'loading'],
      ['TB26W', 'loading'],
      ['TB52W', 'loading'],
    ]);
  });

  it('says how many offers it did not price', () => {
    expect(ignoredText(ready)).toMatch(/^5 other offers with a USDC leg are not USDC against one stock/);
  });
});

describe('the book of one stock', () => {
  it('asks cheapest first and bids dearest first, with exact quantities and totals', () => {
    const a = market('wStkA');
    expect(bookLines(a, 'asks').map(({ offerId: _o, ...l }) => l)).toEqual([
      { price: '1.05', quantity: '10.00', total: '10.50' },
      { price: '1.10', quantity: '20.00', total: '22.00' },
    ]);
    expect(bookLines(a, 'bids').map(({ offerId: _o, ...l }) => l)).toEqual([
      { price: '0.95', quantity: '10.00', total: '9.50' },
      { price: '0.90', quantity: '5.00', total: '4.50' },
    ]);
    expect(spreadText(a)).toBe('0.10');
    expect(depthText(a, 'asks')).toBe('30.00 wStkA for 32.50 wUSDC');
    expect(depthText(a, 'bids')).toBe('15.00 wStkA for 14.00 wUSDC');
  });

  it('a one-sided book has no spread', () => {
    expect(spreadText(market('wStkC'))).toBeNull();
    expect(bookLines(market('wStkC'), 'asks').map((l) => l.price)).toEqual(['0.0104', '0.012']);
  });
});
