import { describe, expect, it } from 'vitest';

import {
  AmountError,
  MAX_UINT128,
  compareRatio,
  formatRatio,
  formatUnits,
  parseRatio,
  parseUnits,
  priceRatio,
  quoteForBase,
} from '../src/amount.js';

describe('parseUnits', () => {
  it('parses 6-decimal token amounts exactly', () => {
    expect(parseUnits('1', 6)).toBe(1_000_000n);
    expect(parseUnits('12.5', 6)).toBe(12_500_000n);
    expect(parseUnits('0.000001', 6)).toBe(1n);
    expect(parseUnits('.5', 6)).toBe(500_000n);
    expect(parseUnits('7.', 6)).toBe(7_000_000n);
    expect(parseUnits(' 1000000 ', 6)).toBe(1_000_000_000_000n);
  });

  it('parses 18-decimal ETH amounts exactly', () => {
    expect(parseUnits('1', 18)).toBe(10n ** 18n);
    expect(parseUnits('0.02', 18)).toBe(20_000_000_000_000_000n);
    expect(parseUnits('0.000000000000000001', 18)).toBe(1n);
    expect(parseUnits('123456789.123456789123456789', 18)).toBe(123_456_789_123_456_789_123_456_789n);
  });

  it('refuses more decimal places than the token has, instead of rounding', () => {
    expect(() => parseUnits('0.0000001', 6)).toThrow(AmountError);
    expect(() => parseUnits('1.0000000000000000001', 18)).toThrow(/19 decimal places/);
  });

  it('refuses everything that is not a plain decimal', () => {
    for (const bad of ['', ' ', '.', '-1', '+1', '1e6', '1,000', '1.2.3', 'abc', '0x10', '1 000', 'NaN', 'Infinity']) {
      expect(() => parseUnits(bad, 6), bad).toThrow(AmountError);
    }
  });

  it('refuses zero unless allowed, and amounts above the maximum', () => {
    expect(() => parseUnits('0', 6)).toThrow(/greater than zero/);
    expect(parseUnits('0.000', 6, { allowZero: true })).toBe(0n);
    expect(() => parseUnits('11', 6, { max: 10_000_000n })).toThrow(/larger than the maximum/);
    expect(parseUnits(formatUnits(MAX_UINT128, 6), 6)).toBe(MAX_UINT128);
    expect(() => parseUnits(formatUnits(MAX_UINT128 + 1n, 6), 6)).toThrow(AmountError);
  });

  it('refuses invalid decimals', () => {
    expect(() => parseUnits('1', -1)).toThrow(AmountError);
    expect(() => parseUnits('1', 1.5)).toThrow(AmountError);
    expect(() => parseUnits('1', 99)).toThrow(AmountError);
  });
});

describe('formatUnits', () => {
  it('formats 6 and 18 decimals exactly, trimming trailing zeros', () => {
    expect(formatUnits(12_500_000n, 6)).toBe('12.5');
    expect(formatUnits(1n, 6)).toBe('0.000001');
    expect(formatUnits(0n, 6)).toBe('0');
    expect(formatUnits(10n ** 18n, 18)).toBe('1');
    expect(formatUnits(1_234_567_890_123_456_789n, 18)).toBe('1.234567890123456789');
    expect(formatUnits(-1_500_000n, 6)).toBe('-1.5');
  });

  it('pads, truncates toward zero and groups on request', () => {
    expect(formatUnits(12_500_000n, 6, { minFractionDigits: 2 })).toBe('12.50');
    expect(formatUnits(1_999_999n, 6, { maxFractionDigits: 2 })).toBe('1.99');
    expect(formatUnits(1_999_999n, 6, { maxFractionDigits: 2, minFractionDigits: 2 })).toBe('1.99');
    expect(formatUnits(1_000_000_000_000n, 6, { grouping: true, minFractionDigits: 2 })).toBe('1,000,000.00');
    expect(formatUnits(5n * 10n ** 15n, 18, { maxFractionDigits: 4 })).toBe('0.005');
  });

  it('round-trips with parseUnits', () => {
    for (const [text, d] of [
      ['1', 6],
      ['0.1', 6],
      ['999999.999999', 6],
      ['0.123456789012345678', 18],
      ['42', 18],
    ] as const) {
      expect(formatUnits(parseUnits(text, d), d)).toBe(text);
    }
  });
});

describe('prices', () => {
  it('computes a USDC price per stock from raw legs (spec US3 / US7)', () => {
    // An ask: gives 10 wStkA, wants 10.5 wUSDC -> 1.05 USDC per wStkA.
    const ask = priceRatio(10_500_000n, 6, 10_000_000n, 6);
    expect(formatRatio(ask, 2)).toBe('1.05');
    // A bid: gives 9.5 wUSDC, wants 10 wStkA -> 0.95.
    const bid = priceRatio(9_500_000n, 6, 10_000_000n, 6);
    expect(formatRatio(bid, 2)).toBe('0.95');
    expect(compareRatio(bid, ask)).toBe(-1);
    expect(compareRatio(ask, bid)).toBe(1);
    expect(compareRatio(ask, priceRatio(21_000_000n, 6, 20_000_000n, 6))).toBe(0);
  });

  it('handles mixed decimals (an 18-decimal base against a 6-decimal quote)', () => {
    // 2 whole units of an 18-dp token for 3 whole USDC -> 1.5 USDC each.
    const r = priceRatio(3_000_000n, 6, 2n * 10n ** 18n, 18);
    expect(formatRatio(r, 4)).toBe('1.5000');
    expect(quoteForBase(4n * 10n ** 18n, 18, r, 6)).toBe(6_000_000n);
  });

  it('turns "sell N at P" into exact legs', () => {
    const p = parseRatio('1.05');
    expect(quoteForBase(10_000_000n, 6, p, 6)).toBe(10_500_000n);
    expect(quoteForBase(5_000_000n, 6, parseRatio('1.00'), 6)).toBe(5_000_000n);
    // Rounds toward zero: 1 base unit at 0.5 is 0 quote units.
    expect(quoteForBase(1n, 6, parseRatio('0.5'), 6)).toBe(0n);
  });

  it('refuses a price with no base amount', () => {
    expect(() => priceRatio(1n, 6, 0n, 6)).toThrow(AmountError);
  });
});
