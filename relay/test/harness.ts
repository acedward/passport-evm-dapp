// A relay app wired with in-memory fakes, for route tests. No network, no wallet, no ports.

import { type BaseWallet, Wallet } from 'ethers';
import {
  API_PATHS,
  RELAY_ACTION_TYPES,
  buildRelayActionMessage,
  relayDomain,
  type HealthResponse,
  type RelayActionName,
} from '@mnbank/core';

import { defaultCatalogue, type ActionDefinition } from '../src/actions/catalogue.js';
import { AppendEntitlements } from '../src/actions/entitlements.js';
import { createApp, type AppDeps } from '../src/app.js';
import { NonceStore } from '../src/auth/nonces.js';
import { notImplementedChainReader, type ChainReader } from '../src/chain/reader.js';
import { loadConfig, type RelayConfig } from '../src/config.js';
import { createLogger, type Logger } from '../src/log.js';
import { JobQueue } from '../src/queue/jobs.js';
import type { SponsorSession, SponsorStatus } from '../src/sponsor/session.js';

export const LOCAL_TOKENS = {
  tokens: [
    { symbol: 'tUSDC', midnightName: 'shielded-a', role: 'usdc', decimals: 6, midnightColour: 'aa'.repeat(32) },
    { symbol: 'tSTK', midnightName: 'shielded-b', role: 'stock', decimals: 6, midnightColour: 'bb'.repeat(32) },
  ],
};

export function testConfig(env: Record<string, string> = {}): RelayConfig {
  return loadConfig({ RELAY_NETWORK: 'undeployed', TOKENS_FILE: '/tokens.json', ...env }, () =>
    JSON.stringify(LOCAL_TOKENS),
  ).config;
}

export class FakeSponsor implements SponsorSession {
  constructor(
    public current: SponsorStatus = { configured: true, state: 'synced', synced: true, dustSpecks: 10n ** 20n },
  ) {}
  async start() {}
  async stop() {}
  status() {
    return this.current;
  }
  async withWallet<T>(fn: (w: unknown) => Promise<T>) {
    return fn({ fake: true });
  }
}

/** The append-inbox entitlements (security review F-B3) with a fixed test key. */
export const testEntitlements = (
  over: Partial<ConstructorParameters<typeof AppendEntitlements>[0]> = {},
): AppendEntitlements =>
  new AppendEntitlements({
    key: new Uint8Array(32).fill(7),
    network: 'undeployed',
    ttlSeconds: 30 * 86_400,
    maxPerAccountPerDay: 20,
    ...over,
  });

export const silentLog = (): Logger & { lines: string[] } => {
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', sink: (l) => lines.push(l) }) as Logger & { lines: string[] };
  log.lines = lines;
  return log;
};

export function harness(
  opts: {
    config?: RelayConfig;
    sponsor?: SponsorSession;
    catalogue?: Map<RelayActionName, ActionDefinition>;
    passportCall?: AppDeps['passportCall'];
    chain?: ChainReader;
    bridge?: AppDeps['bridge'];
  } = {},
) {
  const config = opts.config ?? testConfig();
  const log = silentLog();
  const nonces = new NonceStore(config.limits.nonceTtlSeconds, config.limits.maxNonces);
  const queue = new JobQueue({ ttlSeconds: config.limits.jobTtlSeconds, maxJobs: config.limits.maxJobs, log });
  const catalogue = opts.catalogue ?? defaultCatalogue();
  const health = async (): Promise<HealthResponse> => ({
    status: 'ok',
    network: config.network.name,
    version: 'test',
    uptimeSeconds: 0,
    sponsor: { configured: true, state: 'synced', synced: true, dustSpecks: '1', dustLow: false },
    proofServer: {
      reachable: true,
      version: '9.0.0-rc.6',
      jobCapacity: 10,
      keys: { present: false, fingerprint: null, pinned: false, matchesPin: null },
    },
    queue: { jobs: 0, lanes: {} },
    kernel: { reachable: true, synced: true },
    batcher: { reachable: true },
    vaultGas: { address: '', balanceWei: null, low: null },
  });
  const app = createApp({
    config,
    version: 'test',
    log,
    nonces,
    queue,
    catalogue,
    sponsor: opts.sponsor ?? new FakeSponsor(),
    health,
    chain: opts.chain ?? notImplementedChainReader,
    ...(opts.passportCall ? { passportCall: opts.passportCall } : {}),
    ...(opts.bridge ? { bridge: opts.bridge } : {}),
    clientAddress: () => '198.51.100.7',
  });
  return { app, config, log, nonces, queue, catalogue };
}

export const ACCOUNT = '11'.repeat(32);

export function samplePayload(action: RelayActionName): Record<string, unknown> {
  return action === 'register' ? { encPublicKey: 'ab'.repeat(32) } : { amount: '1000000', colour: 'bb'.repeat(32) };
}

/** Build a correctly signed request body for `action` (or a deliberately broken one). */
export async function signedBody(
  h: ReturnType<typeof harness>,
  action: RelayActionName,
  signer: BaseWallet,
  over: {
    owner?: string;
    expiry?: number;
    payload?: Record<string, unknown>;
    nonce?: string;
    network?: string;
    signedAction?: RelayActionName;
  } = {},
) {
  const def = h.catalogue.get(action)!;
  const payload = over.payload ?? samplePayload(action);
  const nonce = over.nonce ?? (await (await h.app.request(API_PATHS.nonce)).json()).nonce;
  const message = buildRelayActionMessage({
    action: over.signedAction ?? action,
    network: over.network ?? h.config.network.name,
    owner: over.owner ?? signer.address,
    account: def.requiresAccount ? ACCOUNT : undefined,
    payload,
    nonce,
    expiry: over.expiry ?? Math.floor(Date.now() / 1000) + 120,
  });
  const signature = await signer.signTypedData(relayDomain(), RELAY_ACTION_TYPES, message);
  return { ...(def.requiresAccount ? { account: ACCOUNT } : {}), payload, auth: { message, signature } };
}

export const post = (h: ReturnType<typeof harness>, action: string, body: unknown) =>
  h.app.request(`/v1/actions/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export const newWallet = (): BaseWallet => Wallet.createRandom();
