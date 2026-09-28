// Plan L-ACC.2/.4: the relay's account reads. The Zswap activity keeps only the account's own
// leaves (with their exact positions) and spends, once each, and the reads route answers 404 for
// an unknown account, 501 without a key volume, 503 when the chain cannot be read, and 501
// `history-too-long` for an account with a full indexer page of actions (no paging yet, Q27).

import { describe, expect, it } from 'vitest';

import {
  AccountHistoryTooLongError,
  IndexerClient,
  IndexerError,
  zswapActivityOf,
  type DecodedEvent,
  type RawActionTx,
} from '../src/chain/indexer.js';
import { accountStateView, inboxPageOf, type ChainReader, type LedgerView } from '../src/chain/reader.js';
import { harness } from './harness.js';

const ME = 'aa'.repeat(32);
const OTHER = 'bb'.repeat(32);

const events: Record<string, DecodedEvent> = {
  e1: { tag: 'zswapOutput', commitment: `0x${'01'.repeat(32)}`, contract: ME, mtIndex: 12n },
  e2: { tag: 'zswapOutput', commitment: '02'.repeat(32), contract: undefined, mtIndex: 13n }, // a wallet's output
  e3: { tag: 'zswapOutput', commitment: '03'.repeat(32), contract: OTHER, mtIndex: 14n }, // another contract's
  e4: { tag: 'zswapInput', nullifier: '04'.repeat(32), contract: ME },
  e5: { tag: 'zswapInput', nullifier: '05'.repeat(32), contract: undefined },
  e6: { tag: 'dustSpendProcessed' },
};
const decode = (raw: string) => events[raw]!;

describe('zswapActivityOf', () => {
  it("keeps the account's own leaves and spends, with their transactions", () => {
    const txs: RawActionTx[] = [
      {
        hash: 't1',
        blockHeight: 5,
        events: [
          { id: 1, raw: 'e1' },
          { id: 2, raw: 'e2' },
          { id: 3, raw: 'e3' },
        ],
      },
      {
        hash: 't2',
        blockHeight: 9,
        events: [
          { id: 5, raw: 'e5' },
          { id: 4, raw: 'e4' },
          { id: 6, raw: 'e6' },
        ],
      },
    ];
    expect(zswapActivityOf(ME, txs, decode, 20)).toEqual({
      account: ME,
      outputs: [{ commitment: '01'.repeat(32), mtIndex: '12', txHash: 't1', blockHeight: 5 }],
      inputs: [{ nullifier: '04'.repeat(32), txHash: 't2', blockHeight: 9 }],
      transactions: 2,
      blockHeight: 20,
    });
  });

  it('counts an event once even when two actions share its transaction', () => {
    const tx: RawActionTx = { hash: 't1', blockHeight: 5, events: [{ id: 1, raw: 'e1' }] };
    expect(zswapActivityOf(ME, [tx, tx], decode, 5).outputs).toHaveLength(1);
  });
});

describe('IndexerClient.accountTransactions', () => {
  const fakeFetch = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("returns the account's transactions once each, oldest first", async () => {
    const tx = (hash: string, height: number) => ({
      transaction: { hash, block: { height }, zswapLedgerEvents: [{ id: height, raw: 'ab' }] },
    });
    const c = new IndexerClient({
      indexerUrl: 'http://indexer',
      fetchImpl: fakeFetch({
        data: { contract: { actions: [tx('b', 9), tx('a', 5), tx('b', 9)] }, block: { height: 11 } },
      }),
    });
    const r = await c.accountTransactions(ME);
    expect(r?.tip).toBe(11);
    expect(r?.txs.map((t) => [t.hash, t.blockHeight])).toEqual([
      ['a', 5],
      ['b', 9],
    ]);
  });

  it('answers null for an unknown contract, and throws on indexer errors', async () => {
    expect(
      await new IndexerClient({
        indexerUrl: 'http://i',
        fetchImpl: fakeFetch({ data: { contract: null, block: null } }),
      }).accountTransactions(ME),
    ).toBeNull();
    await expect(
      new IndexerClient({
        indexerUrl: 'http://i',
        fetchImpl: fakeFetch({ errors: [{ message: 'boom' }] }),
      }).accountTransactions(ME),
    ).rejects.toThrow('boom');
    await expect(
      new IndexerClient({ indexerUrl: 'http://i', fetchImpl: fakeFetch({}, 502) }).accountTransactions(ME),
    ).rejects.toThrow('502');
  });

  it('refuses a full page of actions with its own error (no paging yet, Q27)', async () => {
    const actions = Array.from({ length: 3 }, (_, i) => ({
      transaction: { hash: `t${i}`, block: { height: i }, zswapLedgerEvents: [] },
    }));
    const full = new IndexerClient({
      indexerUrl: 'http://i',
      maxActions: 3,
      fetchImpl: fakeFetch({ data: { contract: { actions }, block: { height: 9 } } }),
    });
    const e = await full.accountTransactions(ME).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AccountHistoryTooLongError);
    expect(e).toBeInstanceOf(IndexerError);
    expect((e as AccountHistoryTooLongError).limit).toBe(3);
    // One action fewer than a page is read as usual.
    const under = new IndexerClient({
      indexerUrl: 'http://i',
      maxActions: 4,
      fetchImpl: fakeFetch({ data: { contract: { actions }, block: { height: 9 } } }),
    });
    expect((await under.accountTransactions(ME))?.txs).toHaveLength(3);
  });
});

describe('account state and inbox views', () => {
  const ledger: LedgerView = {
    booted: true,
    device_count: 1n,
    device_epoch: 0n,
    auth_nonce: 2n,
    inbox_count: 3n,
    enc_key: Uint8Array.from(Buffer.from('cc'.repeat(32), 'hex')),
    evm_domain_salt: Uint8Array.from(Buffer.from('dd'.repeat(32), 'hex')),
    vault_address: { bytes: Uint8Array.from(Buffer.from('ee'.repeat(32), 'hex')) },
    devices: [Uint8Array.from(Buffer.from('f1'.repeat(32), 'hex'))],
    inbox: {
      member: (k) => k !== 1n,
      lookup: (k) => new Uint8Array(192).fill(Number(k) + 1),
    },
  };

  it('renders the public state as hex and decimal strings', () => {
    expect(accountStateView(ME, ledger)).toEqual({
      account: ME,
      booted: true,
      deviceCount: 1,
      deviceEpoch: '0',
      devices: ['f1'.repeat(32)],
      authNonce: '2',
      inboxCount: '3',
      encKey: 'cc'.repeat(32),
      vault: 'ee'.repeat(32),
      evmDomainSalt: 'dd'.repeat(32),
    });
  });

  it('pages the inbox, with null where an index is empty', () => {
    const page = inboxPageOf(ME, ledger, 0, 10);
    expect(page.total).toBe(3);
    expect(page.entries.map((e) => (e === null ? null : e.slice(0, 2)))).toEqual(['01', null, '03']);
    expect(inboxPageOf(ME, ledger, 2, 10).entries).toHaveLength(1);
  });
});

describe('GET /v1/accounts/:account/*', () => {
  const chain = (over: Partial<ChainReader>): ChainReader => ({
    accountState: async () => null,
    inbox: async () => null,
    zswap: async () => null,
    ...over,
  });

  it('serves the reads, 404 for an unknown account, 503 when the chain fails', async () => {
    const h = harness({
      chain: chain({
        zswap: async (a) => ({ account: a, outputs: [], inputs: [], transactions: 0, blockHeight: 1 }),
        inbox: async () => {
          throw new Error('indexer down');
        },
      }),
    });
    expect((await h.app.request(`/v1/accounts/${ME}/zswap`)).status).toBe(200);
    expect((await h.app.request(`/v1/accounts/${ME}/state`)).status).toBe(404);
    const down = await h.app.request(`/v1/accounts/${ME}/inbox`);
    expect(down.status).toBe(503);
    expect(JSON.stringify(await down.json())).not.toContain('indexer down'); // no internals leak
    expect((await h.app.request('/v1/accounts/nothex/zswap')).status).toBe(400);
  });

  it('says 501 without a key volume', async () => {
    const h = harness();
    expect((await h.app.request(`/v1/accounts/${ME}/zswap`)).status).toBe(501);
  });

  it('says 501 history-too-long, not "chain unavailable", for an account beyond one indexer page (Q27)', async () => {
    const h = harness({
      chain: chain({
        zswap: async () => {
          throw new AccountHistoryTooLongError(500);
        },
      }),
    });
    const res = await h.app.request(`/v1/accounts/${ME}/zswap`);
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('history-too-long');
    expect(body.error.message).toContain('500 or more actions');
  });
});
