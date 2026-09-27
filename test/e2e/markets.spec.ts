// Plan L-MKT testing: the Markets page against a mock exchange that answers in the exact shapes
// the staging kernel returns (served through page.route, so nothing reaches the real kernel).
// The page must equal a manual computation over GET /v1/offers (spec SC-002), show "no
// liquidity" for a pair with no live offer, and "exchange unavailable" when the kernel is down.

import { expect, test, type Page } from '@playwright/test';

import { BOOK, COLOUR, EXPECTED, type WireOffer } from '../../packages/core/test/fixtures/kernel/book.js';
import { KernelFixture, STREAM_HEADERS, connectedEvent } from '../../packages/core/test/fixtures/kernel/mock-kernel.js';

const KERNEL = 'https://stagenet.api-zswap.zkdojo.com';
const STOCKS = { wStkA: COLOUR.wStkA, wStkB: COLOUR.wStkB, wStkC: COLOUR.wStkC } as const;

interface Served {
  kernel: string[];
  external: string[];
  down: boolean;
}

/** Serve the mock kernel for this page, and refuse (and record) any other outside request. */
async function serveKernel(page: Page, fixture: KernelFixture): Promise<Served> {
  const served: Served = { kernel: [], external: [], down: false };
  await page.route(
    (url) => url.hostname !== '127.0.0.1',
    (route) => {
      served.external.push(route.request().url());
      return route.abort('blockedbyclient');
    },
  );
  await page.route(`${KERNEL}/**`, (route) => {
    const url = new URL(route.request().url());
    served.kernel.push(`${route.request().method()} ${url.pathname}`);
    if (served.down) return route.abort('connectionrefused');
    if (url.pathname === '/v1/offers/stream') {
      return route.fulfill({ status: 200, headers: STREAM_HEADERS, body: connectedEvent() });
    }
    const r = fixture.respond(url.pathname + url.search);
    return route.fulfill({ status: r.status, headers: r.headers, body: r.body });
  });
  return served;
}

/** A person's computation over GET /v1/offers, written independently of the app's code: only
 *  one-leg-per-side SHIELDED offers of wUSDC against the stock count; asks give the stock
 *  (price rounded up), bids give wUSDC (price rounded down); both tokens have 6 decimals. */
function manual(offers: WireOffer[], stock: string) {
  const usdc = COLOUR.wUSDC;
  const asks: bigint[] = [];
  const bids: bigint[] = [];
  for (const o of offers) {
    const { gives, wants } = o.computed;
    if (gives.length !== 1 || wants.length !== 1) continue;
    const [g, w] = [gives[0]!, wants[0]!];
    if (g.type !== 'SHIELDED' || w.type !== 'SHIELDED') continue;
    // price in millionths of a USDC per stock
    if (g.token === stock && w.token === usdc)
      asks.push((BigInt(w.amount) * 1_000_000n + BigInt(g.amount) - 1n) / BigInt(g.amount));
    if (g.token === usdc && w.token === stock) bids.push((BigInt(g.amount) * 1_000_000n) / BigInt(w.amount));
  }
  const text = (micro: bigint) => {
    const frac = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
    return `${micro / 1_000_000n}.${frac}`;
  };
  const min = asks.length ? asks.reduce((a, b) => (b < a ? b : a)) : null;
  const max = bids.length ? bids.reduce((a, b) => (b > a ? b : a)) : null;
  return {
    bestAsk: min === null ? 'no asks' : text(min),
    bestBid: max === null ? 'no bids' : text(max),
    counts: `${bids.length} / ${asks.length}`,
  };
}

const row = (page: Page, stock: string) => page.locator(`[data-testid=market-row][data-stock=${stock}]`);

test('the Markets page equals a manual computation over /v1/offers', async ({ page }) => {
  const fixture = new KernelFixture();
  const served = await serveKernel(page, fixture);
  await page.goto('/#markets');
  await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');

  // Everything the exchange lists, unfiltered, as a person would read it.
  const all = JSON.parse(fixture.respond('/v1/offers?limit=100').body) as { offers: WireOffer[]; nextCursor: null };
  expect(all.offers).toHaveLength(BOOK.length);
  for (const [name, colour] of Object.entries(STOCKS)) {
    const m = manual(all.offers, colour);
    const r = row(page, name);
    await expect(r.getByTestId('best-bid'), name).toHaveText(m.bestBid);
    await expect(r.getByTestId('best-ask'), name).toHaveText(m.bestAsk);
    await expect(r.getByTestId('offer-counts'), name).toHaveText(m.counts);
  }
  // … and the hand-written expectations of the fixture (spec US3: ask 1.05, bid 0.95).
  await expect(row(page, 'wStkA').getByTestId('best-ask')).toHaveText(EXPECTED.wStkA.bestAsk);
  await expect(row(page, 'wStkA').getByTestId('best-bid')).toHaveText(EXPECTED.wStkA.bestBid);
  await expect(row(page, 'wStkA').getByTestId('last-trade')).toContainText('1.02');
  await expect(row(page, 'wStkA').getByTestId('market-status')).toHaveText('Two-sided');
  // A pair with no live offer: no liquidity (its old fill still shows as the last trade).
  await expect(row(page, 'wStkB').getByTestId('market-status')).toHaveText('No liquidity');
  await expect(row(page, 'wStkB').getByTestId('last-trade')).toContainText('0.0098');
  // Asks only (US3 scenario 1); the kernel's mid for a never-filled pair is not a trade.
  await expect(row(page, 'wStkC').getByTestId('best-bid')).toHaveText('no bids');
  await expect(row(page, 'wStkC').getByTestId('market-status')).toHaveText('Asks only');
  await expect(row(page, 'wStkC').getByTestId('last-trade')).toHaveText('no trades yet');
  await expect(page.getByTestId('ignored-offers')).toContainText('3 other offers');

  // The book of one stock, with Take as a disabled placeholder (taking is lane L-TRD).
  await row(page, 'wStkA').getByTestId('open-book').click();
  const book = page.getByTestId('book');
  await expect(book).toHaveAttribute('data-stock', 'wStkA');
  const lines = async (side: string) =>
    book
      .getByTestId(side)
      .getByTestId('book-line')
      .evaluateAll((trs) =>
        trs.map((tr) =>
          ['line-price', 'line-quantity', 'line-total'].map(
            (id) => tr.querySelector(`[data-testid=${id}]`)?.textContent ?? '',
          ),
        ),
      );
  expect(await lines('book-asks')).toEqual([
    ['1.05', '10.00', '10.50'],
    ['1.10', '20.00', '22.00'],
  ]);
  expect(await lines('book-bids')).toEqual([
    ['0.95', '10.00', '9.50'],
    ['0.90', '5.00', '4.50'],
  ]);
  await expect(book.getByTestId('book-summary')).toContainText('Spread 0.10');
  const takes = book.getByTestId('take');
  await expect(takes).toHaveCount(4);
  for (const b of await takes.all()) await expect(b).toBeDisabled();

  // Only GETs of the book, pairs, stats and the stream; never /v1/prices or /v1/quote; nothing
  // else leaves the browser.
  expect(served.external).toEqual([]);
  expect(served.kernel.every((k) => k.startsWith('GET '))).toBe(true);
  expect(served.kernel.some((k) => /\/v1\/(prices|quote)/.test(k))).toBe(false);
  const offersQueries = fixture.requests.filter((r) => r.path === '/v1/offers' && r.query.get('token'));
  expect(offersQueries.every((r) => r.query.get('token') === COLOUR.wUSDC)).toBe(true);
});

test('the staging exchange as captured (an empty book): every pair shows no liquidity', async ({ page }) => {
  const fixture = new KernelFixture({ book: [], pairs: [], stats: {} });
  await serveKernel(page, fixture);
  await page.goto('/#markets');
  await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
  for (const name of Object.keys(STOCKS)) {
    await expect(row(page, name).getByTestId('market-status')).toHaveText('No liquidity');
    await expect(row(page, name).getByTestId('best-bid')).toHaveText('no bids');
    await expect(row(page, name).getByTestId('best-ask')).toHaveText('no asks');
    await expect(row(page, name).getByTestId('last-trade')).toHaveText('no trades yet');
  }
  await row(page, 'wStkA').getByTestId('open-book').click();
  await expect(page.getByTestId('book-empty')).toContainText('No liquidity');
});

test('a stopped exchange shows "exchange unavailable" and no price', async ({ page }) => {
  const served = await serveKernel(page, new KernelFixture());
  served.down = true;
  await page.goto('/#markets');
  await expect(page.getByTestId('exchange-unavailable')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('exchange-unavailable')).toContainText('Exchange unavailable');
  for (const name of Object.keys(STOCKS)) {
    await expect(row(page, name).getByTestId('market-status')).toHaveText('Exchange unavailable');
    await expect(row(page, name).getByTestId('best-bid')).toHaveText('—');
    await expect(row(page, name).getByTestId('best-ask')).toHaveText('—');
  }
});

test('sections without prices make no exchange request', async ({ page }) => {
  const served = await serveKernel(page, new KernelFixture());
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'MN Bank' })).toBeVisible();
  await page.getByTestId('tab-local').click();
  await page.waitForTimeout(1_000);
  expect(served.kernel).toEqual([]);
  await page.getByTestId('tab-markets').click();
  await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
  expect(served.kernel.length).toBeGreaterThan(0);
});
