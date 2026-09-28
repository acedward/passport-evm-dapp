// Plan P1 testing: the Playwright smoke. The shell renders; a wallet connects through EIP-6963;
// the switch to Sepolia is requested; Local data round-trips export -> CLEAR ALL -> import, with
// the encryption secret masked until revealed and another tab's writes showing up here.

import { readFile } from 'node:fs/promises';

import { x25519 } from '@noble/curves/ed25519.js';
import { expect, test, type Page } from '@playwright/test';
import { hexlify, randomBytes } from 'ethers';

import { encodeRecord, recordKey } from '../../web/src/store/schema.js';
import { installTestWallet } from './test-wallet.js';

const SECTIONS = ['accounts', 'markets', 'transfers', 'trade', 'local'];

/** Every key the bank keeps in this browser, with its value. */
const bankKeys = (page: Page) =>
  page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith('mn-bank/')) out[k] = localStorage.getItem(k)!;
    }
    return out;
  });

test('shell, wallet connection with the Sepolia switch, and the Local data round trip', async ({ page, context }) => {
  const wallet = await installTestWallet(page);
  await page.goto('/');

  // The shell renders.
  await expect(page.getByRole('heading', { name: 'MN Bank' })).toBeVisible();
  for (const s of SECTIONS) await expect(page.getByTestId(`tab-${s}`)).toBeVisible();
  await expect(page.getByTestId('network-name')).toContainText('stagenet');

  // Connect through EIP-6963; the wallet starts on mainnet, so the dApp must ask for Sepolia.
  await page.getByTestId('connect').click();
  await page.getByTestId('wallet-option').filter({ hasText: 'MN Test Wallet' }).click();
  await expect(page.getByTestId('wallet-address')).toContainText(wallet.address.slice(0, 6));
  await expect(page.getByTestId('wallet-chain')).toHaveText('Sepolia');
  expect(wallet.calls.map((c) => c.method)).toEqual(
    expect.arrayContaining(['eth_requestAccounts', 'eth_chainId', 'wallet_switchEthereumChain']),
  );
  expect(wallet.calls.find((c) => c.method === 'wallet_switchEthereumChain')?.params).toEqual([
    { chainId: '0xaa36a7' },
  ]);
  // No private key or seed is ever requested (FR-001).
  expect(wallet.calls.every((c) => !/private|seed|mnemonic/i.test(c.method))).toBe(true);

  // Local data shows the wallet's profile record.
  await page.getByTestId('tab-local').click();
  await expect(page.locator('[data-testid=record-row][data-kind=profile]')).toHaveCount(1);

  // Another tab writes this wallet's account records; this tab follows (storage events).
  const scope = { network: 'stagenet', evmAddress: wallet.address };
  const account = hexlify(randomBytes(32)).slice(2);
  // Records as the page writes them: Import accepts nothing else (security review F-B4).
  const secretBytes = x25519.utils.randomSecretKey();
  const encSecretKey = Buffer.from(secretBytes).toString('hex');
  const encPublicKey = Buffer.from(x25519.getPublicKey(secretBytes)).toString('hex');
  const colour = 'ab'.repeat(32);
  const other = await context.newPage();
  await other.goto('/');
  await other.evaluate(
    (entries) => {
      for (const [k, v] of entries) localStorage.setItem(k, v);
    },
    [
      [
        recordKey(scope, 'account', { account }),
        encodeRecord(
          'account',
          {
            address: account,
            device: wallet.address.toLowerCase(),
            network: 'stagenet',
            vault: 'ee'.repeat(32),
            createdAt: Date.now(),
          },
          Date.now(),
        ),
      ],
      [recordKey(scope, 'secret', { account }), encodeRecord('secret', { encSecretKey, encPublicKey }, Date.now())],
      [
        recordKey(scope, 'coins', { account }),
        encodeRecord(
          'coins',
          [
            {
              nonce: '01'.repeat(32),
              color: colour,
              value: '60000000',
              mtIndex: '7',
              commitment: 'c0'.repeat(32),
              origin: 'inbox',
              inInbox: true,
              inboxIndex: '0',
              spent: false,
            },
          ],
          Date.now(),
        ),
      ],
    ] as Array<[string, string]>,
  );
  await other.close();
  await expect(page.locator('[data-testid=record-row]')).toHaveCount(4);

  // The secret is masked until revealed.
  const secretRow = page.locator('[data-testid=record-row][data-kind=secret]');
  await expect(secretRow.getByTestId('record-masked')).toBeVisible();
  await expect(page.getByTestId('records')).not.toContainText(encSecretKey);
  await secretRow.getByTestId('reveal').click();
  await expect(secretRow.getByTestId('record-value')).toContainText(encSecretKey);
  await secretRow.getByTestId('reveal').click();
  await expect(page.getByTestId('records')).not.toContainText(encSecretKey);

  const before = await bankKeys(page);
  expect(Object.keys(before)).toHaveLength(5); // 4 records + the schema marker

  // Export.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export').click()]);
  expect(download.suggestedFilename()).toMatch(/^mn-bank-stagenet-0x[0-9a-f]{8}-\d{4}-\d{2}-\d{2}\.json$/);
  const exported = await readFile((await download.path())!, 'utf8');
  const file = JSON.parse(exported) as { format: string; network: string; evmAddress: string; records: unknown[] };
  expect(file).toMatchObject({
    format: 'mn-bank-local-data',
    network: 'stagenet',
    evmAddress: wallet.address.toLowerCase(),
  });
  expect(file.records).toHaveLength(4);

  // CLEAR ALL offers an export first and needs the typed phrase.
  await page.getByTestId('clear-all').click();
  await expect(page.getByTestId('clear-dialog')).toBeVisible();
  await expect(page.getByTestId('clear-export-first')).toBeVisible();
  await page.getByTestId('clear-confirm-input').fill('clear all');
  await expect(page.getByTestId('clear-confirm')).toBeDisabled();
  await page.getByTestId('clear-confirm-input').fill('CLEAR ALL');
  await page.getByTestId('clear-confirm').click();
  await expect(page.getByTestId('records-empty')).toBeVisible();
  expect(await bankKeys(page)).toEqual({}); // SC-005: no dApp key remains

  // Import restores exactly what was there.
  await page
    .getByTestId('import-file')
    .setInputFiles({ name: 'export.json', mimeType: 'application/json', buffer: Buffer.from(exported) });
  await expect(page.getByTestId('local-message')).toContainText('Imported 4 records');
  expect(await bankKeys(page)).toEqual(before);
  await expect(page.locator('[data-testid=record-row]')).toHaveCount(4);

  // A file for another wallet is refused, with a clear message, and nothing changes.
  const foreign = { ...JSON.parse(exported), evmAddress: `0x${'22'.repeat(20)}` };
  await page
    .getByTestId('import-file')
    .setInputFiles({ name: 'other.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(foreign)) });
  await expect(page.getByTestId('local-message')).toContainText('another wallet');
  await page
    .getByTestId('import-file')
    .setInputFiles({ name: 'garbage.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":') });
  await expect(page.getByTestId('local-message')).toContainText('could not be read');
  expect(await bankKeys(page)).toEqual(before);
});

test('says so when the browser blocks storage', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
  });
  await page.goto('/#local');
  await expect(page.getByTestId('storage-banner')).toBeVisible();
  await expect(page.getByTestId('storage-blocked')).toBeVisible();
  await expect(page.getByTestId('export')).toBeDisabled();
});
