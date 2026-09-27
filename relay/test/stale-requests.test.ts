// Plan P4-A, Q21 default A: the relay closes bridge requests their owners left open, with the fake
// MPC and chain of ./bridge-fake.ts. What it may do (a withdrawal: the relayer loop and the settle
// pinned to the account in the vault's settle view; a deposit attested never-executed: the vault's
// abandonDeposit), what it must never touch (wallet recipients, other contracts, requests a job is
// driving, deposits that are their owner's to finish), the sponsor's cap, and what the page and
// /health learn.

import { describe, expect, it } from 'vitest';
import {
  BridgeClosedResponseSchema,
  DEFAULT_EVM_GAS,
  HealthResponseSchema,
  evmTxParamsJson,
  registryFromConfig,
  type JobView,
} from '@mnbank/core';

import { BridgeService, type VerifiedStart } from '../src/bridge/service.js';
import { StaleRequestCloser, bankAccountChecker, type StaleCloserConfig } from '../src/bridge/stale.js';
import { healthCollector } from '../src/health.js';
import { ProofServerClient } from '../src/prover/client.js';
import { JobQueue } from '../src/queue/jobs.js';
import type { SponsorStatus } from '../src/sponsor/session.js';
import { FakeBridge, Gate, STKA, VAULT, VAULT_EVM } from './bridge-fake.js';
import { FakeSponsor, harness, silentLog } from './harness.js';

const ACC1 = '1a'.repeat(32);
const ACC2 = '2b'.repeat(32);
const STRANGER = '3c'.repeat(32); // a contract that is not an MN Bank account
const ONE = 1_000_000n;
const GAS_COST = DEFAULT_EVM_GAS.gasLimit * DEFAULT_EVM_GAS.maxFeePerGas;
const MIN = 60_000;

const tokens = registryFromConfig('undeployed', {
  tokens: [
    {
      symbol: 'USDC',
      midnightName: 'wUSDC',
      role: 'usdc',
      decimals: 6,
      midnightColour: 'c1'.repeat(32),
      sepoliaAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      vault: VAULT,
    },
    {
      symbol: 'stkA',
      midnightName: 'wStkA',
      role: 'stock',
      decimals: 6,
      midnightColour: 'a1'.repeat(32),
      sepoliaAddress: STKA,
      vault: VAULT,
    },
  ],
});

const AUTH = {
  arm: 'evm' as const,
  pk: { x: 1n, y: 2n, identity: false as const },
  use_counter: 0n,
  sig: { r: 1n, s: 2n },
};

/** A sponsor whose DUST the test sets. */
class TestSponsor extends FakeSponsor {
  constructor(dust: bigint) {
    super({ configured: true, state: 'synced', synced: true, dustSpecks: dust });
  }
}

function setup(over: Partial<StaleCloserConfig> = {}, sponsorDust = 10n ** 20n) {
  let now = 1_700_000_000_000;
  const clock = () => now;
  const fake = new FakeBridge();
  fake.setEth(VAULT_EVM, GAS_COST * 4n);
  fake.setErc20(STKA, VAULT_EVM, 10n * ONE);
  const log = silentLog();
  const queue = new JobQueue({ ttlSeconds: 600, maxJobs: 100, log, now: () => Math.floor(now / 1000) });
  const verify = async <P>(raw: unknown): Promise<VerifiedStart<P>> => {
    const { account, digest, ...payload } = raw as Record<string, unknown>;
    return { account: String(account), payload: payload as P, auth: AUTH, digestHex: String(digest ?? '0xd') };
  };
  const svc = new BridgeService({
    backend: () => fake,
    laneLoad: (lane, account) => queue.laneLoad(lane, account),
    gas: DEFAULT_EVM_GAS,
    tokens,
    vaultAddress: VAULT,
    verifyStart: { deposit: verify, withdraw: verify },
    releaseDigest: () => undefined,
    log,
    now: clock,
  });
  const sponsor = new TestSponsor(sponsorDust);
  const bankAccounts = new Set([ACC1, ACC2]);
  const config: StaleCloserConfig = {
    enabled: true,
    intervalMs: 5 * MIN,
    staleAfterMs: 15 * MIN,
    maxPerDay: 24,
    minSponsorDustSpecks: 20n * 10n ** 15n,
    retryAfterMs: 30 * MIN,
    ...over,
  };
  const closer = new StaleRequestCloser({
    config,
    service: svc,
    backend: () => fake,
    submit: (sub) => queue.submit(sub),
    settled: (id) => queue.settled(id),
    sponsor: () => sponsor.status() as SponsorStatus,
    isBankAccount: async (a) => bankAccounts.has(a),
    log,
    now: clock,
  });
  const resume = (account: string, kind: 'deposit' | 'withdraw', requestId: string) =>
    queue.submit({
      action: 'bridge-resume',
      lane: 'deposit',
      account,
      executor: svc.resumeExecutor,
      payload: { account, kind, requestId, startedAtMs: String(now) },
    })!;
  const withdraw = (account: string, nonce = 0n) =>
    queue.submit({
      action: 'bridge-withdraw',
      lane: 'withdrawal',
      executor: svc.withdrawExecutor,
      payload: {
        account,
        dest: '0x484738A67858305Edfc139B194Ed430Fe4D8e56b',
        color: 'a1'.repeat(32),
        erc20: STKA,
        amount: ONE.toString(),
        coin: { nonce: '0e'.repeat(32), color: 'a1'.repeat(32), value: ONE.toString(), mtIndex: '4779' },
        evm: evmTxParamsJson(DEFAULT_EVM_GAS, nonce),
        authNonce: '1',
      },
    })!;
  const deposit = (account: string) =>
    queue.submit({
      action: 'bridge-deposit',
      lane: 'deposit',
      account,
      executor: svc.depositExecutor,
      payload: {
        account,
        digest: `0xdep${account.slice(0, 4)}${fake.calls.length}`,
        erc20: STKA,
        amount: ONE.toString(),
        evm: evmTxParamsJson(DEFAULT_EVM_GAS, 0n),
        authNonce: '0',
      },
    })!;
  const fundDeposit = (account: string) => {
    fake.setErc20(STKA, fake.depositAddress(account), ONE);
    fake.setEth(fake.depositAddress(account), GAS_COST);
  };
  /** Every job the closer queued, in order. */
  const closeJobs = () => allJobs().filter((j) => j.action === 'bridge-close');
  const seen: string[] = [];
  const origSubmit = queue.submit.bind(queue);
  queue.submit = (sub) => {
    const v = origSubmit(sub);
    if (v) seen.push(v.requestId);
    return v;
  };
  const allJobs = () => seen.map((id) => queue.get(id)).filter((j): j is JobView => !!j);
  const advance = (ms: number) => {
    now += ms;
  };
  /** Scan, then wait for every job the scan queued. */
  const scanAndSettle = async () => {
    const before = seen.length;
    await closer.scan();
    for (const id of seen.slice(before)) await queue.settled(id);
  };
  return {
    fake,
    queue,
    svc,
    closer,
    sponsor,
    bankAccounts,
    resume,
    withdraw,
    deposit,
    fundDeposit,
    closeJobs,
    advance,
    scanAndSettle,
    clock,
  };
}

const stages = (j: JobView | undefined) => j?.stages.map((s) => s.stage) ?? [];

describe('a never-executed deposit (the owner’s own job)', () => {
  it('is closed with the vault’s abandonDeposit at once, nothing minted, and the account can deposit again', async () => {
    const t = setup();
    t.fundDeposit(ACC1);
    t.fake.mpc = 'never-executed';
    const done = await t.queue.settled(t.deposit(ACC1).requestId);
    expect(done?.state).toBe('succeeded');
    expect(stages(done)).toEqual(expect.arrayContaining(['attested', 'abandoning', 'abandoned']));
    expect(done?.result).toMatchObject({
      kind: 'deposit',
      attested: 'never-executed',
      settleCircuit: 'abandonDeposit',
      coin: null,
      closedBy: 'owner',
    });
    expect(t.fake.calls.filter((c) => c.startsWith('settle:'))).toEqual([]);
    expect(t.fake.open.deposit.size).toBe(0);

    // Not blocked: the next deposit of the same account runs.
    t.fake.mpc = 'success';
    const again = await t.queue.settled(t.deposit(ACC1).requestId);
    expect(again?.state).toBe('succeeded');
    expect(again?.result).toMatchObject({ settleCircuit: 'bridge_deposit_complete' });
  });
});

describe('the stale-request closer (Q21 A)', () => {
  it('closes an account’s withdrawal left open: the relayer loop, then the settle pinned to the account', async () => {
    const t = setup();
    const id = t.fake.addOpen('withdraw', ACC2, STKA, ONE);

    // At start-up it only notes the request: its owner may still resume it.
    await t.scanAndSettle();
    expect(t.closeJobs()).toEqual([]);
    expect(t.closer.status()).toMatchObject({ open: { withdraw: 1, deposit: 0 }, waiting: 0, closed24h: 0 });

    // While it is open, every customer's withdrawal is refused (the Q21 problem).
    const blocked = await t.queue.settled(t.withdraw(ACC1).requestId);
    expect(blocked?.error?.code).toBe('request-still-open');

    t.advance(15 * 60_000);
    expect(t.closer.status().waiting).toBe(1);
    await t.scanAndSettle();
    const [job] = t.closeJobs();
    expect(job?.lane).toBe('withdrawal');
    expect(job?.state).toBe('succeeded');
    expect(stages(job)).toEqual(expect.arrayContaining(['resumed', 'mpc-signed', 'attested', 'settling', 'settled']));
    expect(t.fake.calls).toContain(`relay:withdraw:${id.slice(-2)}`);
    expect(t.fake.calls).toContain(`settle:bridge_withdraw_complete:${id.slice(-2)}`);
    expect(t.fake.open.withdraw.size).toBe(0);
    expect(t.closer.status()).toMatchObject({
      closed24h: 1,
      recent: [
        { kind: 'withdraw', requestId: id, circuit: 'bridge_withdraw_complete', tx: `tx-settle-${id.slice(-2)}` },
      ],
    });

    // Unblocked: the next customer's withdrawal runs.
    const next = await t.queue.settled(t.withdraw(ACC1, 1n).requestId);
    expect(next?.state).toBe('succeeded');
  });

  it('refunds a never-executed withdrawal to the account the settle view names', async () => {
    const t = setup({ staleAfterMs: 0 });
    const id = t.fake.addOpen('withdraw', ACC2, STKA, ONE);
    t.fake.mpc = 'never-executed';
    await t.scanAndSettle();
    const outcome = t.svc.closedOutcome(id);
    expect(outcome).toMatchObject({
      kind: 'withdraw',
      closedBy: 'relay',
      attested: 'never-executed',
      settleCircuit: 'bridge_withdraw_refund',
      minted: true,
    });
    // The owner's page learns it: a resume returns the whole outcome, coin included.
    const r = await t.queue.settled(t.resume(ACC2, 'withdraw', id).requestId);
    expect(r?.state).toBe('succeeded');
    expect(stages(r)).toContain('already-closed');
    expect(r?.result).toMatchObject({ closedBy: 'relay', coin: { value: ONE.toString() }, account: ACC2 });
    // Nobody else's resume gets it.
    const other = await t.queue.settled(t.resume(ACC1, 'withdraw', id).requestId);
    expect(other?.error?.code).toBe('request-not-open');
  });

  it('abandons a deposit attested never-executed, and leaves every other deposit to its owner', async () => {
    const t = setup({ staleAfterMs: 0 });
    const neverRan = t.fake.addOpen('deposit', ACC1, STKA, ONE);
    const succeeded = t.fake.addOpen('deposit', ACC2, STKA, ONE);
    t.fake.attested.set(neverRan, 'never-executed');
    t.fake.attested.set(succeeded, 'success');
    await t.scanAndSettle(); // one close at a time
    await t.scanAndSettle();
    await t.scanAndSettle();
    expect(t.fake.calls.filter((c) => c.startsWith('abandonDeposit'))).toEqual([
      `abandonDeposit:${neverRan.slice(-2)}`,
    ]);
    // No loop was run for a deposit: nothing broadcast, no settle, no mint.
    expect(t.fake.calls.filter((c) => c.startsWith('relay:') || c.startsWith('settle:'))).toEqual([]);
    expect(t.fake.open.deposit.has(neverRan)).toBe(false);
    expect(t.fake.open.deposit.has(succeeded)).toBe(true);
    const deposits = t.closeJobs();
    expect(deposits.map((j) => j.lane)).toEqual(['deposit', 'deposit']);
    expect(deposits.map((j) => (j.result as { outcome: string }).outcome).sort()).toEqual(['closed', 'skipped']);
    expect(t.closer.status().closed24h).toBe(1);
  });

  it('never touches a wallet recipient, another contract, or a request a job is driving', async () => {
    const t = setup({ staleAfterMs: 0 });
    t.fake.addOpen('withdraw', null, STKA, ONE); // a wallet's
    t.fake.addOpen('withdraw', STRANGER, STKA, ONE); // not an MN Bank account
    const wallet = t.fake.addOpen('deposit', null, STKA, ONE);
    t.fake.attested.set(wallet, 'never-executed');
    await t.scanAndSettle();
    await t.scanAndSettle();
    expect(t.closeJobs()).toEqual([]);
    expect(t.fake.calls.filter((c) => !c.startsWith('attestation'))).toEqual([]);

    // A live withdrawal job of this relay: not stale, whatever its age.
    const t2 = setup({ staleAfterMs: 0 });
    t2.fake.gate = new Gate();
    const live = t2.withdraw(ACC1);
    for (let i = 0; i < 200 && !stages(t2.queue.get(live.requestId)).includes('mpc-signed'); i++)
      await new Promise((r) => setTimeout(r, 5));
    await t2.closer.scan();
    expect(t2.closeJobs()).toEqual([]);
    t2.fake.gate.release();
    expect((await t2.queue.settled(live.requestId))?.state).toBe('succeeded');
  });

  it('a customer who resumes while the bank is closing it joins that run and gets its outcome', async () => {
    const t = setup({ staleAfterMs: 0 });
    const id = t.fake.addOpen('withdraw', ACC2, STKA, ONE);
    t.fake.gate = new Gate();
    await t.closer.scan();
    const [close] = t.closeJobs();
    for (let i = 0; i < 200 && !stages(t.queue.get(close!.requestId)).includes('mpc-signed'); i++)
      await new Promise((r) => setTimeout(r, 5));
    const mine = t.resume(ACC2, 'withdraw', id);
    for (let i = 0; i < 200 && !stages(t.queue.get(mine.requestId)).includes('joined'); i++)
      await new Promise((r) => setTimeout(r, 5));
    t.fake.gate.release();
    const done = await t.queue.settled(mine.requestId);
    expect(done?.state).toBe('succeeded');
    expect(done?.result).toMatchObject({ requestId: id, closedBy: 'relay', settleCircuit: 'bridge_withdraw_complete' });
    expect(t.fake.calls.filter((c) => c.startsWith('settle:'))).toHaveLength(1); // one settle, not two
  });

  it('caps what the sponsor pays: a daily number of closes, and never below its reserve', async () => {
    const t = setup({ staleAfterMs: 0, maxPerDay: 1 });
    t.fake.addOpen('withdraw', ACC1, STKA, ONE);
    t.fake.addOpen('withdraw', ACC2, STKA, ONE);
    await t.scanAndSettle();
    await t.scanAndSettle();
    expect(t.fake.calls.filter((c) => c.startsWith('settle:'))).toHaveLength(1);
    expect(t.closer.status()).toMatchObject({ closed24h: 1, maxPerDay: 1 });
    expect(t.closer.status().paused).toMatch(/daily cap of 1/);
    expect(t.fake.open.withdraw.size).toBe(1);
    // A day later the cap has room again.
    t.advance(24 * 3_600_000 + 1);
    await t.scanAndSettle();
    expect(t.fake.open.withdraw.size).toBe(0);

    const low = setup({ staleAfterMs: 0 }, 5n * 10n ** 15n); // below the 20 DUST reserve
    low.fake.addOpen('withdraw', ACC1, STKA, ONE);
    await low.scanAndSettle();
    expect(low.closeJobs()).toEqual([]);
    expect(low.closer.status().paused).toMatch(/below the closer's reserve/);
  });

  it('the cap is checked when the sponsor is about to pay, so a close that got too late spends nothing', async () => {
    const t = setup({ staleAfterMs: 0 });
    t.fake.addOpen('withdraw', ACC1, STKA, ONE);
    t.fake.gate = new Gate();
    await t.closer.scan();
    const [job] = t.closeJobs();
    for (let i = 0; i < 200 && !stages(t.queue.get(job!.requestId)).includes('mpc-signed'); i++)
      await new Promise((r) => setTimeout(r, 5));
    t.sponsor.current = { ...t.sponsor.current, dustSpecks: 1n }; // the sponsor ran low meanwhile
    t.fake.gate.release();
    const done = await t.queue.settled(job!.requestId);
    expect(done?.error?.code).toBe('close-budget');
    expect(t.fake.calls.filter((c) => c.startsWith('settle:'))).toEqual([]);
    expect(t.fake.open.withdraw.size).toBe(1);
    // It backs off before trying that request again.
    t.sponsor.current = { ...t.sponsor.current, dustSpecks: 10n ** 20n };
    await t.scanAndSettle();
    expect(t.closeJobs()).toHaveLength(1);
    t.advance(30 * 60_000);
    t.fake.gate = null;
    await t.scanAndSettle();
    expect(t.fake.open.withdraw.size).toBe(0);
  });

  it('can be switched off', async () => {
    const t = setup({ staleAfterMs: 0, enabled: false });
    t.fake.addOpen('withdraw', ACC1, STKA, ONE);
    await t.scanAndSettle();
    expect(t.closeJobs()).toEqual([]);
    expect(t.closer.status().enabled).toBe(false);
  });

  it('knows an MN Bank account by its ledger: booted and sealed to this vault', async () => {
    const vault = { bytes: Uint8Array.from(Buffer.from(VAULT, 'hex')) };
    const other = { bytes: new Uint8Array(32) };
    const ledgers: Record<string, { booted: boolean; vault_address: { bytes: Uint8Array } } | null> = {
      [ACC1]: { booted: true, vault_address: vault },
      [ACC2]: { booted: false, vault_address: vault },
      [STRANGER]: { booted: true, vault_address: other },
    };
    const is = bankAccountChecker(async (a) => ledgers[a] ?? null, VAULT);
    expect(await is(ACC1)).toBe(true);
    expect(await is(ACC2)).toBe(false);
    expect(await is(STRANGER)).toBe(false);
    expect(await is('44'.repeat(32))).toBe(false);
  });
});

describe('what the page and /health learn', () => {
  it('GET /v1/bridge/closed/:requestId shows how a closed request ended, with public facts only', async () => {
    const t = setup({ staleAfterMs: 0 });
    const id = t.fake.addOpen('withdraw', ACC2, STKA, ONE);
    t.fake.mpc = 'never-executed';
    await t.scanAndSettle();
    const h = harness({
      bridge: { available: () => true, quote: async () => ({}) as never, closedOutcome: (r) => t.svc.closedOutcome(r) },
    });
    const res = await h.app.request(`/v1/bridge/closed/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(BridgeClosedResponseSchema.strict().parse(body)).toMatchObject({
      requestId: id,
      closedBy: 'relay',
      minted: true,
    });
    // No coin (its nonce), no account: only what the chain shows anyway.
    expect(JSON.stringify(body)).not.toContain('ee'.repeat(32));
    expect(JSON.stringify(body)).not.toContain(ACC2);
    expect((await h.app.request(`/v1/bridge/closed/${'ab'.repeat(32)}`)).status).toBe(404);
    expect((await h.app.request('/v1/bridge/closed/nope')).status).toBe(400);
  });

  it('/health reports the MPC, the closer and its budget, and the batcher’s last refusal', async () => {
    const t = setup({ staleAfterMs: 0 });
    t.fake.addOpen('withdraw', ACC2, STKA, ONE);
    await t.scanAndSettle();
    const health = healthCollector({
      network: 'stagenet',
      version: 'v',
      startedAt: 0,
      sponsor: new FakeSponsor(),
      dustLowSpecks: 10n ** 16n,
      prover: new ProofServerClient('http://prover:6300', null, (async () => {
        throw new TypeError('down');
      }) as unknown as typeof fetch),
      keys: () => ({
        present: true,
        fingerprint: 'f'.repeat(64),
        pinned: false,
        matchesPin: null,
        missingProverKeys: [],
        missingVerifierKeys: [],
        missingZkir: [],
        mismatchedVerifierKeys: [],
      }),
      queue: t.queue,
      probes: {
        kernel: async () => ({ reachable: true, synced: true }),
        batcher: async () => ({ reachable: true }),
        vaultGasWei: async () => 10n ** 18n,
      },
      vaultEvmAddress: VAULT_EVM,
      vaultGasLowWei: 1n,
      cacheSeconds: 0,
      bridge: () => ({ available: true, mpc: t.svc.mpcStatus(), staleRequests: t.closer.status() }),
      batcherRefusal: () => ({ httpStatus: 429, at: 5 }),
    });
    const h = HealthResponseSchema.parse(await health());
    expect(h.bridge?.mpc).toEqual({ lastSignatureAfterSeconds: 110, timeouts24h: 0, inFlight: 0 });
    expect(h.bridge?.staleRequests).toMatchObject({ enabled: true, closed24h: 1, maxPerDay: 24, paused: null });
    expect(h.bridge?.staleRequests.recent[0]).toMatchObject({ kind: 'withdraw', circuit: 'bridge_withdraw_complete' });
    expect(h.batcher).toEqual({ reachable: true, lastRefusal: { httpStatus: 429, at: 5 } });
    expect(h.proofServer.keys).toMatchObject({ complete: true, problems: 0 });
  });

  it('counts MPC timeouts over the last day', async () => {
    const t = setup();
    t.fundDeposit(ACC1);
    t.fake.mpc = 'timeout';
    await t.queue.settled(t.deposit(ACC1).requestId);
    expect(t.svc.mpcStatus().timeouts24h).toBe(1);
    t.advance(24 * 3_600_000 + 1);
    expect(t.svc.mpcStatus().timeouts24h).toBe(0);
  });
});
