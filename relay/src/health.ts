// GET /health (spec FR-013): the sponsor's DUST, the proof server and its keys, the queue, the
// kernel and batcher, and the gas ETH on the vault's EVM account. Public data only: no URL, no
// seed, no key. External probes are cached for a few seconds so /health cannot be used to flood
// the services behind it.

import type { HealthResponse } from '@mnbank/core';

import type { Logger } from './log.js';
import type { ProofServerClient } from './prover/client.js';
import type { KeyCheck } from './prover/keys.js';
import type { JobQueue } from './queue/jobs.js';
import type { SponsorSession } from './sponsor/session.js';

export interface ExternalProbes {
  kernel(): Promise<{ reachable: boolean; synced: boolean | null }>;
  batcher(): Promise<{ reachable: boolean }>;
  /** Wei on the vault's EVM account, or null when no Sepolia RPC is configured or it failed. */
  vaultGasWei(): Promise<bigint | null>;
}

const withTimeout = (ms: number) => AbortSignal.timeout(ms);

/** HTTP probes of the kernel, the batcher and Sepolia. `rpcUrl` is a secret: never logged. */
export function httpProbes(opts: {
  kernelUrl: string;
  batcherUrl: string;
  vaultEvmAddress: string;
  sepoliaRpcUrl: string | null;
  fetchImpl?: typeof fetch;
  log: Logger;
  timeoutMs?: number;
}): ExternalProbes {
  const f = opts.fetchImpl ?? fetch;
  const t = opts.timeoutMs ?? 5_000;
  return {
    async kernel() {
      try {
        const r = await f(new URL('/v1/health', opts.kernelUrl), { signal: withTimeout(t) });
        if (!r.ok) return { reachable: false, synced: null };
        const body = (await r.json().catch(() => ({}))) as { synced?: unknown };
        return { reachable: true, synced: typeof body.synced === 'boolean' ? body.synced : null };
      } catch {
        return { reachable: false, synced: null };
      }
    },
    async batcher() {
      try {
        const r = await f(new URL('/health', opts.batcherUrl), { signal: withTimeout(t) });
        return { reachable: r.ok };
      } catch {
        return { reachable: false };
      }
    },
    async vaultGasWei() {
      if (!opts.sepoliaRpcUrl || !opts.vaultEvmAddress) return null;
      try {
        const r = await f(opts.sepoliaRpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_getBalance',
            params: [opts.vaultEvmAddress, 'latest'],
          }),
          signal: withTimeout(t),
        });
        const body = (await r.json()) as { result?: unknown };
        return typeof body.result === 'string' && /^0x[0-9a-fA-F]+$/.test(body.result) ? BigInt(body.result) : null;
      } catch {
        opts.log.warn('vault gas probe failed');
        return null;
      }
    },
  };
}

export interface HealthDeps {
  network: string;
  version: string;
  startedAt: number;
  sponsor: SponsorSession;
  dustLowSpecks: bigint;
  prover: ProofServerClient;
  keys: () => KeyCheck;
  queue: JobQueue;
  probes: ExternalProbes;
  vaultEvmAddress: string;
  vaultGasLowWei: bigint;
  cacheSeconds: number;
  now?: () => number;
}

export function healthCollector(deps: HealthDeps): () => Promise<HealthResponse> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  let cached: { at: number; external: Awaited<ReturnType<typeof probeAll>> } | null = null;
  const probeAll = async () => {
    const [proof, kernel, batcher, gas] = await Promise.all([
      deps.prover.probe(),
      deps.probes.kernel(),
      deps.probes.batcher(),
      deps.probes.vaultGasWei(),
    ]);
    return { proof, kernel, batcher, gas, keys: deps.keys() };
  };
  return async () => {
    if (!cached || now() - cached.at >= deps.cacheSeconds) cached = { at: now(), external: await probeAll() };
    const { proof, kernel, batcher, gas, keys } = cached.external;
    const sponsor = deps.sponsor.status();
    const dustLow = sponsor.dustSpecks === null ? sponsor.configured : sponsor.dustSpecks < deps.dustLowSpecks;
    const stats = deps.queue.stats();
    const gasLow = gas === null ? null : gas < deps.vaultGasLowWei;
    const keysOk = keys.present && keys.matchesPin !== false && keys.missingProverKeys.length === 0;
    const down = !proof.reachable || sponsor.state === 'error' || keys.matchesPin === false;
    const degraded =
      !sponsor.synced ||
      dustLow ||
      !kernel.reachable ||
      !batcher.reachable ||
      gasLow === true ||
      !keysOk ||
      proof.versionMatches === false;
    return {
      status: down ? 'down' : degraded ? 'degraded' : 'ok',
      network: deps.network,
      version: deps.version,
      uptimeSeconds: Math.max(0, now() - deps.startedAt),
      sponsor: {
        configured: sponsor.configured,
        state: sponsor.state,
        synced: sponsor.synced,
        dustSpecks: sponsor.dustSpecks === null ? null : sponsor.dustSpecks.toString(10),
        dustLow,
      },
      proofServer: {
        reachable: proof.reachable,
        version: proof.version,
        jobCapacity: proof.jobCapacity,
        keys: {
          present: keys.present,
          fingerprint: keys.fingerprint,
          pinned: keys.pinned,
          matchesPin: keys.matchesPin,
        },
      },
      queue: { jobs: stats.jobs, lanes: stats.lanes },
      kernel,
      batcher,
      vaultGas: { address: deps.vaultEvmAddress, balanceWei: gas === null ? null : gas.toString(10), low: gasLow },
    };
  };
}
