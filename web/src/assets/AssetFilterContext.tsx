// The asset filter for every view (plan 00042): ONE source, the list in this browser's local data
// (./filter.ts), applied to the bank's token list. Accounts, Markets, Trade and Transfers ask it
// what to show; nothing else changes. With no list, every asset shows, exactly as before.
//
//   const assets = useAssetFilter();
//   tokens.filter(assets.shows)                 the assets to list
//   assets.showsPair(a, b)                      a market: both of its assets must be shown
//   assets.showsColour(colour)                  a Midnight coin's asset

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import { SEPOLIA_ETH } from '@mnbank/core';

import { Button, Notice } from '../design/index.js';
import { useTokenRegistry } from '../market/MarketContext.js';
import { useStore } from '../store/StoreContext.js';
import { type AssetView, type FilterAsset, assetView, readAssetFilter, saveAssetFilter } from './filter.js';

/** Sepolia ETH pays the customer's gas and is not an asset of the bank: always shown. */
export const ETH_ASSET: FilterAsset = { symbol: SEPOLIA_ETH.symbol, midnightName: SEPOLIA_ETH.symbol };

/** The list the URL set when this browser could not keep it (main.tsx): this page load only. */
export const pageLoadAssets: { list: string[] | null } = { list: null };

export interface AssetFilterValue extends AssetView {
  /** Whether a Midnight colour's asset is shown; a colour the bank does not know shows only while
   *  nothing is filtered. */
  showsColour(colour: string): boolean;
  /** Forget the list: every asset shows again. */
  showAll(): void;
}

const Ctx = createContext<AssetFilterValue | null>(null);

export function AssetFilterProvider({ children }: { children: ReactNode }) {
  const { store, revision } = useStore();
  const registry = useTokenRegistry();
  const [pageLoad, setPageLoad] = useState<string[] | null>(() => pageLoadAssets.list);
  const value = useMemo<AssetFilterValue>(
    () => {
      const view = assetView(readAssetFilter(store) ?? pageLoad, registry?.tokens ?? [], [ETH_ASSET]);
      return {
        ...view,
        showsColour: (colour) => {
          const t = registry?.byColour(colour);
          return t ? view.shows(t) : !view.filtering;
        },
        showAll: () => {
          setPageLoad(null);
          if (store && !store.readOnly) saveAssetFilter(store, null);
        },
      };
    },
    // `revision` changes on every store write, here or in another tab (CLEAR ALL, Import).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, revision, registry, pageLoad],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAssetFilter(): AssetFilterValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAssetFilter outside AssetFilterProvider');
  return v;
}

/** The words for an active list: which assets show, and which listed ones this site lacks. */
export function assetFilterText(f: Pick<AssetView, 'filtering' | 'known' | 'unknown'>): string {
  const lead = f.filtering
    ? `Showing only ${f.known.join(', ')}.`
    : 'None of the listed assets is on this site, so every asset is shown.';
  return f.unknown.length > 0 ? `${lead} Not on this site yet: ${f.unknown.join(', ')}.` : lead;
}

/** The header note while a list is stored (spec US1.4, FR-005), with the way back to everything. */
export function AssetFilterNote() {
  const f = useAssetFilter();
  if (f.listed.length === 0) return null;
  return (
    <Notice data-testid="asset-filter-note" data-filtering={f.filtering}>
      <span data-testid="asset-filter-text">{assetFilterText(f)}</span>{' '}
      <Button variant="link" data-testid="asset-filter-show-all" onClick={f.showAll}>
        Show all assets
      </Button>
    </Notice>
  );
}
