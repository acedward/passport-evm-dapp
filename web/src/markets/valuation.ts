// The valuation hook the Accounts statement uses (spec US2): USDC at face value, and a stock at
// the best live bid of the offer book, or "no liquidity". The prices come from plan lane L-MKT;
// until its Markets feed is wired in here, stocks show "price not available" and are left out
// of the total, which says so.

import { createContext, useContext } from 'react';

import type { TokenRegistry } from '@mnbank/core';

export type HoldingValuation =
  | { kind: 'usdc'; usdcRaw: bigint }
  | { kind: 'priced'; usdcRaw: bigint; price: string }
  | { kind: 'no-liquidity' }
  | { kind: 'unavailable' };

export type Valuer = (colour: string, amountRaw: bigint) => HoldingValuation;

/** Until the markets feed is connected: USDC at face value, every stock unavailable. */
export const faceValueOnly =
  (registry: TokenRegistry | null): Valuer =>
  (colour, amountRaw) => {
    const token = registry?.byColour(colour);
    if (token?.role === 'usdc') return { kind: 'usdc', usdcRaw: amountRaw };
    return { kind: 'unavailable' };
  };

export const ValuationContext = createContext<Valuer>(() => ({ kind: 'unavailable' }));

export const useValuation = (): Valuer => useContext(ValuationContext);
