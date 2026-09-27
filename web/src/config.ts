// The site's runtime configuration: `config.json` next to index.html, so a deployment can point
// the same build at another network or relay without rebuilding. Anything missing falls back to
// the stagenet profile.

import { type NetworkOverrides, type NetworkProfile, resolveNetwork } from '@mnbank/core';

export interface SiteConfig {
  network: NetworkProfile;
  /** The relay's base URL ('' until the lanes call it). */
  relayUrl: string;
}

export async function loadSiteConfig(fetchImpl: typeof fetch = fetch): Promise<SiteConfig> {
  let raw: { network?: unknown; relayUrl?: unknown; overrides?: unknown } = {};
  try {
    const res = await fetchImpl('./config.json', { cache: 'no-store' });
    if (res.ok) raw = (await res.json()) as typeof raw;
  } catch {
    /* no config.json: defaults */
  }
  const name = typeof raw.network === 'string' ? raw.network : 'stagenet';
  const overrides = raw.overrides && typeof raw.overrides === 'object' ? (raw.overrides as NetworkOverrides) : {};
  return { network: resolveNetwork(name, overrides), relayUrl: typeof raw.relayUrl === 'string' ? raw.relayUrl : '' };
}
