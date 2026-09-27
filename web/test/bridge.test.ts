// Plan L-BRG in the browser, against a fake relay and an injected wallet: the deposit address is
// derived here (G-BRIDGE's live address reproduced), the wallet sends the ERC20 and the gas, the
// preflight refuses before any signature, each start is ONE signature, the transfer follows its
// job, resumes by request id after a relay restart, and applies its coins on completion.

import { type BaseWallet, TypedDataEncoder, Wallet, recoverAddress } from 'ethers';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_EVM_GAS,
  STAGENET,
  bytesToHex,
  contractCoinCommitment,
  evmTxParamsJson,
  recoverRelayActionSigner,
  type AccountStateView,
  type ActionRequest,
  type BridgeQuote,
  type InboxPage,
  type JobView,
  type RelayActionName,
  type SignedRelayAction,
  type StoredCoin,
  type ZswapActivity,
} from '@mnbank/core';
import { bridgeDepositStartRequest, evmDeviceEntry, gatedCall } from '@mnbank/core/passport';

import { mpcSlow, outcomeText } from '../src/bridge/messages.js';
import {
  PreflightError,
  applyCoins,
  applyJob,
  depositAddressOf,
  draftDeposit,
  pollTransfer,
  resumeTransfer,
  sendDepositGas,
  sendDepositTokens,
  startDeposit,
  startWithdraw,
  type BridgeEnv,
} from '../src/bridge/operations.js';
import { readTransfer, writeTransfer, type TransferRecord } from '../src/bridge/records.js';
import { readCoins, readRoster } from '../src/passport/records.js';
import type { RelayClient } from '../src/relay/client.js';
import { LocalStore } from '../src/store/store.js';

const ACCOUNT = '70a62b7d0ceca7905a50f5539c5484f3f77aae6e67cf7a5a87d5eeb6887c2a30'; // G-BRIDGE's account
const SALT = '5a'.repeat(32);

class FakeRelay {
  submitted: Array<{ action: RelayActionName; request: ActionRequest }> = [];
  jobs = new Map<string, JobView | null>();
  quote: Partial<BridgeQuote> = {};
  state: AccountStateView | null = null;

  async nonce() {
    return { nonce: `0x${'12'.repeat(32)}`, expiresAt: 0, maxTtlSeconds: 600 };
  }
  async submit(action: RelayActionName, request: ActionRequest): Promise<JobView> {
    this.submitted.push({ action, request });
    const id = `${this.submitted.length}`.padStart(32, '0');
    const job = view(id, action, 'queued');
    this.jobs.set(id, job);
    return job;
  }
  async job(id: string) {
    return this.jobs.get(id) ?? null;
  }
  async bridgeQuote(kind: 'deposit' | 'withdraw', account: string, erc20?: string): Promise<BridgeQuote> {
    return {
      kind,
      account,
      payer: '0x0000000000000000000000000000000000000000',
      vaultEvmAddress: STAGENET.bridge.vaultEvmAddress,
      erc20: erc20 ?? null,
      evm: evmTxParamsJson(DEFAULT_EVM_GAS, 0n),
      maxGasCostWei: '1000000000000000',
      payerEthWei: '1000000000000000',
      payerErc20: '1000000',
      lane: { running: 0, waiting: 0 },
      openInVault: 0,
      accountOpen: [],
      ...this.quote,
    };
  }
  async accountState() {
    return this.state;
  }
  async inbox(): Promise<InboxPage> {
    return { account: ACCOUNT, from: 0, entries: [], total: 0 };
  }
  async zswap(): Promise<ZswapActivity> {
    return { account: ACCOUNT, outputs: [], inputs: [], transactions: 0, blockHeight: 0 };
  }
}

const view = (
  requestId: string,
  action: RelayActionName,
  state: JobView['state'],
  extra: Partial<JobView> = {},
): JobView => ({
  requestId,
  action,
  lane: 'deposit',
  state,
  stage: state,
  stages: [{ stage: state, at: 1 }],
  createdAt: 0,
  updatedAt: 0,
  expiresAt: 0,
  ...extra,
});

/** An injected EIP-1193 wallet: signs typed data, "sends" transactions and serves Sepolia reads. */
function wallet(w: BaseWallet, sepolia: { eth: bigint; erc20: bigint }) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const provider = {
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push({ method, params });
      switch (method) {
        case 'eth_signTypedData_v4': {
          const td = JSON.parse((params as string[])[1]!) as {
            domain: never;
            types: Record<string, never>;
            message: never;
          };
          const { EIP712Domain: _d, ...types } = td.types;
          return w.signTypedData(td.domain, types, td.message);
        }
        case 'eth_getBalance':
          return `0x${sepolia.eth.toString(16)}`;
        case 'eth_call':
          return `0x${sepolia.erc20.toString(16).padStart(64, '0')}`;
        case 'eth_sendTransaction': {
          const tx = (params as Array<{ to: string; data?: string; value?: string }>)[0]!;
          if (tx.data?.startsWith('0xa9059cbb')) sepolia.erc20 += BigInt(`0x${tx.data.slice(74)}`);
          else sepolia.eth += BigInt(tx.value ?? '0x0');
          return `0x${String(calls.length).padStart(64, '0')}`;
        }
        case 'eth_getTransactionReceipt':
          return { status: '0x1' };
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
  return { provider, calls, sepolia };
}

let storage: Storage;
beforeEach(() => {
  window.localStorage.clear();
  storage = window.localStorage;
});

function setup(sepolia = { eth: 0n, erc20: 0n }) {
  const w = Wallet.createRandom();
  const relay = new FakeRelay();
  const wal = wallet(w, sepolia);
  const e: BridgeEnv = {
    relay: relay as unknown as RelayClient,
    store: new LocalStore(storage),
    scope: { network: 'stagenet', evmAddress: w.address },
    provider: wal.provider,
    owner: w.address,
    chainId: 11155111,
    network: STAGENET,
  };
  relay.state = {
    account: ACCOUNT,
    booted: true,
    deviceCount: 1,
    deviceEpoch: '0',
    devices: [evmDeviceEntry(ACCOUNT, w.address, 0n, 0n)],
    authNonce: '4',
    inboxCount: '0',
    encKey: 'ab'.repeat(32),
    vault: STAGENET.bridge.vaultAddress,
    evmDomainSalt: SALT,
  };
  const tokens = {
    stkA: {
      symbol: 'stkA',
      midnightName: 'wStkA',
      role: 'stock' as const,
      decimals: 6,
      sepoliaAddress: '0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52',
      midnightColour: '5eb2a3cebb2ebe7ba910c78f62c9e28e0d74acbd00c810730def3578860e6a02',
      vault: STAGENET.bridge.vaultAddress,
      provisional: false,
      source: null,
    },
  };
  return { w, relay, e, wal, tokens };
}

const signatures = (calls: Array<{ method: string }>) =>
  calls.filter((c) => c.method === 'eth_signTypedData_v4').length;

describe('the deposit address', () => {
  it("is derived in the page, and reproduces G-BRIDGE's live deposit address", () => {
    expect(depositAddressOf(STAGENET, ACCOUNT)).toBe('0xEb5A392eeee639C23434C1FA8bccbF6bC730377C');
  });
});

describe('deposit (L-BRG.1)', () => {
  it('the wallet sends the ERC20 and the gas (two transactions), then signs the start ONCE', async () => {
    const { e, wal, relay, tokens, w } = setup();
    const rec = draftDeposit(e, ACCOUNT, tokens.stkA, 1_000_000n);
    expect(rec.depositAddress).toBe('0xEb5A392eeee639C23434C1FA8bccbF6bC730377C');
    expect(await sendDepositTokens(e, rec)).toMatch(/^0x/);
    expect(await sendDepositGas(e, rec)).toMatch(/^0x/);
    const sends = wal.calls.filter((c) => c.method === 'eth_sendTransaction');
    expect(sends).toHaveLength(2);
    const [tokenTx, gasTx] = sends.map((c) => (c.params as Array<Record<string, string>>)[0]!);
    expect(tokenTx).toMatchObject({ from: w.address, to: tokens.stkA.sepoliaAddress, value: '0x0' });
    expect(tokenTx!.data).toBe(
      `0xa9059cbb${'000000000000000000000000eb5a392eeee639c23434c1fa8bccbf6bc730377c'}${(1_000_000).toString(16).padStart(64, '0')}`,
    );
    expect(gasTx).toMatchObject({ to: rec.depositAddress, value: '0x38d7ea4c68000' }); // 0.001 ETH
    // Already funded: nothing more is sent.
    expect(await sendDepositTokens(e, rec)).toBeNull();
    expect(await sendDepositGas(e, rec)).toBeNull();

    relay.quote = { payer: rec.depositAddress! };
    const started = await startDeposit(e, readTransfer(e.store, e.scope, ACCOUNT, rec.id)!);
    expect(signatures(wal.calls)).toBe(1);
    const [sub] = relay.submitted;
    expect(sub!.action).toBe('bridge-deposit');
    expect(sub!.request.payload).toEqual({
      erc20: tokens.stkA.sepoliaAddress,
      amount: '1000000',
      evm: evmTxParamsJson(DEFAULT_EVM_GAS, 0n),
      authNonce: '4',
    });
    // The signature is over the start's own typed data (the relay rebuilds the same digest).
    const call = gatedCall(
      { account: ACCOUNT, authNonce: 4n, evmDomainSalt: SALT },
      w.address,
      bridgeDepositStartRequest(sub!.request.payload as never),
    );
    const pa = sub!.request.passportAuth as { owner: string; signature: string; useCounter: string };
    expect(recoverAddress(call.digestHex, pa.signature)).toBe(w.address);
    expect(pa.useCounter).toBe('0');
    const { EIP712Domain: _d, ...types } = call.typedData.types as Record<string, never>;
    expect(TypedDataEncoder.hash(call.typedData.domain as never, types, call.typedData.message as never)).toBe(
      call.digestHex,
    );
    expect(started).toMatchObject({ state: 'running', jobIds: [relay.submitted.length.toString().padStart(32, '0')] });
    expect(readRoster(e.store, e.scope, ACCOUNT)).toEqual({ useCounter: '1' });
    expect(readTransfer(e.store, e.scope, ACCOUNT, rec.id)?.funding).toMatchObject({
      tokenTx: expect.any(String),
      gasTx: expect.any(String),
    });
  });

  it('refuses before any signature when the deposit address lacks the gas, naming the shortfall', async () => {
    const { e, wal, relay, tokens } = setup();
    const rec = draftDeposit(e, ACCOUNT, tokens.stkA, 1_000_000n);
    relay.quote = { payer: rec.depositAddress!, payerEthWei: '0' };
    const err = await startDeposit(e, rec).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(PreflightError);
    expect((err as PreflightError).problems).toEqual([
      'The deposit address holds 0 wei but the sweep may cost up to 1000000000000000 wei (gasLimit 100000 x maxFeePerGas 10000000000): send it gas ETH first.',
    ]);
    expect(signatures(wal.calls)).toBe(0);
    expect(relay.submitted).toEqual([]);
  });

  it('refuses when the relay quotes another deposit address, or an earlier deposit is still open', async () => {
    const { e, wal, relay, tokens } = setup();
    const rec = draftDeposit(e, ACCOUNT, tokens.stkA, 1_000_000n);
    await expect(startDeposit(e, rec)).rejects.toThrow(/different deposit address/);
    relay.quote = { payer: rec.depositAddress!, accountOpen: ['aa'.repeat(32)] };
    await expect(startDeposit(e, rec)).rejects.toThrow(/still open .* resume it/);
    expect(signatures(wal.calls)).toBe(0);
  });

  it('a second deposit waits for the first to start, then reserves the first one’s tokens and gas', async () => {
    const { e, wal, relay, tokens } = setup();
    const first = draftDeposit(e, ACCOUNT, tokens.stkA, 1_000_000n);
    relay.quote = { payer: first.depositAddress! };
    await startDeposit(e, first);
    const second = draftDeposit(e, ACCOUNT, tokens.stkA, 1_000_000n);
    await expect(startDeposit(e, second)).rejects.toThrow(/earlier transfer has started/);
    // The first starts (its request id is known) but its sweep is not on Sepolia yet.
    writeTransfer(e.store, e.scope, {
      ...readTransfer(e.store, e.scope, ACCOUNT, first.id)!,
      requestId: 'aa'.repeat(32),
    });
    relay.quote = {
      payer: first.depositAddress!,
      payerErc20: '1000000',
      payerEthWei: '1000000000000000',
      lane: { running: 1, waiting: 0 },
      accountOpen: ['aa'.repeat(32)],
    };
    const err = await startDeposit(e, second).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(PreflightError);
    expect((err as PreflightError).problems).toHaveLength(2);
    relay.quote = {
      ...relay.quote,
      payerErc20: '2000000',
      payerEthWei: '2000000000000000',
      evm: evmTxParamsJson(DEFAULT_EVM_GAS, 1n),
    };
    await startDeposit(e, second);
    expect(signatures(wal.calls)).toBe(2);
    expect((relay.submitted[1]!.request.payload as { evm: { nonce: string } }).evm.nonce).toBe('1');
  });
});

describe('following, resuming and finishing a transfer (L-BRG.1–.3)', () => {
  const started = (requestId: string) => ({
    stage: 'started',
    at: 2,
    detail: { tx: 'mid-start', txHash: 'h1', requestId, startedAtMs: '1700000000000' },
  });

  it('records every stage and hash, and marks a transfer to resume when the relay restarted', async () => {
    const { e, relay, tokens } = setup();
    const rec = draftDeposit(e, ACCOUNT, tokens.stkA, 1_000_000n);
    relay.quote = { payer: rec.depositAddress! };
    let t = await startDeposit(e, rec);
    const jobId = t.jobIds[0]!;
    relay.jobs.set(
      jobId,
      view(jobId, 'bridge-deposit', 'running', {
        stages: [
          { stage: 'queued', at: 1 },
          started('bb'.repeat(32)),
          { stage: 'mpc-signed', at: 3, detail: { signedTx: '0xabc' } },
        ],
      }),
    );
    t = await pollTransfer(e, t);
    expect(t).toMatchObject({ state: 'running', requestId: 'bb'.repeat(32), startedAtMs: 1700000000000 });
    expect(t.stages.map((s) => s.stage)).toEqual(['queued', 'started', 'mpc-signed']);

    relay.jobs.delete(jobId); // the relay restarted
    t = await pollTransfer(e, t);
    expect(t.state).toBe('needs-resume');

    t = await resumeTransfer(e, t);
    const sub = relay.submitted.at(-1)!;
    expect(sub.action).toBe('bridge-resume');
    expect(sub.request.payload).toEqual({ kind: 'deposit', requestId: 'bb'.repeat(32), startedAtMs: '1700000000000' });
    const auth = sub.request.auth as SignedRelayAction;
    expect(recoverRelayActionSigner(auth.message, auth.signature)).toBe(e.owner);
    expect(auth.message.account).toBe(`0x${ACCOUNT}`);
    expect(t.state).toBe('running');
    expect(t.jobIds).toHaveLength(2);
  });

  it('adopts the one open request of the account when the relay went down before the page saw the start', async () => {
    const { e, relay, tokens } = setup();
    const rec = draftDeposit(e, ACCOUNT, tokens.stkA, 1_000_000n);
    relay.quote = { payer: rec.depositAddress! };
    let t = await startDeposit(e, rec);
    relay.jobs.clear();
    relay.quote = { payer: rec.depositAddress!, accountOpen: ['cc'.repeat(32)] };
    t = await pollTransfer(e, t);
    expect(t).toMatchObject({ state: 'needs-resume', requestId: 'cc'.repeat(32) });
    // A new deposit is refused until that open one is resumed.
    await expect(startDeposit(e, draftDeposit(e, ACCOUNT, tokens.stkA, 1n))).rejects.toThrow(/still open/);
    // A transfer whose start never landed (no open request the page does not already know) fails clearly.
    const lone = writeTransfer(e.store, e.scope, {
      ...draftDeposit(e, ACCOUNT, tokens.stkA, 1n),
      state: 'running',
      jobIds: ['09'.padStart(32, '0')],
    });
    const failed = await pollTransfer(e, lone);
    expect(failed).toMatchObject({ state: 'failed', error: { code: 'job-lost' } });
    expect(failed.error?.message).toMatch(/before your transfer started/);
  });

  it('a transfer whose MPC timed out becomes resumable; a deposit adds its coin on completion', async () => {
    const { e, tokens } = setup();
    const rec = draftDeposit(e, ACCOUNT, tokens.stkA, 1_000_000n);
    let t: TransferRecord = { ...rec, state: 'running', jobIds: ['01'.padStart(32, '0')] };
    t = applyJob(
      e,
      t,
      view(t.jobIds[0]!, 'bridge-deposit', 'failed', {
        stages: [started('dd'.repeat(32))],
        error: { code: 'mpc-timeout', message: 'the MPC has not signed' },
      }),
    );
    expect(t.state).toBe('needs-resume');
    expect(outcomeText(t)?.text).toMatch(/has not signed this request within 20 minutes/);

    const coin = { nonce: 'ee'.repeat(32), color: tokens.stkA.midnightColour, value: '1000000' };
    t = applyJob(
      e,
      t,
      view('02'.padStart(32, '0'), 'bridge-resume', 'succeeded', {
        result: {
          kind: 'deposit',
          account: ACCOUNT,
          requestId: 'dd'.repeat(32),
          startTx: null,
          attested: 'success',
          evmTxHash: '0xevm',
          settleTx: 'settle',
          settleCircuit: 'bridge_deposit_complete',
          coin,
          change: null,
          entryMatchesCoin: true,
        },
      }),
    );
    expect(t.state).toBe('succeeded');
    applyCoins(e, t);
    applyCoins(e, t); // idempotent
    const coins = readCoins(e.store, e.scope, ACCOUNT);
    expect(coins).toHaveLength(1);
    expect(coins[0]).toMatchObject({ ...coin, inInbox: true, commitment: contractCoinCommitment(coin, ACCOUNT) });
    expect(outcomeText(t)).toEqual({ kind: 'ok', text: '1.00 wStkA arrived in your account.' });
  });

  it('says clearly when an ERC20 returned false, when a withdrawal was refunded, and when the MPC is slow', () => {
    const { e, tokens } = setup();
    const base = draftDeposit(e, ACCOUNT, tokens.stkA, 1_000_000n);
    const result = {
      kind: 'deposit' as const,
      account: ACCOUNT,
      requestId: 'dd'.repeat(32),
      startTx: 'x',
      attested: 'returned-false' as const,
      evmTxHash: '0x1',
      settleTx: 's',
      settleCircuit: 'bridge_deposit_complete' as const,
      coin: null,
      change: null,
      entryMatchesCoin: true,
    };
    expect(outcomeText({ ...base, state: 'succeeded', result })?.text).toMatch(/returned false\)\. Nothing was minted/);
    const refund = {
      ...result,
      kind: 'withdraw' as const,
      attested: 'never-executed' as const,
      settleCircuit: 'bridge_withdraw_refund' as const,
      coin: { nonce: 'ee'.repeat(32), color: 'aa'.repeat(32), value: '1000000' },
    };
    expect(outcomeText({ ...base, kind: 'withdraw', state: 'succeeded', result: refund })).toEqual({
      kind: 'info',
      text: 'Refunded: the transfer never ran on Sepolia, so 1.00 wStkA came back to your account.',
    });
    const slow: TransferRecord = {
      ...base,
      state: 'running',
      stages: [{ stage: 'started', at: Math.floor(Date.now() / 1000) - 600 }],
    };
    expect(mpcSlow(slow)).toBe(true);
    expect(outcomeText(slow)?.text).toMatch(/slower than usual/);
    expect(mpcSlow({ ...slow, stages: [...slow.stages, { stage: 'mpc-signed', at: 1 }] })).toBe(false);
  });
});

describe('withdrawal (L-BRG.2)', () => {
  const coin = (value: string, mtIndex: string | null = '4779'): StoredCoin => ({
    nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    color: '5eb2a3cebb2ebe7ba910c78f62c9e28e0d74acbd00c810730def3578860e6a02',
    value,
    mtIndex,
    commitment: 'c0'.repeat(32),
    origin: 'inbox',
    inInbox: true,
    spent: false,
  });

  it('is capped by the largest single coin (Q9), refused before signing when the vault lacks gas, then ONE signature', async () => {
    const { e, wal, relay, tokens, w } = setup();
    e.store.put(e.scope, 'coins', [coin('600000'), coin('1000000')], { account: ACCOUNT });
    await expect(
      startWithdraw(e, ACCOUNT, { token: tokens.stkA, amount: 1_500_000n, dest: w.address }),
    ).rejects.toThrow(/largest single payment is 1000000/);
    relay.quote = { payer: STAGENET.bridge.vaultEvmAddress, payerEthWei: '999999999999999', payerErc20: '5000000' };
    const err = await startWithdraw(e, ACCOUNT, { token: tokens.stkA, amount: 700_000n, dest: w.address }).catch(
      (x: unknown) => x,
    );
    expect(err).toBeInstanceOf(PreflightError);
    expect((err as PreflightError).problems[0]).toMatch(/vault account holds 999999999999999 wei of gas/);
    expect(signatures(wal.calls)).toBe(0);

    relay.quote = { payer: STAGENET.bridge.vaultEvmAddress, payerEthWei: '2000000000000000', payerErc20: '5000000' };
    const t = await startWithdraw(e, ACCOUNT, { token: tokens.stkA, amount: 700_000n, dest: w.address });
    expect(signatures(wal.calls)).toBe(1);
    const sub = relay.submitted.at(-1)!;
    expect(sub.action).toBe('bridge-withdraw');
    // The chosen coin is the smallest that covers the amount, with its exact position.
    expect(sub.request.payload).toMatchObject({
      dest: w.address,
      amount: '700000',
      coin: { value: '1000000', mtIndex: '4779' },
    });
    expect(t).toMatchObject({ kind: 'withdraw', state: 'running', dest: w.address });

    // Completion: the coin is marked spent and the change is kept, to be re-filed (Q13 A).
    const change = { nonce: 'cc'.repeat(32), color: tokens.stkA.midnightColour, value: '300000' };
    const done = applyJob(
      e,
      t,
      view(t.jobIds[0]!, 'bridge-withdraw', 'succeeded', {
        stages: [
          {
            stage: 'started',
            at: 2,
            detail: {
              requestId: 'ab'.repeat(32),
              changeNonce: change.nonce,
              changeColour: change.color,
              changeValue: change.value,
            },
          },
        ],
        result: {
          kind: 'withdraw',
          account: ACCOUNT,
          requestId: 'ab'.repeat(32),
          startTx: 'start',
          attested: 'success',
          evmTxHash: '0xevm',
          settleTx: 'settle',
          settleCircuit: 'bridge_withdraw_complete',
          coin: null,
          change,
          entryMatchesCoin: true,
        },
      }),
    );
    expect(done.change).toEqual({ coin: change, secured: false });
    applyCoins(e, { ...done, spentCommitment: 'c0'.repeat(32) });
    const coins = readCoins(e.store, e.scope, ACCOUNT);
    expect(coins.filter((c) => c.spent)).toHaveLength(2); // both test coins share the dummy commitment
    expect(coins.find((c) => c.nonce === change.nonce)).toMatchObject({
      value: '300000',
      inInbox: false,
      origin: 'change',
    });
  });
});
