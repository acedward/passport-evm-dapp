import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HealthResponseSchema } from '@mnbank/core';
import { afterEach, describe, expect, it } from 'vitest';

import { healthCollector, httpProbes, type ExternalProbes } from '../src/health.js';
import { ProofServerClient } from '../src/prover/client.js';
import { cachedKeyCheck, checkKeyVolume, scanKeyTree, type KeyCheck } from '../src/prover/keys.js';
import { JobQueue } from '../src/queue/jobs.js';
import { DisabledSponsorSession } from '../src/sponsor/session.js';
import { FakeSponsor, silentLog } from './harness.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake fetch serving fixed JSON/text per path, counting calls. */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const key = init?.method === 'POST' ? `POST ${url.origin}${url.pathname}` : `${url.origin}${url.pathname}`;
    calls.push(key);
    const r = routes[key];
    if (!r) throw new TypeError('fetch failed');
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}

describe('proof server client', () => {
  it('reads the version, readiness and proof versions of rc.6', async () => {
    const { f } = fakeFetch({
      'http://prover:6300/version': { body: '9.0.0-rc.6' },
      'http://prover:6300/ready': { body: { status: 'ok', jobsProcessing: 0, jobsPending: 0, jobCapacity: 10 } },
      'http://prover:6300/proof-versions': { body: ['V2', 'V3'] },
    });
    const c = new ProofServerClient('http://prover:6300', '9.0.0-rc.6', f);
    expect(await c.proofVersions()).toEqual(['V2', 'V3']);
    expect(await c.probe()).toEqual({ reachable: true, version: '9.0.0-rc.6', jobCapacity: 10, versionMatches: true });
    expect((await new ProofServerClient('http://prover:6300', '9.0.0-rc.5', f).probe()).versionMatches).toBe(false);
    expect(await new ProofServerClient('http://down:6300', null, f).probe()).toEqual({
      reachable: false,
      version: null,
      jobCapacity: null,
      versionMatches: null,
    });
  });
});

describe('the key volume', () => {
  const makeTree = () => {
    const root = mkdtempSync(join(tmpdir(), 'mnbank-keys-'));
    dirs.push(root);
    for (const [contract, circuits] of Object.entries({
      account: ['activate_initial_device_with_evm', 'withdraw_shielded_with_evm'],
      Erc20Vault: ['startDeposit'],
    })) {
      mkdirSync(join(root, contract, 'keys'), { recursive: true });
      mkdirSync(join(root, contract, 'zkir'), { recursive: true });
      for (const c of circuits) {
        writeFileSync(join(root, contract, 'keys', `${c}.verifier`), `vk:${contract}/${c}`);
        writeFileSync(join(root, contract, 'zkir', `${c}.bzkir`), 'ir');
        if (c !== 'withdraw_shielded_with_evm') writeFileSync(join(root, contract, 'keys', `${c}.prover`), 'pk');
      }
    }
    return root;
  };

  it('fingerprints the verifier keys, independent of scan order, and changes when a key changes', () => {
    const root = makeTree();
    const a = scanKeyTree(root);
    expect(a.circuits).toHaveLength(3);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(scanKeyTree(root).fingerprint).toBe(a.fingerprint);
    writeFileSync(join(root, 'account', 'keys', 'activate_initial_device_with_evm.verifier'), 'other');
    expect(scanKeyTree(root).fingerprint).not.toBe(a.fingerprint);
  });

  it('checks the pin and the prover keys the relay needs', () => {
    const root = makeTree();
    const fp = scanKeyTree(root).fingerprint;
    expect(checkKeyVolume(root, fp, ['account/activate_initial_device_with_evm'])).toMatchObject({
      present: true,
      matchesPin: true,
      missingProverKeys: [],
    });
    expect(checkKeyVolume(root, '0'.repeat(64)).matchesPin).toBe(false);
    expect(checkKeyVolume(root, null, ['account/withdraw_shielded_with_evm']).missingProverKeys).toEqual([
      'account/withdraw_shielded_with_evm',
    ]);
    expect(checkKeyVolume(null, null)).toMatchObject({ present: false, matchesPin: null });
    expect(checkKeyVolume(join(root, 'nope'), fp)).toMatchObject({ present: false, matchesPin: false });
  });
});

describe('health (FR-013)', () => {
  const okProbes = (gas: bigint | null = 10n ** 18n): ExternalProbes => ({
    kernel: async () => ({ reachable: true, synced: true }),
    batcher: async () => ({ reachable: true }),
    vaultGasWei: async () => gas,
  });
  const prover = (up = true) =>
    new ProofServerClient(
      'http://prover:6300',
      '9.0.0-rc.6',
      fakeFetch(
        up
          ? {
              'http://prover:6300/version': { body: '9.0.0-rc.6' },
              'http://prover:6300/ready': {
                body: { status: 'ok', jobsProcessing: 0, jobsPending: 0, jobCapacity: 10 },
              },
            }
          : {},
      ).f,
    );
  const collector = (over: Partial<Parameters<typeof healthCollector>[0]> = {}) =>
    healthCollector({
      network: 'stagenet',
      version: 'v',
      startedAt: 0,
      sponsor: new FakeSponsor(),
      dustLowSpecks: 10n ** 16n,
      prover: prover(),
      keys: () => ({
        present: true,
        fingerprint: 'f'.repeat(64),
        pinned: true,
        matchesPin: true,
        missingProverKeys: [],
        missingVerifierKeys: [],
        missingZkir: [],
        mismatchedVerifierKeys: [],
      }),
      queue: new JobQueue({ ttlSeconds: 60, maxJobs: 10, log: silentLog() }),
      probes: okProbes(),
      vaultEvmAddress: '0x648216975e722494bFF92E88FFc68C8F8d438FaA',
      vaultGasLowWei: 2n * 10n ** 15n,
      cacheSeconds: 15,
      now: () => 100,
      ...over,
    });

  it('reports every FR-013 field and is ok when everything is', async () => {
    const h = await collector()();
    expect(HealthResponseSchema.parse(h)).toBeTruthy();
    expect(h.status).toBe('ok');
    expect(h.sponsor).toEqual({
      configured: true,
      state: 'synced',
      synced: true,
      dustSpecks: (10n ** 20n).toString(),
      dustLow: false,
    });
    expect(h.proofServer).toMatchObject({ reachable: true, version: '9.0.0-rc.6', jobCapacity: 10 });
    expect(h.queue.lanes).toHaveProperty('prover');
    expect(h.kernel).toEqual({ reachable: true, synced: true });
    expect(h.vaultGas).toEqual({
      address: '0x648216975e722494bFF92E88FFc68C8F8d438FaA',
      balanceWei: (10n ** 18n).toString(),
      low: false,
    });
  });

  it('degrades on low DUST, low vault gas, an unreachable kernel, or no sponsor', async () => {
    expect(
      (
        await collector({
          sponsor: new FakeSponsor({ configured: true, state: 'synced', synced: true, dustSpecks: 1n }),
        })()
      ).status,
    ).toBe('degraded');
    expect((await collector({ probes: okProbes(1n) })()).vaultGas.low).toBe(true);
    expect(
      (await collector({ probes: { ...okProbes(), kernel: async () => ({ reachable: false, synced: null }) } })())
        .status,
    ).toBe('degraded');
    const none = await collector({ sponsor: new DisabledSponsorSession() })();
    expect(none.status).toBe('degraded');
    expect(none.sponsor).toMatchObject({ configured: false, state: 'disabled', dustSpecks: null });
  });

  it('is down when the proof server is unreachable or the keys do not match the pin', async () => {
    expect((await collector({ prover: prover(false) })()).status).toBe('down');
    expect(
      (
        await collector({
          keys: () => ({
            present: true,
            fingerprint: 'a'.repeat(64),
            pinned: true,
            matchesPin: false,
            missingProverKeys: [],
            missingVerifierKeys: [],
            missingZkir: [],
            mismatchedVerifierKeys: [],
          }),
        })()
      ).status,
    ).toBe('down');
  });

  it('caches the external probes', async () => {
    let calls = 0;
    let now = 100;
    const c = collector({
      now: () => now,
      probes: { ...okProbes(), kernel: async () => (calls++, { reachable: true, synced: true }) },
    });
    await c();
    await c();
    expect(calls).toBe(1);
    now += 15;
    await c();
    expect(calls).toBe(2);
  });

  // Security review F-B1: a burst of /health requests must not multiply the probes.
  it('starts exactly ONE probe set for many simultaneous requests (single-flight)', async () => {
    let probeSets = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const c = collector({
      probes: {
        ...okProbes(),
        kernel: async () => {
          probeSets++;
          await gate;
          return { reachable: true, synced: true };
        },
      },
    });
    const burst = Array.from({ length: 50 }, () => c());
    await Promise.resolve();
    expect(probeSets).toBe(1);
    release();
    const all = await Promise.all(burst);
    expect(probeSets).toBe(1);
    expect(new Set(all.map((h) => h.status))).toEqual(new Set(['ok']));
  });

  it('serves the cached report while one refresh runs, and waits only when the cache is old', async () => {
    let now = 100;
    let probeSets = 0;
    let gasWei = 10n ** 18n;
    const gate: { release?: () => void } = {};
    const c = collector({
      now: () => now,
      probes: {
        ...okProbes(),
        vaultGasWei: async () => {
          probeSets++;
          if (probeSets > 1) await new Promise<void>((r) => (gate.release = r));
          return gasWei;
        },
      },
    });
    expect((await c()).vaultGas.balanceWei).toBe((10n ** 18n).toString());
    now += 20; // expired (15 s), but recent (under 60 s): served at once while ONE refresh runs
    gasWei = 5n;
    const during = await Promise.all(Array.from({ length: 20 }, () => c()));
    expect(probeSets).toBe(2);
    expect(during.every((h) => h.vaultGas.balanceWei === (10n ** 18n).toString())).toBe(true);
    gate.release!();
    await new Promise((r) => setTimeout(r, 0));
    expect((await c()).vaultGas.balanceWei).toBe('5');
    expect(probeSets).toBe(2);
    now += 600; // far past the stale bound: callers wait for the one shared refresh
    gasWei = 7n;
    const waiting = Promise.all([c(), c(), c()]);
    await new Promise((r) => setTimeout(r, 0));
    expect(probeSets).toBe(3);
    gate.release!();
    expect((await waiting).map((h) => h.vaultGas.balanceWei)).toEqual(['7', '7', '7']);
  });

  it('re-scans the key volume only on its own long interval, not per refresh', () => {
    let scans = 0;
    let now = 1000;
    const initial: KeyCheck = {
      present: true,
      fingerprint: 'f'.repeat(64),
      pinned: false,
      matchesPin: null,
      missingProverKeys: [],
      missingVerifierKeys: [],
      missingZkir: [],
      mismatchedVerifierKeys: [],
    };
    const keys = cachedKeyCheck(() => (scans++, initial), { initial, intervalSeconds: 3600, now: () => now });
    for (let i = 0; i < 100; i++) expect(keys()).toBe(initial);
    expect(scans).toBe(0);
    now += 3600;
    keys();
    keys();
    expect(scans).toBe(1);
  });

  it('probes the kernel, batcher and Sepolia over HTTP without leaking the RPC URL', async () => {
    const rpc = 'https://sepolia.example.test/v3/0123456789abcdef';
    const { f, calls } = fakeFetch({
      'http://kernel:9999/v1/health': { body: { status: 'ok', synced: true } },
      'http://batcher:3334/health': { body: { status: 'ok' } },
      [`POST https://sepolia.example.test/v3/0123456789abcdef`]: {
        body: { jsonrpc: '2.0', id: 1, result: '0xde0b6b3a7640000' },
      },
    });
    const log = silentLog();
    const p = httpProbes({
      kernelUrl: 'http://kernel:9999',
      batcherUrl: 'http://batcher:3334',
      vaultEvmAddress: '0x648216975e722494bFF92E88FFc68C8F8d438FaA',
      sepoliaRpcUrl: rpc,
      fetchImpl: f,
      log,
    });
    expect(await p.kernel()).toEqual({ reachable: true, synced: true });
    expect(await p.batcher()).toEqual({ reachable: true });
    expect(await p.vaultGasWei()).toBe(10n ** 18n);
    expect(calls).toHaveLength(3);
    const h = await collector({ probes: p })();
    expect(JSON.stringify(h)).not.toContain('sepolia.example.test');
    const down = httpProbes({
      kernelUrl: 'http://nokernel:1',
      batcherUrl: 'http://nobatcher:1',
      vaultEvmAddress: '0x0',
      sepoliaRpcUrl: 'https://nope.example.test/key123456',
      fetchImpl: f,
      log,
    });
    expect(await down.kernel()).toEqual({ reachable: false, synced: null });
    expect(await down.vaultGasWei()).toBeNull();
    expect(log.lines.join('\n')).not.toContain('key123456');
  });
});
