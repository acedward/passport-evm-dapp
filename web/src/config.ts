// The site's runtime configuration: `config.json` next to index.html, so a deployment can point
// the same build at another network or relay without rebuilding. Anything missing falls back to
// the stagenet profile.
//
//   { "network": "stagenet" | "undeployed",
//     "relayUrl": "https://relay.example",          the MN Bank relay ('' = same origin)
//     "overrides": { …network profile fields… },
//     "tokens": { "tokens": [ … ] } }               the token list (required for "undeployed")

import {
  type NetworkOverrides,
  type NetworkProfile,
  type TokenRegistry,
  registryFor,
  resolveNetwork,
} from '@mnbank/core';

export interface SiteConfig {
  network: NetworkProfile;
  /** The relay's base URL ('' means the site's own origin). */
  relayUrl: string;
  /** The tokens the bank shows; null when the network has no built-in list and none is given. */
  tokens: TokenRegistry | null;
}

export async function loadSiteConfig(fetchImpl: typeof fetch = fetch): Promise<SiteConfig> {
  let raw: { network?: unknown; relayUrl?: unknown; overrides?: unknown; tokens?: unknown } = {};
  try {
    const res = await fetchImpl('./config.json', { cache: 'no-store' });
    if (res.ok) raw = (await res.json()) as typeof raw;
  } catch {
    /* no config.json: defaults */
  }
  const name = typeof raw.network === 'string' ? raw.network : 'stagenet';
  const overrides = raw.overrides && typeof raw.overrides === 'object' ? (raw.overrides as NetworkOverrides) : {};
  const network = resolveNetwork(name, overrides);
  let tokens: TokenRegistry | null = null;
  if (raw.tokens !== undefined)
    tokens = registryFor(network.name, raw.tokens); // a bad list is an error
  else if (network.name === 'stagenet') tokens = registryFor('stagenet');
  return { network, relayUrl: typeof raw.relayUrl === 'string' ? raw.relayUrl : '', tokens };
}
