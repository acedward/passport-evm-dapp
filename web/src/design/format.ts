// Small presentation helpers shared by the design components and the pages.

import type { TokenEntry } from '@mnbank/core';

/** Join class names, skipping empty ones. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** "0x4847…e56b": a long hex value shortened for display (the full value belongs in `title`). */
export function shortHex(value: string, head = 6, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * A plain-language name for a token, shown after its symbol ("stkA  Stock A", "USDC  USD Coin
 * (test)"). Presentation only: the registry's symbol and Midnight name stay the identifiers.
 */
export function tokenDisplayName(token: Pick<TokenEntry, 'role' | 'symbol'>): string {
  if (token.role === 'usdc') return 'USD Coin (test)';
  const m = /^stk([A-Z0-9]+)$/i.exec(token.symbol);
  return m ? `Stock ${m[1]!.toUpperCase()}` : '';
}
