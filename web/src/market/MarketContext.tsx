// The live markets for the whole app: one feed per page load, started while at least one
// component shows prices (the Markets page, or holdings that are valued) and stopped when none
// does, so a page without prices makes no exchange request.
//
// For the holdings view (plan L-ACC.2), `useMarkets()` also values holdings at the best bid:
//   const { value, valueAll, state } = useMarkets();
//   value(colour, amountRaw)  -> { kind: 'usdc' | 'priced' | 'no-liquidity' | 'unavailable' | 'unknown-token', … }
//   valueAll([{ colour, amountRaw }]) -> { items, totalUsdcRaw, excluded }
// A stock with no live bid is "no liquidity" and left out of the total (spec US2); while the
// feed is loading or the exchange is unavailable, stocks are 'unavailable' (USDC still counts).

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';

import {
  type FeedState,
  type HoldingsValuation,
  KernelClient,
  MarketFeed,
  type NetworkProfile,
  type TokenRegistry,
  type Valuation,
  registryFor,
  valueHolding,
  valueHoldings,
} from '@mnbank/core';

interface MarketsContext {
  feed: MarketFeed | null;
  registry: TokenRegistry | null;
  /** Why there is no feed (for example a network without a token list). */
  error: string | null;
  kernelUrl: string;
}

/** How many mounted components use each feed. */
const users = new WeakMap<MarketFeed, number>();

const Ctx = createContext<MarketsContext | null>(null);

export function MarketProvider({
  network,
  tokens,
  children,
}: {
  network: NetworkProfile;
  /** The site configuration's token list; the stagenet registry is built in. */
  tokens?: unknown;
  children: ReactNode;
}) {
  const ctx = useMemo<MarketsContext>(() => {
    let registry: TokenRegistry | null = null;
    let error: string | null = null;
    try {
      registry = registryFor(network.name, tokens);
    } catch (e) {
      error = e instanceof Error ? e.message : 'no token list';
    }
    const feed = registry
      ? new MarketFeed({ client: new KernelClient({ baseUrl: network.zswap.kernelUrl }), registry })
      : null;
    return { feed, registry, error, kernelUrl: network.zswap.kernelUrl };
  }, [network, tokens]);
  useEffect(() => () => ctx.feed?.stop(), [ctx]);
  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

export interface MarketsValue {
  state: FeedState;
  registry: TokenRegistry | null;
  error: string | null;
  kernelUrl: string;
  /** Refresh now (coalesced with a refresh already running). */
  refresh(): void;
  /** Value one holding in USDC base units at the best bid. */
  value(colour: string, amountRaw: bigint): Valuation;
  /** Value a list of holdings; the total leaves out what has no price and counts it. */
  valueAll(holdings: ReadonlyArray<{ colour: string; amountRaw: bigint }>): HoldingsValuation;
}

const LOADING: FeedState = { status: 'loading', stream: 'off' };
const noop = () => () => {};

export function useMarkets(): MarketsValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useMarkets outside MarketProvider');
  const { feed, registry } = ctx;

  useEffect(() => {
    if (!feed) return;
    users.set(feed, (users.get(feed) ?? 0) + 1);
    feed.start();
    return () => {
      const left = (users.get(feed) ?? 1) - 1;
      users.set(feed, left);
      if (left === 0) feed.stop();
    };
  }, [feed]);

  const state = useSyncExternalStore(feed ? (cb) => feed.subscribe(cb) : noop, () =>
    feed ? feed.getState() : LOADING,
  );

  return useMemo<MarketsValue>(() => {
    const snapshot = state.status === 'ready' ? state.snapshot : null;
    return {
      state,
      registry,
      error: ctx.error,
      kernelUrl: ctx.kernelUrl,
      refresh: () => void feed?.refresh(),
      value: (colour, amountRaw) =>
        registry ? valueHolding(snapshot, registry, colour, amountRaw) : { kind: 'unknown-token' },
      valueAll: (holdings) =>
        registry
          ? valueHoldings(snapshot, registry, holdings)
          : {
              items: holdings.map((h) => ({ ...h, valuation: { kind: 'unknown-token' } as const })),
              totalUsdcRaw: 0n,
              excluded: holdings.length,
            },
    };
  }, [state, registry, feed, ctx.error, ctx.kernelUrl]);
}
