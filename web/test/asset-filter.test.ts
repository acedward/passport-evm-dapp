// Plan 00042 P1.4: the asset filter's parsing, storage and rules, case by case (the plan's P1
// testing table). The rules are generic: no asset is special, and a market shows only when both of
// its assets are listed, so a pair without USDC is filtered by the same code.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type FeedState,
  NETWORK_DEFAULT_ASSETS,
  type TokenEntry,
  registryFromConfig,
  stagenetRegistry,
} from '@mnbank/core';

import { assetFilterText } from '../src/assets/AssetFilterContext.js';
import contextSource from '../src/assets/AssetFilterContext.tsx?raw';
import {
  type FilterAsset,
  applyAssetsParam,
  assetView,
  parseAssetsParam,
  readAssetFilter,
  resolveSiteAssets,
  saveAssetFilter,
  withoutAssetsParam,
} from '../src/assets/filter.js';
import filterSource from '../src/assets/filter.ts?raw';
import { loadSiteConfig } from '../src/config.js';
import configSource from '../src/config.ts?raw';
import { marketRows } from '../src/market/view.js';
import { ASSET_FILTER_KEY, type WalletScope } from '../src/store/schema.js';
import { ImportError, LocalStore } from '../src/store/store.js';

const registry = stagenetRegistry();
const ETH: FilterAsset = { symbol: 'ETH', midnightName: 'ETH' };
const token = (symbol: string) => registry.tokens.find((t) => t.symbol === symbol)!;
const LOADING: FeedState = { status: 'loading', stream: 'off' };
const ME: WalletScope = { network: 'stagenet', evmAddress: `0x${'ab'.repeat(20)}` };

/** A page load at `url` on a site whose set is `site` (null = every asset): the parameter
 *  applied to the store, and the view it gives. */
function load(
  url: string,
  store: LocalStore | null,
  assets: readonly TokenEntry[] = registry.tokens,
  site: readonly string[] | null = null,
) {
  const replaced: string[] = [];
  const u = new URL(url, 'https://bank.example/');
  const win = {
    location: { search: u.search, href: u.href },
    history: {
      state: null,
      replaceState: (_s: unknown, _t: string, to?: string | URL | null) => replaced.push(String(to)),
    },
  };
  const applied = applyAssetsParam(win, store);
  const listed =
    readAssetFilter(store) ?? (applied.param.kind === 'set' && !applied.saved ? applied.param.symbols : null);
  return { applied, replaced, view: assetView(listed, assets, [ETH], site) };
}

const shown = (view: ReturnType<typeof assetView>) => registry.tokens.filter(view.shows).map((t) => t.symbol);
const markets = (view: ReturnType<typeof assetView>, r = registry) =>
  marketRows(LOADING, r, view.showsPair).map((m) => `${m.symbol}/${r.usdc().symbol}`);
const bankKeys = () => {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (k.startsWith('mn-bank/')) out[k] = localStorage.getItem(k)!;
  }
  return out;
};

let store: LocalStore;
beforeEach(() => {
  localStorage.clear();
  store = new LocalStore(localStorage);
});

describe('the assets parameter', () => {
  it('parses a list: trimmed, split on commas, well-formed symbols only, no duplicates', () => {
    expect(parseAssetsParam('')).toEqual({ kind: 'absent' });
    expect(parseAssetsParam('?stock=wStkA')).toEqual({ kind: 'absent' });
    expect(parseAssetsParam('?assets=USDC,TBILL')).toEqual({ kind: 'set', symbols: ['USDC', 'TBILL'] });
    expect(parseAssetsParam('?assets=%20usdc%20,,TBILL,USDC,')).toEqual({ kind: 'set', symbols: ['usdc', 'TBILL'] });
    expect(parseAssetsParam('?assets=USDC+TBILL')).toEqual({ kind: 'set', symbols: ['USDC', 'TBILL'] });
    expect(parseAssetsParam('?assets=all')).toEqual({ kind: 'clear' });
    expect(parseAssetsParam('?assets=ALL')).toEqual({ kind: 'clear' });
    expect(parseAssetsParam('?assets=')).toEqual({ kind: 'clear' });
    expect(parseAssetsParam('?assets')).toEqual({ kind: 'clear' });
    expect(parseAssetsParam('?assets=%3Cscript%3E,USDC')).toEqual({ kind: 'set', symbols: ['USDC'] });
    expect(parseAssetsParam('?assets=<script>')).toEqual({ kind: 'invalid' });
    expect(parseAssetsParam(`?assets=${'X'.repeat(17)}`)).toEqual({ kind: 'invalid' });
    const many = Array.from({ length: 40 }, (_, i) => `T${i}`).join(',');
    expect((parseAssetsParam(`?assets=${many}`) as { symbols: string[] }).symbols).toHaveLength(32);
  });

  it('is removed from the address bar, keeping the path, the other parameters and the section', () => {
    expect(withoutAssetsParam('https://bank.example/?assets=USDC')).toBe('/');
    expect(withoutAssetsParam('https://bank.example/app/?x=1&assets=USDC#markets')).toBe('/app/?x=1#markets');
    const { replaced } = load('/?assets=stkA#markets', store);
    expect(replaced).toEqual(['/#markets']);
    expect(load('/#markets', store).replaced).toEqual([]); // no parameter: the address is left alone
  });
});

describe('the rules (the plan P1 testing table)', () => {
  it('no parameter, nothing stored: everything is visible and nothing is written', () => {
    const { view } = load('/', store);
    expect(view.filtering).toBe(false);
    expect(shown(view)).toEqual(['stkA', 'stkB', 'stkC', 'USDC', 'TBILL', 'TB13W', 'TB26W', 'TB52W']);
    expect(markets(view)).toEqual([
      'stkA/USDC',
      'stkB/USDC',
      'stkC/USDC',
      'TBILL/USDC',
      'TB13W/USDC',
      'TB26W/USDC',
      'TB52W/USDC',
    ]);
    expect(bankKeys()).toEqual({});
  });

  it('?assets=USDC: USDC only, and no market (none has both assets listed)', () => {
    const { view } = load('/?assets=USDC', store);
    expect(view.filtering).toBe(true);
    expect(shown(view)).toEqual(['USDC']);
    expect(markets(view)).toEqual([]);
  });

  it('?assets=stka: stkA (wStkA) only, and no market (USDC is not listed)', () => {
    const { view } = load('/?assets=stka', store);
    expect(shown(view)).toEqual(['stkA']);
    expect(view.shows({ symbol: 'STKA', midnightName: 'other' })).toBe(true); // any case
    expect(markets(view)).toEqual([]);
  });

  it('?assets=stkA,USDC: stkA, USDC and the stkA/USDC market only', () => {
    const { view } = load('/?assets=stkA,USDC', store);
    expect(shown(view)).toEqual(['stkA', 'USDC']);
    expect(markets(view)).toEqual(['stkA/USDC']);
  });

  it('matches the Midnight name too: ?assets=wUSDC lists USDC', () => {
    expect(shown(load('/?assets=wusdc', store).view)).toEqual(['USDC']);
  });

  it('a pair without USDC (TBILL/EURC, generic assets): shown when both are listed; USDC is not special', () => {
    const TBILL = { symbol: 'TBILL', midnightName: 'wTBILL' };
    const EURC = { symbol: 'EURC', midnightName: 'wEURC' };
    const USDC = { symbol: 'USDC', midnightName: 'wUSDC' };
    const pairs: Array<[FilterAsset, FilterAsset]> = [
      [TBILL, EURC],
      [TBILL, USDC],
      [EURC, USDC],
    ];
    const view = assetView(['TBILL', 'EURC'], [TBILL, EURC, USDC]);
    expect(pairs.filter(([a, b]) => view.showsPair(a, b))).toEqual([[TBILL, EURC]]);
    expect([TBILL, EURC, USDC].filter(view.shows)).toEqual([TBILL, EURC]);
    // The order of a pair's legs does not matter, and neither leg is a quote currency.
    expect(view.showsPair(EURC, TBILL)).toBe(true);
    expect(assetView(['USDC'], [TBILL, EURC, USDC]).showsPair(TBILL, USDC)).toBe(false);
  });

  it('the rules never read a role: no "usdc"/"stock" in the filter code', () => {
    const src = filterSource.replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/\brole\b|\.usdc\(|stocks\(|'usdc'|'stock'/);
  });

  it('?assets=USDC,EURC while EURC is unknown: USDC only, and the note names EURC', () => {
    const { view } = load('/?assets=USDC,EURC', store);
    expect(shown(view)).toEqual(['USDC']);
    expect(view.known).toEqual(['USDC']);
    expect(view.unknown).toEqual(['EURC']);
    expect(readAssetFilter(store)).toEqual(['USDC', 'EURC']); // kept, for when EURC arrives
  });

  it('?assets=EURC (nothing known): everything stays visible, with the note', () => {
    const { view } = load('/?assets=EURC', store);
    expect(view.filtering).toBe(false);
    expect(view.unknown).toEqual(['EURC']);
    expect(shown(view)).toEqual(['stkA', 'stkB', 'stkC', 'USDC', 'TBILL', 'TB13W', 'TB26W', 'TB52W']);
    expect(markets(view)).toHaveLength(7);
  });

  it('Sepolia ETH is always visible', () => {
    expect(load('/?assets=USDC', store).view.shows(ETH)).toBe(true);
    // Listing it counts as known: the list narrows the view to ETH alone.
    const { view } = load('/?assets=ETH', store);
    expect(view.unknown).toEqual([]);
    expect(shown(view)).toEqual([]);
  });

  it('a stored filter applies with no parameter', () => {
    load('/?assets=stkA,USDC', store);
    const again = load('/#accounts', new LocalStore(localStorage));
    expect(again.applied.param.kind).toBe('absent');
    expect(shown(again.view)).toEqual(['stkA', 'USDC']);
  });

  it('?assets=all and ?assets= clear it', () => {
    for (const url of ['/?assets=all', '/?assets=']) {
      load('/?assets=USDC', store);
      expect(bankKeys()[ASSET_FILTER_KEY]).toBeDefined();
      const { view } = load(url, store);
      expect(view.filtering).toBe(false);
      expect(bankKeys()[ASSET_FILTER_KEY]).toBeUndefined();
      expect(shown(view)).toHaveLength(8);
    }
  });

  it('a new list replaces the old one', () => {
    load('/?assets=USDC', store);
    expect(shown(load('/?assets=stkB,USDC', store).view)).toEqual(['stkB', 'USDC']);
    expect(readAssetFilter(store)).toEqual(['stkB', 'USDC']);
  });

  it('?assets=<script>,USDC drops the bad symbol; a list of only bad ones changes nothing', () => {
    expect(load('/?assets=%3Cscript%3E,USDC', store).view.listed).toEqual(['USDC']);
    const { applied, replaced } = load('/?assets=%3Cscript%3E', store);
    expect(applied.param.kind).toBe('invalid');
    expect(replaced).toEqual(['/']);
    expect(readAssetFilter(store)).toEqual(['USDC']);
  });

  it('a browser that cannot keep data applies the list to this page load only', () => {
    const { applied, view } = load('/?assets=USDC', null);
    expect(applied.saved).toBe(false);
    expect(shown(view)).toEqual(['USDC']);
    expect(bankKeys()).toEqual({});
  });

  it('Export, then Import: the filter survives; CLEAR ALL removes it', () => {
    store.put(ME, 'profile', { firstSeen: 1 });
    load('/?assets=USDC,TBILL', store);
    const file = store.exportWallet(ME);
    expect(file.records.map((r) => r.key)).toContain(ASSET_FILTER_KEY);
    expect(store.clearAll()).toBe(3); // the profile, the filter, the schema marker
    expect(readAssetFilter(store)).toBeNull();
    expect(bankKeys()).toEqual({});
    expect(store.importWallet(JSON.parse(JSON.stringify(file)), ME).imported).toBe(2);
    expect(readAssetFilter(store)).toEqual(['USDC', 'TBILL']);
  });

  it('Import refuses a filter record this page would not write', () => {
    store.put(ME, 'profile', { firstSeen: 1 });
    saveAssetFilter(store, ['USDC']);
    const file = JSON.parse(JSON.stringify(store.exportWallet(ME))) as {
      records: Array<{ key: string; value: { data: unknown } }>;
    };
    file.records.find((r) => r.key === ASSET_FILTER_KEY)!.value.data = { assets: ['<script>'] };
    localStorage.clear();
    expect(() => new LocalStore(localStorage).importWallet(file, ME)).toThrow(ImportError);
    expect(bankKeys()).toEqual({});
  });

  it('a config token list with TBILL + ?assets=USDC,TBILL: the TBILL/USDC market, no stk (no code change)', () => {
    const colour = (b: string) => b.repeat(32);
    const withTbill = registryFromConfig('stagenet', {
      tokens: [
        { symbol: 'USDC', midnightName: 'wUSDC', role: 'usdc', decimals: 6, midnightColour: colour('e5') },
        { symbol: 'stkA', midnightName: 'wStkA', role: 'stock', decimals: 6, midnightColour: colour('5e') },
        { symbol: 'TBILL', midnightName: 'wTBILL', role: 'stock', decimals: 6, midnightColour: colour('7b') },
      ],
    });
    const { view } = load('/?assets=USDC,TBILL', store, withTbill.tokens);
    expect(view.unknown).toEqual([]);
    expect(withTbill.tokens.filter(view.shows).map((t) => t.symbol)).toEqual(['USDC', 'TBILL']);
    expect(markets(view, withTbill)).toEqual(['TBILL/USDC']);
  });
});

describe('the markets view with a filter', () => {
  it('keeps every market when nothing is listed (the unfiltered page is unchanged)', () => {
    expect(marketRows(LOADING, registry)).toEqual(
      marketRows(LOADING, registry, assetView(null, registry.tokens).showsPair),
    );
  });

  it('passes both assets of each market to the filter', () => {
    const seen: string[] = [];
    marketRows(LOADING, registry, (a, b) => {
      seen.push(`${a.symbol}/${b.symbol}`);
      return true;
    });
    expect(seen).toEqual([
      'stkA/USDC',
      'stkB/USDC',
      'stkC/USDC',
      'TBILL/USDC',
      'TB13W/USDC',
      'TB26W/USDC',
      'TB52W/USDC',
    ]);
    expect(token('USDC').midnightName).toBe('wUSDC');
  });
});

// Plan 00046 P2.4: each domain's set (config.json `assets`, or the network's default set, which is
// data) is the ceiling, and the 00042 list narrows within it.
describe("the site's set (plan 00046 P2.4 testing table)", () => {
  const TBANK = ['USDC', 'TBILL', 'TB13W', 'TB26W', 'TB52W'];
  const stagenetSite = (configured: unknown) =>
    resolveSiteAssets(configured, NETWORK_DEFAULT_ASSETS.stagenet, registry.tokens);
  const onSite = (configured: unknown, url = '/') => load(url, store, registry.tokens, stagenetSite(configured).set);

  it('stagenet, no assets: USDC and stkA/B/C, 3 markets (the default set is data)', () => {
    expect(stagenetSite(undefined)).toEqual({ set: ['USDC', 'stkA', 'stkB', 'stkC'], warnings: [] });
    const { view } = onSite(undefined);
    expect(view.filtering).toBe(false);
    expect(shown(view)).toEqual(['stkA', 'stkB', 'stkC', 'USDC']);
    expect(markets(view)).toEqual(['stkA/USDC', 'stkB/USDC', 'stkC/USDC']);
  });

  it('the tbank set: those 5 tokens and 4 markets, no stk', () => {
    expect(stagenetSite(TBANK)).toEqual({ set: TBANK, warnings: [] });
    const { view } = onSite(TBANK);
    expect(shown(view)).toEqual(['USDC', 'TBILL', 'TB13W', 'TB26W', 'TB52W']);
    expect(markets(view)).toEqual(['TBILL/USDC', 'TB13W/USDC', 'TB26W/USDC', 'TB52W/USDC']);
    expect(view.shows(ETH)).toBe(true);
  });

  it('assets: "all": 8 tokens, 7 markets', () => {
    expect(stagenetSite('all')).toEqual({ set: null, warnings: [] });
    expect(stagenetSite('ALL').set).toBeNull();
    const { view } = onSite('all');
    expect(shown(view)).toHaveLength(8);
    expect(markets(view)).toHaveLength(7);
  });

  it('the tbank set + ?assets=USDC,TBILL: TBILL/USDC only', () => {
    const { view } = onSite(TBANK, '/?assets=USDC,TBILL');
    expect(view.filtering).toBe(true);
    expect(shown(view)).toEqual(['USDC', 'TBILL']);
    expect(markets(view)).toEqual(['TBILL/USDC']);
    expect([view.unavailable, view.unknown]).toEqual([[], []]);
  });

  it('the tbank set + ?assets=stkA,USDC: USDC only, and stkA named as not available on this site', () => {
    const { view } = onSite(TBANK, '/?assets=stkA,USDC');
    expect(shown(view)).toEqual(['USDC']);
    expect(markets(view)).toEqual([]);
    expect(view.known).toEqual(['USDC']);
    expect(view.unavailable).toEqual(['stkA']);
    expect(view.unknown).toEqual([]);
    expect(assetFilterText(view)).toBe('Showing only USDC. Not available on this site: stkA.');
    // A list of only outside symbols narrows nothing: the site's set, with the note.
    const only = onSite(TBANK, '/?assets=wStkA').view;
    expect(only.filtering).toBe(false);
    expect(shown(only)).toEqual(['USDC', 'TBILL', 'TB13W', 'TB26W', 'TB52W']);
    expect(assetFilterText(only)).toBe(
      'None of the listed assets is on this site, so every asset is shown. Not available on this site: wStkA.',
    );
  });

  it('the tbank set + ?assets=all: the tbank set (the stored list is forgotten)', () => {
    onSite(TBANK, '/?assets=USDC,TBILL');
    expect(readAssetFilter(store)).toEqual(['USDC', 'TBILL']);
    const { view } = onSite(TBANK, '/?assets=all');
    expect(readAssetFilter(store)).toBeNull();
    expect(view.filtering).toBe(false);
    expect(shown(view)).toEqual(['USDC', 'TBILL', 'TB13W', 'TB26W', 'TB52W']);
    expect(markets(view)).toHaveLength(4);
  });

  it('a typo (TBIL) beside valid symbols: the valid ones, and a warning', () => {
    const r = stagenetSite(['usdc', 'TBIL', 'tbill', 'wUSDC']);
    expect(r.set).toEqual(['USDC', 'TBILL']); // any case, either name, no duplicates
    expect(r.warnings).toEqual(['config.json "assets": ignoring unknown assets: TBIL']);
  });

  it('only unknown symbols (or not a list): the network default, and a warning', () => {
    const r = stagenetSite(['TBIL', 'EURC']);
    expect(r.set).toEqual(['USDC', 'stkA', 'stkB', 'stkC']);
    expect(r.warnings).toEqual([
      'config.json "assets": ignoring unknown assets: TBIL, EURC',
      'config.json "assets" names no known asset; using the network\'s default',
    ]);
    expect(stagenetSite([]).set).toEqual(['USDC', 'stkA', 'stkB', 'stkC']);
    for (const bad of ['USDC,TBILL', 42, { a: 1 }, [7]]) {
      const b = stagenetSite(bad);
      expect(b.set).toEqual(['USDC', 'stkA', 'stkB', 'stkC']);
      expect(b.warnings.length).toBeGreaterThan(0);
    }
    // A default the registry does not know (a configured token list without the stk line): everything.
    const other = resolveSiteAssets(undefined, ['stkA'], [{ symbol: 'USDC', midnightName: 'wUSDC' }]);
    expect(other.set).toBeNull();
    expect(other.warnings).toHaveLength(2);
  });

  it('undeployed, no assets: everything (its network has no default set)', () => {
    expect(NETWORK_DEFAULT_ASSETS.undeployed).toBeNull();
    expect(resolveSiteAssets(undefined, NETWORK_DEFAULT_ASSETS.undeployed, registry.tokens)).toEqual({
      set: null,
      warnings: [],
    });
  });

  it('no site set, no list: exactly the 00042 view (the unfiltered page is unchanged)', () => {
    const a = assetView(null, registry.tokens, [ETH], null);
    expect(registry.tokens.filter(a.shows)).toEqual(registry.tokens);
    expect(a.unavailable).toEqual([]);
  });

  it('the site code names no token and reads no role (the owner rule: no special token in code)', () => {
    for (const src of [filterSource, configSource, contextSource]) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code).not.toMatch(/\b(w?usdc|w?stk[abc]|tbill|tb\d\dw)\b/i);
      expect(code).not.toMatch(/\brole\b|\.usdc\(|stocks\(|'stock'/);
    }
  });
});

describe('loadSiteConfig: the site set from config.json (plan 00046 P2.2)', () => {
  const fetchJson = (body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('the bank domain (no assets): the stagenet default, no warning', async () => {
    const c = await loadSiteConfig(fetchJson({ network: 'stagenet', relayUrl: '/relay' }));
    expect(c.assets).toEqual(['USDC', 'stkA', 'stkB', 'stkC']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('the tbank domain: its own set', async () => {
    const assets = ['USDC', 'TBILL', 'TB13W', 'TB26W', 'TB52W'];
    const c = await loadSiteConfig(fetchJson({ network: 'stagenet', relayUrl: '/relay', assets }));
    expect(c.assets).toEqual(assets);
    expect(warn).not.toHaveBeenCalled();
  });

  it('"all", a typo, and only unknown symbols', async () => {
    expect((await loadSiteConfig(fetchJson({ assets: 'all' }))).assets).toBeNull();
    expect((await loadSiteConfig(fetchJson({ assets: ['USDC', 'TBIL'] }))).assets).toEqual(['USDC']);
    expect(warn).toHaveBeenCalledWith('MN Bank: config.json "assets": ignoring unknown assets: TBIL');
    warn.mockClear();
    expect((await loadSiteConfig(fetchJson({ assets: ['NOPE'] }))).assets).toEqual(['USDC', 'stkA', 'stkB', 'stkC']);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('undeployed with its token list and no assets: everything; no config.json: the stagenet default', async () => {
    const tokens = {
      tokens: [
        { symbol: 'tUSDC', midnightName: 'a', role: 'usdc', decimals: 6, midnightColour: 'aa'.repeat(32) },
        { symbol: 'tSTK', midnightName: 'b', role: 'stock', decimals: 6, midnightColour: 'bb'.repeat(32) },
      ],
    };
    expect((await loadSiteConfig(fetchJson({ network: 'undeployed', tokens }))).assets).toBeNull();
    // A stagenet site with its own token list: the default set belongs to the built-in list, so
    // every configured token shows unless `assets` names some (the 00042 config-TBILL case).
    const own = { tokens: { tokens: [tokens.tokens[0], { ...tokens.tokens[1], symbol: 'TBILL' }] } };
    expect((await loadSiteConfig(fetchJson({ network: 'stagenet', ...own }))).assets).toBeNull();
    expect((await loadSiteConfig(fetchJson({ network: 'stagenet', ...own, assets: ['TBILL'] }))).assets).toEqual([
      'TBILL',
    ]);
    const none = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    expect((await loadSiteConfig(none)).assets).toEqual(['USDC', 'stkA', 'stkB', 'stkC']);
    expect(warn).not.toHaveBeenCalled();
  });
});
