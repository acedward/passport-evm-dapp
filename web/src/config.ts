// The site's runtime configuration: `config.json` next to index.html, so a deployment can point
// the same build at another network or relay without rebuilding. Anything missing falls back to
// the stagenet profile.

import {
  NETWORK_DEFAULT_ASSETS,
  type NetworkOverrides,
  type NetworkProfile,
  registryFor,
  resolveNetwork,
} from '@mnbank/core';

import { resolveSiteAssets } from './assets/filter.js';

export interface SiteConfig {
  network: NetworkProfile;
  /** The relay's base URL ('' until the lanes call it). */
  relayUrl: string;
  /** The token list (USDC and stock roles) when the network has no built-in one, for example the
   *  local stack's colours; stagenet's comes from the vendored PR #4 records. */
  tokens?: unknown;
  /** This site's asset set (plan 00046), from `assets` (a list of symbols, or "all") or the
   *  network's default set (which belongs to the built-in token list: a site that configures its
   *  own `tokens` shows all of them unless it names `assets`); null = every asset. Each domain
   *  serves the same build with its own `config.json`, and the page's `?assets=` list only narrows
   *  within this set. */
  assets: string[] | null;
}

export async function loadSiteConfig(fetchImpl: typeof fetch = fetch): Promise<SiteConfig> {
  let raw: { network?: unknown; relayUrl?: unknown; overrides?: unknown; tokens?: unknown; assets?: unknown } = {};
  try {
    const res = await fetchImpl('./config.json', { cache: 'no-store' });
    if (res.ok) raw = (await res.json()) as typeof raw;
  } catch {
    /* no config.json: defaults */
  }
  const name = typeof raw.network === 'string' ? raw.network : 'stagenet';
  const overrides = raw.overrides && typeof raw.overrides === 'object' ? (raw.overrides as NetworkOverrides) : {};
  const network = resolveNetwork(name, overrides);
  return {
    network,
    relayUrl: typeof raw.relayUrl === 'string' ? raw.relayUrl : '',
    ...(raw.tokens !== undefined ? { tokens: raw.tokens } : {}),
    assets: siteAssets(network, raw.tokens, raw.assets),
  };
}

/** Resolve the site's set against the bank's token list, naming any configuration problem in the
 *  console. Without a token list (the markets then say why), every asset is the set. */
function siteAssets(network: NetworkProfile, tokens: unknown, configured: unknown): string[] | null {
  let registry;
  try {
    registry = registryFor(network.name, tokens);
  } catch {
    return null;
  }
  const networkDefault = tokens === undefined ? NETWORK_DEFAULT_ASSETS[network.name] : null;
  const { set, warnings } = resolveSiteAssets(configured, networkDefault, registry.tokens);
  for (const w of warnings) console.warn(`MN Bank: ${w}`);
  return set;
}
