// Plan L-TRD testing, the UI half in CI: the Trade page against a MOCKED relay and exchange (served
// through page.route) and an injected EIP-1193 test wallet (key random per run). The account's coins
// come from a real inbox walk: entries sealed in this test to a key the page holds, and ledger
// outputs whose commitments the page recomputes.
//
//   - make: "Sell 2 wStkA at 1.05", pre-filled from the best ask, the exact legs shown, ONE
//     OpenSwapShielded signature, My offers shows it live; a second offer is refused; a withdrawal
//     warns that it cancels the offer (and nothing is signed when the customer declines);
//   - take: "Buy at best ask" takes the whole 10 wStkA ask for 10.50 wUSDC with ONE signature;
//     lines one coin cannot pay are "Not takeable", with the reason; the Markets Take link opens
//     the Trade page on that offer;
//   - reconcile: an outside taker fills the offer; Refresh shows it Filled, with the settling tx.
//
// The same flows run LIVE on the staging exchange in L-TRD.0 (test/live/trade/).

import { expect, test, type Page, type Route } from '@playwright/test';

import { contractCoinCommitment, contractCoinNullifier } from '../../packages/core/src/coins.js';
import { bytesToHex, hexToBytes } from '../../packages/core/src/hex.js';
import { evmDeviceEntry } from '../../packages/core/src/passport/gated.js';
import { BOOK, COLOUR } from '../../packages/core/test/fixtures/kernel/book.js';
import { KernelFixture, STREAM_HEADERS, connectedEvent } from '../../packages/core/test/fixtures/kernel/mock-kernel.js';
import { sealEntryPortable } from '../../vendor/passport/contract/src/wallet/deposit.js';
import { installTestWallet, type TestWallet } from './test-wallet.js';

const RELAY = 'http://relay.test';
const KERNEL = 'https://stagenet.api-zswap.zkdojo.com';
const ACCOUNT = 'ac'.repeat(32);
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};
const U = 1_000_000n;

interface Coin {
  nonce: string;
  color: string;
  value: bigint;
}

class MockBank {
  submitted: Array<{ action: string; body: Record<string, unknown> }> = [];
  entries: string[] = [];
  outputs: Array<{ commitment: string; mtIndex: string; txHash: string; blockHeight: number }> = [];
  inputs: Array<{ nullifier: string; txHash: string; blockHeight: number }> = [];
  authNonce = 4n;
  offerStatus: Record<string, string> = {};
  constructor(
    readonly device: string,
    readonly pk: Uint8Array,
  ) {}

  async add(coins: Coin[], txHash: string) {
    for (const c of coins) {
      this.entries.push(
        bytesToHex(
          await sealEntryPortable(this.pk, { nonce: hexToBytes(c.nonce), color: hexToBytes(c.color), value: c.value }),
        ),
      );
      this.outputs.push({
        commitment: contractCoinCommitment({ nonce: c.nonce, color: c.color, value: c.value.toString() }, ACCOUNT),
        mtIndex: String(100 + this.outputs.length),
        txHash,
        blockHeight: 10,
      });
    }
  }
  spend(c: Coin, txHash: string) {
    this.inputs.push({
      nullifier: contractCoinNullifier({ nonce: c.nonce, color: c.color, value: c.value.toString() }, ACCOUNT),
      txHash,
      blockHeight: 11,
    });
  }

  state() {
    return {
      account: ACCOUNT,
      booted: true,
      deviceCount: 1,
      deviceEpoch: '0',
      devices: [evmDeviceEntry(ACCOUNT, this.device, 0n, 0n)],
      authNonce: this.authNonce.toString(),
      inboxCount: String(this.entries.length),
      encKey: bytesToHex(this.pk),
      vault: '77'.repeat(32),
      evmDomainSalt: '5a'.repeat(32),
    };
  }

  result(action: string, body: Record<string, unknown>): { stages: string[]; result: Record<string, unknown> } {
    const p = body.payload as Record<string, string>;
    if (action === 'open-swap') {
      const offerId = 'f0'.repeat(32);
      this.offerStatus[offerId] = 'live';
      return {
        stages: ['proving', 'proven', 'posted', 'listed'],
        result: {
          offerId,
          kernel: { accepted: true, status: 'live', code: null, reason: null },
          legSegment: 0,
          proveSeconds: 35,
          expiresAt: Date.now() + 3_600_000,
          bytes: 21_000,
        },
      };
    }
    if (action === 'take') {
      return {
        stages: ['offer-checked', 'proving', 'merged', 'settled'],
        result: {
          offerId: p.offerId,
          txHash: 'aa'.repeat(32),
          proveSeconds: 36,
          cost: { blockUsage: '30000', computeTimePs: '1', readTimePs: '1', feesSpecks: '1' },
          path: 'batcher',
        },
      };
    }
    return { stages: [], result: { txId: 'mid-x', change: null } };
  }

  async handle(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (url.pathname.endsWith('/state')) return json(200, this.state());
    if (url.pathname.endsWith('/inbox'))
      return json(200, { account: ACCOUNT, from: 0, entries: this.entries, total: this.entries.length });
    if (url.pathname.endsWith('/zswap'))
      return json(200, {
        account: ACCOUNT,
        outputs: this.outputs,
        inputs: this.inputs,
        transactions: this.outputs.length,
        blockHeight: 20,
      });
    const action = /^\/v1\/actions\/(.+)$/.exec(url.pathname)?.[1];
    if (action && req.method() === 'POST') {
      const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>;
      this.submitted.push({ action, body });
      const id = String(this.submitted.length).padStart(32, '0');
      return json(202, { job: this.view(id, false) });
    }
    const job = /^\/v1\/jobs\/([0-9a-f]{32})$/.exec(url.pathname)?.[1];
    if (job) return json(200, { job: this.view(job, true) });
    return json(404, { error: { code: 'not-found', message: 'no such route' } });
  }

  view(id: string, done: boolean) {
    const s = this.submitted[Number(id) - 1]!;
    const { stages, result } = this.result(s.action, s.body);
    const base = {
      requestId: id,
      action: s.action,
      lane: 'prover',
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 9_999_999_999,
    };
    if (!done) return { ...base, state: 'queued', stage: 'queued', stages: [{ stage: 'queued', at: 1 }] };
    return {
      ...base,
      state: 'succeeded',
      stage: 'succeeded',
      stages: [...['queued', 'running', ...stages].map((stage) => ({ stage, at: 1 })), { stage: 'succeeded', at: 2 }],
      result,
    };
  }
}

const signatures = (w: TestWallet) => w.calls.filter((c) => c.method === 'eth_signTypedData_v4');

/** The account holds 3 wStkA (one coin) and 11 + 6 wUSDC (two coins). */
const HELD: Coin[] = [
  { nonce: '01'.repeat(32), color: COLOUR.wStkA, value: 3n * U },
  { nonce: '02'.repeat(32), color: COLOUR.wUSDC, value: 11n * U },
  { nonce: '03'.repeat(32), color: COLOUR.wUSDC, value: 6n * U },
];

async function open(page: Page, hash = '#trade') {
  const { x25519 } = await import('@noble/curves/ed25519.js');
  const sk = x25519.utils.randomSecretKey();
  const pk = x25519.getPublicKey(sk);
  const fixture = new KernelFixture();
  await page.route(
    (url) => url.hostname !== '127.0.0.1',
    (route) => route.abort('blockedbyclient'),
  );
  await page.route('**/config.json', (r) => r.fulfill({ json: { network: 'stagenet', relayUrl: RELAY } }));
  const wallet = await installTestWallet(page, { startChainId: '0xaa36a7' });
  const bank = new MockBank(wallet.address, pk);
  await bank.add(HELD, 'fund-tx');
  await page.route(`${RELAY}/**`, (r) => bank.handle(r));
  await page.route(`${KERNEL}/**`, (route) => {
    const url = new URL(route.request().url());
    const status = /^\/v1\/offers\/([0-9a-f]{64})\/status$/.exec(url.pathname)?.[1];
    if (status)
      return route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({ offerId: status, status: bank.offerStatus[status] ?? 'not_found' }),
      });
    if (url.pathname === '/v1/offers/stream')
      return route.fulfill({ status: 200, headers: STREAM_HEADERS, body: connectedEvent() });
    const r = fixture.respond(url.pathname + url.search);
    return route.fulfill({ status: r.status, headers: { ...r.headers, ...CORS }, body: r.body });
  });
  const evm = wallet.address.toLowerCase();
  const base = `mn-bank/v1/stagenet/${evm}/${ACCOUNT}`;
  const rec = (kind: string, data: unknown) => JSON.stringify({ v: 1, kind, updatedAt: 1, data });
  await page.addInitScript(
    ([b, entries]) => {
      if (localStorage.getItem('mn-bank/schema')) return;
      localStorage.setItem('mn-bank/schema', '1');
      for (const [k, v] of entries as unknown as Array<[string, string]>) localStorage.setItem(`${b}/${k}`, v);
    },
    [
      base,
      [
        [
          'account',
          rec('account', { address: ACCOUNT, device: evm, network: 'stagenet', vault: '77'.repeat(32), createdAt: 1 }),
        ],
        ['secret', rec('secret', { encSecretKey: bytesToHex(sk), encPublicKey: bytesToHex(pk) })],
        ['roster', rec('roster', { useCounter: '0' })],
        ['coins', rec('coins', [])],
      ],
    ] as const,
  );
  await page.goto(`/${hash}`);
  await page.getByTestId('connect').click();
  await page.getByTestId('wallet-option').filter({ hasText: 'MN Test Wallet' }).click();
  return { wallet, bank, fixture };
}

const line = (page: Page, offerId: string) => page.locator(`[data-testid=trade-line][data-offer="${offerId}"]`);
const ASK_10 = BOOK.find(
  (o) => o.computed.gives[0]!.token === COLOUR.wStkA && o.computed.gives[0]!.amount === '10000000',
)!;
const ASK_20 = BOOK.find(
  (o) => o.computed.gives[0]!.token === COLOUR.wStkA && o.computed.gives[0]!.amount === '20000000',
)!;
const BID_10 = BOOK.find(
  (o) => o.computed.wants[0]!.token === COLOUR.wStkA && o.computed.wants[0]!.amount === '10000000',
)!;

test.describe('Trade (mocked relay and exchange)', () => {
  test.setTimeout(120_000);

  test('make: sell 2 wStkA at the best ask with ONE signature; a second offer is refused; a withdrawal warns', async ({
    page,
  }) => {
    const { wallet, bank } = await open(page);
    await expect(page.getByTestId('section-trade')).toBeVisible();
    await expect(line(page, ASK_10.offerId)).toBeVisible(); // the book and the coins are loaded

    await page.getByTestId('side-buy').check();
    await page.getByTestId('side-sell').check(); // pre-fills the best ask
    await expect(page.getByTestId('make-price')).toHaveValue('1.05');
    await page.getByTestId('make-quantity').fill('2');
    await expect(page.getByTestId('legs-give')).toHaveText('2.00 wStkA');
    await expect(page.getByTestId('legs-want')).toHaveText('2.10 wUSDC');
    await expect(page.getByTestId('legs-price')).toContainText('1.05 wUSDC per wStkA');
    await page.getByTestId('make-sign').click();
    await expect(page.getByTestId('trade-message')).toContainText(
      'Your offer is on the exchange: sell 2.00 wStkA at 1.05',
    );

    const sigs = signatures(wallet);
    expect(sigs).toHaveLength(1);
    expect(JSON.parse(String((sigs[0]!.params as string[])[1])).primaryType).toBe('OpenSwapShielded');
    expect(bank.submitted.map((s) => s.action)).toEqual(['open-swap']);
    expect(bank.submitted[0]!.body.payload).toMatchObject({
      giveColor: COLOUR.wStkA,
      giveAmount: '2000000',
      wantColor: COLOUR.wUSDC,
      wantAmount: '2100000',
    });
    const mine = page.locator('[data-testid=my-trade][data-role=make]');
    await expect(mine).toHaveAttribute('data-state', 'live');
    await expect(page.getByTestId('live-offer-banner')).toContainText('sell 2.00 wStkA at 1.05');

    // A second offer is refused (Q9), before any signature.
    await page.getByTestId('make-quantity').fill('1');
    await expect(page.getByTestId('make-refused')).toContainText('one live offer at a time');
    await expect(page.getByTestId('make-sign')).toBeDisabled();

    // A withdrawal warns that it cancels the offer; declining signs nothing (L-TRD.3).
    await page.getByTestId('tab-accounts').click();
    await page.locator('[data-testid=send-midnight] summary').click();
    await page.getByTestId('send-token').selectOption(COLOUR.wUSDC);
    await page.getByTestId('send-amount').fill('1');
    await page.getByTestId('send-recipient').fill('11'.repeat(32));
    let warned = '';
    page.once('dialog', (d) => {
      warned = d.message();
      void d.dismiss();
    });
    await page.getByTestId('send-submit').click();
    await expect.poll(() => warned).toContain('This withdrawal cancels your live offer (sell 2.00 wStkA at 1.05)');
    await page.waitForTimeout(300);
    expect(signatures(wallet)).toHaveLength(1);
    expect(bank.submitted).toHaveLength(1);
  });

  test('take: buy the whole best ask with ONE signature; what one coin cannot pay is not takeable, with the reason', async ({
    page,
  }) => {
    const { wallet, bank } = await open(page);
    await expect(line(page, ASK_10.offerId).getByTestId('take-line')).toBeVisible();
    // 22 wUSDC for the 20 wStkA ask: the account's coins are 11 and 6.
    await expect(line(page, ASK_20.offerId).getByTestId('not-takeable')).toHaveText(
      'Not takeable: Needs 22.00 wUSDC from one coin; your largest single payment is 11.00.',
    );
    // Selling into the 10 wStkA bid needs a 10 wStkA coin; the account has 3.
    await expect(line(page, BID_10.offerId).getByTestId('not-takeable')).toContainText(
      'Needs 10.00 wStkA from one coin; your largest single payment is 3.00.',
    );
    await expect(page.getByTestId('sell-best-bid')).toBeDisabled();

    await page.getByTestId('buy-best-ask').click();
    const confirm = page.getByTestId('take-confirm');
    await expect(confirm).toHaveAttribute('data-offer', ASK_10.offerId);
    await expect(confirm.getByTestId('legs-give')).toHaveText('10.50 wUSDC');
    await expect(confirm.getByTestId('legs-want')).toHaveText('10.00 wStkA');
    // After the take, the relay's ledger: the 11 wUSDC coin spent, 10 wStkA and 0.5 wUSDC arrive.
    bank.spend(HELD[1]!, 'aa'.repeat(32));
    await confirm.getByTestId('take-sign').click();
    await expect(page.getByTestId('trade-message')).toContainText('settled in one transaction');
    expect(signatures(wallet)).toHaveLength(1);
    expect(bank.submitted.map((s) => s.action)).toEqual(['take']);
    expect(bank.submitted[0]!.body.payload).toMatchObject({
      offerId: ASK_10.offerId,
      giveColor: COLOUR.wUSDC,
      giveAmount: '10500000',
      wantColor: COLOUR.wStkA,
      wantAmount: '10000000',
      coin: { nonce: HELD[1]!.nonce, value: '11000000' },
    });
    const taken = page.locator('[data-testid=my-trade][data-role=take]');
    await expect(taken).toHaveAttribute('data-state', 'filled');
    await expect(taken.getByTestId('my-trade-tx')).toContainText('aaaaaaaa');
  });

  test('the Markets Take link opens the Trade page on that offer', async ({ page }) => {
    await open(page, '#markets');
    await page.locator('[data-testid=market-row][data-stock=wStkA] [data-testid=open-book]').click();
    await page.locator(`[data-testid=book-line][data-offer="${ASK_10.offerId}"] [data-testid=take]`).click();
    await expect(page.getByTestId('section-trade')).toBeVisible();
    await page.getByTestId('take-picked').click();
    await expect(page.getByTestId('take-confirm')).toHaveAttribute('data-offer', ASK_10.offerId);
  });

  test('reconcile: an outside taker fills the offer; Refresh shows it filled with the settling transaction', async ({
    page,
  }) => {
    const { bank } = await open(page);
    await expect(line(page, ASK_10.offerId)).toBeVisible();
    await page.getByTestId('make-quantity').fill('2');
    await page.getByTestId('make-price').fill('1.05');
    await page.getByTestId('make-sign').click();
    await expect(page.locator('[data-testid=my-trade][data-role=make]')).toHaveAttribute('data-state', 'live');

    // Someone else takes it: the circuit files the wanted coin and the change; the nonce moves.
    const p = bank.submitted[0]!.body.payload as { wantNonce: string };
    bank.spend(HELD[0]!, 'bb'.repeat(32));
    await bank.add(
      [
        { nonce: p.wantNonce, color: COLOUR.wUSDC, value: 2_100_000n },
        { nonce: '09'.repeat(32), color: COLOUR.wStkA, value: 1n * U },
      ],
      'bb'.repeat(32),
    );
    bank.authNonce += 1n;
    bank.offerStatus['f0'.repeat(32)] = 'consumed';
    await page.getByTestId('reconcile').click();
    const mine = page.locator('[data-testid=my-trade][data-role=make]');
    await expect(mine).toHaveAttribute('data-state', 'filled');
    await expect(mine.getByTestId('my-trade-tx')).toContainText('bbbbbbbb');
    await expect(page.getByTestId('trade-message')).toContainText('was filled');
  });
});
