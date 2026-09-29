// A believable customer for the visual tests (plan P1.5): a connected wallet with Sepolia
// balances, a Passport account whose inbox holds real sealed entries (so the page's own inbox
// walk rebuilds the coins), a change coin waiting to be recorded, and the markets book of the
// L-MKT fixture. Everything is served through page.route: no relay, kernel or chain is used,
// and nothing leaves the page's origin.

import type { Page } from '@playwright/test';
import { x25519 } from '@noble/curves/ed25519.js';

import { BOOK, COLOUR, type WireOffer } from '../../packages/core/test/fixtures/kernel/book.js';
import { KernelFixture, STREAM_HEADERS, connectedEvent } from '../../packages/core/test/fixtures/kernel/mock-kernel.js';
import { contractCoinCommitment, localCoin, reconcileCoins } from '../../packages/core/src/coins.js';
import { bytesToHex, hexToBytes } from '../../packages/core/src/hex.js';
import { evmDeviceEntry } from '../../packages/core/src/passport/gated.js';
import { sealEntryPortable } from '../../vendor/passport/contract/src/wallet/deposit.js';
import { encodeRecord, recordKey } from '../../web/src/store/schema.js';
import { installTestWallet, type TestWallet } from './test-wallet.js';

export const KERNEL = 'https://stagenet.api-zswap.zkdojo.com';
export const VAULT_EVM = '0x648216975e722494bff92e88ffc68c8f8d438faa';
const DEPOSIT_JOB = '7'.repeat(32);
export const ACCOUNT = 'e8d3a41c7b5f09e2d6c3b8a1f0e4d7c2b9a6f3e0d1c8b5a2f9e6d3c0b7a42d09';

/** The stagenet registry's Sepolia token addresses (lowercase), for the fake balanceOf. */
export const SEPOLIA = {
  stkA: '0x2ab7be0769e3bbd5c7d047b422cb383fcc06fb52',
  stkB: '0xf2beff36543219c8fec2ab2f42070aa65d3c844b',
  stkC: '0x70c5c1978e5d428fa5c82111980e1af0a64a270d',
  USDC: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
  TBILL: '0x1531b11722cf9b600816ed0eacbc49594dbb991f',
  TB13W: '0x5cf366deca552c30ebb2504d0b9ee104a99f1c72',
  TB26W: '0x26db7221903e62310409e454442adbb46e0b6e33',
  TB52W: '0x02a0d1baf66351715a84ac4763b82f1155bdd5b0',
} as const;

const units = (whole: number) => BigInt(Math.round(whole * 1_000_000));

/** Refuse (and record) anything that would leave the page's origin, and serve the mock kernel. */
export async function serveExchange(page: Page, opts: { kernelDown?: boolean; book?: WireOffer[] } = {}) {
  const external: string[] = [];
  const fixture = new KernelFixture({ book: opts.book ?? BOOK });
  await page.route(
    (url) => url.hostname !== '127.0.0.1',
    (route) => {
      external.push(route.request().url());
      return route.abort('blockedbyclient');
    },
  );
  await page.route(`${KERNEL}/**`, (route) => {
    const url = new URL(route.request().url());
    if (opts.kernelDown) return route.abort('connectionrefused');
    if (url.pathname === '/v1/offers/stream') {
      return route.fulfill({ status: 200, headers: STREAM_HEADERS, body: connectedEvent() });
    }
    const r = fixture.respond(url.pathname + url.search);
    return route.fulfill({ status: r.status, headers: r.headers, body: r.body });
  });
  return { external };
}

export interface Customer {
  wallet: TestWallet;
  account: string | null;
}

/**
 * Connect-ready customer. With `withAccount`, the browser already holds the account record and
 * its secret (as after an Import), and the relay's account reads answer with sealed entries for
 * wStkA 60 + 40, wStkB 35.50, wStkC 12 and wUSDC 11 + 9.50, plus a 0.50 wUSDC change coin that
 * has no inbox entry yet (it shows under Pending). With `withTbills` (plan 00046), the customer
 * also holds the T-bills: on Sepolia, and TBILL 25 and TB13W 10 in the account.
 */
export async function installCustomer(
  page: Page,
  opts: { withAccount: boolean; withTransfers?: boolean; withTrades?: boolean; withTbills?: boolean },
): Promise<Customer> {
  const wallet = await installTestWallet(page, {
    startChainId: '0xaa36a7',
    sepolia: {
      ethWei: 412_310_000_000_000_000n,
      erc20: {
        [SEPOLIA.stkA]: units(989_690),
        [SEPOLIA.stkB]: units(989_880),
        [SEPOLIA.stkC]: units(999_900),
        [SEPOLIA.USDC]: units(20),
        ...(opts.withTbills
          ? {
              [SEPOLIA.TBILL]: units(1_000),
              [SEPOLIA.TB13W]: units(500),
              [SEPOLIA.TB26W]: units(250),
              [SEPOLIA.TB52W]: units(125),
            }
          : {}),
      },
      // The bank's vault account on Sepolia holds gas for withdrawals.
      others: { eth: { [VAULT_EVM]: 1_428_415_000_000_000n } },
    },
  });
  if (!opts.withAccount) return { wallet, account: null };

  const sk = x25519.utils.randomSecretKey();
  const pk = x25519.getPublicKey(sk);
  const nonce = (i: number) => i.toString(16).padStart(2, '0').repeat(32);
  const coins = [
    { color: COLOUR.wStkA, value: units(60) },
    { color: COLOUR.wStkA, value: units(40) },
    { color: COLOUR.wStkB, value: units(35.5) },
    { color: COLOUR.wStkC, value: units(12) },
    { color: COLOUR.wUSDC, value: units(11) },
    { color: COLOUR.wUSDC, value: units(9.5) },
    ...(opts.withTbills
      ? [
          { color: COLOUR.TBILL, value: units(25) },
          { color: COLOUR.TB13W, value: units(10) },
        ]
      : []),
  ].map((c, i) => ({ ...c, nonce: nonce(i + 1) }));
  const entries = await Promise.all(
    coins.map(async (c) =>
      bytesToHex(
        await sealEntryPortable(pk, { nonce: hexToBytes(c.nonce), color: hexToBytes(c.color), value: c.value }),
      ),
    ),
  );
  const change = localCoin({ nonce: nonce(99), color: COLOUR.wUSDC, value: units(0.5).toString() }, ACCOUNT);
  const outputs = [...coins.map((c) => ({ ...c, value: c.value.toString() })), change].map((c, i) => ({
    commitment: contractCoinCommitment(c, ACCOUNT),
    mtIndex: String(4700 + i * 13),
    txHash: nonce(0x40 + i),
    blockHeight: 648_000 + i,
  }));

  const scope = { network: 'stagenet', evmAddress: wallet.address };
  const now = Date.now();
  const seed: Array<[string, string]> = [
    [
      recordKey(scope, 'account', { account: ACCOUNT }),
      encodeRecord(
        'account',
        {
          address: ACCOUNT,
          device: wallet.address.toLowerCase(),
          network: 'stagenet',
          vault: '7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637',
          createdAt: now - 3 * 86_400_000,
        },
        now - 3 * 86_400_000,
      ),
    ],
    [
      recordKey(scope, 'secret', { account: ACCOUNT }),
      encodeRecord('secret', { encSecretKey: bytesToHex(sk), encPublicKey: bytesToHex(pk) }, now - 3 * 86_400_000),
    ],
    // The coin list as the page's last inbox walk left it (the Accounts page walks again on open).
    [
      recordKey(scope, 'coins', { account: ACCOUNT }),
      encodeRecord(
        'coins',
        reconcileCoins({
          account: ACCOUNT,
          inbox: coins.map((c, i) => ({
            nonce: c.nonce,
            color: c.color,
            value: c.value.toString(),
            inboxIndex: String(i),
          })),
          outputs,
          inputs: [],
          previous: [change],
        }),
        now - 3_600_000,
      ),
    ],
    [recordKey(scope, 'roster', { account: ACCOUNT }), encodeRecord('roster', { useCounter: '14' }, now - 3_600_000)],
  ];
  if (opts.withTransfers) seed.push(...transferRecords(scope, wallet.address, now));
  if (opts.withTrades) seed.push(...tradeRecords(scope, now));
  await page.addInitScript((pairs) => {
    if (sessionStorage.getItem('mn-visual-seeded')) return; // seed once per tab, not on reloads
    for (const [k, v] of pairs) localStorage.setItem(k, v);
    sessionStorage.setItem('mn-visual-seeded', '1');
  }, seed);

  // The running deposit's relay job: still waiting for Sepolia finality.
  await page.route(`**/v1/jobs/${DEPOSIT_JOB}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        job: {
          requestId: DEPOSIT_JOB,
          action: 'bridge-deposit',
          lane: 'deposit',
          state: 'running',
          stage: 'evm-broadcast',
          stages: runningDepositStages(Math.floor(now / 1000)),
          createdAt: Math.floor(now / 1000) - 540,
          updatedAt: Math.floor(now / 1000) - 60,
          expiresAt: Math.floor(now / 1000) + 3600,
        },
      }),
    }),
  );
  await page.route(`**/v1/accounts/${ACCOUNT}/**`, (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.endsWith('/state')) {
      return json({
        account: ACCOUNT,
        booted: true,
        deviceCount: 1,
        deviceEpoch: '0',
        // The connected wallet is the account's device, at the roster's use counter (14), so the
        // page can build a signed call (plan P4-A: the error walkthroughs take an offer).
        devices: [evmDeviceEntry(ACCOUNT, wallet.address, 0n, 14n)],
        authNonce: '14',
        inboxCount: String(entries.length),
        encKey: bytesToHex(pk),
        vault: '7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637',
        evmDomainSalt: '5a'.repeat(32),
      });
    }
    if (url.pathname.endsWith('/inbox')) {
      const from = Number(url.searchParams.get('from') ?? 0);
      return json({ account: ACCOUNT, from, entries: entries.slice(from), total: entries.length });
    }
    if (url.pathname.endsWith('/zswap')) {
      return json({ account: ACCOUNT, outputs, inputs: [], transactions: outputs.length, blockHeight: 648_100 });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });
  return { wallet, account: ACCOUNT };
}

/** Connect through the wallet menu, as a customer would. */
export async function connect(page: Page): Promise<void> {
  await page.getByTestId('connect').click();
  await page.getByTestId('wallet-option').filter({ hasText: 'MN Test Wallet' }).click();
  await page.getByTestId('wallet-chain').waitFor();
}

const REQUEST = `077e${'5c'.repeat(28)}e216`;

function runningDepositStages(t: number) {
  return [
    { stage: 'queued', at: t - 540 },
    { stage: 'running', at: t - 538 },
    { stage: 'preflight', at: t - 536, detail: { evmNonce: '0' } },
    { stage: 'starting', at: t - 530, detail: { circuit: 'bridge_deposit_start_with_evm' } },
    {
      stage: 'started',
      at: t - 450,
      detail: { tx: 'mid-start', txHash: `4c39${'a0'.repeat(28)}3a7f`, requestId: REQUEST },
    },
    { stage: 'mpc-signed', at: t - 402, detail: { signedTx: `0x53a3${'b1'.repeat(28)}320f`, evmNonce: '0' } },
    {
      stage: 'evm-broadcast',
      at: t - 390,
      detail: { evmTx: `0x63bd${'c2'.repeat(28)}606f`, evmBlock: '9284117', evmStatus: '1' },
    },
  ];
}

/** A deposit in flight, a finished withdrawal and a refunded one, as this browser keeps them. */
function transferRecords(scope: { network: string; evmAddress: string }, evm: string, now: number) {
  const t = Math.floor(now / 1000);
  const base = { account: ACCOUNT, decimals: 6, createdAt: now, updatedAt: now };
  const done = (kind: 'deposit' | 'withdraw', at: number) => [
    { stage: 'queued', at },
    { stage: 'running', at: at + 2 },
    { stage: 'preflight', at: at + 3, detail: { evmNonce: '4' } },
    {
      stage: 'started',
      at: at + 80,
      detail: { txHash: `9d${'e3'.repeat(30)}01`, requestId: `66${'f4'.repeat(30)}7c` },
    },
    { stage: 'mpc-signed', at: at + 170, detail: { signedTx: `0x67${'a5'.repeat(30)}4a`, evmNonce: '4' } },
    { stage: 'evm-broadcast', at: at + 180, detail: { evmTx: `0x67${'a5'.repeat(30)}4a`, evmBlock: '9270551' } },
    { stage: 'evm-final', at: at + 1000, detail: { evmBlock: '9270551', finalizedBlock: '9270600' } },
    { stage: 'attested', at: at + 1100, detail: { kind: 'success' } },
    {
      stage: 'settled',
      at: at + 1180,
      detail: { txHash: `00${'93'.repeat(30)}8e`, circuit: `bridge_${kind}_complete` },
    },
    { stage: 'succeeded', at: at + 1181 },
  ];
  const records = [
    {
      ...base,
      id: 'visual-deposit-1',
      kind: 'deposit',
      symbol: 'stkA',
      midnightName: 'wStkA',
      erc20: '0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52',
      colour: COLOUR.wStkA,
      amount: String(units(25)),
      depositAddress: '0x54b08cd00e09226e7c456943b2d5ba7ce8df46c1',
      createdAt: now - 540_000,
      state: 'running',
      funding: { tokenTx: `0xa559${'d6'.repeat(28)}cba6`, gasTx: `0x2566${'e7'.repeat(28)}fd6a` },
      jobIds: [DEPOSIT_JOB],
      requestId: REQUEST,
      stages: runningDepositStages(t),
    },
    {
      ...base,
      id: 'visual-withdraw-1',
      kind: 'withdraw',
      symbol: 'stkB',
      midnightName: 'wStkB',
      erc20: '0xF2bEFf36543219C8feC2AB2f42070AA65D3C844B',
      colour: COLOUR.wStkB,
      amount: String(units(5)),
      dest: evm,
      createdAt: now - 86_400_000,
      state: 'succeeded',
      applied: true,
      jobIds: ['8'.repeat(32)],
      requestId: `66${'f4'.repeat(30)}7c`,
      stages: done('withdraw', t - 86_400),
      result: { kind: 'withdraw', settleCircuit: 'bridge_withdraw_complete', attested: 'success' },
    },
  ];
  return records.map(
    (r) =>
      [recordKey(scope, 'bridge', { account: ACCOUNT, id: r.id }), encodeRecord('bridge', r, r.createdAt)] as [
        string,
        string,
      ],
  );
}

/** My offers as this browser keeps them: a live offer of the account, and an offer it took. */
function tradeRecords(scope: { network: string; evmAddress: string }, now: number) {
  const base = { stock: COLOUR.wStkA, usdc: COLOUR.wUSDC, coin: 'c0'.repeat(32), authNonce: '14' };
  const records = [
    {
      ...base,
      offerId: 'f1'.repeat(32),
      role: 'make',
      side: 'sell',
      stockRaw: String(units(2)),
      usdcRaw: String(units(2.2)),
      summary: 'sell 2.00 wStkA at 1.10',
      wantNonce: 'f2'.repeat(32),
      createdAt: now - 600_000,
      expiresAt: now + 3_000_000,
      status: 'live',
      kernelStatus: 'live',
    },
    {
      ...base,
      offerId: 'f3'.repeat(32),
      role: 'take',
      side: 'buy',
      stockRaw: String(units(5)),
      usdcRaw: String(units(4.85)),
      summary: 'buy 5.00 wStkA at 0.97',
      wantNonce: 'f4'.repeat(32),
      createdAt: now - 86_400_000,
      expiresAt: now - 86_400_000,
      status: 'filled',
      kernelStatus: 'consumed',
      settledTx: `44${'21'.repeat(30)}c9`,
    },
  ];
  return records.map(
    (r) =>
      [
        recordKey(scope, 'offer', { account: ACCOUNT, id: `${r.role}-${r.offerId}` }),
        encodeRecord('offer', r, r.createdAt),
      ] as [string, string],
  );
}
