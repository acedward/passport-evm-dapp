// Plan L-TRD testing, the LIVE part through the UI (Q8 caps): one make and one take on the staging
// exchange, by the two accounts L-TRD.0 funded, with an injected EIP-1193 wallet backed by the
// account's device key (read by this test process from a mode-600 file; the page only sees a
// provider) and the relay (in Docker, configured for stagenet) under the shared funding lock.
// Never in CI: test/stack/run-trade-live.sh drives it, one phase per run:
//
//   make       LIVE_ACCOUNT's page: "Sell 10 wStkA at 0.02" on the Trade page, one signature, listed
//              (wUSDC is the quote at cent prices; 0.02 sits above the ladder asks, so no stranger
//              takes it first)
//   take       LIVE_ACCOUNT's page: the offer from the make phase, taken whole with one signature
//   reconcile  LIVE_ACCOUNT's page: Refresh until My offers shows the offer filled
//
// The account's records (address, encryption secret) are seeded into the page's local storage, as
// an Import would; nothing secret is written to the evidence (public values only).

import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import { Wallet } from 'ethers';

const RELAY = process.env.LIVE_RELAY_URL ?? '';
const PHASE = process.env.LIVE_PHASE ?? '';
const WHO = (process.env.LIVE_ACCOUNT ?? '') as 'A' | 'B' | '';
const CFG = process.env.LIVE_CFG_DIR ?? '/cfg';
const OUT = process.env.LIVE_OUT_DIR ?? join(process.cwd(), 'test-results', 'live-trade');
const KERNEL = 'https://stagenet.api-zswap.zkdojo.com';
const QTY = process.env.LIVE_QTY ?? '10';
const PRICE = process.env.LIVE_PRICE ?? '0.02';

/** The page's local storage between phases (it holds the encryption secret): mode 600, outside the
 *  repository and the evidence. */
const STATE_FILE = process.env.LIVE_STATE_DIR ? join(process.env.LIVE_STATE_DIR, `browser-${WHO}.json`) : '';

test.skip(!RELAY || !PHASE || !WHO, 'needs a stagenet relay and the live-run files (run-trade-live.sh)');
test.use({ storageState: STATE_FILE && existsSync(STATE_FILE) ? STATE_FILE : undefined });
test.setTimeout(30 * 60_000);

async function saveState(page: Page) {
  if (!STATE_FILE) return;
  await page.context().storageState({ path: STATE_FILE });
  chmodSync(STATE_FILE, 0o600);
}

interface Who {
  address: string;
  key: string;
  encSecret: string;
  encPublic: string;
}

/** The account, from the L-TRD.0 state files (read here, never printed). */
function who(): Who {
  const keyOf = (f: string) => {
    const m = /^(0x[0-9a-fA-F]{64})\s*$/.exec(readFileSync(join(CFG, f), 'utf8'));
    if (!m) throw new Error(`no key in ${f}`);
    return m[1]!;
  };
  if (WHO === 'A') {
    const g = JSON.parse(readFileSync(join(CFG, 'gate-bridge-state.json'), 'utf8'));
    return {
      address: String(g.account.address).replace(/^0x/, '').toLowerCase(),
      key: keyOf('gate-bridge-device.key'),
      encSecret: String(g.account.encSecretHex),
      encPublic: String(g.account.encPublicHex),
    };
  }
  const s = JSON.parse(readFileSync(join(CFG, 'l-trd-state.json'), 'utf8'));
  const b = s.accounts.B;
  return { address: b.address, key: keyOf('l-trd-B.key'), encSecret: b.encSecretHex, encPublic: b.encPublicHex };
}

/** An EIP-6963 wallet backed by `key` (in this process); the page sees only the provider. */
async function installWallet(page: Page, key: string) {
  const wallet = new Wallet(key);
  const calls: string[] = [];
  await page.exposeFunction('__mnbankLiveWallet', async (method: string, params: unknown[]) => {
    calls.push(method);
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [wallet.address];
      case 'eth_chainId':
        return '0xaa36a7';
      case 'eth_signTypedData_v4': {
        const td = JSON.parse(String(params[1])) as {
          domain: Record<string, unknown>;
          types: Record<string, unknown>;
          message: Record<string, unknown>;
        };
        const { EIP712Domain: _d, ...types } = td.types;
        return wallet.signTypedData(td.domain, types as never, td.message);
      }
      case 'eth_getBalance':
        return '0x0';
      case 'eth_call':
        return `0x${'0'.repeat(64)}`;
      default:
        return { __error: { code: 4200, message: `unsupported method ${method}` } };
    }
  });
  await page.addInitScript(() => {
    const bridge = (window as unknown as { __mnbankLiveWallet: (m: string, p: unknown[]) => Promise<unknown> })
      .__mnbankLiveWallet;
    const provider = {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        const r = await bridge(method, params ?? []);
        const err = (r as { __error?: { code: number; message: string } } | null)?.__error;
        if (err) throw Object.assign(new Error(err.message), { code: err.code });
        return r;
      },
      on() {},
      removeListener() {},
    };
    const info = {
      uuid: '0f5c2a4e-6b1d-4c38-9a57-00000000e2e1',
      name: 'MN Live Wallet',
      icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E',
      rdns: 'live.mnbank',
    };
    const announce = () =>
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  });
  return { address: wallet.address, calls };
}

async function open(page: Page) {
  const w = who();
  await page.route('**/config.json', (r) => r.fulfill({ json: { network: 'stagenet', relayUrl: RELAY } }));
  const wallet = await installWallet(page, w.key);
  const evm = wallet.address.toLowerCase();
  const base = `mn-bank/v1/stagenet/${evm}/${w.address}`;
  const rec = (kind: string, data: unknown) => JSON.stringify({ v: 1, kind, updatedAt: Date.now(), data });
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
          rec('account', {
            address: w.address,
            device: evm,
            network: 'stagenet',
            vault: '7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637',
            createdAt: Date.now(),
          }),
        ],
        ['secret', rec('secret', { encSecretKey: w.encSecret, encPublicKey: w.encPublic })],
        ['roster', rec('roster', { useCounter: '0' })],
        ['coins', rec('coins', [])],
      ],
    ] as const,
  );
  await page.goto('/#trade');
  await page.getByTestId('connect').click();
  await page.getByTestId('wallet-option').filter({ hasText: 'MN Live Wallet' }).click();
  await expect(page.getByTestId('section-trade')).toBeVisible();
  return { w, wallet };
}

const trades = (page: Page) =>
  page.evaluate(() => {
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.includes('/offer/')) out.push(JSON.parse(localStorage.getItem(k)!).data as Record<string, unknown>);
    }
    return out;
  });
const stagesSeen = (page: Page) =>
  page
    .getByTestId('trade-stage')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-stage')))
    .catch(() => [] as Array<string | null>);

async function evidence(name: string, body: Record<string, unknown>) {
  await mkdir(OUT, { recursive: true });
  await writeFile(
    join(OUT, `${name}.json`),
    `${JSON.stringify({ ...body, writtenUtc: new Date().toISOString() }, null, 2)}\n`,
  );
}

test('L-TRD live through the UI', async ({ page }) => {
  const { w, wallet } = await open(page);
  const t0 = Date.now();
  if (PHASE === 'make') {
    // Wait for the inbox walk to show a wStkA coin that can pay QTY.
    await page.getByTestId('trade-stock').selectOption('wStkA');
    await page.getByTestId('side-sell').check();
    await page.getByTestId('make-quantity').fill(QTY);
    await page.getByTestId('make-price').fill(PRICE);
    await expect(page.getByTestId('make-sign')).toBeEnabled({ timeout: 5 * 60_000 });
    const give = await page.getByTestId('legs-give').textContent();
    const want = await page.getByTestId('legs-want').textContent();
    await page.getByTestId('make-sign').click();
    await expect(page.getByTestId('trade-message')).toContainText('Your offer is on the exchange', {
      timeout: 15 * 60_000,
    });
    const stages = await stagesSeen(page);
    const made = (await trades(page)).find((t) => t.role === 'make' && t.status === 'live');
    const status = await (await fetch(`${KERNEL}/v1/offers/${String(made?.offerId)}/status`)).json();
    await evidence('ui-make', {
      account: w.address,
      device: wallet.address,
      order: `sell ${QTY} wStkA at ${PRICE}`,
      legs: { give, want },
      offerId: made?.offerId,
      expiresAt: made?.expiresAt,
      kernelStatus: status,
      signatures: wallet.calls.filter((c) => c === 'eth_signTypedData_v4').length,
      stages,
      seconds: Math.round((Date.now() - t0) / 1000),
    });
    expect(wallet.calls.filter((c) => c === 'eth_signTypedData_v4')).toHaveLength(1);
    expect(status.status).toBe('live');
  } else if (PHASE === 'take') {
    const made = JSON.parse(await readFile(join(OUT, 'ui-make.json'), 'utf8')) as { offerId: string };
    await page.getByTestId('trade-stock').selectOption('wStkA');
    const line = page.locator(`[data-testid=trade-line][data-offer="${made.offerId}"]`);
    await expect(line.getByTestId('take-line')).toBeVisible({ timeout: 5 * 60_000 });
    await line.getByTestId('take-line').click();
    const confirm = page.getByTestId('take-confirm');
    const give = await confirm.getByTestId('legs-give').textContent();
    const want = await confirm.getByTestId('legs-want').textContent();
    await confirm.getByTestId('take-sign').click();
    await expect(page.getByTestId('trade-message')).toContainText('settled in one transaction', {
      timeout: 15 * 60_000,
    });
    const stages = await stagesSeen(page);
    const taken = (await trades(page)).find((t) => t.role === 'take' && t.offerId === made.offerId);
    let status: unknown = null;
    for (let i = 0; i < 30; i++) {
      status = await (await fetch(`${KERNEL}/v1/offers/${made.offerId}/status`)).json();
      if ((status as { status?: string }).status === 'consumed') break;
      await page.waitForTimeout(5_000);
    }
    await evidence('ui-take', {
      account: w.address,
      device: wallet.address,
      offerId: made.offerId,
      legs: { give, want },
      settledTx: taken?.settledTx,
      kernelStatus: status,
      signatures: wallet.calls.filter((c) => c === 'eth_signTypedData_v4').length,
      stages,
      seconds: Math.round((Date.now() - t0) / 1000),
    });
    expect(wallet.calls.filter((c) => c === 'eth_signTypedData_v4')).toHaveLength(1);
    expect((status as { status?: string }).status).toBe('consumed');
  } else if (PHASE === 'reconcile') {
    // The maker's own browser (its storage kept from the make phase) learns of the fill from the
    // inbox walk and the exchange.
    const made = JSON.parse(await readFile(join(OUT, 'ui-make.json'), 'utf8')) as { offerId: string };
    const mine = page.locator(`[data-testid=my-trade][data-role=make]`).first();
    for (let i = 0; i < 20; i++) {
      await page.getByTestId('reconcile').click();
      if (
        (await mine.getAttribute('data-state')) === 'filled' &&
        (await mine.getByTestId('my-trade-tx').textContent()) !== '—'
      )
        break;
      await page.waitForTimeout(10_000);
    }
    const rec = (await trades(page)).find((t) => t.role === 'make' && t.offerId === made.offerId);
    await evidence('ui-reconcile', {
      account: w.address,
      offerId: made.offerId,
      status: rec?.status,
      settledTx: rec?.settledTx,
      kernelStatus: rec?.kernelStatus,
      seconds: Math.round((Date.now() - t0) / 1000),
    });
    expect(rec?.status).toBe('filled');
  } else {
    throw new Error(`unknown phase ${PHASE}`);
  }
  await saveState(page);
});
