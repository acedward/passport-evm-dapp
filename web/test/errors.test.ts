// Plan P4-A, error states, the browser half: every way the bank, the exchange, the MPC, the wallet
// or the browser can stop an action has one clear, specific sentence, and the page learns what the
// bank closed on its own (Q21 A). The walkthroughs in the browser are test/e2e/errors.spec.ts.

import { beforeEach, describe, expect, it } from 'vitest';

import { STAGENET, type BridgeClosedResponse, type HealthResponse } from '@mnbank/core';

import { outcomeText } from '../src/bridge/messages.js';
import { pollTransfer, type BridgeEnv } from '../src/bridge/operations.js';
import { readTransfer, writeTransfer, type TransferRecord } from '../src/bridge/records.js';
import { WrongNetworkError, ensureChain, signTypedData, type OperationEnv } from '../src/passport/operations.js';
import { RelayClient, RelayError } from '../src/relay/client.js';
import { jobErrorText, relayErrorText, sentence } from '../src/relay/messages.js';
import { bankNotices, spendingPaused, withdrawalsPaused, type BankState } from '../src/relay/status.js';
import { storageText } from '../src/store/messages.js';
import { LocalStore, StoreFullError } from '../src/store/store.js';

const ACCOUNT = '70a62b7d0ceca7905a50f5539c5484f3f77aae6e67cf7a5a87d5eeb6887c2a30';

function health(over: Partial<HealthResponse> = {}): HealthResponse {
  return {
    status: 'ok',
    network: 'stagenet',
    version: 'v',
    uptimeSeconds: 1,
    sponsor: { configured: true, state: 'synced', synced: true, dustSpecks: '1', dustLow: false },
    proofServer: {
      reachable: true,
      version: '9.0.0-rc.6',
      jobCapacity: 10,
      keys: { present: true, fingerprint: null, pinned: false, matchesPin: null },
    },
    queue: { jobs: 0, lanes: {} },
    kernel: { reachable: true, synced: true },
    batcher: { reachable: true, lastRefusal: null },
    vaultGas: { address: STAGENET.bridge.vaultEvmAddress, balanceWei: '10000000000000000', low: false },
    ...over,
  };
}
const ok = (h: HealthResponse): BankState => ({ health: h, reachable: true, checkedAt: 1 });

describe('the relay’s refusals, in words', () => {
  it('says what happened and what to do, for each code', () => {
    const t = (code: string, extra: Partial<Parameters<typeof relayErrorText>[0]> = {}) =>
      relayErrorText({ status: 400, code, message: 'raw', ...extra });
    expect(t('unreachable')).toMatch(/could not be reached.*nothing was sent/);
    expect(t('rate-limited', { status: 429, retryAfterSeconds: 12 })).toBe(
      'The bank is getting too many requests from this connection. Wait 12 s and try again; nothing was sent.',
    );
    expect(t('rate-limited', { status: 429 })).toMatch(/Wait a minute/);
    expect(t('sponsor-low', { status: 503 })).toMatch(/low on the network-fee funds \(DUST\).*paused new actions/);
    expect(t('sponsor-unavailable', { status: 503 })).toMatch(/still starting up/);
    expect(t('busy', { status: 503 })).toMatch(/at capacity/);
    expect(t('unauthorised', { status: 401, detail: 'expired' })).toMatch(/older state of your account/);
    expect(t('unauthorised', { status: 401, detail: 'replayed' })).toMatch(/already used/);
    expect(t('unauthorised', { status: 401, detail: 'wrong-signer' })).toMatch(/not from a device of this account/);
    expect(t('unauthorised', { status: 401, detail: 'unknown-nonce' })).toMatch(/restarted since this was signed/);
    expect(relayErrorText({ status: 502, code: 'error', message: '' })).toBe(
      'The bank answered with an error (HTTP 502). Try again later.',
    );
    expect(t('not-found', { message: 'no such job' })).toBe('No such job.');
    expect(sentence('the exchange refused it')).toBe('The exchange refused it.');
  });

  it('the relay client carries the sentence, the code and Retry-After', async () => {
    const client = new RelayClient(
      'http://relay.test',
      (async () =>
        new Response(
          JSON.stringify({ error: { code: 'rate-limited', message: 'too many requests; try again shortly' } }),
          {
            status: 429,
            headers: { 'retry-after': '7' },
          },
        )) as unknown as typeof fetch,
    );
    const e = await client.nonce().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RelayError);
    expect((e as RelayError).code).toBe('rate-limited');
    expect((e as RelayError).retryAfterSeconds).toBe(7);
    expect((e as RelayError).message).toMatch(/Wait 7 s/);
    expect((e as RelayError).relayMessage).toBe('too many requests; try again shortly');
    const down = new RelayClient('http://relay.test', (async () => {
      throw new TypeError('failed to fetch');
    }) as unknown as typeof fetch);
    await expect(down.health()).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('reads /health, whether the relay says ok or down', async () => {
    const h = health({ status: 'down' });
    const client = new RelayClient(
      'http://relay.test',
      (async () => new Response(JSON.stringify(h), { status: 503 })) as unknown as typeof fetch,
    );
    expect((await client.health()).status).toBe('down');
  });

  it('words failed jobs of the exchange and the internal error', () => {
    expect(
      jobErrorText(
        {
          code: 'exchange-busy',
          message: "the exchange's settlement service is not taking more settlements right now",
        },
        'x',
      ),
    ).toBe("The exchange's settlement service is not taking more settlements right now.");
    expect(jobErrorText({ code: 'internal-error', message: 'the relay could not complete this request' }, 'x')).toMatch(
      /could not complete this.*ask the bank/,
    );
    expect(jobErrorText(undefined, 'Fallback.')).toBe('Fallback.');
  });
});

describe('what /health pauses, and says', () => {
  it('nothing when all is well', () => {
    expect(bankNotices(ok(health()))).toEqual([]);
    expect(spendingPaused(ok(health()))).toBeNull();
    expect(bankNotices({ health: null, reachable: null, checkedAt: null })).toEqual([]);
  });

  it('the bank unreachable, its prover down, its fee wallet low or syncing: every paid action pauses', () => {
    const down = bankNotices({ health: null, reachable: false, checkedAt: 1 });
    expect(down.map((n) => [n.id, n.place])).toEqual([['relay-down', 'shell']]);
    expect(spendingPaused({ health: null, reachable: false, checkedAt: 1 })).toMatch(/cannot be reached/);

    const prover = health({ proofServer: { ...health().proofServer, reachable: false } });
    expect(bankNotices(ok(prover)).map((n) => n.id)).toEqual(['prover-down']);
    expect(spendingPaused(ok(prover))).toMatch(/prover is not available/);

    const low = health({ sponsor: { ...health().sponsor, dustLow: true } });
    expect(bankNotices(ok(low))[0]).toMatchObject({ id: 'sponsor-low', place: 'shell', tone: 'danger' });
    expect(spendingPaused(ok(low))).toMatch(/low on network-fee funds.*DUST/);

    const syncing = health({ sponsor: { ...health().sponsor, synced: false, state: 'syncing' } });
    expect(bankNotices(ok(syncing)).map((n) => n.id)).toEqual(['sponsor-syncing']);
    expect(spendingPaused(ok(syncing))).toMatch(/starting up/);
  });

  it('the vault’s EVM account low on gas pauses withdrawals only, naming its balance', () => {
    const s = ok(health({ vaultGas: { address: '0x', balanceWei: '1070000000000000', low: true } }));
    const [n] = bankNotices(s);
    expect(n).toMatchObject({ id: 'vault-gas-low', place: 'transfers' });
    expect(n!.text).toContain('it holds 0.00107 ETH');
    expect(withdrawalsPaused(s)).toMatch(/Withdrawals to Sepolia are paused/);
    expect(spendingPaused(s)).toBeNull();
  });

  it('a slow MPC, and the exchange’s settlement service down, at its limit (429) or failing (500)', () => {
    const mpc = ok(
      health({
        bridge: {
          available: true,
          mpc: { lastSignatureAfterSeconds: 1300, timeouts24h: 2, inFlight: 1 },
          staleRequests: {
            enabled: true,
            lastScanAt: 1,
            open: { deposit: 0, withdraw: 0 },
            waiting: 0,
            closing: 0,
            closed24h: 0,
            maxPerDay: 24,
            recent: [],
            paused: null,
          },
        },
      }),
    );
    expect(bankNotices(mpc)[0]).toMatchObject({ id: 'mpc-slow', place: 'transfers' });
    expect(bankNotices(mpc)[0]!.text).toMatch(/^2 transfers waited more than 20 minutes/);

    expect(bankNotices(ok(health({ batcher: { reachable: false } })))[0]).toMatchObject({
      id: 'batcher-down',
      place: 'trade',
    });
    const now = 10_000;
    const busy = ok(health({ batcher: { reachable: true, lastRefusal: { httpStatus: 429, at: now - 60 } } }));
    expect(bankNotices(busy, now)[0]).toMatchObject({ id: 'batcher-refusing' });
    expect(bankNotices(busy, now)[0]!.text).toMatch(/HTTP 429/);
    const failing = ok(health({ batcher: { reachable: true, lastRefusal: { httpStatus: 500, at: now - 60 } } }));
    expect(bankNotices(failing, now)[0]!.title).toMatch(/failing/);
    expect(bankNotices(failing, now)[0]!.text).toMatch(/HTTP 500/);
    // An old refusal is not news.
    expect(bankNotices(failing, now + 7_200)).toEqual([]);
  });
});

describe('local storage blocked or full', () => {
  it('has one wording per cause', () => {
    expect(storageText('blocked').text).toMatch(/private window/);
    expect(storageText('full').title).toMatch(/no room left/);
    expect(storageText('unavailable').title).toMatch(/no local storage/);
  });

  it('a write that finds the storage full says so, and what to do', () => {
    const map = new Map<string, string>();
    const full = {
      get length() {
        return map.size;
      },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (k !== 'mn-bank/schema') {
          const e = new Error('quota');
          e.name = 'QuotaExceededError';
          throw e;
        }
        map.set(k, v);
      },
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
    } as Storage;
    const store = new LocalStore(full);
    const scope = { network: 'stagenet', evmAddress: '0x484738A67858305Edfc139B194Ed430Fe4D8e56b' };
    expect(() => store.put(scope, 'profile', { firstSeen: 1 })).toThrow(StoreFullError);
    expect(() => store.put(scope, 'profile', { firstSeen: 1 })).toThrow(/no room left.*Export your data/);
  });
});

describe('the wallet on another network', () => {
  const env = (chain: string) => {
    const calls: string[] = [];
    return {
      calls,
      env: {
        chainId: 11155111,
        owner: '0x484738A67858305Edfc139B194Ed430Fe4D8e56b',
        provider: {
          async request({ method }: { method: string }) {
            calls.push(method);
            if (method === 'eth_chainId') return chain;
            return `0x${'11'.repeat(65)}`;
          },
        },
      } as unknown as OperationEnv,
    };
  };

  it('refuses before any signature is asked for, naming both chains', async () => {
    const wrong = env('0x1');
    const e = await signTypedData(wrong.env, { domain: {} }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WrongNetworkError);
    expect((e as Error).message).toBe(
      'Your wallet is on another network (chain 1). Switch it to Sepolia (chain 11155111) and try again; nothing was signed or sent.',
    );
    expect(wrong.calls).toEqual(['eth_chainId']);
    const right = env('0xaa36a7');
    await expect(ensureChain(right.env)).resolves.toBeUndefined();
    await expect(signTypedData(right.env, { domain: {} })).resolves.toMatch(/^0x/);
    expect(right.calls).toEqual(['eth_chainId', 'eth_chainId', 'eth_signTypedData_v4']);
  });
});

describe('a transfer the bank closed (Q21 A)', () => {
  let storage: Storage;
  beforeEach(() => {
    window.localStorage.clear();
    storage = window.localStorage;
  });

  const base = (over: Partial<TransferRecord>): TransferRecord => ({
    id: 't1',
    kind: 'withdraw',
    account: ACCOUNT,
    symbol: 'stkA',
    midnightName: 'wStkA',
    erc20: '0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52',
    colour: '5e'.repeat(32),
    decimals: 6,
    amount: '1000000',
    dest: '0x484738A67858305Edfc139B194Ed430Fe4D8e56b',
    createdAt: 1,
    updatedAt: 1,
    state: 'needs-resume',
    jobIds: ['00000000000000000000000000000001'],
    requestId: 'ab'.repeat(32),
    stages: [],
    error: { code: 'job-lost', message: 'The bank restarted while your transfer was in progress.' },
    ...over,
  });

  function setup(closed: BridgeClosedResponse | null) {
    const asked: string[] = [];
    const relay = {
      async job() {
        return null;
      },
      async bridgeClosed(id: string) {
        asked.push(id);
        return closed;
      },
      async bridgeQuote() {
        throw new Error('not used');
      },
    };
    const e = {
      relay: relay as unknown as RelayClient,
      store: new LocalStore(storage),
      scope: { network: 'stagenet', evmAddress: '0x484738A67858305Edfc139B194Ed430Fe4D8e56b' },
      provider: { request: async () => null },
      owner: '0x484738A67858305Edfc139B194Ed430Fe4D8e56b',
      chainId: 11155111,
      network: STAGENET,
    } as unknown as BridgeEnv;
    return { e, asked };
  }

  const refund: BridgeClosedResponse = {
    requestId: 'ab'.repeat(32),
    kind: 'withdraw',
    closedAt: 1_700_000_000,
    closedBy: 'relay',
    attested: 'never-executed',
    settleCircuit: 'bridge_withdraw_refund',
    settleTx: 'tx-settle',
    evmTxHash: null,
    minted: true,
  };

  it('a transfer waiting to be resumed learns the bank closed it, and says a stale request was closed', async () => {
    const { e, asked } = setup(refund);
    const rec = writeTransfer(e.store, e.scope, base({}));
    const next = await pollTransfer(e, rec);
    expect(asked).toEqual(['ab'.repeat(32)]);
    expect(next.state).toBe('succeeded');
    expect(next.result).toMatchObject({ closedBy: 'relay', settleCircuit: 'bridge_withdraw_refund', coin: null });
    expect(next.stages.at(-1)).toMatchObject({ stage: 'settled', detail: { by: 'bank', tx: 'tx-settle' } });
    const o = outcomeText(next);
    expect(o?.text).toMatch(
      /^A stale request was closed: the bank finished this transfer after it was left open\. Refunded/,
    );
  });

  it('asks at most once a minute while nothing is closed', async () => {
    const { e, asked } = setup(null);
    const rec = writeTransfer(e.store, e.scope, base({}));
    await pollTransfer(e, rec);
    await pollTransfer(e, readTransfer(e.store, e.scope, ACCOUNT, 't1')!);
    expect(asked).toHaveLength(1);
    expect(readTransfer(e.store, e.scope, ACCOUNT, 't1')?.state).toBe('needs-resume');
  });

  it('a running transfer whose job was lost finds it closed instead of asking to resume', async () => {
    const { e } = setup({
      ...refund,
      kind: 'withdraw',
      settleCircuit: 'bridge_withdraw_complete',
      attested: 'success',
      minted: false,
      closedBy: 'owner',
    });
    const rec = writeTransfer(e.store, e.scope, base({ state: 'running' }));
    const next = await pollTransfer(e, rec);
    expect(next.state).toBe('succeeded');
    expect(outcomeText(next)?.text).toBe('1.00 stkA sent to 0x484738A67858305Edfc139B194Ed430Fe4D8e56b on Sepolia.');
  });

  it('a never-executed deposit abandoned in the vault: nothing minted, deposit again, the tokens wait', () => {
    const t = base({
      kind: 'deposit',
      state: 'succeeded',
      result: {
        kind: 'deposit',
        account: ACCOUNT,
        requestId: 'ab'.repeat(32),
        startTx: null,
        attested: 'never-executed',
        evmTxHash: null,
        settleTx: 'tx-abandon',
        settleCircuit: 'abandonDeposit',
        coin: null,
        change: null,
        entryMatchesCoin: true,
        closedBy: 'owner',
      },
    });
    expect(outcomeText(t)).toEqual({
      kind: 'info',
      text: 'Sig Network reported that the sweep never ran on Sepolia, so nothing was minted and the request is closed: you can deposit again. Your stkA is still at your deposit address, where your next deposit will use it.',
    });
  });
});
