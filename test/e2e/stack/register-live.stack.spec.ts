// Plan L-ACC testing, the capped live part (Q8): ONE registration on stagenet through the page,
// with a fresh test EOA (random per run, never stored) and the relay paying from the owner's
// shared stagenet wallet under the funding lock. Measures click-to-activated (SC-001: < 10 min)
// and reads the account back. Never in CI: it needs LIVE_RELAY_URL (a relay configured for
// stagenet with its key volume and sponsor).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { evmDeviceEntry } from '../../../packages/core/src/passport/gated.js';
import { installTestWallet } from '../test-wallet.js';

const RELAY = process.env.LIVE_RELAY_URL ?? '';
const OUT = process.env.LIVE_OUT_DIR ?? join(process.cwd(), 'test-results', 'live');

test.skip(!RELAY, 'needs a stagenet relay (LIVE_RELAY_URL)');
test.setTimeout(20 * 60_000);

test('opens one account on stagenet with one signature, in under 10 minutes', async ({ page }) => {
  await page.route('**/config.json', (r) => r.fulfill({ json: { network: 'stagenet', relayUrl: RELAY } }));
  const wallet = await installTestWallet(page, { startChainId: '0xaa36a7', sepolia: { ethWei: 0n } });
  await page.goto('/#accounts');
  await page.getByTestId('connect').click();
  await page.getByTestId('wallet-option').filter({ hasText: 'MN Test Wallet' }).click();
  await expect(page.getByTestId('no-account')).toBeVisible();

  const stagesSeen: Array<{ stage: string; atMs: number }> = [];
  const tClick = Date.now();
  await page.getByTestId('open-account').click();
  await expect(page.getByTestId('job-tracker')).toBeVisible({ timeout: 60_000 });
  const poll = setInterval(() => {
    void page
      .getByTestId('job-tracker')
      .getAttribute('data-stage')
      .then((s) => {
        if (s && stagesSeen.at(-1)?.stage !== s) stagesSeen.push({ stage: s, atMs: Date.now() - tClick });
      })
      .catch(() => {});
  }, 1_000);
  await expect(page.getByTestId('account-address')).toBeVisible({ timeout: 15 * 60_000 });
  clearInterval(poll);
  const clickToActivatedSeconds = (Date.now() - tClick) / 1000;
  const signatures = wallet.calls.filter(
    (c) => c.method === 'eth_signTypedData_v4' || c.method === 'personal_sign',
  ).length;
  expect(signatures).toBe(1);
  const account = (await page.getByTestId('account-address').textContent())!.trim();

  const state = (await (await fetch(`${RELAY}/v1/accounts/${account}/state`)).json()) as Record<string, unknown>;
  expect(state.booted).toBe(true);
  expect(state.deviceCount).toBe(1);
  expect(state.devices).toEqual([evmDeviceEntry(account, wallet.address, BigInt(String(state.deviceEpoch)), 0n)]);
  const stored = await page.evaluate(
    ([evm, acc]) => JSON.parse(localStorage.getItem(`mn-bank/v1/stagenet/${evm}/${acc}/secret`) ?? 'null'),
    [wallet.address.toLowerCase(), account],
  );
  expect(stored?.data?.encPublicKey).toBe(state.encKey);
  const record = await page.evaluate(
    ([evm, acc]) => JSON.parse(localStorage.getItem(`mn-bank/v1/stagenet/${evm}/${acc}/account`) ?? 'null'),
    [wallet.address.toLowerCase(), account],
  );

  await mkdir(OUT, { recursive: true });
  await writeFile(
    join(OUT, 'registration.json'),
    `${JSON.stringify(
      {
        account,
        device: wallet.address.toLowerCase(),
        vault: state.vault,
        booted: state.booted,
        deviceCount: state.deviceCount,
        encKeyMatches: stored?.data?.encPublicKey === state.encKey,
        txs: record?.data?.txs ?? null,
        signatures,
        clickToActivatedSeconds,
        stagesSeen,
      },
      null,
      2,
    )}\n`,
  );
  expect(clickToActivatedSeconds).toBeLessThan(600); // SC-001
});
