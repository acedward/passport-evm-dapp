// Plan 00042 P3.1: the asset filter in the browser. `?assets=…` is stored, removed from the
// address bar, and applied in every view (Accounts, Markets, Trade, Transfers); a market shows
// only when both of its assets are listed; a reload keeps the list; `?assets=all`, Show all
// assets and CLEAR ALL bring everything back; a token from the site's config (a fake TBILL) is
// filtered with no code change. The customer, the relay's reads and the exchange are the visual
// tests' fixtures (served through page.route: nothing leaves the page's origin). Screenshots go
// to $ASSET_FILTER_OUT_DIR (default test-results/asset-filter).

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { COLOUR } from '../../packages/core/test/fixtures/kernel/book.js';
import { connect, installCustomer, serveExchange } from './visual-fixtures.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const OUT = process.env.ASSET_FILTER_OUT_DIR ?? `${root}/test-results/asset-filter`;
mkdirSync(OUT, { recursive: true });

const FILTER_KEY = 'mn-bank/v1/_global/settings/asset-filter';
/** Any stock token's name, in either form (stkA, wStkB, …). */
const STK = /\bw?stk[abc]\b/i;

test.use({ viewport: { width: 1280, height: 900 } });

const shot = async (page: Page, name: string) => {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true, animations: 'disabled' });
};
const stored = (page: Page) => page.evaluate((k) => localStorage.getItem(k), FILTER_KEY);
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

test('no parameter: every asset shows, and nothing is stored', async ({ page }) => {
  const ex = await serveExchange(page);
  await installCustomer(page, { withAccount: true, withTransfers: true, withTrades: true });
  await page.goto('/#accounts');
  await connect(page);
  await expect(page.locator('[data-testid=passport-row]')).toHaveCount(4);
  expect(await attrs(page, '[data-testid=sepolia-row]', 'data-symbol')).toEqual([
    'ETH',
    'stkA',
    'stkB',
    'stkC',
    'USDC',
  ]);
  await expect(page.getByTestId('asset-filter-note')).toHaveCount(0);
  await openTab(page, 'markets');
  await expect(page.locator('[data-testid=market-row]')).toHaveCount(3);
  await openTab(page, 'transfers');
  await expect(page.locator('[data-testid=transfer][data-state=succeeded]')).toHaveCount(1);
  expect(await stored(page)).toBeNull();
  await shot(page, '01-no-filter-transfers');
  expect(ex.external).toEqual([]);
});

test('?assets=stkA,USDC: only those assets and their market, in every view; a reload keeps it', async ({ page }) => {
  const ex = await serveExchange(page);
  await installCustomer(page, { withAccount: true, withTransfers: true, withTrades: true });
  await page.goto('/?assets=stkA,USDC#accounts');
  await expect(page.getByTestId('asset-filter-note')).toContainText('Showing only stkA, USDC.');
  // Stored, and gone from the address bar (the section stays).
  await expect.poll(() => new URL(page.url()).search).toBe('');
  expect(new URL(page.url()).hash).toBe('#accounts');
  expect(JSON.parse((await stored(page))!)).toMatchObject({ kind: 'settings', data: { assets: ['stkA', 'USDC'] } });
  await connect(page);

  // Accounts: the EVM and Passport holdings (ETH always shows: it pays for gas).
  await expect(page.locator('[data-testid=passport-row]')).toHaveCount(2);
  expect(await attrs(page, '[data-testid=sepolia-row]', 'data-symbol')).toEqual(['ETH', 'stkA', 'USDC']);
  expect(await attrs(page, '[data-testid=passport-row]', 'data-name')).toEqual(['wStkA', 'wUSDC']);
  await expect(page.getByTestId('sepolia-holdings')).not.toContainText(/stk[bc]/i);
  await expect(page.getByTestId('passport-holdings')).not.toContainText(/stk[bc]/i);
  await shot(page, '02-stkA-USDC-accounts');

  // Markets: the one market whose two assets are listed.
  await openTab(page, 'markets');
  await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
  expect(await attrs(page, '[data-testid=market-row]', 'data-stock')).toEqual(['wStkA']);
  await shot(page, '03-stkA-USDC-markets');

  // Trade: the pair picker.
  await openTab(page, 'trade');
  expect(await options(page, 'trade-stock')).toEqual([expect.stringMatching(/^wStkA .* \/ wUSDC$/)]);
  await shot(page, '04-stkA-USDC-trade');

  // Transfers: what can be deposited or withdrawn; the finished wStkB withdrawal is left out, the
  // stkA deposit still in progress stays.
  await openTab(page, 'transfers');
  expect(await options(page, 'deposit-token')).toEqual(['stkA → wStkA', 'USDC → wUSDC']);
  expect((await options(page, 'withdraw-token')).map((o) => o.split(' ')[0])).toEqual(['wStkA', 'wUSDC']);
  await expect(page.locator('[data-testid=transfer][data-state=succeeded]')).toHaveCount(0);
  await expect(page.locator('[data-testid=transfer][data-state=running]')).toHaveCount(1);
  await shot(page, '05-stkA-USDC-transfers');

  // A reload, with no parameter: the same view.
  await page.reload();
  await expect(page.getByTestId('asset-filter-note')).toContainText('Showing only stkA, USDC.');
  await openTab(page, 'markets');
  await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
  expect(await attrs(page, '[data-testid=market-row]', 'data-stock')).toEqual(['wStkA']);
  expect(ex.external).toEqual([]);
});

test('?assets=USDC (the partner view without its token yet): USDC only, and no market', async ({ page }) => {
  await serveExchange(page);
  await installCustomer(page, { withAccount: true, withTransfers: true, withTrades: true });
  await page.goto('/?assets=USDC,TBILL#accounts');
  await expect(page.getByTestId('asset-filter-note')).toHaveText(
    'Showing only USDC. Not on this site yet: TBILL. Show all assets',
  );
  await connect(page);
  await expect(page.locator('[data-testid=passport-row]')).toHaveCount(1);
  expect(await attrs(page, '[data-testid=sepolia-row]', 'data-symbol')).toEqual(['ETH', 'USDC']);
  await expect(page.getByTestId('section-accounts')).not.toContainText(STK);
  await shot(page, '06-USDC-TBILL-accounts');
  await openTab(page, 'markets');
  await expect(page.getByTestId('markets-filtered-empty')).toBeVisible();
  await expect(page.locator('[data-testid=market-row]')).toHaveCount(0);
  await expect(page.getByTestId('section-markets')).not.toContainText(STK);
  await shot(page, '07-USDC-TBILL-markets');
  await openTab(page, 'trade');
  await expect(page.getByTestId('trade-filtered-empty')).toBeVisible();
  await expect(page.getByTestId('section-trade')).not.toContainText(STK);
  await openTab(page, 'transfers');
  expect(await options(page, 'deposit-token')).toEqual(['USDC → wUSDC']);
  expect((await options(page, 'withdraw-token')).map((o) => o.split(' ')[0])).toEqual(['wUSDC']);
});

test('a token from the config (a fake TBILL): ?assets=USDC,TBILL shows only TBILL/USDC', async ({ page }) => {
  await serveExchange(page);
  await page.route('**/config.json', (route) =>
    route.fulfill({
      json: {
        network: 'stagenet',
        relayUrl: '',
        // The site config's token list (TokenConfig: { tokens: [...] }), as a deployment would set it.
        tokens: {
          tokens: [
            { symbol: 'USDC', midnightName: 'wUSDC', role: 'usdc', decimals: 6, midnightColour: COLOUR.wUSDC },
            { symbol: 'stkA', midnightName: 'wStkA', role: 'stock', decimals: 6, midnightColour: COLOUR.wStkA },
            { symbol: 'TBILL', midnightName: 'wTBILL', role: 'stock', decimals: 6, midnightColour: '7b'.repeat(32) },
          ],
        },
      },
    }),
  );
  await page.goto('/?assets=USDC,TBILL#markets');
  await expect(page.getByTestId('asset-filter-note')).toHaveText('Showing only USDC, TBILL. Show all assets');
  await expect(page.locator('[data-testid=market-row]')).toHaveCount(1);
  expect(await attrs(page, '[data-testid=market-row]', 'data-stock')).toEqual(['wTBILL']);
  await expect(page.getByTestId('section-markets')).not.toContainText(STK);
  await shot(page, '08-config-TBILL-markets');
});

test('an unknown list shows everything; ?assets=all, Show all assets and CLEAR ALL clear it', async ({ page }) => {
  await serveExchange(page);
  // Nothing known: everything shows, and the note says why.
  await page.goto('/?assets=TBILL#markets');
  await expect(page.getByTestId('asset-filter-note')).toContainText(
    'None of the listed assets is on this site, so every asset is shown. Not on this site yet: TBILL.',
  );
  await expect(page.locator('[data-testid=market-row]')).toHaveCount(3);

  // ?assets=all.
  await page.goto('/?assets=stkA,USDC#markets');
  await expect(page.locator('[data-testid=market-row]')).toHaveCount(1);
  await page.goto('/?assets=all#markets');
  await expect(page.locator('[data-testid=market-row]')).toHaveCount(3);
  await expect(page.getByTestId('asset-filter-note')).toHaveCount(0);
  expect(await stored(page)).toBeNull();
  await expect.poll(() => new URL(page.url()).search).toBe('');

  // Show all assets, in Local data (with the note that it is not a security setting).
  await page.goto('/?assets=stkA,USDC#local');
  await expect(page.getByTestId('asset-filter-panel')).toContainText('?assets=stkA,USDC');
  await expect(page.getByTestId('asset-filter-disclaimer')).toHaveText(
    'This only changes what this page shows; it is not a security setting.',
  );
  await shot(page, '09-local-data-filter');
  await page.getByTestId('asset-filter-clear').click();
  await expect(page.getByTestId('asset-filter-panel')).toHaveCount(0);
  await expect(page.getByTestId('asset-filter-note')).toHaveCount(0);
  expect(await stored(page)).toBeNull();

  // The header note's Show all assets.
  await page.goto('/?assets=USDC#markets');
  await expect(page.locator('[data-testid=market-row]')).toHaveCount(0);
  await page.getByTestId('asset-filter-show-all').click();
  await expect(page.locator('[data-testid=market-row]')).toHaveCount(3);
  expect(await stored(page)).toBeNull();

  // CLEAR ALL.
  await page.goto('/?assets=USDC#local');
  await page.getByTestId('clear-all').click();
  await page.getByTestId('clear-confirm-input').fill('CLEAR ALL');
  await page.getByTestId('clear-confirm').click();
  await expect(page.getByTestId('asset-filter-note')).toHaveCount(0);
  expect(await stored(page)).toBeNull();
  await openTab(page, 'markets');
  await expect(page.locator('[data-testid=market-row]')).toHaveCount(3);
});
