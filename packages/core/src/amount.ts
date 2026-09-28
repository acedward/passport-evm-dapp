// Exact token amounts. Every amount is a bigint count of base units; text is only ever parsed
// into, or formatted from, base units. No floating point anywhere.
//
// The tokens here have 6 decimals (the stocks and USDC) or 18 (Sepolia ETH).

export class AmountError extends Error {
  override name = 'AmountError';
}

const MAX_DECIMALS = 36;
/** Largest amount a Midnight shielded coin can carry (Uint<128>). */
export const MAX_UINT128 = (1n << 128n) - 1n;

function checkDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new AmountError(`decimals must be an integer in [0, ${MAX_DECIMALS}], got ${decimals}`);
  }
}

export interface ParseOptions {
  /** Refuse amounts above this many base units (default: Uint<128> max). */
  max?: bigint;
  /** Allow a zero amount (default false: a payment of 0 is almost always a mistake). */
  allowZero?: boolean;
}

/**
 * Parse a decimal string in whole-token units ("12.5") into base units (12_500_000n at 6
 * decimals). Strict: digits with at most one '.', no sign, no exponent, no grouping
 * separators, and never more fractional digits than the token has (no silent rounding).
 */
export function parseUnits(text: string, decimals: number, options: ParseOptions = {}): bigint {
  checkDecimals(decimals);
  const s = text.trim();
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || s === '' || s === '.' || (m[1] === '' && (m[2] ?? '') === '')) {
    throw new AmountError(`not a plain decimal amount: "${text}"`);
  }
  const whole = m[1] ?? '';
  const frac = m[2] ?? '';
  if (frac.length > decimals) {
    throw new AmountError(`"${text}" has ${frac.length} decimal places; this token has ${decimals}`);
  }
  const raw = BigInt((whole === '' ? '0' : whole) + frac.padEnd(decimals, '0'));
  if (raw === 0n && !options.allowZero) throw new AmountError('amount must be greater than zero');
  const max = options.max ?? MAX_UINT128;
  if (raw > max) throw new AmountError(`"${text}" is larger than the maximum ${formatUnits(max, decimals)}`);
  return raw;
}

export interface FormatOptions {
  /** Always show at least this many fractional digits (padded with zeros). Default 0. */
  minFractionDigits?: number;
  /** Show at most this many fractional digits, truncating (never rounding up). Default: all. */
  maxFractionDigits?: number;
  /** Group the whole part in thousands with ','. Default false. */
  grouping?: boolean;
}

/** Format base units as a decimal string in whole-token units. Exact unless truncated by
 *  `maxFractionDigits`, which always rounds toward zero (a balance is never overstated). */
export function formatUnits(raw: bigint, decimals: number, options: FormatOptions = {}): string {
  checkDecimals(decimals);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const wholeDigits = (abs / base).toString(10);
  let frac = decimals === 0 ? '' : (abs % base).toString(10).padStart(decimals, '0');
  if (options.maxFractionDigits !== undefined) frac = frac.slice(0, Math.max(0, options.maxFractionDigits));
  frac = frac.replace(/0+$/, '');
  const min = Math.min(options.minFractionDigits ?? 0, options.maxFractionDigits ?? Number.MAX_SAFE_INTEGER);
  if (frac.length < min) frac = frac.padEnd(min, '0');
  const whole = options.grouping ? wholeDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : wholeDigits;
  const body = frac === '' ? whole : `${whole}.${frac}`;
  return negative && abs !== 0n ? `-${body}` : body;
}

/** An exact non-negative ratio of two base-unit amounts, for prices. */
export interface Ratio {
  readonly num: bigint;
  readonly den: bigint;
}

/**
 * The price of one whole BASE token in QUOTE tokens, from raw base units:
 * (quoteRaw / 10^quoteDecimals) / (baseRaw / 10^baseDecimals).
 * Example: 10 wStkA (6 dp) for 10.5 wUSDC (6 dp) is 1.05 USDC per wStkA.
 */
export function priceRatio(quoteRaw: bigint, quoteDecimals: number, baseRaw: bigint, baseDecimals: number): Ratio {
  checkDecimals(quoteDecimals);
  checkDecimals(baseDecimals);
  if (baseRaw <= 0n || quoteRaw < 0n) throw new AmountError('a price needs a positive base amount');
  return { num: quoteRaw * 10n ** BigInt(baseDecimals), den: baseRaw * 10n ** BigInt(quoteDecimals) };
}

/** Compare two ratios exactly: negative, zero or positive, like a sort comparator. */
export function compareRatio(a: Ratio, b: Ratio): number {
  const l = a.num * b.den;
  const r = b.num * a.den;
  return l < r ? -1 : l > r ? 1 : 0;
}

/** Format a ratio with a fixed number of decimals, rounding toward zero. */
export function formatRatio(
  r: Ratio,
  fractionDigits: number,
  options: Omit<FormatOptions, 'maxFractionDigits'> = {},
): string {
  if (r.den <= 0n) throw new AmountError('ratio denominator must be positive');
  const scaled = (r.num * 10n ** BigInt(fractionDigits)) / r.den;
  return formatUnits(scaled, fractionDigits, { minFractionDigits: fractionDigits, ...options });
}

/**
 * What `baseRaw` base units cost in quote base units at price `r` (whole quote per whole
 * base), rounded toward zero: floor(baseRaw * r * 10^quoteDecimals / 10^baseDecimals).
 * Example: 10 wStkA (10_000_000n, 6 dp) at 1.05 USDC is 10_500_000n wUSDC (6 dp).
 */
export function quoteForBase(baseRaw: bigint, baseDecimals: number, r: Ratio, quoteDecimals: number): bigint {
  checkDecimals(baseDecimals);
  checkDecimals(quoteDecimals);
  if (r.den <= 0n) throw new AmountError('ratio denominator must be positive');
  return (baseRaw * r.num * 10n ** BigInt(quoteDecimals)) / (r.den * 10n ** BigInt(baseDecimals));
}

/** Parse a decimal price text ("1.05") into an exact ratio. */
export function parseRatio(text: string, maxFractionDigits = 18): Ratio {
  const raw = parseUnits(text, maxFractionDigits);
  return { num: raw, den: 10n ** BigInt(maxFractionDigits) };
}
