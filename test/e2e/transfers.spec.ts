// Plan L-BRG testing, the UI half in CI: the Transfers page against a MOCKED relay and MPC (served
// through page.route) and an injected EIP-1193 test wallet (key random per run, fake Sepolia).
//
//   - deposit: the deposit address derived in the page (G-BRIDGE's live one for its account), the
//     wallet sends the ERC20 and the gas (two eth_sendTransaction), ONE signature starts it, the
//     tracker shows every stage and hash, the coin lands;
//   - the preflight refuses a start without gas before anything is signed;
//   - resume: the relay "restarts" (the job is lost), the page reloads, the customer resumes by
//     request id with one RelayAction signature, and the transfer completes;
//   - a partial withdrawal: one signature, then the change re-filed with a second (Q13 A).
//
// The same flows run LIVE on stagenet and Sepolia in test/e2e/stack/bridge-live.stack.spec.ts.

import { expect, test, type Page, type Route } from '@playwright/test';

import { evmDeviceEntry } from '../../packages/core/src/passport/gated.js';
import { installTestWallet, type TestWallet } from './test-wallet.js';

const RELAY = 'http://relay.test';
const ACCOUNT = '70a62b7d0ceca7905a50f5539c5484f3f77aae6e67cf7a5a87d5eeb6887c2a30'; // G-BRIDGE's account
const DEPOSIT_ADDRESS = '0xEb5A392eeee639C23434C1FA8bccbF6bC730377C';
const VAULT_EVM = '0x648216975e722494bFF92E88FFc68C8F8d438FaA';
const STKA = '0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52';
const WSTKA = '5eb2a3cebb2ebe7ba910c78f62c9e28e0d74acbd00c810730def3578860e6a02';
const REQUEST = 'a1'.repeat(32);
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

type Stage = { stage: string; at: number; detail?: Record<string, string> };

class MockRelay {
  submitted: Array<{ action: string; body: Record<string, unknown> }> = [];
  jobs = new Map<
    string,
    { action: string; script: Stage[][]; step: number; result: Record<string, unknown>; lane: string }
  >();
  quote: Record<string, unknown> = {};
  lost = false;
  constructor(readonly device: string) {}

  state() {
    return {
      account: ACCOUNT,
      booted: true,
      deviceCount: 1,
      deviceEpoch: '0',
      devices: [0n, 1n, 2n, 3n].map((k) => evmDeviceEntry(ACCOUNT, this.device, 0n, k)),
      authNonce: String(this.submitted.filter((s) => s.action !== 'bridge-resume').length),
      inboxCount: '0',
      encKey: 'ab'.repeat(32),
      vault: '7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637',
      evmDomainSalt: '5a'.repeat(32),
    };
  }

  script(
    action: string,
    body: Record<string, unknown>,
  ): { script: Stage[][]; result: Record<string, unknown>; lane: string } {
    const t = Math.floor(Date.now() / 1000);
    const p = (body.payload ?? {}) as Record<string, string>;
    if (action === 'append-inbox')
      return { script: [[{ stage: 'running', at: t }]], result: { txId: 'mid-append' }, lane: 'prover' };
    const kind = action === 'bridge-resume' ? p.kind : action === 'bridge-deposit' ? 'deposit' : 'withdraw';
    const change =
      kind === 'withdraw' && action !== 'bridge-resume' && BigInt(p.amount!) < 1_000_000n
        ? { nonce: 'cc'.repeat(32), color: WSTKA, value: String(1_000_000n - BigInt(p.amount!)) }
        : null;
    const head: Stage[] =
      action === 'bridge-resume'
        ? [
            { stage: 'running', at: t },
            { stage: 'resumed', at: t, detail: { requestId: REQUEST, kind: kind! } },
          ]
        : [
            { stage: 'running', at: t },
            { stage: 'preflight', at: t, detail: { evmNonce: '0' } },
            { stage: 'starting', at: t, detail: { circuit: `bridge_${kind}_start_with_evm` } },
            {
              stage: 'started',
              at: t,
              detail: {
                tx: 'mid-start',
                txHash: 'f0'.repeat(32),
                requestId: REQUEST,
                startedAtMs: String(Date.now()),
                ...(change ? { changeNonce: change.nonce, changeColour: change.color, changeValue: change.value } : {}),
              },
            },
          ];
    const tail: Stage[] = [
      {
        stage: 'mpc-signed',
        at: t + 1,
        detail: { signedTx: `0x${'5e'.repeat(32)}`, from: DEPOSIT_ADDRESS, evmNonce: '0' },
      },
      {
        stage: 'evm-broadcast',
        at: t + 2,
        detail: { evmTx: `0x${'5e'.repeat(32)}`, evmBlock: '11794644', evmStatus: '1' },
      },
      { stage: 'evm-final', at: t + 3, detail: { evmBlock: '11794644', finalizedBlock: '11794700' } },
      { stage: 'attested', at: t + 4, detail: { kind: 'success', evmTx: `0x${'5e'.repeat(32)}` } },
      {
        stage: 'settled',
        at: t + 5,
        detail: { tx: 'mid-settle', txHash: 'e0'.repeat(32), circuit: `bridge_${kind}_complete` },
      },
    ];
    return {
      script: [head, tail],
      lane: kind === 'deposit' ? 'deposit' : 'withdrawal',
      result: {
        kind,
        account: ACCOUNT,
        requestId: REQUEST,
        startTx: action === 'bridge-resume' ? null : 'mid-start',
        attested: 'success',
        evmTxHash: `0x${'5e'.repeat(32)}`,
        settleTx: 'mid-settle',
        settleCircuit: kind === 'deposit' ? 'bridge_deposit_complete' : 'bridge_withdraw_complete',
        coin: kind === 'deposit' ? { nonce: 'ee'.repeat(32), color: WSTKA, value: '1000000' } : null,
        change,
        entryMatchesCoin: true,
      },
    };
  }

  view(id: string, advance = true) {
    const j = this.jobs.get(id)!;
    const stages: Stage[] = [{ stage: 'queued', at: 1 }, ...j.script.slice(0, j.step + 1).flat()];
    const done = j.step >= j.script.length - 1;
    if (advance) j.step = Math.min(j.step + 1, j.script.length - 1);
    return {
      requestId: id,
      action: j.action,
      lane: j.lane,
      state: done ? 'succeeded' : 'running',
      stage: done ? 'succeeded' : stages.at(-1)!.stage,
      stages: done ? [...stages, { stage: 'succeeded', at: 9 }] : stages,
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 9_999_999_999,
      ...(done ? { result: j.result } : {}),
    };
  }

  async handle(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (url.pathname === '/v1/auth/nonce')
      return json(200, { nonce: `0x${'12'.repeat(32)}`, expiresAt: 9_999_999_999, maxTtlSeconds: 600 });
    if (url.pathname.endsWith('/state')) return json(200, this.state());
    if (url.pathname.endsWith('/inbox')) return json(200, { account: ACCOUNT, from: 0, entries: [], total: 0 });
    if (url.pathname.endsWith('/zswap'))
      return json(200, { account: ACCOUNT, outputs: [], inputs: [], transactions: 0, blockHeight: 1 });
    if (url.pathname === '/v1/bridge/quote') {
      const kind = url.searchParams.get('kind')!;
      return json(200, {
        kind,
        account: ACCOUNT,
        payer: kind === 'deposit' ? DEPOSIT_ADDRESS : VAULT_EVM,
        vaultEvmAddress: VAULT_EVM,
        erc20: url.searchParams.get('erc20'),
        evm: {
          nonce: '0',
          gasLimit: '100000',
          maxFeePerGas: '10000000000',
          maxPriorityFeePerGas: '1000000000',
          keyVersion: '1',
        },
        maxGasCostWei: '1000000000000000',
        payerEthWei: '1000000000000000',
        payerErc20: '1000000',
        lane: { running: 0, waiting: 0 },
        openInVault: 0,
        accountOpen: [],
        ...this.quote,
      });
    }
    const action = /^\/v1\/actions\/(.+)$/.exec(url.pathname)?.[1];
    if (action && req.method() === 'POST') {
      const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>;
      this.submitted.push({ action, body });
      const id = String(this.submitted.length).padStart(32, '0');
      this.jobs.set(id, { action, step: 0, ...this.script(action, body) });
      const v = this.view(id, false);
      return json(202, {
        job: { ...v, state: 'queued', stage: 'queued', stages: [{ stage: 'queued', at: 1 }], result: undefined },
      });
    }
    const job = /^\/v1\/jobs\/([0-9a-f]{32})$/.exec(url.pathname)?.[1];
    if (job) {
      if (this.lost || !this.jobs.has(job)) return json(404, { error: { code: 'not-found', message: 'no such job' } });
      return json(200, { job: this.view(job) });
    }
    return json(404, { error: { code: 'not-found', message: 'no such route' } });
  }
}

const signatures = (w: TestWallet) => w.calls.filter((c) => c.method === 'eth_signTypedData_v4').length;

async function open(page: Page, coins: unknown[] = []) {
  await page.route(
    (url) => url.hostname !== '127.0.0.1',
    (route) => route.abort('blockedbyclient'),
  );
  await page.route('**/config.json', (r) => r.fulfill({ json: { network: 'stagenet', relayUrl: RELAY } }));
  const wallet = await installTestWallet(page, {
    startChainId: '0xaa36a7',
    sepolia: { ethWei: 10n ** 17n, erc20: { [STKA.toLowerCase()]: 5_000_000n } },
  });
  const relay = new MockRelay(wallet.address);
  await page.route(`${RELAY}/**`, (r) => relay.handle(r));
  const evm = wallet.address.toLowerCase();
  const base = `mn-bank/v1/stagenet/${evm}/${ACCOUNT}`;
  const rec = (kind: string, data: unknown) => JSON.stringify({ v: 1, kind, updatedAt: 1, data });
  await page.addInitScript(
    ([b, entries]) => {
      if (localStorage.getItem('mn-bank/schema')) return; // seeded once; reloads keep the page's own writes
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
        ['secret', rec('secret', { encSecretKey: '11'.repeat(32), encPublicKey: 'ab'.repeat(32) })],
        ['roster', rec('roster', { useCounter: '0' })],
        ['coins', rec('coins', coins)],
      ],
    ] as const,
  );
  await page.goto('/#transfers');
  await page.getByTestId('connect').click();
  await page.getByTestId('wallet-option').filter({ hasText: 'MN Test Wallet' }).click();
  await expect(page.getByTestId('deposit-address')).toHaveText(DEPOSIT_ADDRESS);
  return { wallet, relay };
}

test.describe('Transfers (mocked relay and MPC)', () => {
  test.setTimeout(120_000);

  test('deposit: two wallet sends, ONE signature, every stage and hash, the coin lands', async ({ page }) => {
    const { wallet, relay } = await open(page);
    await page.getByTestId('deposit-token').selectOption('stkA');
    await page.getByTestId('deposit-amount').fill('1');
    await page.getByTestId('deposit-continue').click();
    await page.getByTestId('send-tokens').click();
    await expect(page.getByTestId('tokens-ready')).toBeVisible();
    await page.getByTestId('send-gas').click();
    await expect(page.getByTestId('gas-ready')).toBeVisible();
    const sends = wallet.calls.filter((c) => c.method === 'eth_sendTransaction');
    expect(sends).toHaveLength(2);
    expect((sends[0]!.params as Array<{ to: string }>)[0]!.to).toBe(STKA);
    expect((sends[1]!.params as Array<{ to: string; value: string }>)[0]).toMatchObject({
      to: DEPOSIT_ADDRESS,
      value: '0x38d7ea4c68000',
    });

    await page.getByTestId('start-deposit').click();
    const card = page.getByTestId('transfer').first();
    await expect(card).toHaveAttribute('data-state', 'succeeded', { timeout: 60_000 });
    expect(signatures(wallet)).toBe(1);
    expect(relay.submitted.map((s) => s.action)).toEqual(['bridge-deposit']);
    expect(relay.submitted[0]!.body.passportAuth).toMatchObject({
      owner: wallet.address.toLowerCase(),
      useCounter: '0',
    });
    for (const s of ['preflight', 'started', 'mpc-signed', 'evm-broadcast', 'evm-final', 'attested', 'settled'])
      await expect(card.locator(`[data-testid=transfer-stage][data-stage=${s}]`)).toBeVisible();
    await expect(card.getByTestId('transfer-request')).toContainText('a1a1a1a1');
    await expect(card.locator(`a[href="https://sepolia.etherscan.io/tx/0x${'5e'.repeat(32)}"]`).first()).toBeVisible();
    await expect(card.getByTestId('transfer-outcome')).toHaveText('1.00 wStkA arrived in your account.');
    const coins = await page.evaluate(
      ([k]) => JSON.parse(localStorage.getItem(k!) ?? 'null')?.data,
      [`mn-bank/v1/stagenet/${wallet.address.toLowerCase()}/${ACCOUNT}/coins`],
    );
    expect(coins).toEqual([expect.objectContaining({ color: WSTKA, value: '1000000', nonce: 'ee'.repeat(32) })]);
  });

  test('the preflight refuses a start without the sweep gas, before anything is signed', async ({ page }) => {
    const { wallet, relay } = await open(page);
    relay.quote = { payerEthWei: '0' };
    await page.getByTestId('deposit-amount').fill('1');
    await page.getByTestId('deposit-continue').click();
    await page.getByTestId('start-deposit').click();
    await expect(page.getByTestId('deposit-message')).toContainText('Not started, nothing was signed');
    await expect(page.getByTestId('preflight-problem')).toHaveText(
      'The deposit address holds 0 wei but the sweep may cost up to 1000000000000000 wei (gasLimit 100000 x maxFeePerGas 10000000000): send it gas ETH first.',
    );
    expect(signatures(wallet)).toBe(0);
    expect(relay.submitted).toEqual([]);
  });

  test('resume: the relay restarts mid-transfer; after a reload the customer resumes it by request id', async ({
    page,
  }) => {
    const { wallet, relay } = await open(page);
    await page.getByTestId('deposit-amount').fill('1');
    await page.getByTestId('deposit-continue').click();
    await page.getByTestId('start-deposit').click();
    const card = page.getByTestId('transfer').first();
    await expect(card.locator('[data-testid=transfer-stage][data-stage=started]')).toBeVisible({ timeout: 30_000 });
    relay.lost = true; // the relay restarted: it no longer knows the job
    await page.reload();
    await page.getByTestId('connect').click();
    await page.getByTestId('wallet-option').filter({ hasText: 'MN Test Wallet' }).click();
    await expect(page.getByTestId('transfer').first()).toHaveAttribute('data-state', 'needs-resume', {
      timeout: 30_000,
    });
    relay.lost = false;
    await page.getByTestId('resume-transfer').click();
    await expect(page.getByTestId('transfer').first()).toHaveAttribute('data-state', 'succeeded', { timeout: 60_000 });
    expect(relay.submitted.map((s) => s.action)).toEqual(['bridge-deposit', 'bridge-resume']);
    expect(relay.submitted[1]!.body.payload).toMatchObject({ kind: 'deposit', requestId: REQUEST });
    expect(signatures(wallet)).toBe(2); // the start, then the resume's RelayAction
  });

  test('a partial withdrawal: ONE signature, then the change re-filed with a second (Q13 A)', async ({ page }) => {
    const coin = {
      nonce: '0e'.repeat(32),
      color: WSTKA,
      value: '1000000',
      mtIndex: '4779',
      commitment: 'c0'.repeat(32),
      origin: 'inbox',
      inInbox: true,
      inboxIndex: '0',
      spent: false,
    };
    const { wallet, relay } = await open(page, [coin]);
    await expect(page.getByTestId('withdraw-largest')).toContainText('1 wStkA');
    await page.getByTestId('withdraw-amount').fill('1.5');
    await page.getByTestId('withdraw-submit').click();
    await expect(page.getByTestId('withdraw-message')).toContainText('largest single payment is 1');
    expect(signatures(wallet)).toBe(0);
    await page.getByTestId('withdraw-amount').fill('0.6');
    await page.getByTestId('withdraw-submit').click();
    const card = page.locator('[data-testid=transfer][data-kind=withdraw]').first();
    await expect(card.getByTestId('transfer-change-secured')).toBeVisible({ timeout: 60_000 });
    expect(relay.submitted.map((s) => s.action)).toEqual(['bridge-withdraw', 'append-inbox']);
    expect(relay.submitted[0]!.body.payload).toMatchObject({
      amount: '600000',
      dest: wallet.address,
      coin: { mtIndex: '4779' },
    });
    expect(signatures(wallet)).toBe(2);
    await expect(card.getByTestId('transfer-outcome')).toContainText(`0.60 stkA sent to ${wallet.address} on Sepolia.`);
  });
});
