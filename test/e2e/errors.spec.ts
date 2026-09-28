// Plan P4-A, error-state walkthroughs in the browser, against a mocked relay (its /health, its
// action and job routes) and the mocked exchange of the visual fixtures, with the injected test
// wallet. Each state shows a clear, specific message where the customer is, and the action it
// stops is paused before anything is signed:
//
//   the bank's relay unreachable · its fee wallet (DUST) low or still syncing · the vault's EVM
//   account low on gas · the MPC slow, then timed out · the exchange (kernel) down · its settlement
//   service (batcher) down, answering 429, answering 500 · an account with more history than this
//   version reads (Q27) · local storage full · the wallet on the wrong network.

import { expect, test, type Page, type Route } from '@playwright/test';

import { COLOUR } from '../../packages/core/test/fixtures/kernel/book.js';
import { encodeRecord, recordKey } from '../../web/src/store/schema.js';
import { healthBody } from './errors-fixtures.js';
import { ACCOUNT, connect, installCustomer, serveExchange } from './visual-fixtures.js';

const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });

async function serveHealth(page: Page, opts: Parameters<typeof healthBody>[0] = {}) {
  await page.route('**/health', (route) => json(route, opts.proverDown ? 503 : 200, healthBody(opts)));
}

test.describe('the bank itself', () => {
  test('its relay unreachable: every page says so, and the records are safe', async ({ page }) => {
    await serveExchange(page);
    await installCustomer(page, { withAccount: false });
    await page.route('**/health', (route) => route.abort('connectionrefused'));
    await page.goto('/#markets');
    await expect(page.getByTestId('bank-relay-down')).toContainText("The bank's server cannot be reached.");
    await expect(page.getByTestId('bank-relay-down')).toContainText('records in this browser are safe');
    await page.goto('/#accounts');
    await connect(page);
    await expect(page.getByTestId('open-account')).toBeDisabled();
    await expect(page.getByTestId('open-account-paused')).toContainText('cannot be reached');
  });

  test('its fee wallet low on DUST: opening accounts, transfers and offers pause, with the reason', async ({
    page,
  }) => {
    await serveExchange(page);
    await installCustomer(page, { withAccount: false });
    await serveHealth(page, { dustLow: true });
    await page.goto('/#accounts');
    await connect(page);
    await expect(page.getByTestId('bank-sponsor-low')).toContainText('The bank is low on network-fee funds.');
    await expect(page.getByTestId('bank-sponsor-low')).toContainText('Your balances are safe');
    await expect(page.getByTestId('open-account')).toBeDisabled();
    await expect(page.getByTestId('open-account-paused')).toContainText('paused until the bank tops it up');
  });

  test('its fee wallet still syncing', async ({ page }) => {
    await serveExchange(page);
    await installCustomer(page, { withAccount: false });
    await serveHealth(page, { syncing: true });
    await page.goto('/#accounts');
    await expect(page.getByTestId('bank-sponsor-syncing')).toContainText("The bank's fee wallet is starting up.");
  });

  test('its prover down', async ({ page }) => {
    await serveExchange(page);
    await installCustomer(page, { withAccount: true });
    await serveHealth(page, { proverDown: true });
    await page.goto('/#trade');
    await connect(page);
    await expect(page.getByTestId('bank-prover-down')).toContainText("The bank's prover is not available.");
    await expect(page.getByTestId('trade-paused')).toBeVisible();
    await expect(page.getByTestId('buy-best-ask')).toBeDisabled();
  });
});

test.describe('the bridge', () => {
  test('the vault’s Sepolia account low on gas: withdrawals pause, deposits do not', async ({ page }) => {
    await serveExchange(page);
    await installCustomer(page, { withAccount: true });
    await serveHealth(page, { vaultGasLow: true });
    await page.goto('/#transfers');
    await connect(page);
    await expect(page.getByTestId('bank-vault-gas-low')).toContainText('Withdrawals to Sepolia are paused.');
    await expect(page.getByTestId('bank-vault-gas-low')).toContainText('it holds 0.001428 ETH');
    await expect(page.getByTestId('withdraw-submit')).toBeDisabled();
    await expect(page.getByTestId('withdraw-paused')).toContainText('Deposits and trading still work');
    await expect(page.getByTestId('deposit-continue')).toBeEnabled();
  });

  test('the MPC slow, then timed out: the transfer says so and can be resumed', async ({ page }) => {
    await serveExchange(page);
    const { wallet } = await installCustomer(page, { withAccount: true });
    await serveHealth(page, { mpcTimeouts: 1 });
    const JOB = '5'.repeat(32);
    const REQUEST = 'ab'.repeat(32);
    const startedAt = Math.floor(Date.now() / 1000) - 400; // over 5 minutes ago, no signature yet
    let timedOut = false;
    await page.route(`**/v1/jobs/${JOB}`, (route) => {
      const stages = [
        { stage: 'queued', at: startedAt - 60 },
        { stage: 'running', at: startedAt - 59 },
        { stage: 'started', at: startedAt, detail: { requestId: REQUEST, startedAtMs: String(startedAt * 1000) } },
      ];
      return json(route, 200, {
        job: {
          requestId: JOB,
          action: 'bridge-withdraw',
          lane: 'withdrawal',
          state: timedOut ? 'failed' : 'running',
          stage: timedOut ? 'failed' : 'started',
          stages: timedOut ? [...stages, { stage: 'failed', at: startedAt + 1200 }] : stages,
          createdAt: startedAt - 60,
          updatedAt: startedAt,
          expiresAt: startedAt + 86_400,
          ...(timedOut
            ? {
                error: {
                  code: 'mpc-timeout',
                  message: `the MPC has not signed request ${REQUEST} within 20 minutes; nothing moved on Sepolia. Resume it later, or ask the bank`,
                },
              }
            : {}),
        },
      });
    });
    await page.route('**/v1/bridge/closed/**', (route) =>
      json(route, 404, { error: { code: 'not-found', message: 'x' } }),
    );
    const scope = { network: 'stagenet', evmAddress: wallet.address };
    const rec = {
      id: 'mpc-1',
      kind: 'withdraw',
      account: ACCOUNT,
      symbol: 'stkA',
      midnightName: 'wStkA',
      erc20: '0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52',
      colour: COLOUR.wStkA,
      decimals: 6,
      amount: '1000000',
      dest: wallet.address,
      createdAt: Date.now() - 460_000,
      updatedAt: Date.now() - 400_000,
      state: 'running',
      jobIds: [JOB],
      requestId: REQUEST,
      stages: [],
    };
    await page.addInitScript(
      ([k, v]) => {
        if (!sessionStorage.getItem('mn-mpc-seeded')) localStorage.setItem(k!, v!);
        sessionStorage.setItem('mn-mpc-seeded', '1');
      },
      [recordKey(scope, 'bridge', { account: ACCOUNT, id: 'mpc-1' }), encodeRecord('bridge', rec, Date.now())],
    );
    await page.goto('/#transfers');
    await connect(page);
    await expect(page.getByTestId('bank-mpc-slow')).toContainText('1 transfer waited more than 20 minutes');
    const card = page.locator('[data-testid=transfer][data-id=mpc-1]');
    await expect(card.getByTestId('transfer-outcome')).toContainText('Sig Network is slower than usual', {
      timeout: 15_000,
    });
    timedOut = true;
    await expect(card).toHaveAttribute('data-state', 'needs-resume', { timeout: 15_000 });
    await expect(card.getByTestId('transfer-outcome')).toContainText(
      'Sig Network has not signed this request within 20 minutes. Nothing moved on Sepolia.',
    );
    await expect(card.getByTestId('resume-transfer')).toBeVisible();
  });
});

test.describe('the exchange', () => {
  /** A take through the mocked relay whose job fails with `error`. */
  async function takeFails(page: Page, error: { code: string; message: string }, health = {}) {
    await serveExchange(page);
    await installCustomer(page, { withAccount: true });
    await serveHealth(page, health);
    const JOB = '6'.repeat(32);
    await page.route('**/v1/actions/take', (route) =>
      json(route, 202, {
        job: {
          requestId: JOB,
          action: 'take',
          lane: 'prover',
          state: 'queued',
          stage: 'queued',
          stages: [{ stage: 'queued', at: 1 }],
          createdAt: 1,
          updatedAt: 1,
          expiresAt: 9_999_999_999,
        },
      }),
    );
    await page.route(`**/v1/jobs/${JOB}`, (route) =>
      json(route, 200, {
        job: {
          requestId: JOB,
          action: 'take',
          lane: 'prover',
          state: 'failed',
          stage: 'failed',
          stages: ['queued', 'running', 'offer-checked', 'proving', 'merged', 'failed'].map((stage) => ({
            stage,
            at: 2,
          })),
          createdAt: 1,
          updatedAt: 2,
          expiresAt: 9_999_999_999,
          error,
        },
      }),
    );
    await page.goto('/#trade');
    await connect(page);
    await expect(page.locator('[data-testid=trade-line]').first()).toBeVisible();
    await page.getByTestId('buy-best-ask').click();
    await page.getByTestId('take-sign').click();
  }

  test('its settlement service at its limit (HTTP 429): nothing moved, try later', async ({ page }) => {
    await takeFails(
      page,
      {
        code: 'exchange-busy',
        message:
          "the exchange's settlement service is not taking more settlements right now (HTTP 429: it allows a limited number a day). Nothing was settled and your coins did not move; try again later",
      },
      { batcherRefusal: 429 },
    );
    await expect(page.getByTestId('trade-message')).toHaveText(
      "The exchange's settlement service is not taking more settlements right now (HTTP 429: it allows a limited number a day). Nothing was settled and your coins did not move; try again later.",
    );
    await expect(page.getByTestId('bank-batcher-refusing')).toContainText('at its limit');
  });

  test('its settlement service failing (HTTP 500): what to check', async ({ page }) => {
    await takeFails(
      page,
      {
        code: 'exchange-error',
        message:
          "the exchange's settlement service failed (HTTP 500) and did not confirm the take. Refresh the book: if the offer was taken by someone else it is gone, and if your take settled after all your balances show it",
      },
      { batcherRefusal: 500 },
    );
    await expect(page.getByTestId('trade-message')).toContainText(
      "The exchange's settlement service failed (HTTP 500) and did not confirm the take.",
    );
    await expect(page.getByTestId('bank-batcher-refusing')).toContainText('is failing');
  });

  test('its settlement service down: taking pauses, making does not', async ({ page }) => {
    await serveExchange(page);
    await installCustomer(page, { withAccount: true });
    await serveHealth(page, { batcherDown: true });
    await page.goto('/#trade');
    await connect(page);
    await expect(page.locator('[data-testid=trade-line]').first()).toBeVisible();
    await expect(page.getByTestId('bank-batcher-down')).toContainText('Taking an offer is paused');
    await expect(page.getByTestId('buy-best-ask')).toBeDisabled();
    await page.getByTestId('make-quantity').fill('1');
    await page.getByTestId('make-price').fill('1.05');
    await expect(page.getByTestId('make-sign')).toBeEnabled();
  });

  test('the exchange (kernel) down: Trade says so, and nothing can be taken', async ({ page }) => {
    await serveExchange(page, { kernelDown: true });
    await installCustomer(page, { withAccount: true });
    await serveHealth(page);
    await page.goto('/#trade');
    await connect(page);
    await expect(page.getByTestId('trade-exchange-unavailable')).toContainText('Exchange unavailable', {
      timeout: 20_000,
    });
    await expect(page.getByTestId('buy-best-ask')).toBeDisabled();
  });
});

test.describe('the account', () => {
  test('more history than this version reads (Q27): the page says so, and keeps the last balances', async ({
    page,
  }) => {
    await serveExchange(page);
    await installCustomer(page, { withAccount: true });
    await serveHealth(page);
    // Registered after installCustomer's account routes, so it answers first (Playwright runs the
    // newest matching route first).
    await page.route(`**/v1/accounts/${ACCOUNT}/zswap`, (route) =>
      json(route, 501, {
        error: {
          code: 'history-too-long',
          message: 'this account has 500 or more actions, more history than this version of the bank can read',
        },
      }),
    );
    await page.goto('/#accounts');
    await connect(page);
    const message = page.getByTestId('accounts-message');
    await expect(message).toContainText('more history than this version of MN Bank can read', { timeout: 20_000 });
    await expect(message).toContainText('Nothing is lost');
    await expect(message).not.toContainText('cannot read Midnight right now');
    // The coins from the last refresh are still listed.
    await expect(page.getByTestId('passport-row').first()).toBeVisible();
  });
});

test.describe('the browser and the wallet', () => {
  test('local storage full: the page says so, and will not open an account here', async ({ page }) => {
    await page.addInitScript(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (this === window.localStorage) throw new DOMException('quota', 'QuotaExceededError');
        return setItem.call(this, key, value);
      };
    });
    await serveExchange(page);
    await installCustomer(page, { withAccount: false });
    await serveHealth(page);
    await page.goto('/#accounts');
    const banner = page.getByTestId('storage-banner');
    await expect(banner).toHaveAttribute('data-status', 'full');
    await expect(banner).toContainText('This browser has no room left for MN Bank’s records.');
    await expect(banner).toContainText('Free some site data');
    await connect(page);
    await expect(page.getByTestId('open-account')).toBeDisabled();
    await expect(page.getByTestId('open-account-storage')).toContainText('no room left');
    await page.goto('/#local');
    await expect(page.getByTestId('storage-blocked')).toHaveAttribute('data-status', 'full');
  });

  test('the wallet on another network: the page says which, pauses, and switches back on request', async ({ page }) => {
    await serveExchange(page);
    await installCustomer(page, { withAccount: false });
    await serveHealth(page);
    await page.goto('/#accounts');
    await connect(page);
    await expect(page.getByTestId('wrong-network')).toHaveCount(0);
    // The customer switches the wallet to Ethereum mainnet by hand.
    await page.evaluate(async () => {
      const provider = await new Promise<{ request(a: unknown): Promise<unknown> }>((resolve) => {
        window.addEventListener(
          'eip6963:announceProvider',
          (e) => resolve((e as CustomEvent<{ provider: { request(a: unknown): Promise<unknown> } }>).detail.provider),
          { once: true },
        );
        window.dispatchEvent(new Event('eip6963:requestProvider'));
      });
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
    });
    const banner = page.getByTestId('wrong-network');
    await expect(banner).toContainText('Your wallet is on another network.');
    await expect(banner).toContainText('your wallet is on chain 1');
    await expect(banner).toContainText('Nothing will be signed or sent until you switch.');
    await expect(page.getByTestId('open-account')).toBeDisabled();
    await page.getByTestId('wrong-network-switch').click();
    await expect(banner).toHaveCount(0);
    await expect(page.getByTestId('open-account')).toBeEnabled();
  });
});
