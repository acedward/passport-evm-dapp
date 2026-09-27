// The relay's entry point (Bun): load the configuration, register every secret with the log
// redactor, check the key volume (and refuse to start when it lacks any circuit the relay proves,
// plan P4-A), open the sponsor wallet (under the funding lock when one is configured), start the
// stale bridge-request closer (Q21 A), and serve.

import { readFileSync } from 'node:fs';

import { bridgeConfigured } from '@mnbank/core';

import { accountCatalogue, withBridge, withTrade } from './actions/catalogue.js';
import { createApp } from './app.js';
import { NonceStore } from './auth/nonces.js';
import { passportCallAuthoriser } from './auth/passport-call.js';
import { DigestReplayGuard } from './auth/verifiers.js';
import type { BridgeBackend } from './bridge/backend.js';
import { loadLiveBridgeBackend } from './bridge/live-backend.js';
import { BridgeService } from './bridge/service.js';
import { StaleRequestCloser, bankAccountChecker } from './bridge/stale.js';
import { deviceChecker, gatedStartVerifier } from './bridge/wiring.js';
import { IndexerClient } from './chain/indexer.js';
import { IndexerChainReader, notImplementedChainReader, type ChainReader } from './chain/reader.js';
import { ConfigError, loadConfig } from './config.js';
import { healthCollector, httpProbes } from './health.js';
import { Redactor, createLogger } from './log.js';
import { ProofServerClient } from './prover/client.js';
import { deployedVerifierKeys } from './prover/deployed.js';
import { checkKeyVolume, keyVolumeProblems } from './prover/keys.js';
import { RELAY_PROVEN_CIRCUITS } from './prover/required.js';
import { PassportRuntime, PassportRuntimeError } from './passport/runtime.js';
import { JobQueue } from './queue/jobs.js';
import { FacadeSponsorSession, openFacadeWallet } from './sponsor/facade.js';
import { DisabledSponsorSession, type SponsorSession } from './sponsor/session.js';
import { RELAY_VERSION } from './version.js';

async function main(): Promise<void> {
  const redactor = new Redactor();
  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig(process.env, (p) => readFileSync(p, 'utf8'));
  } catch (e) {
    const msg = e instanceof ConfigError ? e.message : 'the configuration could not be loaded';
    process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), level: 'error', msg: `config: ${msg}` })}\n`);
    process.exit(78);
  }
  const { config, secrets } = loaded;
  redactor.addSecret(secrets.sponsorSeedHex);
  redactor.addSecret(secrets.sponsorSeedSource);
  redactor.addSecret(secrets.sepoliaRpcUrl);
  const log = createLogger({ level: config.logLevel, redactor }, { service: 'relay', network: config.network.name });

  // The key volume (plan P4-A): every circuit the relay proves must have its prover key, verifier
  // key and ZKIR, the vault's and the singleton's keys must be the deployed ones, and a pinned
  // fingerprint must match. When a volume is configured and any of that fails, the relay does not
  // start: a missing key would otherwise surface only in a customer's job.
  const deployed = deployedVerifierKeys(config.network.name, config.network.bridge.vaultAddress);
  const keys = () => checkKeyVolume(config.managedPath, config.keysFingerprint, RELAY_PROVEN_CIRCUITS, deployed);
  const keyCheck = keys();
  if (config.managedPath) {
    const problems = keyVolumeProblems(keyCheck, {
      root: config.managedPath,
      pin: config.keysFingerprint,
      deployed,
    });
    if (problems.length > 0) {
      log.error(
        `the key volume is incomplete or does not match; refusing to start (${problems.length} problem${problems.length === 1 ? '' : 's'})`,
        { problems, fingerprint: keyCheck.fingerprint, circuitsChecked: RELAY_PROVEN_CIRCUITS.length },
      );
      process.exit(78);
    }
    log.info('key volume complete', {
      circuits: RELAY_PROVEN_CIRCUITS.length,
      fingerprint: keyCheck.fingerprint,
      deployedKeysChecked: Object.keys(deployed).length,
    });
  } else if (config.requireKeys) {
    log.error('RELAY_REQUIRE_KEYS is set but MIDNIGHT_MANAGED_PATH names no key volume; refusing to start');
    process.exit(78);
  } else {
    log.warn('no key volume (MIDNIGHT_MANAGED_PATH): account, bridge and trade actions are unavailable');
  }

  let sponsor: SponsorSession = new DisabledSponsorSession();
  if (config.sponsor.enabled && secrets.sponsorSeedHex) {
    sponsor = new FacadeSponsorSession(
      {
        seedHex: secrets.sponsorSeedHex,
        endpoints: {
          networkId: config.network.midnightNetworkId,
          indexerUrl: config.network.midnight.indexerUrl,
          indexerWsUrl: config.network.midnight.indexerWsUrl,
          nodeWsUrl: config.network.midnight.nodeWsUrl,
          proofServerUrl: config.proofServerUrl,
        },
        feeBlocksMargin: config.sponsor.feeBlocksMargin,
        fundingLockFile: config.sponsor.fundingLockFile,
        purpose: `mn-bank relay ${RELAY_VERSION} (${config.network.name})`,
      },
      openFacadeWallet,
      log.child({ component: 'sponsor' }),
    );
    try {
      await sponsor.start();
    } catch (e) {
      log.error('the sponsor wallet could not be started; refusing to start', { error: e });
      process.exit(75);
    }
  }

  // The Passport runtime: the pinned client bound to the key volume's compiled contracts. Without
  // a key volume the relay still serves /health and /v1/config, and the account actions say they
  // are not available.
  let runtime: PassportRuntime | null = null;
  if (config.managedPath && keyCheck.present) {
    try {
      runtime = await PassportRuntime.load({
        managedPath: config.managedPath,
        networkId: config.network.midnightNetworkId,
        indexerUrl: config.network.midnight.indexerUrl,
        indexerWsUrl: config.network.midnight.indexerWsUrl,
        proofServerUrl: config.proofServerUrl,
        log: log.child({ component: 'passport' }),
      });
    } catch (e) {
      if (e instanceof PassportRuntimeError) {
        // The account keys in the volume are not the code's (or the volume is the light compile).
        log.error('the key volume does not match the Passport client; refusing to start', { error: e });
        process.exit(78);
      }
      log.error('the Passport runtime could not be loaded; account actions are unavailable', { error: e });
    }
  }
  const indexer = new IndexerClient({ indexerUrl: config.network.midnight.indexerUrl });
  const chain: ChainReader = runtime
    ? new IndexerChainReader((account) => runtime!.ledgerState(account), indexer)
    : notImplementedChainReader;
  const replay = new DigestReplayGuard(config.limits.authMaxTtlSeconds * 6);

  // The bridge (plan L-BRG): needs the runtime, a complete vault profile and a Sepolia RPC.
  let bridgeBackend: BridgeBackend | null = null;
  if (runtime && bridgeConfigured(config.network) && secrets.sepoliaRpcUrl) {
    try {
      bridgeBackend = await loadLiveBridgeBackend({
        runtime,
        sponsor,
        network: config.network,
        evmRpcUrl: secrets.sepoliaRpcUrl,
        indexer,
        log: log.child({ component: 'bridge' }),
      });
      log.info('bridge ready', { vault: config.network.bridge.vaultAddress });
    } catch (e) {
      log.error('the bridge could not be loaded; bridge actions are unavailable', { error: e });
    }
  } else {
    log.info('bridge not configured (it needs the key volume, the vault profile and SEPOLIA_RPC_URL_FILE)');
  }

  const nonces = new NonceStore(config.limits.nonceTtlSeconds, config.limits.maxNonces);
  const queue = new JobQueue({
    ttlSeconds: config.limits.jobTtlSeconds,
    maxJobs: config.limits.maxJobs,
    log: log.child({ component: 'queue' }),
  });
  const bridge = new BridgeService({
    backend: () => bridgeBackend,
    laneLoad: (lane, account) => queue.laneLoad(lane, account),
    gas: config.bridgeGas,
    tokens: config.tokens,
    vaultAddress: config.network.bridge.vaultAddress,
    verifyStart: gatedStartVerifier(() => runtime),
    releaseDigest: (digest) => replay.release(digest),
    isDevice: deviceChecker(() => runtime),
    log: log.child({ component: 'bridge' }),
    closedTtlMs: config.limits.jobTtlSeconds * 1000,
  });
  // Q21 A: close bridge requests their owners left open (./bridge/stale.ts).
  const closer = new StaleRequestCloser({
    config: {
      enabled: config.staleClose.enabled && config.staleClose.maxPerDay > 0,
      intervalMs: config.staleClose.intervalSeconds * 1000,
      staleAfterMs: config.staleClose.afterSeconds * 1000,
      maxPerDay: config.staleClose.maxPerDay,
      minSponsorDustSpecks: config.staleClose.minSponsorDustSpecks,
      retryAfterMs: config.staleClose.retrySeconds * 1000,
    },
    service: bridge,
    backend: () => bridgeBackend,
    submit: (sub) => queue.submit(sub),
    settled: (id) => queue.settled(id),
    sponsor: () => sponsor.status(),
    isBankAccount: bankAccountChecker(
      async (account) => (runtime ? runtime.ledgerState(account) : null),
      config.network.bridge.vaultAddress,
    ),
    log: log.child({ component: 'stale-requests' }),
  });
  let batcherRefusal: { httpStatus: number; at: number } | null = null;
  const bridgeHealth = () => ({
    available: bridge.available(),
    mpc: bridge.mpcStatus(),
    staleRequests: closer.status(),
  });
  const health = healthCollector({
    network: config.network.name,
    version: RELAY_VERSION,
    startedAt: Math.floor(Date.now() / 1000),
    sponsor,
    dustLowSpecks: config.sponsor.dustLowSpecks,
    prover: new ProofServerClient(config.proofServerUrl, config.proofServerVersion),
    keys,
    queue,
    probes: httpProbes({
      kernelUrl: config.network.zswap.kernelUrl,
      batcherUrl: config.network.zswap.batcherUrl,
      vaultEvmAddress: config.network.bridge.vaultEvmAddress,
      sepoliaRpcUrl: secrets.sepoliaRpcUrl,
      log,
    }),
    vaultEvmAddress: config.network.bridge.vaultEvmAddress,
    vaultGasLowWei: config.vaultGasLowWei,
    cacheSeconds: config.healthCacheSeconds,
    bridge: bridgeHealth,
    batcherRefusal: () => batcherRefusal,
  });
  const app = createApp({
    config,
    version: RELAY_VERSION,
    log,
    nonces,
    queue,
    catalogue: withTrade(
      withBridge(
        accountCatalogue({
          runtime: () => runtime,
          sponsor,
          vaultAddress: config.network.bridge.vaultAddress,
          chainId: config.network.evm.chainId,
          replay,
          log: log.child({ component: 'accounts' }),
        }),
        bridge,
      ),
      {
        runtime: () => runtime,
        sponsor,
        kernelUrl: config.network.zswap.kernelUrl,
        batcherUrl: config.network.zswap.batcherUrl,
        batcherTarget: config.network.zswap.batcherTarget,
        replay,
        log: log.child({ component: 'trade' }),
        onBatcherRefusal: (httpStatus) => {
          batcherRefusal = { httpStatus, at: Math.floor(Date.now() / 1000) };
        },
      },
    ),
    sponsor,
    health,
    chain,
    bridge,
    passportCall: passportCallAuthoriser(() => runtime, replay),
  });

  const sweeper = setInterval(() => {
    queue.sweep();
    nonces.sweep();
  }, 60_000);

  const server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch });
  if (bridgeBackend) closer.start();
  log.info('relay listening', {
    host: config.host,
    port: server.port,
    version: RELAY_VERSION,
    sponsor: sponsor.status().state,
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    clearInterval(sweeper);
    closer.stop();
    await server.stop();
    await sponsor.stop().catch((e: unknown) => log.warn('sponsor stop failed', { error: e }));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
