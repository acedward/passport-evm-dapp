// Plan L-TRD in the browser, against a fake relay, a fake exchange and an injected wallet: a make
// and a take are ONE signature each over the contract's OpenSwapShielded typed data; the browser
// seals the entries to the account's own key and picks one coin; a second offer is refused while one
// is live; an offer too big for any coin is not takeable; a taken or externally settled offer is
// reconciled from the inbox walk.

import { type BaseWallet, TypedDataEncoder, Wallet, recoverAddress } from 'ethers';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  bytesToHex,
  contractCoinCommitment,
  hexToBytes,
  orderLegs,
  parsePrice,
  type AccountStateView,
  type ActionRequest,
  type InboxPage,
  type JobView,
  type RelayActionName,
  type TokenEntry,
  type ZswapActivity,
} from '@mnbank/core';
import { evmDeviceEntry, openEntryPortable, openSwapGatedCall, sealEntryPortable } from '@mnbank/core/passport';
import { x25519 } from '@noble/curves/ed25519.js';

import { syncAccount, type OperationEnv } from '../src/passport/operations.js';
import { readCoins, readRoster } from '../src/passport/records.js';
import type { RelayClient } from '../src/relay/client.js';
import { LocalStore } from '../src/store/store.js';
import { guardFor, makeOffer, reconcileOffers, takeOffer } from '../src/trade/operations.js';
import { readTrades } from '../src/trade/records.js';

const ACCOUNT = 'ac'.repeat(32);
const SALT = '5a'.repeat(32);
const STOCK = {
  midnightColour: 'a1'.repeat(32),
  decimals: 6,
  midnightName: 'wStkA',
} as unknown as TokenEntry;
const USDC = {
  midnightColour: 'b2'.repeat(32),
  decimals: 6,
  midnightName: 'wUSDC',
} as unknown as TokenEntry;
const U = 1_000_000n;

class FakeRelay {
  submitted: Array<{ action: RelayActionName; request: ActionRequest }> = [];
  results: Record<string, Record<string, unknown>> = {};
  failNext: string | null = null;
  state!: AccountStateView;
  entries: Array<string | null> = [];
  zswapActivity: ZswapActivity = { account: ACCOUNT, outputs: [], inputs: [], transactions: 0, blockHeight: 0 };

  async submit(action: RelayActionName, request: ActionRequest): Promise<JobView> {
    this.submitted.push({ action, request });
    return this.view(`${this.submitted.length}`.padStart(32, '0'), action, 'queued');
  }
  private view(requestId: string, action: RelayActionName, state: JobView['state'], extra: Partial<JobView> = {}) {
    return {
      requestId,
      action,
      lane: 'prover' as const,
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

function injectedWallet(w: BaseWallet) {
  const signed: Array<{ primaryType: string; digest: string; signature: string }> = [];
  const provider = {
    async request({ method, params }: { method: string; params?: unknown }) {
      if (method !== 'eth_signTypedData_v4') throw new Error(`unexpected ${method}`);
      const td = JSON.parse((params as string[])[1]!) as {
        primaryType: string;
        domain: never;
        types: Record<string, never>;
        message: never;
      };
      const { EIP712Domain: _d, ...types } = td.types;
      const signature = await w.signTypedData(td.domain, types, td.message);
      signed.push({
        primaryType: td.primaryType,
        digest: TypedDataEncoder.hash(td.domain, types, td.message),
        signature,
      });
      return signature;
    },
  };
  return { provider, signed };
}

let storage: Storage;
beforeEach(() => {
  window.localStorage.clear();
  storage = window.localStorage;
});

/** An account holding 3 wStkA (one coin) and 8 + 6 wUSDC (two coins), synced from its inbox. */
async function setup() {
  const w = Wallet.createRandom();
  const relay = new FakeRelay();
  const { provider, signed } = injectedWallet(w);
  const e: OperationEnv = {
    relay: relay as unknown as RelayClient,
    store: new LocalStore(storage),
    scope: { network: 'undeployed', evmAddress: w.address },
    provider,
    owner: w.address,
    chainId: 11155111,
  };
  const sk = x25519.utils.randomSecretKey();
  const pk = x25519.getPublicKey(sk);
  e.store.put(e.scope, 'secret', { encSecretKey: bytesToHex(sk), encPublicKey: bytesToHex(pk) }, { account: ACCOUNT });
  e.store.put(e.scope, 'roster', { useCounter: '0' }, { account: ACCOUNT });
  relay.state = {
    account: ACCOUNT,
    booted: true,
    deviceCount: 1,
    deviceEpoch: '0',
    devices: [evmDeviceEntry(ACCOUNT, w.address, 0n, 2n)],
    authNonce: '4',
    inboxCount: '3',
    encKey: bytesToHex(pk),
    vault: 'ee'.repeat(32),
    evmDomainSalt: SALT,
  };
  const coins = [
    { nonce: '01'.repeat(32), color: STOCK.midnightColour, value: 3n * U },
    { nonce: '02'.repeat(32), color: USDC.midnightColour, value: 8n * U },
    { nonce: '03'.repeat(32), color: USDC.midnightColour, value: 6n * U },
  ];
  await addInbox(relay, pk, coins);
  await syncAccount(e, ACCOUNT);
  return { w, relay, e, pk, sk, signed };
}

async function addInbox(
  relay: FakeRelay,
  pk: Uint8Array,
  coins: Array<{ nonce: string; color: string; value: bigint }>,
) {
  for (const c of coins) {
    relay.entries.push(
      bytesToHex(
        await sealEntryPortable(pk, { nonce: hexToBytes(c.nonce), color: hexToBytes(c.color), value: c.value }),
      ),
    );
    relay.zswapActivity.outputs.push({
      commitment: contractCoinCommitment({ nonce: c.nonce, color: c.color, value: c.value.toString() }, ACCOUNT),
      mtIndex: String(relay.zswapActivity.outputs.length + 10),
      txHash: `tx-${c.nonce.slice(0, 4)}`,
      blockHeight: 1,
    });
  }
  relay.state.inboxCount = String(relay.entries.length);
}

describe('make an offer (L-TRD.1)', () => {
  it('sell 2 wStkA at 1.05: ONE OpenSwapShielded signature over the exact legs, entries sealed to the account', async () => {
    const { w, relay, e, sk, signed } = await setup();
    relay.results['open-swap'] = {
      offerId: 'f0'.repeat(32),
      kernel: { accepted: true, status: 'live', code: null, reason: null },
      legSegment: 0,
      proveSeconds: 35,
      expiresAt: Date.now() + 3_600_000,
      bytes: 20000,
    };
    const legs = orderLegs('sell', STOCK, USDC, 2n * U, parsePrice('1.05', USDC));
    const rec = await makeOffer(e, ACCOUNT, legs, { stock: STOCK, usdc: USDC });

    expect(signed).toHaveLength(1);
    expect(signed[0]!.primaryType).toBe('OpenSwapShielded');
    const [sub] = relay.submitted;
    expect(sub!.action).toBe('open-swap');
    const p = sub!.request.payload as Record<string, string> & { coin: Record<string, string> };
    expect(p).toMatchObject({
      giveColor: STOCK.midnightColour,
      giveAmount: '2000000',
      wantColor: USDC.midnightColour,
      wantAmount: '2100000',
      validUntil: '0',
      authNonce: '4',
    });
    expect(p.coin).toMatchObject({ nonce: '01'.repeat(32), value: '3000000' });
    // The relay can rebuild the digest from the payload, and it recovers to the wallet.
    const call = openSwapGatedCall({ account: ACCOUNT, authNonce: 4n, evmDomainSalt: SALT }, w.address, p as never);
    expect(call.digestHex).toBe(signed[0]!.digest);
    expect(recoverAddress(call.digestHex, signed[0]!.signature)).toBe(w.address);
    expect(sub!.request.passportAuth).toMatchObject({ owner: w.address.toLowerCase(), useCounter: '2' });
    // Both entries open with the account's secret: the 2.10 wUSDC wanted, and the 1 wStkA change.
    const want = await openEntryPortable(sk, hexToBytes(p.wantEntry, 192));
    const change = await openEntryPortable(sk, hexToBytes(p.changeEntry, 192));
    expect(want).toMatchObject({ value: 2_100_000n });
    expect(bytesToHex(want!.nonce)).toBe(p.wantNonce);
    expect(change).toMatchObject({ value: 1_000_000n });
    // My offers holds it as live; the coin is NOT spent and the counter does not move.
    expect(rec).toMatchObject({ role: 'make', state: 'live', summary: 'sell 2.00 wStkA at 1.05' });
    expect(readCoins(e.store, e.scope, ACCOUNT).every((c) => !c.spent)).toBe(true);
    expect(readRoster(e.store, e.scope, ACCOUNT)).toEqual({ useCounter: '0' });
  });

  it('refuses a second offer while one is live (Q9), without asking the wallet', async () => {
    const { relay, e, signed } = await setup();
    relay.results['open-swap'] = {
      offerId: 'f0'.repeat(32),
      kernel: { accepted: true, status: 'live', code: null, reason: null },
      legSegment: 0,
      proveSeconds: 35,
      expiresAt: Date.now() + 3_600_000,
      bytes: 1,
    };
    await makeOffer(e, ACCOUNT, orderLegs('sell', STOCK, USDC, 2n * U, parsePrice('1.05', USDC)), {
      stock: STOCK,
      usdc: USDC,
    });
    await expect(
      makeOffer(e, ACCOUNT, orderLegs('buy', STOCK, USDC, 1n * U, parsePrice('1', USDC)), { stock: STOCK, usdc: USDC }),
    ).rejects.toThrow(/one live offer at a time/);
    expect(signed).toHaveLength(1);
    expect(relay.submitted).toHaveLength(1);
    // And a withdrawal would warn that it cancels the offer (L-TRD.3).
    expect(guardFor(e, ACCOUNT, 'withdraw')).toMatchObject({ kind: 'warn' });
  });

  it('refuses an offer bigger than any single coin, naming the largest payment', async () => {
    const { e, signed } = await setup();
    // 12 wUSDC: the account holds 8 + 6, but no single coin of 12.
    const legs = orderLegs('buy', STOCK, USDC, 10n * U, parsePrice('1.2', USDC));
    await expect(makeOffer(e, ACCOUNT, legs, { stock: STOCK, usdc: USDC })).rejects.toThrow(
      'Needs 12.00 wUSDC from one coin; your largest single payment is 8.00.',
    );
    expect(signed).toHaveLength(0);
  });
});

describe('take an offer (L-TRD.2)', () => {
  it('buys a whole ask with ONE signature, pays from the smallest covering coin, and records the settlement', async () => {
    const { relay, e, signed } = await setup();
    relay.results.take = {
      offerId: 'e1'.repeat(32),
      txHash: 'aa'.repeat(32),
      proveSeconds: 36,
      cost: { blockUsage: '1', computeTimePs: '1', readTimePs: '1', feesSpecks: '1' },
      path: 'batcher',
    };
    const rec = await takeOffer(
      e,
      ACCOUNT,
      { offerId: 'e1'.repeat(32), side: 'ask', stockRaw: 5n * U, usdcRaw: 5_250_000n },
      { stock: STOCK, usdc: USDC },
    );
    expect(signed).toHaveLength(1);
    const [sub] = relay.submitted;
    expect(sub!.action).toBe('take');
    expect(sub!.request.payload).toMatchObject({
      offerId: 'e1'.repeat(32),
      giveColor: USDC.midnightColour,
      giveAmount: '5250000',
      wantColor: STOCK.midnightColour,
      wantAmount: '5000000',
      coin: { nonce: '03'.repeat(32), value: '6000000' }, // 6 covers 5.25; 8 would leave more change
    });
    expect(rec).toMatchObject({ role: 'take', state: 'filled', settledTx: 'aa'.repeat(32), side: 'buy' });
    expect(readRoster(e.store, e.scope, ACCOUNT)).toEqual({ useCounter: '3' });
  });

  it('a take cancels this account’s live offer', async () => {
    const { relay, e } = await setup();
    relay.results['open-swap'] = {
      offerId: 'f0'.repeat(32),
      kernel: { accepted: true, status: 'live', code: null, reason: null },
      legSegment: 0,
      proveSeconds: 1,
      expiresAt: Date.now() + 3_600_000,
      bytes: 1,
    };
    relay.results.take = {
      offerId: 'e1'.repeat(32),
      txHash: 'aa'.repeat(32),
      proveSeconds: 1,
      cost: {},
      path: 'batcher',
    };
    await makeOffer(e, ACCOUNT, orderLegs('sell', STOCK, USDC, 2n * U, parsePrice('1.05', USDC)), {
      stock: STOCK,
      usdc: USDC,
    });
    expect(guardFor(e, ACCOUNT, 'take')).toMatchObject({ kind: 'warn' });
    await takeOffer(
      e,
      ACCOUNT,
      { offerId: 'e1'.repeat(32), side: 'ask', stockRaw: U, usdcRaw: U },
      {
        stock: STOCK,
        usdc: USDC,
      },
    );
    const own = readTrades(e.store, e.scope, ACCOUNT).find((t) => t.role === 'make')!;
    expect(own.state).toBe('cancelled');
  });

  it('an offer too big for any coin is refused before the wallet is asked', async () => {
    const { e, signed } = await setup();
    await expect(
      takeOffer(
        e,
        ACCOUNT,
        { offerId: 'e1'.repeat(32), side: 'ask', stockRaw: 9n * U, usdcRaw: 9n * U },
        {
          stock: STOCK,
          usdc: USDC,
        },
      ),
    ).rejects.toThrow('Needs 9.00 wUSDC from one coin; your largest single payment is 8.00.');
    expect(signed).toHaveLength(0);
  });
});

describe('reconciling My offers (FR-011: whoever settles it)', () => {
  it('marks the offer filled when its wanted coin reaches the inbox, with the settling transaction', async () => {
    const { relay, e, pk } = await setup();
    relay.results['open-swap'] = {
      offerId: 'f0'.repeat(32),
      kernel: { accepted: true, status: 'live', code: null, reason: null },
      legSegment: 0,
      proveSeconds: 1,
      expiresAt: Date.now() + 3_600_000,
      bytes: 1,
    };
    const rec = await makeOffer(e, ACCOUNT, orderLegs('sell', STOCK, USDC, 2n * U, parsePrice('1.05', USDC)), {
      stock: STOCK,
      usdc: USDC,
    });
    const kernel = { offerStatus: async () => 'live' as const };
    expect(await reconcileOffers(e, ACCOUNT, kernel)).toEqual([]);

    // Someone takes it: the circuit files the wanted coin (and the change) in the inbox, and the
    // offer's coin is spent in the same transaction.
    const payload = relay.submitted[0]!.request.payload as { wantNonce: string };
    await addInbox(relay, pk, [
      { nonce: payload.wantNonce, color: USDC.midnightColour, value: 2_100_000n },
      { nonce: '09'.repeat(32), color: STOCK.midnightColour, value: 1n * U },
    ]);
    relay.zswapActivity.outputs.at(-2)!.txHash = 'settle-tx';
    relay.state.authNonce = '5';
    const changed = await reconcileOffers(e, ACCOUNT, { offerStatus: async () => 'consumed' as const });
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ offerId: rec.offerId, state: 'filled', settledTx: 'settle-tx' });
    const usdc = readCoins(e.store, e.scope, ACCOUNT).filter((c) => c.color === USDC.midnightColour && !c.spent);
    expect(usdc.map((c) => c.value).sort()).toEqual(['2100000', '6000000', '8000000']);
  });

  it('fills in the settling transaction later when the exchange says consumed before the inbox shows the coin', async () => {
    const { relay, e, pk } = await setup();
    relay.results['open-swap'] = {
      offerId: 'f0'.repeat(32),
      kernel: { accepted: true, status: 'live', code: null, reason: null },
      legSegment: 0,
      proveSeconds: 1,
      expiresAt: Date.now() + 3_600_000,
      bytes: 1,
    };
    await makeOffer(e, ACCOUNT, orderLegs('sell', STOCK, USDC, 2n * U, parsePrice('1.05', USDC)), {
      stock: STOCK,
      usdc: USDC,
    });
    const consumed = { offerStatus: async () => 'consumed' as const };
    const [first] = await reconcileOffers(e, ACCOUNT, consumed);
    expect(first).toMatchObject({ state: 'filled' });
    expect(first!.settledTx).toBeUndefined();
    const payload = relay.submitted[0]!.request.payload as { wantNonce: string };
    await addInbox(relay, pk, [{ nonce: payload.wantNonce, color: USDC.midnightColour, value: 2_100_000n }]);
    relay.zswapActivity.outputs.at(-1)!.txHash = 'late-tx';
    const [second] = await reconcileOffers(e, ACCOUNT, consumed);
    expect(second).toMatchObject({ state: 'filled', settledTx: 'late-tx' });
  });

  it('marks it cancelled when another signed call moved the nonce, and expired after its TTL', async () => {
    const { relay, e } = await setup();
    relay.results['open-swap'] = {
      offerId: 'f0'.repeat(32),
      kernel: { accepted: true, status: 'live', code: null, reason: null },
      legSegment: 0,
      proveSeconds: 1,
      expiresAt: Date.now() + 3_600_000,
      bytes: 1,
    };
    await makeOffer(e, ACCOUNT, orderLegs('sell', STOCK, USDC, 2n * U, parsePrice('1.05', USDC)), {
      stock: STOCK,
      usdc: USDC,
    });
    relay.state.authNonce = '5';
    const [c] = await reconcileOffers(e, ACCOUNT, { offerStatus: async () => 'live' as const });
    expect(c).toMatchObject({ state: 'cancelled' });

    const second = await setup();
    second.relay.results['open-swap'] = {
      offerId: 'f1'.repeat(32),
      kernel: { accepted: true, status: 'live', code: null, reason: null },
      legSegment: 0,
      proveSeconds: 1,
      expiresAt: Date.now() + 1000,
      bytes: 1,
    };
    await makeOffer(second.e, ACCOUNT, orderLegs('sell', STOCK, USDC, 2n * U, parsePrice('1.05', USDC)), {
      stock: STOCK,
      usdc: USDC,
    });
    const [x] = await reconcileOffers(
      second.e,
      ACCOUNT,
      { offerStatus: async () => 'live' as const },
      Date.now() + 5000,
    );
    expect(x).toMatchObject({ state: 'expired' });
  });
});
