// Plan L-TRD: the legs of an order in exact bigint maths, taking a whole book entry, funding it
// from one coin (Q9), and the one-live-offer rule with its warnings (L-TRD.3).

import { describe, expect, it } from 'vitest';

import type { StoredCoin } from '../src/coins.js';
import {
  OpenSwapPayloadSchema,
  TakePayloadSchema,
  TradeError,
  fundWithOneCoin,
  guardSignedAction,
  offerStillLive,
  orderLegs,
  parsePrice,
  takeLegs,
} from '../src/trade.js';

const STOCK = { midnightColour: 'a1'.repeat(32), decimals: 6, midnightName: 'wStkA' };
const USDC = { midnightColour: 'b2'.repeat(32), decimals: 6, midnightName: 'wUSDC' };
const U = 1_000_000n;

const coin = (value: bigint, extra: Partial<StoredCoin> = {}): StoredCoin => ({
  nonce: (value.toString(16).padStart(2, '0') + 'cc'.repeat(32)).slice(0, 64),
  color: USDC.midnightColour,
  value: value.toString(),
  mtIndex: '7',
  commitment: `${value.toString(16)}`.padStart(64, '0'),
  origin: 'inbox',
  inInbox: true,
  spent: false,
  ...extra,
});

describe('the legs of an order (FR-011)', () => {
  it('sell 10 at 1.05 gives 10 wStkA and wants 10.5 wUSDC; buy 10 at 0.95 gives 9.5 wUSDC and wants 10 wStkA', () => {
    const sell = orderLegs('sell', STOCK, USDC, 10n * U, parsePrice('1.05', USDC));
    expect(sell.give).toEqual({ colour: STOCK.midnightColour, amount: 10_000_000n });
    expect(sell.want).toEqual({ colour: USDC.midnightColour, amount: 10_500_000n });
    expect(sell.rounded).toBe(false);
    const buy = orderLegs('buy', STOCK, USDC, 10n * U, parsePrice('0.95', USDC));
    expect(buy.give).toEqual({ colour: USDC.midnightColour, amount: 9_500_000n });
    expect(buy.want).toEqual({ colour: STOCK.midnightColour, amount: 10_000_000n });
  });

  it("L-TRD.0's order: sell 2 wStkA at 1.05 wants exactly 2.10 wUSDC", () => {
    const o = orderLegs('sell', STOCK, USDC, 2n * U, parsePrice('1.05', USDC));
    expect(o.want.amount).toBe(2_100_000n);
    expect(o.effectivePrice).toEqual({ num: 2_100_000n * U, den: 2_000_000n * U });
  });

  it('rounds a fractional USDC leg in the customer’s favour: a sell asks at least P, a buy pays at most P', () => {
    // 0.000003 wStkA at 0.5 = 0.0000015 wUSDC: not a whole base unit.
    const sell = orderLegs('sell', STOCK, USDC, 3n, parsePrice('0.5', USDC));
    expect(sell.want.amount).toBe(2n);
    expect(sell.rounded).toBe(true);
    const buy = orderLegs('buy', STOCK, USDC, 3n, parsePrice('0.5', USDC));
    expect(buy.give.amount).toBe(1n);
    expect(buy.rounded).toBe(true);
    // Effective prices respect the limit on both sides.
    expect(sell.effectivePrice.num * 2n >= sell.effectivePrice.den).toBe(true);
    expect(buy.effectivePrice.num * 2n <= buy.effectivePrice.den).toBe(true);
  });

  it('works across decimals (an 18-decimal stock against 6-decimal USDC)', () => {
    const stock18 = { ...STOCK, decimals: 18 };
    const o = orderLegs('buy', stock18, USDC, 10n ** 18n, parsePrice('2.5', USDC));
    expect(o.give.amount).toBe(2_500_000n);
    expect(o.want.amount).toBe(10n ** 18n);
  });

  it('refuses nonsense: zero quantity, zero price, a buy that rounds to nothing, too many price digits', () => {
    expect(() => orderLegs('sell', STOCK, USDC, 0n, parsePrice('1', USDC))).toThrow(TradeError);
    expect(() => parsePrice('0', USDC)).toThrow(TradeError);
    expect(() => parsePrice('1.0000001', USDC)).toThrow(TradeError);
    expect(() => parsePrice('abc', USDC)).toThrow(TradeError);
    expect(() => orderLegs('buy', STOCK, USDC, 1n, parsePrice('0.5', USDC))).toThrow(/rounds to zero/);
  });
});

describe('taking a whole book entry (FR-012)', () => {
  it('taking an ask is a buy: give its USDC, want its stock', () => {
    const t = takeLegs({ side: 'ask', stockRaw: 2n * U, usdcRaw: 2_100_000n }, STOCK, USDC);
    expect(t.side).toBe('buy');
    expect(t.give).toEqual({ colour: USDC.midnightColour, amount: 2_100_000n });
    expect(t.want).toEqual({ colour: STOCK.midnightColour, amount: 2n * U });
  });

  it('taking a bid is a sell: give its stock, want its USDC', () => {
    const t = takeLegs({ side: 'bid', stockRaw: 5n * U, usdcRaw: 4_750_000n }, STOCK, USDC);
    expect(t.side).toBe('sell');
    expect(t.give).toEqual({ colour: STOCK.midnightColour, amount: 5n * U });
    expect(t.want).toEqual({ colour: USDC.midnightColour, amount: 4_750_000n });
  });
});

describe('one coin per payment (Q9)', () => {
  const give = { colour: USDC.midnightColour, amount: 10_500_000n };

  it('uses the smallest positioned, unspent coin that covers the payment', () => {
    const coins = [coin(20n * U), coin(11n * U), coin(12n * U), coin(50n * U, { spent: true })];
    const r = fundWithOneCoin(coins, give, USDC);
    expect(r.ok && r.coin.value).toBe('11000000');
  });

  it('an offer bigger than every single coin is not takeable, and says why (US8 acceptance 1)', () => {
    const coins = [coin(8n * U), coin(6n * U), coin(40n * U, { mtIndex: null })];
    const r = fundWithOneCoin(coins, give, USDC);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.largest).toBe(8n * U);
      expect(r.reason).toBe('Needs 10.50 wUSDC from one coin; your largest single payment is 8.00.');
    }
  });

  it('says so when the account holds none of the token', () => {
    const r = fundWithOneCoin([], give, USDC);
    expect(!r.ok && r.reason).toBe('You hold no spendable wUSDC.');
  });
});

describe('the one-live-offer rule and the warnings (Q9, L-TRD.1, L-TRD.3)', () => {
  const now = Date.parse('2026-09-27T20:00:00Z');
  const live = {
    status: 'live' as const,
    authNonce: '4',
    expiresAt: now + 30 * 60_000,
    summary: 'sell 2.00 wStkA at 1.05',
  };

  it('a second offer is refused while one is live', () => {
    const g = guardSignedAction('open-swap', live, now, '4');
    expect(g.kind).toBe('refuse');
    expect(g.kind === 'refuse' && g.message).toContain('one live offer at a time');
    expect(g.kind === 'refuse' && g.message).toContain('20:30 UTC');
  });

  it('a withdrawal, a bridge move, re-filing change or a take warns that it cancels the offer', () => {
    for (const a of ['withdraw', 'bridge-deposit', 'bridge-withdraw', 'append-inbox', 'take'] as const) {
      const g = guardSignedAction(a, live, now, '4');
      expect(g.kind).toBe('warn');
      expect(g.kind === 'warn' && g.message).toContain('cancels your live offer (sell 2.00 wStkA at 1.05)');
    }
  });

  it('nothing to warn about once the offer is filled, expired, or already dead (the nonce moved)', () => {
    expect(guardSignedAction('withdraw', { ...live, status: 'filled' }, now).kind).toBe('ok');
    expect(guardSignedAction('withdraw', live, live.expiresAt).kind).toBe('ok');
    expect(guardSignedAction('open-swap', live, now, '5').kind).toBe('ok');
    expect(guardSignedAction('withdraw', null, now).kind).toBe('ok');
    expect(offerStillLive(live, now, 4n)).toBe(true);
    expect(offerStillLive(live, now)).toBe(true);
  });
});

describe('the wire shapes', () => {
  const payload = {
    giveColor: STOCK.midnightColour,
    giveAmount: '2000000',
    wantColor: USDC.midnightColour,
    wantAmount: '2100000',
    wantNonce: '11'.repeat(32),
    wantEntry: '22'.repeat(192),
    changeEntry: '00'.repeat(192),
    validUntil: '0',
    coin: { nonce: '33'.repeat(32), color: STOCK.midnightColour, value: '3000000', mtIndex: '9' },
    authNonce: '2',
  };

  it('accepts a make and a take, and nothing extra', () => {
    expect(OpenSwapPayloadSchema.safeParse(payload).success).toBe(true);
    expect(TakePayloadSchema.safeParse({ ...payload, offerId: 'ab'.repeat(32) }).success).toBe(true);
    expect(TakePayloadSchema.safeParse(payload).success).toBe(false);
    expect(OpenSwapPayloadSchema.safeParse({ ...payload, extra: 1 }).success).toBe(false);
    expect(OpenSwapPayloadSchema.safeParse({ ...payload, wantEntry: '22'.repeat(191) }).success).toBe(false);
  });
});
