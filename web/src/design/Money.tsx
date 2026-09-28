// Money: an exact token amount in tabular numerals. Amounts are BigInt base units and are never
// converted to floating point; the token's decimals say where the point goes.
//
//   <Money raw={100_000_000n} decimals={6} />              → 100.00
//   <Money raw={1_979_586_200_000n} decimals={6} unit="USDC" /> → 1,979,586.20 USDC
//   <Money raw={wei} decimals={18} minFractionDigits={0} maxFractionDigits={6} />

import type { HTMLAttributes } from 'react';

import { formatUnits } from '@mnbank/core';

import { cx } from './format.js';

export interface MoneyFormat {
  /** At least this many decimals (default 2, as on a statement). */
  minFractionDigits?: number;
  /** At most this many decimals (truncated, never rounded up); default: all of the token's. */
  maxFractionDigits?: number;
  /** Thousands separators (default true). */
  grouping?: boolean;
}

export function formatMoney(raw: bigint, decimals: number, f: MoneyFormat = {}): string {
  return formatUnits(raw, decimals, {
    minFractionDigits: f.minFractionDigits ?? 2,
    maxFractionDigits: f.maxFractionDigits,
    grouping: f.grouping ?? true,
  });
}

export interface MoneyProps extends MoneyFormat, Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  raw: bigint;
  decimals: number;
  /** A unit after the number, in smaller type ("USDC", "wStkA"). */
  unit?: string;
}

/** The amount, with `data-raw` holding the exact base units for tests and tooling. */
export function Money({
  raw,
  decimals,
  unit,
  minFractionDigits,
  maxFractionDigits,
  grouping,
  className,
  ...rest
}: MoneyProps) {
  return (
    <span className={cx('num', className)} data-raw={raw.toString()} {...rest}>
      {formatMoney(raw, decimals, { minFractionDigits, maxFractionDigits, grouping })}
      {unit ? <span className="money-unit">{unit}</span> : null}
    </span>
  );
}
