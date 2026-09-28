// Plan L-BRG testing, the relay half, with a fake chain and a fake MPC (./bridge-fake.ts): the
// stage machine, the preflight refusals before any Midnight transaction, the per-account deposit
// lane, the global withdrawal lane, the nonce the customer signs, resume by request id, and the
// refund paths.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EVM_GAS,
  evmTxParamsJson,
  registryFromConfig,
  type BridgeDepositPayload,
  type BridgeWithdrawPayload,
  type JobView,
} from '@mnbank/core';

import { BridgeService, type VerifiedStart } from '../src/bridge/service.js';
import { JobQueue } from '../src/queue/jobs.js';
import { COLOUR_A, COLOUR_B, FakeBridge, Gate, STKA, STKB, VAULT, VAULT_EVM } from './bridge-fake.js';
import { silentLog, testEntitlements } from './harness.js';

const ACC1 = '1a'.repeat(32);
const ACC2 = '2b'.repeat(32);
const ONE = 1_000_000n; // 1 token at 6 decimals
const GAS_COST = DEFAULT_EVM_GAS.gasLimit * DEFAULT_EVM_GAS.maxFeePerGas;

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
      midnightColour: COLOUR_A,
      sepoliaAddress: STKA,
      vault: VAULT,
    },
    {
      symbol: 'stkB',
      midnightName: 'wStkB',
      role: 'stock',
      decimals: 6,
      midnightColour: COLOUR_B,
      sepoliaAddress: STKB,
      vault: VAULT,
    },
    {
      symbol: 'tOther',
      midnightName: 'other',
      role: 'stock',
      decimals: 6,
      midnightColour: 'd1'.repeat(32),
      sepoliaAddress: '0x000000000000000000000000000000000000dEaD',
    },
  ],
});

const AUTH = {
  arm: 'evm' as const,
  pk: { x: 1n, y: 2n, identity: false as const },
  use_counter: 0n,
  sig: { r: 1n, s: 2n },
};

function setup() {
  const fake = new FakeBridge();
  const log = silentLog();
  const queue = new JobQueue({ ttlSeconds: 600, maxJobs: 100, log });
  const released: string[] = [];
  const entitlements = testEntitlements();
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
    releaseDigest: (d) => released.push(d),
    issueEntitlement: (account, source) => entitlements.issue(account, source),
    log,
  });
  const deposit = (account: string, p: Partial<BridgeDepositPayload> = {}, digest = `0xdep${account.slice(0, 4)}`) =>
    queue.submit({
      action: 'bridge-deposit',
      lane: 'deposit',
      account,
      executor: svc.depositExecutor,
      payload: {
        account,
        digest,
        erc20: STKA,
        amount: ONE.toString(),
        evm: evmTxParamsJson(DEFAULT_EVM_GAS, 0n),
        authNonce: '0',
        ...p,
      },
    })!;
  const withdraw = (account: string, p: Partial<BridgeWithdrawPayload> = {}) =>
    queue.submit({
      action: 'bridge-withdraw',
      lane: 'withdrawal',
      executor: svc.withdrawExecutor,
      payload: {
        account,
        dest: '0x484738A67858305Edfc139B194Ed430Fe4D8e56b',
        color: COLOUR_A,
        erc20: STKA,
        amount: ONE.toString(),
        coin: { nonce: '0e'.repeat(32), color: COLOUR_A, value: ONE.toString(), mtIndex: '4779' },
        evm: evmTxParamsJson(DEFAULT_EVM_GAS, 0n),
        authNonce: '1',
        ...p,
      },
    })!;
  const resume = (account: string, kind: 'deposit' | 'withdraw', requestId: string) =>
    queue.submit({
      action: 'bridge-resume',
      lane: 'deposit',
      account,
      executor: svc.resumeExecutor,
      payload: { account, kind, requestId, startedAtMs: '1700000000000' },
    })!;
  const fundDeposit = (account: string, token = STKA, amount = ONE, eth = GAS_COST) => {
    fake.setErc20(token, fake.depositAddress(account), amount);
    fake.setEth(fake.depositAddress(account), eth);
  };
  const fundVault = (eth = GAS_COST * 2n, amount = 10n * ONE) => {
    fake.setEth(VAULT_EVM, eth);
    fake.setErc20(STKA, VAULT_EVM, amount);
  };
  return { fake, queue, svc, released, deposit, withdraw, resume, fundDeposit, fundVault, entitlements };
}

const stages = (j: JobView | undefined) => j?.stages.map((s) => s.stage) ?? [];
const detail = (j: JobView | undefined, stage: string) => j?.stages.find((s) => s.stage === stage)?.detail ?? {};

async function waitForStage(queue: JobQueue, id: string, stage: string) {
  for (let i = 0; i < 200; i++) {
    if (stages(queue.get(id)).includes(stage)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`job ${id} never reached ${stage}: ${stages(queue.get(id)).join(' > ')}`);
}

describe('bridge deposit', () => {
  it('runs start → MPC → sweep → finality → attestation → settle, recording every hash', async () => {
    const t = setup();
    t.fundDeposit(ACC1);
    const job = t.deposit(ACC1);
    const done = await t.queue.settled(job.requestId);
    expect(done?.state).toBe('succeeded');
    expect(stages(done)).toEqual([
      'queued',
      'running',
      'preflight',
      'waiting-for-prover',
      'proving',
      'starting',
      'started',
      'mpc-signed',
      'evm-broadcast',
      'evm-final',
      'attested',
      'waiting-for-prover',
      'proving',
      'settling',
      'settled',
      'succeeded',
    ]);
    const started = detail(done, 'started');
    expect(started.requestId).toMatch(/^[0-9a-f]{64}$/);
    expect(started.tx).toBe('tx-start-1');
    expect(started.txHash).toBe('hash-tx-start-1');
    expect(detail(done, 'mpc-signed').signedTx).toMatch(/^0xsigned/);
    expect(detail(done, 'evm-broadcast').evmTx).toMatch(/^0xevm/);
    expect(detail(done, 'attested').kind).toBe('success');
    expect(detail(done, 'settled').circuit).toBe('bridge_deposit_complete');
    expect(done?.result).toMatchObject({
      kind: 'deposit',
      account: ACC1,
      requestId: started.requestId,
      attested: 'success',
      settleCircuit: 'bridge_deposit_complete',
      coin: { color: COLOUR_A, value: ONE.toString() },
      change: null,
    });
    expect(t.fake.calls).toEqual([`startDeposit:1a1a:0`, `relay:deposit:01`, `settle:bridge_deposit_complete:01`]);
    expect(t.released).toEqual([]);
  });

  it('refuses a start without the sweep gas BEFORE any Midnight transaction, naming the shortfall', async () => {
    const t = setup();
    t.fundDeposit(ACC1, STKA, ONE, 0n);
    const done = await t.queue.settled(t.deposit(ACC1).requestId);
    expect(done?.state).toBe('failed');
    expect(done?.error?.code).toBe('preflight-refused');
    expect(done?.error?.message).toMatch(/holds 0 wei but the sweep may cost up to 1000000000000000 wei/);
    expect(t.fake.calls).toEqual([]);
    expect(t.released).toEqual(['0xdep1a1a']);
  });

  it('refuses the wrong token (stkB asked, only stkA at the address) before any Midnight transaction', async () => {
    const t = setup();
    t.fundDeposit(ACC1, STKA);
    const done = await t.queue.settled(t.deposit(ACC1, { erc20: STKB }).requestId);
    expect(done?.error?.code).toBe('preflight-refused');
    expect(done?.error?.message).toMatch(/holds 0 of the ERC20 but the sweep moves 1/);
    expect(t.fake.calls).toEqual([]);
  });

  it('refuses a token this vault does not bridge, and gas fields other than the policy', async () => {
    const t = setup();
    t.fundDeposit(ACC1);
    const unknown = await t.queue.settled(
      t.deposit(ACC1, { erc20: '0x000000000000000000000000000000000000dEaD' }).requestId,
    );
    expect(unknown?.error?.code).toBe('unknown-token');
    const greedy = await t.queue.settled(
      t.deposit(ACC1, { evm: { ...evmTxParamsJson(DEFAULT_EVM_GAS, 0n), maxFeePerGas: '999000000000' } }).requestId,
    );
    expect(greedy?.error?.code).toBe('gas-policy');
    expect(t.fake.calls).toEqual([]);
  });

  it('refuses a signed nonce that is no longer the deposit address nonce (sign again)', async () => {
    const t = setup();
    t.fundDeposit(ACC1);
    t.fake.setNonce(t.fake.depositAddress(ACC1), 3n);
    const done = await t.queue.settled(t.deposit(ACC1).requestId);
    expect(done?.error?.code).toBe('stale-evm-nonce');
    expect(done?.error?.message).toMatch(/now 3, not the 0 you signed/);
    expect(t.fake.calls).toEqual([]);
  });

  it('refuses a new deposit while an earlier one of the account is still open in the vault (resume it first)', async () => {
    const t = setup();
    t.fundDeposit(ACC1);
    t.fake.addOpen('deposit', ACC1, STKA, ONE);
    const done = await t.queue.settled(t.deposit(ACC1).requestId);
    expect(done?.error?.code).toBe('request-still-open');
    expect(t.fake.calls).toEqual([]);
  });

  it('a second deposit of the same account queues behind the first; another account runs alongside', async () => {
    const t = setup();
    t.fundDeposit(ACC1, STKA, 2n * ONE, 2n * GAS_COST);
    t.fundDeposit(ACC2);
    t.fake.gate = new Gate();
    const first = t.deposit(ACC1);
    await waitForStage(t.queue, first.requestId, 'mpc-signed');

    // The quote reserves the next nonce while the first sweep is not yet on Sepolia.
    const q1 = await t.svc.quote('deposit', ACC1, STKA);
    expect(q1.evm.nonce).toBe('1');
    expect(q1.lane).toEqual({ running: 1, waiting: 0 });
    expect(q1.payer).toBe(t.fake.depositAddress(ACC1));

    const second = t.deposit(ACC1, { evm: q1.evm }, '0xdep-second');
    expect(t.queue.get(second.requestId)?.state).toBe('queued');
    expect(t.queue.get(second.requestId)?.position).toBe(1);
    const q2 = await t.svc.quote('deposit', ACC1, STKA);
    expect(q2.evm.nonce).toBe('2'); // one more request is waiting in the lane

    const other = t.deposit(ACC2);
    await waitForStage(t.queue, other.requestId, 'mpc-signed'); // not blocked by ACC1's lane
    expect(t.queue.get(second.requestId)?.state).toBe('queued');

    t.fake.gate.release();
    const [a, b, c] = await Promise.all([
      t.queue.settled(first.requestId),
      t.queue.settled(second.requestId),
      t.queue.settled(other.requestId),
    ]);
    expect([a?.state, b?.state, c?.state]).toEqual(['succeeded', 'succeeded', 'succeeded']);
    // ACC1's second start ran only after its first had settled.
    const calls = t.fake.calls;
    expect(calls.indexOf('startDeposit:1a1a:1')).toBeGreaterThan(calls.indexOf('settle:bridge_deposit_complete:01'));
    expect(calls.indexOf('startDeposit:2b2b:0')).toBeLessThan(calls.indexOf('settle:bridge_deposit_complete:01'));
  });

  it('a start whose vault diff is ambiguous stops with a request-match error (never "the newest id")', async () => {
    const t = setup();
    t.fundDeposit(ACC1);
    t.fake.extraOnStart = [{ kind: 'deposit', path: (a) => t.fake.depositPathHex(a) }];
    const done = await t.queue.settled(t.deposit(ACC1).requestId);
    expect(done?.error?.code).toBe('request-match');
  });

  it('a deposit whose ERC20 transfer returned false closes with nothing minted', async () => {
    const t = setup();
    t.fundDeposit(ACC1);
    t.fake.mpc = 'returned-false';
    const done = await t.queue.settled(t.deposit(ACC1).requestId);
    expect(done?.state).toBe('succeeded');
    expect(done?.result).toMatchObject({
      attested: 'returned-false',
      coin: null,
      settleCircuit: 'bridge_deposit_complete',
    });
  });

  it('an MPC that never signs fails with the stop-rule code, and the request stays resumable', async () => {
    const t = setup();
    t.fundDeposit(ACC1);
    t.fake.mpc = 'timeout';
    const done = await t.queue.settled(t.deposit(ACC1).requestId);
    expect(done?.error?.code).toBe('mpc-timeout');
    const requestId = detail(done, 'started').requestId!;
    expect(t.fake.open.deposit.has(requestId)).toBe(true);

    t.fake.mpc = 'success';
    const resumed = await t.queue.settled(t.resume(ACC1, 'deposit', requestId).requestId);
    expect(resumed?.state).toBe('succeeded');
    expect(stages(resumed)).toContain('resumed');
    expect(resumed?.result).toMatchObject({ requestId, coin: { value: ONE.toString() } });
  });
});

describe('bridge resume by request id (after a relay restart)', () => {
  it('picks up an open request of the account and settles it', async () => {
    const t = setup();
    const requestId = t.fake.addOpen('deposit', ACC1, STKA, ONE);
    const done = await t.queue.settled(t.resume(ACC1, 'deposit', requestId).requestId);
    expect(done?.state).toBe('succeeded');
    expect(stages(done)).toEqual([
      'queued',
      'running',
      'resumed',
      'mpc-signed',
      'evm-broadcast',
      'evm-final',
      'attested',
      'waiting-for-prover',
      'proving',
      'settling',
      'settled',
      'succeeded',
    ]);
    expect(t.fake.calls).toEqual([`relay:deposit:01`, `settle:bridge_deposit_complete:01`]);
  });

  it("refuses another account's request and a request that is no longer open", async () => {
    const t = setup();
    const theirs = t.fake.addOpen('deposit', ACC2, STKA, ONE);
    const other = await t.queue.settled(t.resume(ACC1, 'deposit', theirs).requestId);
    expect(other?.error?.code).toBe('request-not-open');
    const gone = await t.queue.settled(t.resume(ACC1, 'deposit', 'ff'.repeat(32)).requestId);
    expect(gone?.error?.code).toBe('request-not-open');
    expect(t.fake.calls).toEqual([]);
  });

  it('resumes a withdrawal on the account lane, and refunds a never-executed one', async () => {
    const t = setup();
    const requestId = t.fake.addOpen('withdraw', ACC1, STKA, ONE);
    t.fake.mpc = 'never-executed';
    const done = await t.queue.settled(t.resume(ACC1, 'withdraw', requestId).requestId);
    expect(done?.state).toBe('succeeded');
    expect(done?.result).toMatchObject({
      attested: 'never-executed',
      settleCircuit: 'bridge_withdraw_refund',
      coin: { color: COLOUR_A, value: ONE.toString() },
    });
  });
});

describe('bridge withdrawal', () => {
  it('runs start → MPC transfer → settle, returning the change of a partial withdrawal', async () => {
    const t = setup();
    t.fundVault();
    const done = await t.queue.settled(
      t.withdraw(ACC1, {
        amount: '600000',
        coin: { nonce: '0e'.repeat(32), color: COLOUR_A, value: ONE.toString(), mtIndex: '4779' },
      }).requestId,
    );
    expect(done?.state).toBe('succeeded');
    expect(detail(done, 'started')).toMatchObject({
      changeValue: '400000',
      changeNonce: 'cc'.repeat(32),
      changeColour: COLOUR_A,
    });
    expect(done?.result).toMatchObject({
      kind: 'withdraw',
      attested: 'success',
      settleCircuit: 'bridge_withdraw_complete',
      coin: null,
      change: { color: COLOUR_A, value: '400000' },
    });
    // Security review F-B3: the change's entitlement, in the start stage (so a page that loses the
    // job still has it) and in the result; valid for this account only.
    const token = detail(done, 'started')?.changeEntitlement;
    expect(token).toMatch(/^ae1\./);
    expect((done?.result as { changeEntitlement?: string }).changeEntitlement).toBe(token);
    expect(t.entitlements.verify(token, ACC1)).toMatchObject({ ok: true });
    expect(t.entitlements.verify(token, '99'.repeat(32))).toMatchObject({ ok: false });
  });

  it('issues no entitlement for a withdrawal of a whole coin (no change)', async () => {
    const t = setup();
    t.fundVault();
    const done = await t.queue.settled(t.withdraw(ACC1).requestId);
    expect(done?.state).toBe('succeeded');
    expect(detail(done, 'started')?.changeEntitlement).toBeUndefined();
    expect((done?.result as { changeEntitlement?: string }).changeEntitlement).toBeUndefined();
  });

  it('refuses before signing is spent when the vault account lacks gas, naming the shortfall', async () => {
    const t = setup();
    t.fundVault(GAS_COST - 1n);
    const done = await t.queue.settled(t.withdraw(ACC1).requestId);
    expect(done?.error?.code).toBe('preflight-refused');
    expect(done?.error?.message).toMatch(/vault account holds 999999999999999 wei of gas/);
    expect(t.fake.calls).toEqual([]);
  });

  it('refuses while another withdrawal is open in the vault, and a coin of another colour', async () => {
    const t = setup();
    t.fundVault();
    const wrongCoin = await t.queue.settled(
      t.withdraw(ACC1, { coin: { nonce: '0e'.repeat(32), color: COLOUR_B, value: ONE.toString(), mtIndex: '1' } })
        .requestId,
    );
    expect(wrongCoin?.error?.code).toBe('bad-request');
    t.fake.addOpen('withdraw', ACC2, STKA, ONE);
    const busy = await t.queue.settled(t.withdraw(ACC1).requestId);
    expect(busy?.error?.code).toBe('request-still-open');
    expect(t.fake.calls).toEqual([]);
  });

  it('runs withdrawals of different customers one after the other, each with its own vault nonce', async () => {
    const t = setup();
    t.fundVault();
    t.fake.gate = new Gate();
    const a = t.withdraw(ACC1);
    await waitForStage(t.queue, a.requestId, 'mpc-signed');
    const q = await t.svc.quote('withdraw', ACC2, STKA);
    expect(q.payer).toBe(VAULT_EVM);
    expect(q.evm.nonce).toBe('1');
    expect(q.openInVault).toBe(1);
    const b = t.withdraw(ACC2, { evm: q.evm });
    expect(t.queue.get(b.requestId)?.state).toBe('queued');
    t.fake.gate.release();
    const [da, db] = await Promise.all([t.queue.settled(a.requestId), t.queue.settled(b.requestId)]);
    expect([da?.state, db?.state]).toEqual(['succeeded', 'succeeded']);
    expect(t.fake.calls.filter((c) => c.startsWith('startWithdraw'))).toEqual([
      'startWithdraw:1a1a:0',
      'startWithdraw:2b2b:1',
    ]);
    expect(t.fake.calls.indexOf('startWithdraw:2b2b:1')).toBeGreaterThan(
      t.fake.calls.indexOf('settle:bridge_withdraw_complete:01'),
    );
  });

  it('refund: a never-executed transfer settles with bridge_withdraw_refund and mints the coin back', async () => {
    const t = setup();
    t.fundVault();
    t.fake.mpc = 'never-executed';
    const done = await t.queue.settled(t.withdraw(ACC1).requestId);
    expect(stages(done)).toContain('evm-not-broadcast');
    expect(done?.result).toMatchObject({
      attested: 'never-executed',
      settleCircuit: 'bridge_withdraw_refund',
      coin: { value: ONE.toString() },
    });
  });

  it('refund: a transfer that returned false settles with bridge_withdraw_complete, which re-mints', async () => {
    const t = setup();
    t.fundVault();
    t.fake.mpc = 'returned-false';
    const done = await t.queue.settled(t.withdraw(ACC1).requestId);
    expect(done?.result).toMatchObject({
      attested: 'returned-false',
      settleCircuit: 'bridge_withdraw_complete',
      coin: { value: ONE.toString() },
    });
  });
});

describe('the bridge quote', () => {
  it('quotes the payer, the gas policy and the balances', async () => {
    const t = setup();
    t.fundDeposit(ACC1);
    t.fake.setNonce(t.fake.depositAddress(ACC1), 2n);
    const q = await t.svc.quote('deposit', ACC1, STKA);
    expect(q).toMatchObject({
      kind: 'deposit',
      account: ACC1,
      payer: t.fake.depositAddress(ACC1),
      vaultEvmAddress: VAULT_EVM,
      erc20: STKA,
      evm: {
        nonce: '2',
        gasLimit: '100000',
        maxFeePerGas: '10000000000',
        maxPriorityFeePerGas: '1000000000',
        keyVersion: '1',
      },
      maxGasCostWei: GAS_COST.toString(),
      payerEthWei: GAS_COST.toString(),
      payerErc20: ONE.toString(),
      lane: { running: 0, waiting: 0 },
      openInVault: 0,
      accountOpen: [],
    });
    const open = t.fake.addOpen('deposit', ACC1, STKA, ONE);
    t.fake.addOpen('deposit', ACC2, STKA, ONE);
    expect((await t.svc.quote('deposit', ACC1, STKA)).accountOpen).toEqual([open]);
    const w = t.fake.addOpen('withdraw', ACC1, STKA, ONE);
    t.fake.addOpen('withdraw', ACC2, STKA, ONE);
    const qw = await t.svc.quote('withdraw', ACC1, STKA);
    expect([qw.openInVault, qw.accountOpen]).toEqual([2, [w]]);
    await expect(t.svc.quote('deposit', ACC1, '0x000000000000000000000000000000000000dEaD')).rejects.toThrow(
      /does not bridge/,
    );
  });
});
