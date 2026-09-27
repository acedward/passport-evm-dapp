// Network profiles. Every endpoint is configuration (spec FR-014): a profile is a set of
// defaults, and any field can be overridden by the relay's env or the site's config.json.
//
// Only PUBLIC endpoints live here. The Sepolia RPC (it carries a key), the sponsor seed and
// the proof server's internal URL are relay-only configuration and never reach the browser.

import { z } from 'zod';

import stagenetVault from './tokens/deployments/stagenet-vault.json' with { type: 'json' };

export const SEPOLIA_CHAIN_ID = 11155111;
export const SEPOLIA_CHAIN_ID_HEX = '0xaa36a7';

export const NETWORK_NAMES = ['undeployed', 'stagenet'] as const;
export type NetworkName = (typeof NETWORK_NAMES)[number];

const url = z.url();
const hex32 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lowercase hex characters');
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x-prefixed 20-byte address');

export const NetworkProfileSchema = z.object({
  name: z.enum(NETWORK_NAMES),
  /** The Midnight network id the SDK is set to (`setNetworkId`). */
  midnightNetworkId: z.string().min(1),
  midnight: z.object({
    nodeUrl: url,
    nodeWsUrl: url,
    indexerUrl: url,
    indexerWsUrl: url,
    /** A block explorer for Midnight transactions, when there is one. */
    explorerUrl: url.optional(),
  }),
  zswap: z.object({
    /** The offer-files kernel API (`/v1/offers`, `/v1/pairs`, …). */
    kernelUrl: url,
    /** The batcher (`POST /send-input`). */
    batcherUrl: url,
    batcherTarget: z.string().min(1),
    /** The public exchange site, for links. */
    siteUrl: url.optional(),
  }),
  evm: z.object({
    chainId: z.number().int().positive(),
    chainIdHex: z.string().regex(/^0x[0-9a-f]+$/),
    chainName: z.string().min(1),
    explorerUrl: url,
    /** Public RPC offered to wallets in `wallet_addEthereumChain`. Never a keyed URL. */
    publicRpcUrl: url,
  }),
  bridge: z.object({
    /** The ERC20 vault contract on Midnight. Empty until the stack or the deployment names it. */
    vaultAddress: hex32.or(z.literal('')),
    vaultEvmAddress: evmAddress.or(z.literal('')),
    signetSingleton: hex32.or(z.literal('')),
    /** Uncompressed secp256k1 MPC root key (0x04…). */
    mpcRootPublicKey: z.string().regex(/^(0x04[0-9a-fA-F]{128})?$/),
    mpcOutputCacheUrl: url.or(z.literal('')),
    explorerUrl: url.optional(),
  }),
});
export type NetworkProfile = z.infer<typeof NetworkProfileSchema>;

const SEPOLIA = {
  chainId: SEPOLIA_CHAIN_ID,
  chainIdHex: SEPOLIA_CHAIN_ID_HEX,
  chainName: 'Sepolia',
  explorerUrl: 'https://sepolia.etherscan.io',
  publicRpcUrl: 'https://rpc.sepolia.org',
} as const;

/** The live staging network: the stagenet node and indexer, the staging ZSwap exchange, and
 *  the PR #4 vault (from the vendored deployment record). */
export const STAGENET: NetworkProfile = {
  name: 'stagenet',
  midnightNetworkId: 'stagenet',
  midnight: {
    nodeUrl: 'https://rpc.stagenet.shielded.tools',
    nodeWsUrl: 'wss://rpc.stagenet.shielded.tools',
    indexerUrl: 'https://indexer.stagenet.shielded.tools/api/v4/graphql',
    indexerWsUrl: 'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws',
  },
  zswap: {
    kernelUrl: 'https://stagenet.api-zswap.zkdojo.com',
    batcherUrl: 'https://stagenet.batcher-zswap.zkdojo.com',
    batcherTarget: 'midnight-balancer',
    siteUrl: 'https://stagenet.zswap.zkdojo.com',
  },
  evm: { ...SEPOLIA },
  bridge: {
    vaultAddress: stagenetVault.vaultContractAddress,
    vaultEvmAddress: stagenetVault.vaultEvmAddress,
    signetSingleton: stagenetVault.signetSingleton,
    mpcRootPublicKey: stagenetVault.mpcRootPublicKey,
    mpcOutputCacheUrl: stagenetVault.mpcOutputCacheUrl,
    explorerUrl: stagenetVault.explorer,
  },
};

/** The local ledger-9 stack (plan P0.5 recipe): in-network DNS names, as a relay container on
 *  `${COMPOSE_PROJECT_NAME}_default` sees them. The vault is deployed fresh by every stack,
 *  so the bridge fields are empty until the harness passes the stack's receipt. */
export const UNDEPLOYED: NetworkProfile = {
  name: 'undeployed',
  midnightNetworkId: 'undeployed',
  midnight: {
    nodeUrl: 'http://node:9944',
    nodeWsUrl: 'ws://node:9944',
    indexerUrl: 'http://indexer:8088/api/v4/graphql',
    indexerWsUrl: 'ws://indexer:8088/api/v4/graphql/ws',
  },
  zswap: {
    kernelUrl: 'http://kernel:9999',
    batcherUrl: 'http://batcher:3334',
    batcherTarget: 'midnight-balancer',
  },
  evm: { ...SEPOLIA },
  bridge: {
    vaultAddress: '',
    vaultEvmAddress: '',
    signetSingleton: '',
    mpcRootPublicKey: '',
    mpcOutputCacheUrl: '',
  },
};

export const PROFILES: Readonly<Record<NetworkName, NetworkProfile>> = { stagenet: STAGENET, undeployed: UNDEPLOYED };

/** A partial profile: any subset of fields, nested. */
export type NetworkOverrides = {
  [K in keyof Omit<NetworkProfile, 'name'>]?: NetworkProfile[K] extends object
    ? Partial<NetworkProfile[K]>
    : NetworkProfile[K];
};

export class NetworkConfigError extends Error {
  override name = 'NetworkConfigError';
}

export function isNetworkName(value: unknown): value is NetworkName {
  return typeof value === 'string' && (NETWORK_NAMES as readonly string[]).includes(value);
}

/** The profile for `name` with `overrides` applied, validated. Unknown keys are refused. */
export function resolveNetwork(name: string, overrides: NetworkOverrides = {}): NetworkProfile {
  if (!isNetworkName(name))
    throw new NetworkConfigError(`unknown network "${name}" (expected ${NETWORK_NAMES.join(' or ')})`);
  const base = PROFILES[name];
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in base) || key === 'name') throw new NetworkConfigError(`unknown network setting "${key}"`);
    const current = (base as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (current !== null && typeof current === 'object' && typeof value === 'object' && value !== null) {
      for (const sub of Object.keys(value)) {
        if (!(sub in current)) {
          const optional = ['explorerUrl', 'siteUrl'];
          if (!optional.includes(sub)) throw new NetworkConfigError(`unknown network setting "${key}.${sub}"`);
        }
      }
      const defined = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
      merged[key] = { ...current, ...defined };
    } else {
      merged[key] = value;
    }
  }
  const parsed = NetworkProfileSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new NetworkConfigError(`invalid ${name} network settings: ${issues}`);
  }
  return parsed.data;
}

/** Whether the bridge settings are complete enough to derive deposit addresses. */
export function bridgeConfigured(profile: NetworkProfile): boolean {
  const b = profile.bridge;
  return b.vaultAddress !== '' && b.vaultEvmAddress !== '' && b.mpcRootPublicKey !== '';
}
