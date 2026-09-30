// Plan 00046 P4.1: each domain's asset set in the browser. One build serves two domains, each with
// its own config.json: the bank domain has no `assets` (the stagenet default set: USDC and
// stkA/B/C), and the T-bills domain names USDC and the four T-bills. The partner link `?assets=`
// narrows within the domain's set. The exchange serves live offers on BOTH lines, and the customer
// holds both, so every view shows what the domain's set lets through, and nothing else. The
// customer, the relay's reads and the exchange are the visual tests' fixtures (served through
// page.route: nothing leaves the page's origin). Screenshots go to $SITE_ASSETS_OUT_DIR (default
// test-results/site-assets).

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { BOOK, COLOUR, leg, offerRow } from '../../packages/core/test/fixtures/kernel/book.js';
import { connect, installCustomer, serveExchange } from './visual-fixtures.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const OUT = process.env.SITE_ASSETS_OUT_DIR ?? `${root}/test-results/site-assets`;
mkdirSync(OUT, { recursive: true });

/**
 * A T-bills domain's config.json with every T-bill, TBILL included, so the checks cover all four. The documented
 * tbank set (web/README.md, RUNBOOK section 16) is the same without TBILL, which stays one of the bank's tokens.
 */
const TBANK = { network: 'stagenet', relayUrl: '', assets: ['USDC', 'TBILL', 'TB13W', 'TB26W', 'TB52W'] };
/** Any stk token's name, in either form (stkA, wStkB, …). */
const STK = /\bw?stk[abc]\b/i;
/** Any T-bill's name. */
const TBILLS = /\b(tbill|tb\d\dw)\b/i;

/** The fixture book plus live offers on every T-bill market (ids 21+). */
const BOTH_LINES = [
  ...BOOK,
  offerRow(21, [leg(COLOUR.TBILL, 10_000_000)], [leg(COLOUR.wUSDC, 9_900_000)]), // ask 10 TBILL @ 0.99
  offerRow(22, [leg(COLOUR.wUSDC, 9_800_000)], [leg(COLOUR.TBILL, 10_000_000)]), // bid 10 TBILL @ 0.98
  offerRow(23, [leg(COLOUR.TB13W, 5_000_000)], [leg(COLOUR.wUSDC, 4_940_000)]), // ask 5 TB13W @ 0.988
  offerRow(24, [leg(COLOUR.wUSDC, 4_850_000)], [leg(COLOUR.TB26W, 5_000_000)]), // bid 5 TB26W @ 0.97
  offerRow(25, [leg(COLOUR.TB52W, 2_000_000)], [leg(COLOUR.wUSDC, 1_920_000)]), // ask 2 TB52W @ 0.96
  offerRow(26, [leg(COLOUR.wUSDC, 1_900_000)], [leg(COLOUR.TB52W, 2_000_000)]), // bid 2 TB52W @ 0.95
];

test.use({ viewport: { width: 1280, height: 900 } });

const shot = async (page: Page, name: string) => {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true, animations: 'disabled' });
};
const attrs = (page: Page, selector: string, name: string) =>
  page.locator(selector).evaluateAll((els, n) => els.map((e) => e.getAttribute(n) ?? ''), name);
const options = (page: Page, testId: string) =>
  page
    .getByTestId(testId)
    .locator('option')
    .evaluateAll((os) => os.map((o) => (o.textContent ?? '').trim()));
const openTab = async (page: Page, id: string) => {
  await page.getByTestId(`tab-${id}`).click();
  await expect(page.getByTestId(`section-${id}`)).toBeVisible();
};

/** The page on one domain: its config.json (none = the build's own), the exchange with both
 *  lines, and a customer who holds both. */
async function onDomain(page: Page, config: object | null) {
  const ex = await serveExchange(page, { book: BOTH_LINES });
  if (config) await page.route('**/config.json', (route) => route.fulfill({ json: config }));
  await installCustomer(page, { withAccount: true, withTbills: true });
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text());
  });
  return { ex, warnings };
}

test('(a) the bank domain (no assets): the stk line only, on every view', async ({ page }) => {
  const { ex, warnings } = await onDomain(page, null);
  await page.goto('/#markets');
  await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
  expect(await attrs(page, '[data-testid=market-row]', 'data-stock')).toEqual(['wStkA', 'wStkB', 'wStkC']);
  await expect(page.getByTestId('section-markets')).not.toContainText(TBILLS);
  await expect(page.getByTestId('asset-filter-note')).toHaveCount(0);
  await shot(page, 'a-bank-default-markets');

  await openTab(page, 'accounts');
  await connect(page);
  await expect(page.locator('[data-testid=passport-row]')).toHaveCount(4);
  expect(await attrs(page, '[data-testid=sepolia-row]', 'data-symbol')).toEqual([
    'ETH',
    'stkA',
    'stkB',
    'stkC',
    'USDC',
  ]);
  expect(await attrs(page, '[data-testid=passport-row]', 'data-name')).toEqual(['wStkA', 'wStkB', 'wStkC', 'wUSDC']);
  await expect(page.getByTestId('section-accounts')).not.toContainText(TBILLS);
  await shot(page, 'a-bank-default-accounts');

  await openTab(page, 'trade');
  expect((await options(page, 'trade-stock')).map((o) => o.split(' ')[0])).toEqual(['wStkA', 'wStkB', 'wStkC']);
  await expect(page.getByTestId('section-trade')).not.toContainText(TBILLS);
  await openTab(page, 'transfers');
  expect(await options(page, 'deposit-token')).toEqual([
    'stkA → wStkA',
    'stkB → wStkB',
    'stkC → wStkC',
    'USDC → wUSDC',
  ]);
  await expect(page.getByTestId('section-transfers')).not.toContainText(TBILLS);
  expect(warnings).toEqual([]);
  expect(ex.external).toEqual([]);
});

test('(b) the T-bills domain: USDC and the four T-bills, their four markets, no stk', async ({ page }) => {
  const { ex, warnings } = await onDomain(page, TBANK);
  await page.goto('/#markets');
  await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
  expect(await attrs(page, '[data-testid=market-row]', 'data-stock')).toEqual(['TBILL', 'TB13W', 'TB26W', 'TB52W']);
  await expect(page.getByTestId('section-markets')).not.toContainText(STK);
  await expect(page.getByTestId('asset-filter-note')).toHaveCount(0);
  // Live prices on the T-bill line: TBILL both sides, TB13W asks only, TB26W bids only.
  const row = (name: string) => page.locator(`[data-testid=market-row][data-stock=${name}]`);
  await expect(row('TBILL')).toContainText('0.98');
  await expect(row('TBILL')).toContainText('0.99');
  await expect(row('TB13W')).toContainText('0.988');
  await expect(row('TB26W')).toContainText('0.97');
  await shot(page, 'b-tbank-markets');

  await openTab(page, 'accounts');
  await connect(page);
  expect(await attrs(page, '[data-testid=sepolia-row]', 'data-symbol')).toEqual([
    'ETH',
    'USDC',
    'TBILL',
    'TB13W',
    'TB26W',
    'TB52W',
  ]);
  await expect(page.locator('[data-testid=passport-row]')).toHaveCount(3);
  expect(await attrs(page, '[data-testid=passport-row]', 'data-name')).toEqual(['wUSDC', 'TBILL', 'TB13W']);
  await expect(page.getByTestId('section-accounts')).not.toContainText(STK);
  // TB13W has no bid: left out of the total, and named once although it is held on both sides.
  await expect(page.getByTestId('section-accounts')).toContainText(
    'Not included: ETH (not priced), and TB13W (no price).',
  );
  await shot(page, 'b-tbank-accounts');

  await openTab(page, 'trade');
  expect((await options(page, 'trade-stock')).map((o) => o.split(' ')[0])).toEqual([
    'TBILL',
    'TB13W',
    'TB26W',
    'TB52W',
  ]);
  await expect(page.getByTestId('section-trade')).not.toContainText(STK);
  await shot(page, 'b-tbank-trade');
  await openTab(page, 'transfers');
  expect(await options(page, 'deposit-token')).toEqual([
    'USDC → wUSDC',
    'TBILL → TBILL',
    'TB13W → TB13W',
    'TB26W → TB26W',
    'TB52W → TB52W',
  ]);
  await expect(page.getByTestId('section-transfers')).not.toContainText(STK);
  await shot(page, 'b-tbank-transfers');
  expect(warnings).toEqual([]);
  expect(ex.external).toEqual([]);
});

test('(c) the T-bills domain with ?assets=USDC,TBILL: TBILL/USDC only', async ({ page }) => {
  await onDomain(page, TBANK);
  await page.goto('/?assets=USDC,TBILL#markets');
  await expect(page.getByTestId('asset-filter-note')).toHaveText('Showing only USDC, TBILL. Show all assets');
  await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
  expect(await attrs(page, '[data-testid=market-row]', 'data-stock')).toEqual(['TBILL']);
  await expect(page.getByTestId('section-markets')).not.toContainText(STK);
  await expect(page.getByTestId('section-markets')).not.toContainText(/\btb\d\dw\b/i);
  await shot(page, 'c-tbank-USDC-TBILL-markets');
  await openTab(page, 'accounts');
  await connect(page);
  expect(await attrs(page, '[data-testid=sepolia-row]', 'data-symbol')).toEqual(['ETH', 'USDC', 'TBILL']);
  expect(await attrs(page, '[data-testid=passport-row]', 'data-name')).toEqual(['wUSDC', 'TBILL']);
  await openTab(page, 'trade');
  expect((await options(page, 'trade-stock')).map((o) => o.split(' ')[0])).toEqual(['TBILL']);
  await shot(page, 'c-tbank-USDC-TBILL-trade');
});

test('(d) the T-bills domain with ?assets=stkA,USDC: stkA stays hidden, and the note says why', async ({ page }) => {
  await onDomain(page, TBANK);
  await page.goto('/?assets=stkA,USDC#markets');
  await expect(page.getByTestId('asset-filter-note')).toHaveText(
    'Showing only USDC. Not available on this site: stkA. Show all assets',
  );
  // No market: none has both of its assets listed on this site. stkA is named only as unavailable.
  await expect(page.getByTestId('markets-filtered-empty')).toContainText('Not available on this site: stkA.');
  await expect(page.locator('[data-testid=market-row]')).toHaveCount(0);
  await expect(page.getByTestId('section-markets')).not.toContainText(/\bwstk[abc]\b|\bstk[bc]\b/i);
  await shot(page, 'd-tbank-stkA-USDC-markets');
  await openTab(page, 'accounts');
  await connect(page);
  expect(await attrs(page, '[data-testid=sepolia-row]', 'data-symbol')).toEqual(['ETH', 'USDC']);
  expect(await attrs(page, '[data-testid=passport-row]', 'data-name')).toEqual(['wUSDC']);
  await expect(page.getByTestId('section-accounts')).not.toContainText(STK);
  await shot(page, 'd-tbank-stkA-USDC-accounts');

  // ?assets=all goes back to the domain's set, never beyond it.
  await page.goto('/?assets=all#markets');
  await expect(page.getByTestId('asset-filter-note')).toHaveCount(0);
  await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
  expect(await attrs(page, '[data-testid=market-row]', 'data-stock')).toEqual(['TBILL', 'TB13W', 'TB26W', 'TB52W']);
});

test('a typo in the domain set is ignored, with a console warning; "all" shows both lines', async ({ page }) => {
  const { warnings } = await onDomain(page, { ...TBANK, assets: ['USDC', 'TBIL', 'TB13W'] });
  await page.goto('/#markets');
  await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
  expect(await attrs(page, '[data-testid=market-row]', 'data-stock')).toEqual(['TB13W']);
  expect(warnings).toEqual(['MN Bank: config.json "assets": ignoring unknown assets: TBIL']);

  await page.unroute('**/config.json');
  await page.route('**/config.json', (route) => route.fulfill({ json: { ...TBANK, assets: 'all' } }));
  await page.reload();
  await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
  expect(await attrs(page, '[data-testid=market-row]', 'data-stock')).toEqual([
    'wStkA',
    'wStkB',
    'wStkC',
    'TBILL',
    'TB13W',
    'TB26W',
    'TB52W',
  ]);
});
