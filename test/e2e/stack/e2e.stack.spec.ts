// Plan P4-C, the local end-to-end (P4.1): the whole product on a LOCAL ledger-9 stack with the
// ZSwap kernel and batcher, driven the way a customer drives it — through the page, which talks to
// the relay over HTTP — with two injected EIP-1193 test wallets (random keys, fresh every run).
// Never in CI's hosted jobs: test/stack/run-e2e.sh brings the stack, the relay and the signals up.
//
//   1. two customers open accounts at once: one signature each; the second waits in the relay's
//      queue and sees its position (US1 #4); both read back booted, one device, enc_key;
//   2. the harness funds them with deposit_shielded (A: 10 stock, B: 10 USDC) and seeds the local
//      kernel with a wallet maker's BID (0.95) and a stock-to-stock offer;
//   3. Markets equals a manual computation over the local kernel's GET /v1/offers; the second stock
//      (a stock-to-stock offer only) shows "No liquidity" (SC-002, US3);
//   4. A sells 2 stock at 1.05 (one signature; proven guaranteed, posted to the LOCAL kernel); the
//      ask shows on Markets and still equals the manual computation (SC-004);
//   5. B takes it whole through the LOCAL batcher (`midnight-balancer`): one signature, one
//      transaction; the kernel marks the offer consumed (US8);
//   6. both pages reconcile: B holds 2 stock + 7.9 USDC, A 8 stock + 2.1 USDC, A's offer is Filled
//      with the same settling transaction, which holds both accounts' spends and new coins; the
//      pair's last trade is the offer's price;
//   7. Export -> CLEAR ALL -> Import on B restores the same balances (SC-005);
//   8. the harness stops the kernel: Markets says "exchange unavailable".
//
// Public values only are written (addresses, transaction ids, offer ids, timings) to E2E_OUT_DIR.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { evmDeviceEntry } from '../../../packages/core/src/passport/gated.js';
import { installTestWallet, type TestWallet } from '../test-wallet.js';

const RELAY = process.env.STACK_RELAY_URL ?? '';
const KERNEL = process.env.STACK_KERNEL_URL ?? '';
const SIGNALS = process.env.STACK_SIGNAL_DIR ?? join(process.cwd(), 'test-results', 'e2e-signals');
const OUT = process.env.E2E_OUT_DIR ?? join(process.cwd(), 'test-results', 'e2e');
const TOKENS = process.env.STACK_TOKENS_JSON
  ? (JSON.parse(process.env.STACK_TOKENS_JSON) as {
      tokens: Array<{ midnightName: string; role: 'usdc' | 'stock'; midnightColour: string; decimals: number }>;
    })
  : null;
const QTY = process.env.E2E_QTY ?? '2';
const PRICE = process.env.E2E_PRICE ?? '1.05';

test.skip(!RELAY || !KERNEL || !TOKENS, 'needs the local stack (test/stack/run-e2e.sh)');
test.setTimeout(90 * 60_000);

// ── helpers ─────────────────────────────────────────────────────────────────────────

const micro = (whole: string) => BigInt(Math.round(Number(whole) * 1e6)); // the local colours: 6 decimals
const signatures = (w: TestWallet) =>
  w.calls.filter((c) => c.method === 'eth_signTypedData_v4' || c.method === 'personal_sign').length;

async function signal(name: string, data: unknown) {
  await mkdir(SIGNALS, { recursive: true });
  await writeFile(join(SIGNALS, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
}
async function waitForSignal<T>(name: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return JSON.parse(await readFile(join(SIGNALS, `${name}.json`), 'utf8')) as T;
    } catch {
      if (Date.now() > deadline) throw new Error(`no ${name} signal after ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

const getJson = async <T = Record<string, unknown>>(url: string): Promise<T> => {
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return (await r.json()) as T;
};

const bankKeys = (page: Page) =>
  page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith('mn-bank/')) out[k] = localStorage.getItem(k)!;
    }
    return out;
  });
const trades = (page: Page) =>
  page.evaluate(() => {
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith('mn-bank/') && k.includes('/offer/'))
        out.push(JSON.parse(localStorage.getItem(k)!).data as Record<string, unknown>);
    }
    return out;
  });
const rowRaw = (page: Page, colour: string) =>
  page
    .locator(`[data-testid=passport-row][data-colour="${colour}"] [data-testid=passport-amount]`)
    .getAttribute('data-raw', { timeout: 5_000 })
    .catch(() => null);

// ── the exchange, read the way a person would ────────────────────────────────────────

interface WireLeg {
  token: string;
  amount: string;
  type: string;
}
interface WireOffer {
  offerId: string;
  computed: { gives: WireLeg[]; wants: WireLeg[] };
}

/** Every live offer on the local kernel, unfiltered (keyset paging). */
async function kernelOffers(): Promise<WireOffer[]> {
  const all: WireOffer[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const page: { offers: WireOffer[]; nextCursor: string | null } = await getJson(
      `${KERNEL}/v1/offers?limit=100${cursor ? `&after_hash=${cursor}` : ''}`,
    );
    all.push(...page.offers);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return all;
}

/** A person's computation over GET /v1/offers, written independently of the app's code (as in
 *  markets.spec.ts): only one-leg-per-side SHIELDED offers of USDC against the stock count; asks
 *  give the stock (price rounded up), bids give USDC (price rounded down); 6 decimals both. */
function manual(offers: WireOffer[], stock: string, usdc: string) {
  const asks: bigint[] = [];
  const bids: bigint[] = [];
  for (const o of offers) {
    const { gives, wants } = o.computed;
    if (gives.length !== 1 || wants.length !== 1) continue;
    const [g, w] = [gives[0]!, wants[0]!];
    if (g.type !== 'SHIELDED' || w.type !== 'SHIELDED') continue;
    if (g.token === stock && w.token === usdc)
      asks.push((BigInt(w.amount) * 1_000_000n + BigInt(g.amount) - 1n) / BigInt(g.amount));
    if (g.token === usdc && w.token === stock) bids.push((BigInt(g.amount) * 1_000_000n) / BigInt(w.amount));
  }
  const text = (m: bigint) => {
    const frac = (m % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
    return `${m / 1_000_000n}.${frac}`;
  };
  const min = asks.length ? asks.reduce((a, b) => (b < a ? b : a)) : null;
  const max = bids.length ? bids.reduce((a, b) => (b > a ? b : a)) : null;
  return {
    bestBid: max === null ? 'no bids' : text(max),
    bestAsk: min === null ? 'no asks' : text(min),
    counts: `${bids.length} / ${asks.length}`,
  };
}

const marketRow = (page: Page, stock: string) => page.locator(`[data-testid=market-row][data-stock=${stock}]`);
async function pageMarket(page: Page, stock: string) {
  const r = marketRow(page, stock);
  const t = async (id: string) => ((await r.getByTestId(id).textContent({ timeout: 5_000 })) ?? '').trim();
  return {
    bestBid: await t('best-bid'),
    bestAsk: await t('best-ask'),
    counts: await t('offer-counts'),
    status: await t('market-status'),
    lastTrade: await t('last-trade'),
  };
}

/** Markets equals the manual computation for every stock (re-read both sides until they agree:
 *  the page refreshes on the kernel's stream, a moment after the book changes). */
async function marketsMatchKernel(page: Page, stocks: Array<{ name: string; colour: string }>, usdc: string) {
  await page.getByTestId('tab-markets').click();
  await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  const seen: Record<string, unknown> = {};
  for (const s of stocks) {
    await expect
      .poll(
        async () => {
          const m = manual(await kernelOffers(), s.colour, usdc);
          const p = await pageMarket(page, s.name);
          seen[s.name] = { page: p, manual: m };
          return [p.bestBid, p.bestAsk, p.counts].join(' | ') === [m.bestBid, m.bestAsk, m.counts].join(' | ');
        },
        { timeout: 90_000, intervals: [2_000] },
      )
      .toBe(true);
  }
  return seen as Record<string, { page: Awaited<ReturnType<typeof pageMarket>>; manual: ReturnType<typeof manual> }>;
}

// ── the test ─────────────────────────────────────────────────────────────────────────

interface Seeded {
  colours: { stock: string; usdc: string; stock2: string };
  deposits: { A: { txId: string; coin: { value: string } }; B: { txId: string; coin: { value: string } } };
  offers: { bid: { offerId: string }; stockToStock: { offerId: string } };
}

test('P4-C: register, fund, make, take, markets, export — on the local stack', async ({ browser }, testInfo) => {
  const baseURL = String(testInfo.project.use.baseURL ?? `http://127.0.0.1:${process.env.E2E_PORT}`);
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const since = (t: number) => Math.round((Date.now() - t) / 100) / 10;
  const jobs = new Map<string, Record<string, unknown>>();

  const usdcToken = TOKENS!.tokens.find((t) => t.role === 'usdc')!;
  const stocks = TOKENS!.tokens.filter((t) => t.role === 'stock');
  const stock = stocks[0]!;
  const emptyStock = stocks[1] ?? null;
  const U = usdcToken.midnightColour.replace(/^0x/, '').toLowerCase();
  const S = stock.midnightColour.replace(/^0x/, '').toLowerCase();
  const stockList = stocks.map((s) => ({ name: s.midnightName, colour: s.midnightColour.replace(/^0x/, '') }));

  async function customer(who: 'A' | 'B') {
    const context = await browser.newContext({ baseURL, acceptDownloads: true });
    await context.route('**/config.json', (r) =>
      r.fulfill({ json: { network: 'undeployed', relayUrl: RELAY, tokens: TOKENS } }),
    );
    const page = await context.newPage();
    page.on('response', (res) => {
      if (!/\/v1\/(jobs|actions)\//.test(res.url())) return;
      res
        .json()
        .then((b: { job?: { requestId?: string } }) => {
          if (b?.job?.requestId) jobs.set(b.job.requestId, { who, ...b.job });
        })
        .catch(() => {});
    });
    const wallet = await installTestWallet(page, { startChainId: '0xaa36a7', sepolia: { ethWei: 5n * 10n ** 17n } });
    await page.goto('/#accounts');
    await page.getByTestId('connect').click();
    await page.getByTestId('wallet-option').filter({ hasText: 'MN Test Wallet' }).click();
    await expect(page.getByTestId('wallet-chain')).toHaveText('Sepolia');
    await expect(page.getByTestId('no-account')).toBeVisible();
    return { who, context, page, wallet };
  }
  const A = await customer('A');
  const B = await customer('B');
  expect(A.wallet.address).not.toBe(B.wallet.address);

  // ── 1. two registrations at once: one signature each; B queues behind A ─────────────
  let t = Date.now();
  await A.page.getByTestId('open-account').click();
  await expect(A.page.getByTestId('job-tracker')).toBeVisible({ timeout: 60_000 });
  await B.page.getByTestId('open-account').click();
  await expect(B.page.getByTestId('queue-position')).toBeVisible({ timeout: 60_000 });
  const queueText = ((await B.page.getByTestId('queue-position').textContent()) ?? '').trim();
  await expect(A.page.getByTestId('account-address')).toBeVisible({ timeout: 15 * 60_000 });
  timings.registerASeconds = since(t);
  await expect(B.page.getByTestId('account-address')).toBeVisible({ timeout: 15 * 60_000 });
  timings.registerBothSeconds = since(t);
  expect(signatures(A.wallet)).toBe(1);
  expect(signatures(B.wallet)).toBe(1);
  const accountOf = async (c: typeof A) => {
    const account = ((await c.page.getByTestId('account-address').textContent()) ?? '').trim();
    expect(account).toMatch(/^[0-9a-f]{64}$/);
    const state = await getJson(`${RELAY}/v1/accounts/${account}/state`);
    expect(state.booted).toBe(true);
    expect(state.deviceCount).toBe(1);
    expect(state.devices).toEqual([evmDeviceEntry(account, c.wallet.address, BigInt(String(state.deviceEpoch)), 0n)]);
    const stored = await c.page.evaluate(
      ([evm, acc]) => JSON.parse(localStorage.getItem(`mn-bank/v1/undeployed/${evm}/${acc}/secret`) ?? 'null'),
      [c.wallet.address.toLowerCase(), account],
    );
    expect(stored?.data?.encPublicKey).toBe(state.encKey);
    return account;
  };
  const accountA = await accountOf(A);
  const accountB = await accountOf(B);
  expect(accountA).not.toBe(accountB);
  await signal('registered', {
    A: { account: accountA, device: A.wallet.address.toLowerCase() },
    B: { account: accountB, device: B.wallet.address.toLowerCase() },
  });

  // ── 2. funded by the harness (deposit_shielded), and the kernel seeded ───────────────
  t = Date.now();
  const seeded = await waitForSignal<Seeded>('funded', 30 * 60_000);
  timings.fundAndSeedSeconds = since(t);
  expect(seeded.colours.stock).toBe(S);
  expect(seeded.colours.usdc).toBe(U);
  const fundStock = BigInt(seeded.deposits.A.coin.value);
  const fundUsdc = BigInt(seeded.deposits.B.coin.value);
  t = Date.now();
  await A.page.getByTestId('refresh-balances').click();
  await B.page.getByTestId('refresh-balances').click();
  await expect.poll(() => rowRaw(A.page, S), { timeout: 180_000 }).toBe(fundStock.toString());
  await expect.poll(() => rowRaw(B.page, U), { timeout: 180_000 }).toBe(fundUsdc.toString());
  timings.walkAfterFundSeconds = since(t);

  // ── 3. Markets = a manual computation over the local kernel ────────────────────────
  const marketsBefore = await marketsMatchKernel(A.page, stockList, U);
  expect(marketsBefore[stock.midnightName]!.page.bestBid).toBe('0.95'); // the seeded wallet bid
  if (emptyStock) {
    // Its only offer trades it against the first stock, never against USDC.
    await expect(marketRow(A.page, emptyStock.midnightName).getByTestId('market-status')).toHaveText('No liquidity');
  }

  // ── 4. A sells QTY stock at PRICE: one signature, posted to the local kernel ─────────
  const giveRaw = micro(QTY);
  const wantRaw = (micro(QTY) * micro(PRICE)) / 1_000_000n;
  await A.page.getByTestId('tab-trade').click();
  await A.page.getByTestId('trade-stock').selectOption(stock.midnightName);
  await A.page.getByTestId('side-sell').check();
  await A.page.getByTestId('make-quantity').fill(QTY);
  await A.page.getByTestId('make-price').fill(PRICE);
  await expect(A.page.getByTestId('make-sign')).toBeEnabled({ timeout: 5 * 60_000 });
  await expect(A.page.getByTestId('legs-give')).toHaveAttribute('data-raw', giveRaw.toString());
  await expect(A.page.getByTestId('legs-want')).toHaveAttribute('data-raw', wantRaw.toString());
  const sigsA = signatures(A.wallet);
  t = Date.now();
  await A.page.getByTestId('make-sign').click();
  await expect(A.page.getByTestId('trade-message')).toContainText('Your offer is on the exchange', {
    timeout: 20 * 60_000,
  });
  timings.makeClickToListedSeconds = since(t);
  expect(signatures(A.wallet) - sigsA).toBe(1);
  const made = (await trades(A.page)).find((x) => x.role === 'make' && x.status === 'live');
  expect(made?.offerId).toMatch(/^[0-9a-f]{64}$/);
  const offerId = String(made!.offerId);
  const statusAfterMake = await getJson<{ status: string }>(`${KERNEL}/v1/offers/${offerId}/status`);
  expect(statusAfterMake.status).toBe('live');

  const marketsAfterMake = await marketsMatchKernel(A.page, stockList, U);
  expect(marketsAfterMake[stock.midnightName]!.page.bestAsk).toBe(PRICE);
  await expect(marketRow(A.page, stock.midnightName).getByTestId('market-status')).toHaveText('Two-sided');
  await marketRow(A.page, stock.midnightName).getByTestId('open-book').click();
  const line = A.page.locator(`[data-testid=book-asks] [data-testid=book-line][data-offer="${offerId}"]`);
  await expect(line.getByTestId('line-price')).toHaveText(PRICE);

  // ── 5. B takes it whole through the local batcher: one signature, one transaction ───
  await B.page.getByTestId('tab-trade').click();
  await B.page.getByTestId('trade-stock').selectOption(stock.midnightName);
  const takeLine = B.page.locator(`[data-testid=trade-line][data-offer="${offerId}"]`);
  await expect(takeLine.getByTestId('take-line')).toBeVisible({ timeout: 5 * 60_000 });
  await takeLine.getByTestId('take-line').click();
  const confirm = B.page.getByTestId('take-confirm');
  await expect(confirm.getByTestId('legs-give')).toHaveAttribute('data-raw', wantRaw.toString());
  await expect(confirm.getByTestId('legs-want')).toHaveAttribute('data-raw', giveRaw.toString());
  const sigsB = signatures(B.wallet);
  t = Date.now();
  await confirm.getByTestId('take-sign').click();
  await expect(B.page.getByTestId('trade-message')).toContainText('settled in one transaction', {
    timeout: 20 * 60_000,
  });
  timings.takeClickToSettledSeconds = since(t);
  expect(signatures(B.wallet) - sigsB).toBe(1);
  const taken = (await trades(B.page)).find((x) => x.role === 'take' && x.offerId === offerId);
  expect(String(taken?.settledTx ?? '')).toMatch(/^[0-9a-f]{64,66}$/);
  t = Date.now();
  await expect
    .poll(async () => (await getJson<{ status: string }>(`${KERNEL}/v1/offers/${offerId}/status`)).status, {
      timeout: 300_000,
      intervals: [3_000],
    })
    .toBe('consumed');
  timings.settledToConsumedSeconds = since(t);

  // ── 6. both pages reconcile ─────────────────────────────────────────────────────────
  t = Date.now();
  await B.page.getByTestId('tab-accounts').click();
  await B.page.getByTestId('refresh-balances').click();
  await expect.poll(() => rowRaw(B.page, S), { timeout: 180_000 }).toBe(giveRaw.toString());
  await expect.poll(() => rowRaw(B.page, U), { timeout: 180_000 }).toBe((fundUsdc - wantRaw).toString());
  timings.takerReconcileSeconds = since(t);
  t = Date.now();
  await A.page.getByTestId('tab-trade').click();
  const mine = A.page.locator(`[data-testid=my-trade][data-role=make]`).first();
  for (let i = 0; i < 30; i++) {
    await A.page.getByTestId('reconcile').click();
    if (
      (await mine.getAttribute('data-state')) === 'filled' &&
      ((await mine.getByTestId('my-trade-tx').textContent()) ?? '—').trim() !== '—'
    )
      break;
    await A.page.waitForTimeout(5_000);
  }
  await expect(mine).toHaveAttribute('data-state', 'filled');
  const makerRecord = (await trades(A.page)).find((x) => x.role === 'make' && x.offerId === offerId);
  timings.makerReconcileSeconds = since(t);
  const settledTx = String(taken!.settledTx);
  expect(makerRecord?.settledTx).toBe(settledTx); // the maker's page names the same settling transaction
  // ONE transaction settled both sides: each account's spent coin and its new coins (what it
  // received, and its change) are all in the settling transaction, as the ledger's events say.
  const settledIn: Record<string, { inputs: number; outputs: number; blockHeight: number | null }> = {};
  for (const [who, acc] of [
    ['A', accountA],
    ['B', accountB],
  ] as const) {
    const z = await getJson<{
      outputs: Array<{ txHash: string; blockHeight: number }>;
      inputs: Array<{ txHash: string; blockHeight: number }>;
    }>(`${RELAY}/v1/accounts/${acc}/zswap`);
    const ins = z.inputs.filter((i) => i.txHash === settledTx);
    const outs = z.outputs.filter((o) => o.txHash === settledTx);
    settledIn[who] = { inputs: ins.length, outputs: outs.length, blockHeight: outs[0]?.blockHeight ?? null };
    expect(ins, `${who} spent one coin in the settlement`).toHaveLength(1);
    expect(outs, `${who} received its leg and its change in the settlement`).toHaveLength(2);
  }
  await A.page.getByTestId('tab-accounts').click();
  await A.page.getByTestId('refresh-balances').click();
  await expect.poll(() => rowRaw(A.page, S), { timeout: 180_000 }).toBe((fundStock - giveRaw).toString());
  await expect.poll(() => rowRaw(A.page, U), { timeout: 180_000 }).toBe(wantRaw.toString());

  const marketsAfterTake = await marketsMatchKernel(A.page, stockList, U);
  expect(marketsAfterTake[stock.midnightName]!.page.bestAsk).toBe('no asks');
  // The kernel records the fill: the pair's last trade is the offer's price.
  await expect
    .poll(async () => (await pageMarket(A.page, stock.midnightName)).lastTrade, { timeout: 120_000 })
    .toContain(PRICE);
  const lastTrade = (await pageMarket(A.page, stock.midnightName)).lastTrade;

  // ── 7. Export -> CLEAR ALL -> Import on B restores the same balances ─────────────────
  t = Date.now();
  const beforeExport = { stock: await rowRaw(B.page, S), usdc: await rowRaw(B.page, U) };
  await B.page.getByTestId('tab-local').click();
  const [download] = await Promise.all([B.page.waitForEvent('download'), B.page.getByTestId('export').click()]);
  const exported = await readFile((await download.path())!, 'utf8');
  await B.page.getByTestId('clear-all').click();
  await B.page.getByTestId('clear-confirm-input').fill('CLEAR ALL');
  await B.page.getByTestId('clear-confirm').click();
  expect(await bankKeys(B.page)).toEqual({});
  await B.page.getByTestId('tab-accounts').click();
  await expect(B.page.getByTestId('no-account')).toBeVisible();
  await B.page.getByTestId('tab-local').click();
  await B.page
    .getByTestId('import-file')
    .setInputFiles({ name: 'export.json', mimeType: 'application/json', buffer: Buffer.from(exported) });
  await expect(B.page.getByTestId('local-message')).toContainText('Imported');
  await B.page.getByTestId('tab-accounts').click();
  await expect(B.page.getByTestId('account-address')).toHaveText(accountB);
  await B.page.getByTestId('refresh-balances').click();
  await expect.poll(() => rowRaw(B.page, S), { timeout: 180_000 }).toBe(beforeExport.stock);
  await expect.poll(() => rowRaw(B.page, U), { timeout: 180_000 }).toBe(beforeExport.usdc);
  timings.exportClearImportSeconds = since(t);

  // ── 8. a stopped exchange: "exchange unavailable" ────────────────────────────────────
  await signal('stop-kernel', { at: new Date().toISOString() });
  await waitForSignal('kernel-stopped', 5 * 60_000);
  t = Date.now();
  await A.page.getByTestId('tab-local').click();
  await A.page.getByTestId('tab-markets').click();
  await expect(A.page.getByTestId('exchange-unavailable')).toBeVisible({ timeout: 120_000 });
  await expect(marketRow(A.page, stock.midnightName).getByTestId('market-status')).toHaveText('Exchange unavailable');
  timings.exchangeUnavailableSeconds = since(t);
  timings.totalSeconds = since(t0);

  // ── evidence (public values) ─────────────────────────────────────────────────────────
  const publicJob = (j: Record<string, unknown>) => ({
    who: j.who,
    action: j.action,
    state: j.state,
    requestId: j.requestId,
    stages: (j.stages as Array<{ stage: string; at: number; detail?: Record<string, string> }> | undefined)?.map(
      (s) => ({ stage: s.stage, at: new Date(s.at).toISOString(), ...(s.detail ? { detail: s.detail } : {}) }),
    ),
    result: j.result ?? null,
    error: j.error ?? null,
  });
  await mkdir(OUT, { recursive: true });
  await writeFile(
    join(OUT, 'e2e-result.json'),
    `${JSON.stringify(
      {
        plan: '00039 P4-C (local end-to-end)',
        writtenUtc: new Date().toISOString(),
        accounts: {
          A: { account: accountA, device: A.wallet.address.toLowerCase(), signatures: signatures(A.wallet) },
          B: { account: accountB, device: B.wallet.address.toLowerCase(), signatures: signatures(B.wallet) },
        },
        queue: { secondRegistrationSaw: queueText },
        seeded,
        order: { side: 'sell', quantity: QTY, price: PRICE, giveRaw: giveRaw.toString(), wantRaw: wantRaw.toString() },
        offer: { offerId, statusAfterMake: statusAfterMake.status, statusAfterTake: 'consumed' },
        take: { settledTx, settledIn },
        makerRecord: makerRecord ?? null,
        markets: { before: marketsBefore, afterMake: marketsAfterMake, afterTake: marketsAfterTake, lastTrade },
        balances: {
          A: { stock: (fundStock - giveRaw).toString(), usdc: wantRaw.toString() },
          B: { stock: giveRaw.toString(), usdc: (fundUsdc - wantRaw).toString() },
          BAfterImport: beforeExport,
        },
        timings,
        jobs: [...jobs.values()].map(publicJob),
      },
      null,
      2,
    )}\n`,
  );
  await signal('done', { at: new Date().toISOString(), timings });
  await A.context.close();
  await B.context.close();
});
