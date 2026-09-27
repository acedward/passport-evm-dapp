// The relay's configuration, from the environment. deploy/.env.example documents every variable.
//
// Secrets never come from plain env values in production: pass the PATH of a file
// (SPONSOR_SEED_FILE, SEPOLIA_RPC_URL_FILE), which a deployment mounts read-only. Secrets are
// returned separately from the config, are registered with the log redactor at startup, and
// never appear in /health, /v1/config or any log line.

import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
  DEFAULT_EVM_GAS,
  type EvmGasPolicy,
  type NetworkOverrides,
  type NetworkProfile,
  type TokenRegistry,
  isNetworkName,
  registryFor,
  resolveNetwork,
} from '@mnbank/core';

import { LOG_LEVELS, type LogLevel } from './log.js';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export interface RelayConfig {
  network: NetworkProfile;
  tokens: TokenRegistry;
  host: string;
  port: number;
  /** Trust the last X-Forwarded-For entry (set by our own reverse proxy) for rate limiting. */
  trustProxy: boolean;
  /** Origins allowed to call the relay from a browser (exact match). Empty: no CORS headers. */
  corsOrigins: string[];
  proofServerUrl: string;
  /** Expected proof-server version (health reports a mismatch). */
  proofServerVersion: string;
  /** The read-only key volume (compiled contracts with prover keys), or null. */
  managedPath: string | null;
  /** The pinned verifier-key fingerprint of the key volume; the relay refuses to start on another. */
  keysFingerprint: string | null;
  sponsor: {
    enabled: boolean;
    /** The wallet SDK's fee margin in blocks: it declares fee × 1.046^margin. 5 fails the
     *  registration's activation (BalanceCheckOverspend); 20 is tested locally and on stagenet (Q19). */
    feeBlocksMargin: number;
    /** Below this many specks (10^-15 DUST), spending actions are refused and health degrades. */
    dustLowSpecks: bigint;
    /** A shared lock file to take before opening the wallet (live runs on a shared seed). */
    fundingLockFile: string | null;
    /** The owner confirms the seed is dedicated to this relay, so no shared lock is needed. */
    dedicated: boolean;
  };
  limits: {
    readsPerMinute: number;
    noncesPerMinute: number;
    actionsPerMinute: number;
    actionsPerOwnerPerMinute: number;
    authMaxTtlSeconds: number;
    nonceTtlSeconds: number;
    maxNonces: number;
    jobTtlSeconds: number;
    maxJobs: number;
    maxBodyBytes: number;
  };
  /** Health reports low gas when the vault's EVM account holds less than this (wei). */
  vaultGasLowWei: bigint;
  /** The Sepolia gas fields every bridge start signs (the MPC signs them verbatim). A withdrawal's
   *  gas is paid from the vault's shared EVM account, so the relay accepts no other values. */
  bridgeGas: EvmGasPolicy;
  healthCacheSeconds: number;
  logLevel: LogLevel;
}

export interface RelaySecrets {
  /** The sponsor wallet's seed as hex (from a hex seed or a BIP-39 mnemonic). */
  sponsorSeedHex: string | null;
  /** The raw secret text as read, so the redactor can also cut out a mnemonic. */
  sponsorSeedSource: string | null;
  /** A Sepolia RPC URL; it usually carries an API key. */
  sepoliaRpcUrl: string | null;
}

type Env = Record<string, string | undefined>;
type ReadFile = (path: string) => string;

const bool = (v: string | undefined, dflt: boolean, name: string): boolean => {
  if (v === undefined || v.trim() === '') return dflt;
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  throw new ConfigError(`${name} must be true or false`);
};

const int = (v: string | undefined, dflt: number, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  if (v === undefined || v.trim() === '') return dflt;
  const n = Number(v.trim());
  if (!Number.isInteger(n) || n < min || n > max)
    throw new ConfigError(`${name} must be an integer in [${min}, ${max}]`);
  return n;
};

const big = (v: string | undefined, dflt: bigint, name: string): bigint => {
  if (v === undefined || v.trim() === '') return dflt;
  if (!/^\d+$/.test(v.trim())) throw new ConfigError(`${name} must be a non-negative integer`);
  return BigInt(v.trim());
};

const str = (v: string | undefined): string | undefined => (v === undefined || v.trim() === '' ? undefined : v.trim());

/**
 * Read a secret from `<NAME>_FILE` (preferred) or, for local development only, `<NAME>`.
 * Returns null when neither is set.
 */
function secret(env: Env, readFile: ReadFile, name: string): string | null {
  const file = str(env[`${name}_FILE`]);
  if (file) {
    let text: string;
    try {
      text = readFile(file);
    } catch {
      throw new ConfigError(`${name}_FILE cannot be read`);
    }
    return text;
  }
  return str(env[name]) ?? null;
}

/**
 * The sponsor seed from a secret file's text. Accepts a hex seed, a BIP-39 mnemonic, or an
 * env-style file with one `WALLET=`, `SEED=` or `MNEMONIC=` line (the format of the shared
 * test wallets). Never echoes the value in an error.
 */
export function parseSponsorSeed(text: string): string {
  let value = text.trim();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?(WALLET|SEED|MNEMONIC|SPONSOR_SEED)\s*=\s*(.*)$/.exec(line);
    if (m) value = (m[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
  }
  if (/^(0x)?[0-9a-fA-F]{64,128}$/.test(value) && value.replace(/^0x/, '').length % 2 === 0) {
    return value.replace(/^0x/, '').toLowerCase();
  }
  const words = value.split(/\s+/).filter(Boolean);
  if ([12, 15, 18, 21, 24].includes(words.length)) {
    const mnemonic = words.join(' ').toLowerCase();
    if (!validateMnemonic(mnemonic, wordlist))
      throw new ConfigError('the sponsor seed file holds an invalid BIP-39 mnemonic');
    return Buffer.from(mnemonicToSeedSync(mnemonic, '')).toString('hex');
  }
  throw new ConfigError('the sponsor seed file must hold a hex seed or a BIP-39 mnemonic');
}

function overridesFromEnv(env: Env): NetworkOverrides {
  const pick = <T extends Record<string, string | undefined>>(o: T): Partial<Record<keyof T, string>> =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<Record<keyof T, string>>;
  const overrides: NetworkOverrides = {
    midnight: pick({
      nodeUrl: str(env.MIDNIGHT_NODE_URL),
      nodeWsUrl: str(env.MIDNIGHT_NODE_WS_URL),
      indexerUrl: str(env.MIDNIGHT_INDEXER_URL),
      indexerWsUrl: str(env.MIDNIGHT_INDEXER_WS_URL),
      explorerUrl: str(env.MIDNIGHT_EXPLORER_URL),
    }),
    zswap: pick({
      kernelUrl: str(env.ZSWAP_KERNEL_URL),
      batcherUrl: str(env.ZSWAP_BATCHER_URL),
      batcherTarget: str(env.ZSWAP_BATCHER_TARGET),
      siteUrl: str(env.ZSWAP_SITE_URL),
    }),
    bridge: pick({
      vaultAddress: str(env.BRIDGE_VAULT_ADDRESS)?.replace(/^0x/, '').toLowerCase(),
      vaultEvmAddress: str(env.BRIDGE_VAULT_EVM_ADDRESS),
      signetSingleton: str(env.BRIDGE_SIGNET_SINGLETON)?.replace(/^0x/, '').toLowerCase(),
      mpcRootPublicKey: str(env.BRIDGE_MPC_ROOT_PUBLIC_KEY),
      mpcOutputCacheUrl: str(env.BRIDGE_MPC_OUTPUT_CACHE_URL),
      explorerUrl: str(env.BRIDGE_EXPLORER_URL),
    }),
  };
  const midnightNetworkId = str(env.MIDNIGHT_NETWORK_ID);
  if (midnightNetworkId) overrides.midnightNetworkId = midnightNetworkId;
  return overrides;
}

export function loadConfig(env: Env, readFile: ReadFile): { config: RelayConfig; secrets: RelaySecrets } {
  const networkName = str(env.RELAY_NETWORK);
  if (!networkName || !isNetworkName(networkName))
    throw new ConfigError('RELAY_NETWORK must be "undeployed" or "stagenet"');
  let network: NetworkProfile;
  try {
    network = resolveNetwork(networkName, overridesFromEnv(env));
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }

  let tokenConfig: unknown;
  const tokensFile = str(env.TOKENS_FILE);
  if (tokensFile) {
    try {
      tokenConfig = JSON.parse(readFile(tokensFile));
    } catch {
      throw new ConfigError('TOKENS_FILE cannot be read as JSON');
    }
  }
  let tokens: TokenRegistry;
  try {
    tokens = registryFor(network.name, tokenConfig);
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }

  const logLevel = (str(env.LOG_LEVEL) ?? 'info') as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);

  const proofServerUrl = str(env.MIDNIGHT_PROOF_SERVER_URL) ?? 'http://proof-server:6300';
  try {
    new URL(proofServerUrl);
  } catch {
    throw new ConfigError('MIDNIGHT_PROOF_SERVER_URL is not a URL');
  }

  const fingerprint = str(env.RELAY_KEYS_FINGERPRINT)?.toLowerCase() ?? null;
  if (fingerprint && !/^[0-9a-f]{64}$/.test(fingerprint))
    throw new ConfigError('RELAY_KEYS_FINGERPRINT must be 64 hex characters');

  const sponsorEnabled = bool(env.SPONSOR_ENABLED, false, 'SPONSOR_ENABLED');
  const fundingLockFile = str(env.SPONSOR_FUNDING_LOCK_FILE) ?? null;
  const dedicated = bool(env.SPONSOR_DEDICATED_WALLET, false, 'SPONSOR_DEDICATED_WALLET');

  const config: RelayConfig = {
    network,
    tokens,
    host: str(env.RELAY_HOST) ?? '0.0.0.0',
    port: int(env.RELAY_PORT, 8080, 'RELAY_PORT', 1, 65535),
    trustProxy: bool(env.RELAY_TRUST_PROXY, false, 'RELAY_TRUST_PROXY'),
    corsOrigins: (str(env.RELAY_CORS_ORIGINS) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    proofServerUrl,
    proofServerVersion: str(env.PROOF_SERVER_EXPECTED_VERSION) ?? '9.0.0-rc.6',
    managedPath: str(env.MIDNIGHT_MANAGED_PATH) ?? null,
    keysFingerprint: fingerprint,
    sponsor: {
      enabled: sponsorEnabled,
      feeBlocksMargin: int(env.SPONSOR_FEE_BLOCKS_MARGIN, 20, 'SPONSOR_FEE_BLOCKS_MARGIN', 1, 1000),
      dustLowSpecks: big(env.SPONSOR_DUST_LOW_SPECKS, 10n * 10n ** 15n, 'SPONSOR_DUST_LOW_SPECKS'),
      fundingLockFile,
      dedicated,
    },
    limits: {
      readsPerMinute: int(env.RATE_LIMIT_READS_PER_MIN, 240, 'RATE_LIMIT_READS_PER_MIN', 1),
      noncesPerMinute: int(env.RATE_LIMIT_NONCES_PER_MIN, 30, 'RATE_LIMIT_NONCES_PER_MIN', 1),
      actionsPerMinute: int(env.RATE_LIMIT_ACTIONS_PER_MIN, 10, 'RATE_LIMIT_ACTIONS_PER_MIN', 1),
      actionsPerOwnerPerMinute: int(
        env.RATE_LIMIT_ACTIONS_PER_OWNER_PER_MIN,
        5,
        'RATE_LIMIT_ACTIONS_PER_OWNER_PER_MIN',
        1,
      ),
      authMaxTtlSeconds: int(env.AUTH_MAX_TTL_SECONDS, 600, 'AUTH_MAX_TTL_SECONDS', 30, 3600),
      nonceTtlSeconds: int(env.AUTH_NONCE_TTL_SECONDS, 600, 'AUTH_NONCE_TTL_SECONDS', 30, 3600),
      maxNonces: int(env.AUTH_MAX_NONCES, 50_000, 'AUTH_MAX_NONCES', 100),
      jobTtlSeconds: int(env.JOB_TTL_SECONDS, 86_400, 'JOB_TTL_SECONDS', 60),
      maxJobs: int(env.JOB_MAX, 10_000, 'JOB_MAX', 10),
      maxBodyBytes: int(env.RELAY_MAX_BODY_BYTES, 1_048_576, 'RELAY_MAX_BODY_BYTES', 1024),
    },
    vaultGasLowWei: big(env.VAULT_GAS_LOW_WEI, 2_000_000_000_000_000n, 'VAULT_GAS_LOW_WEI'),
    bridgeGas: {
      gasLimit: big(env.BRIDGE_EVM_GAS_LIMIT, DEFAULT_EVM_GAS.gasLimit, 'BRIDGE_EVM_GAS_LIMIT'),
      maxFeePerGas: big(env.BRIDGE_EVM_MAX_FEE_PER_GAS, DEFAULT_EVM_GAS.maxFeePerGas, 'BRIDGE_EVM_MAX_FEE_PER_GAS'),
      maxPriorityFeePerGas: big(
        env.BRIDGE_EVM_MAX_PRIORITY_FEE_PER_GAS,
        DEFAULT_EVM_GAS.maxPriorityFeePerGas,
        'BRIDGE_EVM_MAX_PRIORITY_FEE_PER_GAS',
      ),
      keyVersion: DEFAULT_EVM_GAS.keyVersion,
    },
    healthCacheSeconds: int(env.HEALTH_CACHE_SECONDS, 15, 'HEALTH_CACHE_SECONDS', 0, 600),
    logLevel,
  };

  const sponsorSeedSource = secret(env, readFile, 'SPONSOR_SEED');
  const sponsorSeedHex = sponsorSeedSource === null ? null : parseSponsorSeed(sponsorSeedSource);
  const sepoliaRpcUrl = secret(env, readFile, 'SEPOLIA_RPC_URL')?.trim() ?? null;
  if (sepoliaRpcUrl !== null) {
    try {
      new URL(sepoliaRpcUrl);
    } catch {
      throw new ConfigError('the Sepolia RPC URL is not a URL');
    }
  }

  if (sponsorEnabled && sponsorSeedHex === null) throw new ConfigError('SPONSOR_ENABLED needs SPONSOR_SEED_FILE');
  // Live networks: a seed shared with other tools must be taken under the shared lock, and a
  // dedicated seed must be declared as such. The relay never opens a live wallet otherwise.
  if (sponsorEnabled && network.name !== 'undeployed' && !fundingLockFile && !dedicated) {
    throw new ConfigError(
      'on a live network the sponsor needs SPONSOR_FUNDING_LOCK_FILE (a shared seed) or SPONSOR_DEDICATED_WALLET=true',
    );
  }

  return { config, secrets: { sponsorSeedHex, sponsorSeedSource, sepoliaRpcUrl } };
}
