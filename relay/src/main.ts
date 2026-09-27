// The relay's entry point (Bun): load the configuration, register every secret with the log
// redactor, check the key volume, open the sponsor wallet (under the funding lock when one is
// configured), and serve.

import { readFileSync } from 'node:fs';

import { defaultCatalogue } from './actions/catalogue.js';
import { createApp } from './app.js';
import { NonceStore } from './auth/nonces.js';
import { notImplementedChainReader } from './chain/reader.js';
import { ConfigError, loadConfig } from './config.js';
import { healthCollector, httpProbes } from './health.js';
import { Redactor, createLogger } from './log.js';
import { ProofServerClient } from './prover/client.js';
import { checkKeyVolume } from './prover/keys.js';
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

  const keys = () => checkKeyVolume(config.managedPath, config.keysFingerprint);
  const keyCheck = keys();
  if (config.keysFingerprint && keyCheck.matchesPin !== true) {
    log.error('the key volume does not match RELAY_KEYS_FINGERPRINT; refusing to start', {
      found: keyCheck.fingerprint,
    });
    process.exit(78);
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

  const nonces = new NonceStore(config.limits.nonceTtlSeconds, config.limits.maxNonces);
  const queue = new JobQueue({
    ttlSeconds: config.limits.jobTtlSeconds,
    maxJobs: config.limits.maxJobs,
    log: log.child({ component: 'queue' }),
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
  });
  const app = createApp({
    config,
    version: RELAY_VERSION,
    log,
    nonces,
    queue,
    catalogue: defaultCatalogue(),
    sponsor,
    health,
    chain: notImplementedChainReader,
  });

  const sweeper = setInterval(() => {
    queue.sweep();
    nonces.sweep();
  }, 60_000);

  const server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch });
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
    await server.stop();
    await sponsor.stop().catch((e: unknown) => log.warn('sponsor stop failed', { error: e }));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
