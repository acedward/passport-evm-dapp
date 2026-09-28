// Plan L-ACC testing, on the local ledger-9 stack (never in CI: it needs the stack, the relay with
// its key volume and a sponsor wallet; test/stack/run-accounts.sh drives it).
//
//   1. register a fresh EOA through the page (an injected EIP-1193 test wallet, key random per run):
//      ONE wallet signature; the page shows the relay's stages; the account reads back booted,
//      one device (this EOA), enc_key = the public key stored in this browser;
//   2. a third party funds it with deposit_shielded (the harness does, between two signals);
//   3. the inbox walk (decrypted in the page) shows the coin with its exact value and position;
//   4. one k=18 spend (withdraw_shielded_with_evm) with ONE signature, then the change re-filed in
//      the inbox with ONE more (Q13 default A);
//   5. an independent inbox walk from the exported secret, outside the dApp, equals the page;
//   6. Export -> CLEAR ALL -> Import restores the same balances.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

// Module by module (the package entry points also load JSON records the test does not need).
import { contractCoinCommitment, holdingsByColour, reconcileCoins } from '../../../packages/core/src/coins.js';
import { evmDeviceEntry } from '../../../packages/core/src/passport/gated.js';
import { openEntryPortable } from '../../../vendor/passport/contract/src/wallet/deposit.js';
import { installTestWallet, type TestWallet } from '../test-wallet.js';

const RELAY = process.env.STACK_RELAY_URL ?? '';
const SIGNALS = process.env.STACK_SIGNAL_DIR ?? join(process.cwd(), 'test-results', 'stack');
const TOKENS = process.env.STACK_TOKENS_JSON ? (JSON.parse(process.env.STACK_TOKENS_JSON) as unknown) : null;
const SEND_WHOLE = process.env.STACK_SEND_AMOUNT ?? '1.5';

test.skip(!RELAY || !TOKENS, 'needs the local stack (test/stack/run-accounts.sh)');
test.setTimeout(45 * 60_000);

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

const relayGet = async (path: string) => {
  const r = await fetch(`${RELAY}${path}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<Record<string, unknown>>;
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

const rowRaw = (page: Page, colour: string, testId: 'passport-amount' | 'passport-largest') =>
  page.locator(`[data-testid=passport-row][data-colour="${colour}"] [data-testid=${testId}]`).getAttribute('data-raw');

test('open an account, fund it, see it, spend from it with one signature, and restore it', async ({ page }) => {
  const timings: Record<string, number> = {};
  await page.route('**/config.json', (r) =>
    r.fulfill({ json: { network: 'undeployed', relayUrl: RELAY, tokens: TOKENS } }),
  );
  const wallet = await installTestWallet(page, { startChainId: '0xaa36a7', sepolia: { ethWei: 5n * 10n ** 17n } });
  await page.goto('/#accounts');
  await page.getByTestId('connect').click();
  await page.getByTestId('wallet-option').filter({ hasText: 'MN Test Wallet' }).click();
  await expect(page.getByTestId('wallet-chain')).toHaveText('Sepolia');

  // Sepolia holdings come from the wallet's provider (the fake chain says 0.5 ETH).
  await expect(page.locator('[data-testid=sepolia-row][data-symbol=ETH] [data-testid=sepolia-balance]')).toHaveText(
    '0.5',
  );

  // ── 1. register: one signature ────────────────────────────────────────────────
  await expect(page.getByTestId('no-account')).toBeVisible();
  expect(signatures(wallet)).toBe(0);
  const tClick = Date.now();
  await page.getByTestId('open-account').click();
  await expect(page.getByTestId('job-tracker')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('account-address')).toBeVisible({ timeout: 15 * 60_000 });
  timings.clickToActivatedSeconds = (Date.now() - tClick) / 1000;
  expect(signatures(wallet)).toBe(1);
  const account = (await page.getByTestId('account-address').textContent())!.trim();
  expect(account).toMatch(/^[0-9a-f]{64}$/);

  const state = await relayGet(`/v1/accounts/${account}/state`);
  expect(state.booted).toBe(true);
  expect(state.deviceCount).toBe(1);
  const entry0 = evmDeviceEntry(account, wallet.address, BigInt(String(state.deviceEpoch)), 0n);
  expect(state.devices).toEqual([entry0]); // the one device is this EOA, at use counter 0
  const stored = await page.evaluate(
    ([evm, acc]) => JSON.parse(localStorage.getItem(`mn-bank/v1/undeployed/${evm}/${acc}/secret`) ?? 'null'),
    [wallet.address.toLowerCase(), account],
  );
  expect(stored?.data?.encPublicKey).toBe(state.encKey); // enc_key == the public key this browser keeps
  await signal('registered', { account, device: wallet.address.toLowerCase(), timings });

  // ── 2. the harness funds it (deposit_shielded by a third party) ─────────────────
  const funded = await waitForSignal<{
    txId: string;
    coin: { nonce: string; color: string; value: string };
    funderCoinPublicKey: string;
    funderShieldedAddress: string;
  }>('funded', 20 * 60_000);
  const colour = funded.coin.color;
  const value = BigInt(funded.coin.value);

  // ── 3. the inbox walk shows the coin, with its exact position ───────────────────
  await page.getByTestId('refresh-balances').click();
  await expect(page.locator(`[data-testid=passport-row][data-colour="${colour}"]`)).toBeVisible({ timeout: 120_000 });
  expect(await rowRaw(page, colour, 'passport-amount')).toBe(value.toString());
  expect(await rowRaw(page, colour, 'passport-largest')).toBe(value.toString());
  const zswap = await relayGet(`/v1/accounts/${account}/zswap`);
  const commitment = contractCoinCommitment(funded.coin, account);
  const leaf = (zswap.outputs as Array<{ commitment: string; mtIndex: string; txHash: string }>).find(
    (o) => o.commitment === commitment,
  );
  expect(leaf).toBeTruthy();
  const coinsRecord = await page.evaluate(
    ([evm, acc]) => JSON.parse(localStorage.getItem(`mn-bank/v1/undeployed/${evm}/${acc}/coins`) ?? 'null'),
    [wallet.address.toLowerCase(), account],
  );
  expect(coinsRecord.data).toEqual([expect.objectContaining({ commitment, mtIndex: leaf!.mtIndex, inInbox: true })]);

  // ── 4. one k=18 spend, one signature; then the change re-filed, one more ─────────
  const sigsBefore = signatures(wallet);
  const send = BigInt(Math.round(Number(SEND_WHOLE) * 1e6)); // the local test colours use 6 decimals
  await page.getByTestId('send-midnight').locator('summary').click();
  await page.getByTestId('send-amount').fill(SEND_WHOLE);
  await page.getByTestId('send-recipient').fill(funded.funderShieldedAddress); // a third-party wallet
  const tSend = Date.now();
  await page.getByTestId('send-submit').click();
  await expect(page.getByTestId('accounts-message')).toContainText('Sent (tx', { timeout: 20 * 60_000 });
  timings.withdrawSeconds = (Date.now() - tSend) / 1000;
  const tSecure = Date.now();
  await expect(page.getByTestId('accounts-message')).toContainText('the change is recorded in your inbox', {
    timeout: 20 * 60_000,
  });
  timings.appendInboxSeconds = (Date.now() - tSecure) / 1000;
  expect(signatures(wallet) - sigsBefore).toBe(2); // exactly one per action
  await page.getByTestId('refresh-balances').click();
  await expect
    .poll(() => rowRaw(page, colour, 'passport-amount'), { timeout: 120_000 })
    .toBe((value - send).toString());
  await expect(page.getByTestId('pending-items')).toHaveCount(0);

  // ── 5. an independent inbox walk from the exported secret (outside the page) ─────
  await page.getByTestId('tab-local').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export').click()]);
  const exported = await readFile((await download.path())!, 'utf8');
  const file = JSON.parse(exported) as { records: Array<{ key: string; value: { data: unknown } }> };
  const secret = file.records.find((r) => r.key.endsWith(`/${account}/secret`))!.value.data as { encSecretKey: string };
  const st = await relayGet(`/v1/accounts/${account}/state`);
  const inbox = await relayGet(`/v1/accounts/${account}/inbox?from=0&limit=500`);
  const opened: Array<{ nonce: string; color: string; value: string; inboxIndex: string }> = [];
  for (const [i, e] of (inbox.entries as Array<string | null>).entries()) {
    if (!e) continue;
    const c = await openEntryPortable(Buffer.from(secret.encSecretKey, 'hex'), Buffer.from(e, 'hex'));
    if (c)
      opened.push({
        nonce: Buffer.from(c.nonce).toString('hex'),
        color: Buffer.from(c.color).toString('hex'),
        value: c.value.toString(),
        inboxIndex: String(i),
      });
  }
  const z2 = await relayGet(`/v1/accounts/${account}/zswap`);
  const independent = holdingsByColour(
    reconcileCoins({
      account,
      inbox: opened,
      outputs: z2.outputs as never,
      inputs: z2.inputs as never,
      previous: [],
    }),
  );
  expect(independent.map((h) => [h.color, h.total.toString()])).toEqual([[colour, (value - send).toString()]]);
  expect(Number(st.inboxCount)).toBe(2); // the deposit's entry and the re-filed change

  // ── 6. Export -> CLEAR ALL -> Import restores the same balances ───────────────────
  await page.getByTestId('clear-all').click();
  await page.getByTestId('clear-confirm-input').fill('CLEAR ALL');
  await page.getByTestId('clear-confirm').click();
  expect(await bankKeys(page)).toEqual({});
  await page.getByTestId('tab-accounts').click();
  await expect(page.getByTestId('no-account')).toBeVisible();
  await page.getByTestId('tab-local').click();
  await page
    .getByTestId('import-file')
    .setInputFiles({ name: 'export.json', mimeType: 'application/json', buffer: Buffer.from(exported) });
  await expect(page.getByTestId('local-message')).toContainText('Imported');
  await page.getByTestId('tab-accounts').click();
  await expect(page.getByTestId('account-address')).toHaveText(account);
  await page.getByTestId('refresh-balances').click();
  await expect
    .poll(() => rowRaw(page, colour, 'passport-amount'), { timeout: 120_000 })
    .toBe((value - send).toString());

  await signal('done', {
    account,
    device: wallet.address.toLowerCase(),
    timings,
    signatures: signatures(wallet),
    inboxCount: st.inboxCount,
    funded: { txId: funded.txId, value: funded.coin.value, colour, mtIndex: leaf!.mtIndex },
    remaining: (value - send).toString(),
  });
});
