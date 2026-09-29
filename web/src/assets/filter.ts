// The asset filter (plan 00042): an opt-in whitelist, set by the page's URL, of the assets the
// site shows. `https://<bank>/?assets=USDC,TBILL` keeps the list in this browser's local data and
// shows only those assets, everywhere tokens appear; with no list, everything is shown, as before.
//
// The rules are generic on purpose (owner, 2026-09-28): an asset is a symbol and a Midnight name,
// a market is any two assets, and no asset is special. A market shows only when BOTH of its assets
// are listed, whatever the registry's market model calls them, so a future pair without USDC is
// filtered by the same code. The filter is presentation only: it hides nothing from the relay,
// the kernel or the wallet, and it is not a security setting.

import { z } from 'zod';

import { ASSET_FILTER_ID, ASSET_FILTER_KEY } from '../store/schema.js';
import type { LocalStore } from '../store/store.js';

/** The URL parameter: a comma-separated list of symbols. */
export const ASSETS_PARAM = 'assets';
/** A well-formed symbol; anything else in the list is dropped. */
export const ASSET_SYMBOL_RE = /^[A-Za-z0-9._-]{1,16}$/;
/** The most symbols one list keeps. */
export const MAX_LISTED_ASSETS = 32;

/** The stored record's data, under `ASSET_FILTER_KEY`. */
export const AssetFilterDataSchema = z
  .object({ assets: z.array(z.string().regex(ASSET_SYMBOL_RE)).min(1).max(MAX_LISTED_ASSETS) })
  .strict();
export type AssetFilterData = z.infer<typeof AssetFilterDataSchema>;

// ── The URL ─────────────────────────────────────────────────────────────────

export type AssetsParam =
  /** No `assets` parameter: the stored list (or none) stays. */
  | { kind: 'absent' }
  /** `?assets=all` or an empty value: forget the list, show everything. */
  | { kind: 'clear' }
  /** A new list, which replaces the stored one. */
  | { kind: 'set'; symbols: string[] }
  /** Only ill-formed symbols (`?assets=<script>`): nothing changes. */
  | { kind: 'invalid' };

/** Read `assets` from a query string (`location.search`). Symbols are split on commas (and
 *  spaces), trimmed, checked against `ASSET_SYMBOL_RE`, and de-duplicated without regard to case,
 *  keeping the first spelling. */
export function parseAssetsParam(search: string): AssetsParam {
  const params = new URLSearchParams(search);
  if (!params.has(ASSETS_PARAM)) return { kind: 'absent' };
  const items = params
    .getAll(ASSETS_PARAM)
    .join(',')
    .split(/[\s,]+/)
    .filter((s) => s !== '');
  if (items.length === 0 || (items.length === 1 && items[0]!.toLowerCase() === 'all')) return { kind: 'clear' };
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const s of items) {
    if (!ASSET_SYMBOL_RE.test(s) || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    symbols.push(s);
  }
  return symbols.length === 0 ? { kind: 'invalid' } : { kind: 'set', symbols: symbols.slice(0, MAX_LISTED_ASSETS) };
}

/** The address without the `assets` parameter (path, the other parameters, the hash). */
export function withoutAssetsParam(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(ASSETS_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

// ── Local data ──────────────────────────────────────────────────────────────

type FilterStore = Pick<LocalStore, 'get' | 'put' | 'remove' | 'readOnly'>;

/** The stored list, or null when there is none (or it is not one this page writes). */
export function readAssetFilter(store: Pick<LocalStore, 'get'> | null): string[] | null {
  const data = store?.get(ASSET_FILTER_KEY)?.data;
  const parsed = AssetFilterDataSchema.safeParse(data);
  return parsed.success ? parsed.data.assets : null;
}

/** Store a list (replacing the old one), or remove it (null). */
export function saveAssetFilter(store: FilterStore, symbols: readonly string[] | null): void {
  if (symbols === null) {
    if (store.get(ASSET_FILTER_KEY) !== null) store.remove(ASSET_FILTER_KEY);
    return;
  }
  const data: AssetFilterData = AssetFilterDataSchema.parse({ assets: [...symbols] });
  store.put('global', 'settings', data, { id: ASSET_FILTER_ID });
}

/**
 * Apply the page's `assets` parameter once, when the page loads (spec FR-001, FR-002, FR-006):
 * store the new list or clear it, then remove the parameter from the address bar so a copied
 * link does not spread it. Returns what the URL said, and whether the store now holds it (false
 * when this browser cannot keep data: the list then applies to this page load only).
 */
export function applyAssetsParam(
  win: { location: Pick<Location, 'search' | 'href'>; history: Pick<History, 'replaceState' | 'state'> },
  store: FilterStore | null,
): { param: AssetsParam; saved: boolean } {
  const param = parseAssetsParam(win.location.search);
  if (param.kind === 'absent') return { param, saved: false };
  win.history.replaceState(win.history.state, '', withoutAssetsParam(win.location.href));
  if (param.kind === 'invalid' || !store || store.readOnly) return { param, saved: false };
  try {
    saveAssetFilter(store, param.kind === 'set' ? param.symbols : null);
    return { param, saved: true };
  } catch {
    return { param, saved: false }; // a full storage: this page load only
  }
}

// ── The rules ───────────────────────────────────────────────────────────────

/** An asset as the filter sees it: nothing but its names. */
export interface FilterAsset {
  /** The ERC20 symbol on Sepolia (USDC, stkA). */
  symbol: string;
  /** The name on Midnight (wUSDC, wStkA). */
  midnightName: string;
}

export interface AssetView {
  /** The stored list, as given; empty when there is none. */
  listed: readonly string[];
  /** The listed symbols this site has an asset for. */
  known: readonly string[];
  /** The listed symbols this site has no asset for (yet): named in the note. */
  unknown: readonly string[];
  /** True when the view is narrowed: a list is stored and at least one of its symbols is known.
   *  A list of only unknown symbols narrows nothing, so a typo never blanks the site. */
  filtering: boolean;
  shows(asset: FilterAsset): boolean;
  /** A market (any two assets): shown only when both of them are. */
  showsPair(a: FilterAsset, b: FilterAsset): boolean;
}

const namesOf = (a: FilterAsset) => [a.symbol.toLowerCase(), a.midnightName.toLowerCase()];

/**
 * The view a list gives over a site's assets. Matching ignores case and accepts either name
 * (`USDC`, `usdc` and `wUSDC` all list the same asset). `alwaysVisible` assets (Sepolia ETH, which
 * pays for gas) are shown whatever the list, and count as known when listed.
 */
export function assetView(
  listed: readonly string[] | null,
  assets: readonly FilterAsset[],
  alwaysVisible: readonly FilterAsset[] = [],
): AssetView {
  const list = listed ?? [];
  const wanted = new Set(list.map((s) => s.toLowerCase()));
  const everything = [...assets, ...alwaysVisible];
  const known = list.filter((s) => everything.some((a) => namesOf(a).includes(s.toLowerCase())));
  const unknown = list.filter((s) => !known.includes(s));
  const filtering = known.length > 0;
  const fixed = new Set(alwaysVisible.flatMap(namesOf));
  const shows = (a: FilterAsset) =>
    !filtering || namesOf(a).some((n) => wanted.has(n)) || namesOf(a).some((n) => fixed.has(n));
  return { listed: list, known, unknown, filtering, shows, showsPair: (a, b) => shows(a) && shows(b) };
}
