// Plan L-ACC in the browser, against a fake relay and an injected wallet: one signature per
// action, the secret stored before anything leaves the page, the inbox decrypted here, the coin
// chosen here and passed as the call's private state, the change kept here until re-filed (Q13).

import { type BaseWallet, TypedDataEncoder, Wallet, recoverAddress } from 'ethers';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  NO_ACCOUNT,
  bytesToHex,
  contractCoinCommitment,
  contractCoinNullifier,
  hexToBytes,
  recoverRelayActionSigner,
  type AccountStateView,
  type ActionRequest,
  type InboxPage,
  type JobView,
  type RelayActionName,
  type SignedRelayAction,
  type ZswapActivity,
} from '@mnbank/core';
import {
  evmDeviceEntry,
  gatedCall,
  openEntryPortable,
  sealEntryPortable,
  withdrawRequest,
} from '@mnbank/core/passport';
import { x25519 } from '@noble/curves/ed25519.js';

import {
  openAccount,
  secureChange,
  syncAccount,
  withdrawToWallet,
  type OperationEnv,
} from '../src/passport/operations.js';
import { readCoins, readRoster, readSecret } from '../src/passport/records.js';
import type { RelayClient } from '../src/relay/client.js';
import { recordKey } from '../src/store/schema.js';
import { LocalStore } from '../src/store/store.js';

const ACCOUNT = 'ac'.repeat(32);
const SALT = '5a'.repeat(32);
const COLOUR = 'c0'.repeat(32);

class FakeRelay {
  submitted: Array<{ action: RelayActionName; request: ActionRequest }> = [];
  results: Record<string, Record<string, unknown>> = {};
  failNext: string | null = null;
  state: AccountStateView | null = null;
  entries: Array<string | null> = [];
  zswapActivity: ZswapActivity = { account: ACCOUNT, outputs: [], inputs: [], transactions: 0, blockHeight: 0 };

  async nonce() {
    return { nonce: `0x${'12'.repeat(32)}`, expiresAt: 0, maxTtlSeconds: 600 };
  }
  async submit(action: RelayActionName, request: ActionRequest): Promise<JobView> {
    this.submitted.push({ action, request });
    return this.view(`${this.submitted.length}`.padStart(32, '0'), action, 'queued');
  }
  private view(
    requestId: string,
    action: RelayActionName,
    state: JobView['state'],
    extra: Partial<JobView> = {},
  ): JobView {
    return {
      requestId,
      action,
      lane: 'prover',
      state,
      stage: state,
      stages: [{ stage: state, at: 0 }],
      createdAt: 0,
      updatedAt: 0,
      expiresAt: 0,
      ...extra,
    };
  }
  async waitForJob(requestId: string, onUpdate: (j: JobView) => void): Promise<JobView> {
    const action = this.submitted[Number(requestId) - 1]!.action;
    const job =
      this.failNext !== null
        ? this.view(requestId, action, 'failed', { error: { code: 'x', message: this.failNext } })
        : this.view(requestId, action, 'succeeded', { result: this.results[action] ?? {} });
    this.failNext = null;
    onUpdate(job);
    return job;
  }
  async accountState() {
    return this.state;
  }
  async inbox(): Promise<InboxPage> {
    return { account: ACCOUNT, from: 0, entries: this.entries, total: this.entries.length };
  }
  async zswap() {
    return this.zswapActivity;
  }
}

function injectedWallet(w: BaseWallet, onSign?: () => void) {
  const calls: string[] = [];
  const provider = {
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push(method);
      if (method !== 'eth_signTypedData_v4') throw new Error(`unexpected ${method}`);
      onSign?.();
      const td = JSON.parse((params as string[])[1]!) as {
        domain: never;
        types: Record<string, never>;
        message: never;
      };
      const { EIP712Domain: _d, ...types } = td.types;
      return w.signTypedData(td.domain, types, td.message);
    },
  };
  return { provider, calls };
}

let storage: Storage;
beforeEach(() => {
  window.localStorage.clear();
  storage = window.localStorage;
});

function env(w: BaseWallet, relay: FakeRelay, provider: OperationEnv['provider']): OperationEnv {
  return {
    relay: relay as unknown as RelayClient,
    store: new LocalStore(storage),
    scope: { network: 'undeployed', evmAddress: w.address },
    provider,
    owner: w.address,
    chainId: 11155111,
  };
}

describe('openAccount (L-ACC.1)', () => {
  it('stores the secret first, asks for ONE signature, and keeps the account record on success', async () => {
    const w = Wallet.createRandom();
    const relay = new FakeRelay();
    relay.results.register = {
      account: ACCOUNT,
      device: w.address.toLowerCase(),
      txs: { waveOne: 'w1', waveTwo: 'w2', activation: 'act' },
      seconds: { waveOne: 1, waveTwo: 1, activation: 1, total: 3 },
    };
    let secretAtSigning: unknown = null;
    const e = env(w, relay, null as never);
    const { provider, calls } = injectedWallet(w, () => {
      secretAtSigning = readSecret(e.store, e.scope, null);
    });
    e.provider = provider;
    const rec = await openAccount(e, 'ee'.repeat(32));

    expect(calls).toEqual(['eth_signTypedData_v4']);
    expect(secretAtSigning).toMatchObject({ pending: true });
    const [sub] = relay.submitted;
    expect(sub!.action).toBe('register');
    const secret = readSecret(e.store, e.scope, ACCOUNT)!;
    expect(bytesToHex(x25519.getPublicKey(hexToBytes(secret.encSecretKey, 32)))).toBe(secret.encPublicKey);
    expect(sub!.request.payload).toEqual({ encPublicKey: secret.encPublicKey }); // only the PUBLIC key leaves
    const auth = sub!.request.auth as SignedRelayAction;
    expect(auth.message.account).toBe(NO_ACCOUNT);
    expect(recoverRelayActionSigner(auth.message, auth.signature)).toBe(w.address);
    expect(rec).toMatchObject({ address: ACCOUNT, device: w.address.toLowerCase(), vault: 'ee'.repeat(32) });
    expect(readSecret(e.store, e.scope, null)).toBeNull();
    expect(readRoster(e.store, e.scope, ACCOUNT)).toEqual({ useCounter: '0' });
    expect(JSON.stringify(Object.keys(localStorage))).not.toContain('/job/');
  });

  it('keeps the key pair for a retry when the relay fails, and reuses it', async () => {
    const w = Wallet.createRandom();
    const relay = new FakeRelay();
    relay.failNext = 'the bank is busy';
    const { provider } = injectedWallet(w);
    const e = env(w, relay, provider);
    await expect(openAccount(e, 'ee'.repeat(32))).rejects.toThrow('the bank is busy');
    const pending = readSecret(e.store, e.scope, null)!;
    expect(pending.pending).toBe(true);
    relay.results.register = { account: ACCOUNT, device: w.address.toLowerCase(), txs: {}, seconds: {} };
    await openAccount(e, 'ee'.repeat(32));
    expect(relay.submitted[1]!.request.payload).toEqual({ encPublicKey: pending.encPublicKey });
  });
});

describe('the inbox walk and the gated calls (L-ACC.2 to L-ACC.5)', () => {
  async function fundedAccount() {
    const w = Wallet.createRandom();
    const relay = new FakeRelay();
    const { provider, calls } = injectedWallet(w);
    const e = env(w, relay, provider);
    const sk = x25519.utils.randomSecretKey();
    const pk = x25519.getPublicKey(sk);
    e.store.put(
      e.scope,
      'secret',
      { encSecretKey: bytesToHex(sk), encPublicKey: bytesToHex(pk) },
      { account: ACCOUNT },
    );
    e.store.put(e.scope, 'roster', { useCounter: '0' }, { account: ACCOUNT });
    relay.state = {
      account: ACCOUNT,
      booted: true,
      deviceCount: 1,
      deviceEpoch: '0',
      devices: [evmDeviceEntry(ACCOUNT, w.address, 0n, 1n)],
      authNonce: '7',
      inboxCount: '3',
      encKey: bytesToHex(pk),
      vault: 'ee'.repeat(32),
      evmDomainSalt: SALT,
    };
    const c60 = { nonce: '01'.repeat(32), color: COLOUR, value: 60_000_000n };
    const c40 = { nonce: '02'.repeat(32), color: COLOUR, value: 40_000_000n };
    const seal = async (c: typeof c60) =>
      bytesToHex(
        await sealEntryPortable(pk, { nonce: hexToBytes(c.nonce), color: hexToBytes(c.color), value: c.value }),
      );
    relay.entries = [await seal(c60), 'ff'.repeat(192), await seal(c40)];
    const info = (c: typeof c60) => ({ nonce: c.nonce, color: c.color, value: c.value.toString() });
    relay.zswapActivity = {
      account: ACCOUNT,
      outputs: [
        { commitment: contractCoinCommitment(info(c60), ACCOUNT), mtIndex: '100', txHash: 'd1', blockHeight: 1 },
        { commitment: contractCoinCommitment(info(c40), ACCOUNT), mtIndex: '205', txHash: 'd2', blockHeight: 2 },
      ],
      inputs: [],
      transactions: 2,
      blockHeight: 3,
    };
    return { w, relay, e, calls, sk, pk, c60, c40 };
  }

  it('decrypts the inbox here and positions every coin exactly', async () => {
    const { relay, e, calls } = await fundedAccount();
    const r = await syncAccount(e, ACCOUNT);
    expect(r.unreadable).toBe(1); // the poisoned entry is skipped, never an error
    expect(readCoins(e.store, e.scope, ACCOUNT).map((c) => [c.value, c.mtIndex, c.inInbox])).toEqual([
      ['60000000', '100', true],
      ['40000000', '205', true],
    ]);
    expect(calls).toEqual([]); // reading needs no signature
    expect(relay.submitted).toEqual([]);
  });

  it('withdraws from the smallest covering coin with ONE signature, and keeps the change', async () => {
    const { w, relay, e, calls } = await fundedAccount();
    await syncAccount(e, ACCOUNT);
    relay.results.withdraw = { txId: 'wd1', change: { nonce: '09'.repeat(32), color: COLOUR, value: '10000000' } };
    const out = await withdrawToWallet(e, ACCOUNT, {
      color: COLOUR,
      amount: 30_000_000n,
      recipient: '0x' + '44'.repeat(32),
    });

    expect(calls).toEqual(['eth_signTypedData_v4']);
    const sub = relay.submitted[0]!;
    expect(sub.action).toBe('withdraw');
    expect(sub.request.account).toBe(ACCOUNT);
    const payload = sub.request.payload as { coin: { value: string; mtIndex: string }; authNonce: string };
    expect(payload.coin).toMatchObject({ value: '40000000', mtIndex: '205' }); // the 40 covers 30; least change
    expect(payload.authNonce).toBe('7');
    const pa = sub.request.passportAuth as { owner: string; signature: string; useCounter: string };
    expect(pa.useCounter).toBe('1'); // resolved from the live device set, not the stale hint 0
    const call = gatedCall(
      { account: ACCOUNT, authNonce: 7n, evmDomainSalt: SALT },
      w.address,
      withdrawRequest(sub.request.payload as never),
    );
    expect(recoverAddress(call.digestHex, pa.signature)).toBe(w.address);
    const { EIP712Domain: _d, ...types } = call.typedData.types as Record<string, never>;
    expect(TypedDataEncoder.hash(call.typedData.domain, types, call.typedData.message)).toBe(call.digestHex);

    expect(out.change).toMatchObject({ value: '10000000', inInbox: false, origin: 'change', mtIndex: null });
    const coins = readCoins(e.store, e.scope, ACCOUNT);
    expect(coins.find((c) => c.value === '40000000')).toMatchObject({ spent: true, spentTx: 'wd1' });
    expect(coins.find((c) => c.value === '10000000')).toMatchObject({ inInbox: false });
    expect(readRoster(e.store, e.scope, ACCOUNT)).toEqual({ useCounter: '2' });

    // The next walk confirms the spend from the ledger's nullifier and positions the change.
    relay.zswapActivity = {
      ...relay.zswapActivity,
      outputs: [
        ...relay.zswapActivity.outputs,
        { commitment: out.change!.commitment, mtIndex: '300', txHash: 'wd1', blockHeight: 4 },
      ],
      inputs: [
        {
          nullifier: contractCoinNullifier({ nonce: '02'.repeat(32), color: COLOUR, value: '40000000' }, ACCOUNT),
          txHash: 'wd1',
          blockHeight: 4,
        },
      ],
    };
    await syncAccount(e, ACCOUNT);
    expect(readCoins(e.store, e.scope, ACCOUNT).find((c) => c.value === '10000000')).toMatchObject({
      mtIndex: '300',
      inInbox: false,
    });
  });

  it('refuses an amount no single coin covers before asking the wallet', async () => {
    const { e, calls } = await fundedAccount();
    await syncAccount(e, ACCOUNT);
    await expect(
      withdrawToWallet(e, ACCOUNT, { color: COLOUR, amount: 70_000_000n, recipient: '44'.repeat(32) }),
    ).rejects.toThrow(/largest single payment is 60000000/);
    expect(calls).toEqual([]);
  });

  it("re-files the change in the inbox, sealed to the account's key, with ONE signature (Q13)", async () => {
    const { relay, e, calls, sk } = await fundedAccount();
    relay.results['append-inbox'] = { txId: 'ai1' };
    const change = { nonce: '09'.repeat(32), color: COLOUR, value: '10000000' };
    const { localCoin } = await import('@mnbank/core');
    const r = await secureChange(e, ACCOUNT, localCoin(change, ACCOUNT));
    expect(r.txId).toBe('ai1');
    expect(calls).toEqual(['eth_signTypedData_v4']);
    const payload = relay.submitted[0]!.request.payload as { entry: string };
    const opened = await openEntryPortable(sk, hexToBytes(payload.entry, 192));
    expect(
      opened && { nonce: bytesToHex(opened.nonce), color: bytesToHex(opened.color), value: opened.value.toString() },
    ).toEqual(change);
    expect(recordKey(e.scope, 'job', { account: ACCOUNT, id: '1'.padStart(32, '0') })).toBeTruthy();
  });
});
