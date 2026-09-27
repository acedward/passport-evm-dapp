// Plan L-BRG testing, the LIVE part (Q8 caps): the bridge through the UI on Midnight stagenet and
// Sepolia, with an injected EIP-1193 wallet backed by the lane's throwaway test EOA (its key is read
// by this test process from a mode-600 file; the page only sees a provider) broadcasting through a
// public Sepolia RPC, and the relay (in Docker, configured for stagenet) paying DUST from the
// shared sponsor under the funding lock. Never in CI: test/stack/run-bridge-live.sh drives it.
//
// One phase per run (LIVE_PHASE), so each spend is its own step; the browser's local storage (it
// holds the account's encryption SECRET) is kept between phases in LIVE_STATE_FILE, mode 600,
// outside the repository and the evidence:
//
//   register        open an account (one signature)
//   deposit         LIVE_TOKEN + LIVE_AMOUNT: the two wallet sends, one signature, until it lands
//   withdraw        LIVE_TOKEN + LIVE_AMOUNT (+ LIVE_DEST): one signature (+ one for a change)
//   deposit-resume  a deposit whose relay is stopped right after the start (signal files), then
//                   restarted; the page is reloaded and the customer resumes it
//
// Evidence (public values only: addresses, hashes, amounts, timings) goes to LIVE_OUT_DIR.

import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import { Contract, JsonRpcProvider } from 'ethers';

import { installTestWallet, type TestWallet } from '../test-wallet.js';

const RELAY = process.env.LIVE_RELAY_URL ?? '';
const PHASE = process.env.LIVE_PHASE ?? '';
const STATE_FILE = process.env.LIVE_STATE_FILE ?? '';
const KEY_FILE = process.env.LIVE_EOA_KEY_FILE ?? '';
const RPC = process.env.LIVE_SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const INDEXER = process.env.LIVE_INDEXER_URL ?? 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
const OUT = process.env.LIVE_OUT_DIR ?? join(process.cwd(), 'test-results', 'live-bridge');
const SIGNALS = process.env.LIVE_SIGNAL_DIR ?? join(process.cwd(), 'test-results', 'live-bridge-signals');
const TOKEN = process.env.LIVE_TOKEN ?? 'stkA';
const AMOUNT = process.env.LIVE_AMOUNT ?? '1';
const VAULT_EVM = '0x648216975e722494bFF92E88FFc68C8F8d438FaA';

test.skip(
  !RELAY || !PHASE || !STATE_FILE || !KEY_FILE,
  'needs a stagenet relay and the live-run files (run-bridge-live.sh)',
);
test.use({ storageState: STATE_FILE && existsSync(STATE_FILE) ? STATE_FILE : undefined });
test.setTimeout(75 * 60_000);

const key = () => {
  const m = /^(0x[0-9a-fA-F]{64})\s*$/.exec(readFileSync(KEY_FILE, 'utf8'));
  if (!m) throw new Error('the test EOA key file does not hold a key');
  return m[1]!;
};
const signatures = (w: TestWallet) =>
  w.calls.filter((c) => c.method === 'eth_signTypedData_v4' || c.method === 'personal_sign').length;
const sends = (w: TestWallet) => w.calls.filter((c) => c.method === 'eth_sendTransaction').length;
const sepolia = () => new JsonRpcProvider(RPC, 11155111, { staticNetwork: true });
const erc20 = (token: string, p: JsonRpcProvider) =>
  new Contract(token, ['function balanceOf(address) view returns (uint256)'], p);

async function relayJson(path: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${RELAY}${path}`);
  return (await r.json()) as Record<string, unknown>;
}
const sponsorDust = async () =>
  String(((await relayJson('/health')).sponsor as { dustSpecks?: string } | undefined)?.dustSpecks ?? '');

/** The DUST fee a Midnight transaction paid (by hash), from the stagenet indexer. */
async function feeOf(hash: string): Promise<string | null> {
  try {
    const r = await fetch(INDEXER, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($h: HexEncoded!) { transactions(offset: { hash: $h }) { hash block { height } ... on RegularTransaction { fee } } }`,
        variables: { h: hash },
      }),
    });
    const t = ((await r.json()) as { data?: { transactions?: Array<{ fee?: string; block?: { height?: number } }> } })
      .data?.transactions?.[0];
    return t?.fee === undefined ? null : `${String(t.fee)} @${String(t.block?.height)}`;
  } catch {
    return null;
  }
}

async function evidence(name: string, body: Record<string, unknown>) {
  await mkdir(OUT, { recursive: true });
  await writeFile(
    join(OUT, `${name}.json`),
    `${JSON.stringify({ ...body, writtenUtc: new Date().toISOString() }, null, 2)}\n`,
  );
}

async function saveState(page: Page) {
  await page.context().storageState({ path: STATE_FILE });
  chmodSync(STATE_FILE, 0o600);
}

async function connect(page: Page, section: string) {
  await page.goto(`/#${section}`);
  await page.getByTestId('connect').click();
  await page.getByTestId('wallet-option').filter({ hasText: 'MN Test Wallet' }).click();
  await expect(page.getByTestId('wallet-connected')).toBeVisible();
}

async function start(page: Page): Promise<TestWallet> {
  await page.route('**/config.json', (r) => r.fulfill({ json: { network: 'stagenet', relayUrl: RELAY } }));
  return installTestWallet(page, { startChainId: '0xaa36a7', privateKey: key(), live: { rpcUrl: RPC } });
}

const bankKeys = (page: Page, suffix: string) =>
  page.evaluate((s) => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith('mn-bank/v1/') && k.includes(s)) out[k] = JSON.parse(localStorage.getItem(k)!).data;
    }
    return out;
  }, suffix);

async function accountOf(page: Page): Promise<string> {
  const accounts = await bankKeys(page, '/account');
  const a = Object.values(accounts)[0] as { address?: string } | undefined;
  if (!a?.address) throw new Error('no account in this browser: run the register phase first');
  return a.address;
}

/** Follow the newest transfer card until it ends; returns what the page recorded and saw. */
async function follow(page: Page, kind: 'deposit' | 'withdraw', t0: number, opts: { untilSecured?: boolean } = {}) {
  const card = page.locator(`[data-testid=transfer][data-kind=${kind}]`).first();
  await expect(card).toBeVisible({ timeout: 5 * 60_000 });
  const seen: Array<{ stage: string; atS: number }> = [];
  const deadline = Date.now() + 60 * 60_000;
  let state: string;
  for (;;) {
    state = (await card.getAttribute('data-state')) ?? '';
    for (const s of await card
      .locator('[data-testid=transfer-stage]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-stage')))) {
      if (s && !seen.some((x) => x.stage === s)) seen.push({ stage: s, atS: Math.round((Date.now() - t0) / 1000) });
    }
    const secured =
      !opts.untilSecured ||
      (await card.getByTestId('transfer-change-secured').count()) > 0 ||
      (await card.getByTestId('transfer-change').count()) === 0;
    if ((state === 'succeeded' && secured) || state === 'failed' || state === 'needs-resume') break;
    if (Date.now() > deadline) break;
    await page.waitForTimeout(5_000);
  }
  const id = await card.getAttribute('data-id');
  const records = await bankKeys(page, `/bridge/${id}`);
  const rec = Object.values(records)[0] as Record<string, unknown>;
  const outcome = (await card.getByTestId('transfer-outcome').allTextContents()).join(' ');
  return { state, seen, rec, outcome, card };
}

/** The public part of a transfer record, with each Midnight transaction's fee. */
async function publicTransfer(rec: Record<string, unknown>) {
  const stages = (rec.stages ?? []) as Array<{ stage: string; at: number; detail?: Record<string, string> }>;
  const scrub = (d?: Record<string, string>) => {
    if (!d) return d;
    const { changeNonce: _n, ...rest } = d; // a coin nonce is private (it links the coin's spend)
    return rest;
  };
  const fees: Record<string, string | null> = {};
  for (const s of stages)
    if (s.detail?.txHash && /^[0-9a-f]{64}$/.test(s.detail.txHash))
      fees[`${s.stage}:${s.detail.txHash}`] = await feeOf(s.detail.txHash);
  const result = rec.result as Record<string, unknown> | undefined;
  return {
    id: rec.id,
    kind: rec.kind,
    account: rec.account,
    token: rec.symbol,
    amount: rec.amount,
    depositAddress: rec.depositAddress,
    dest: rec.dest,
    state: rec.state,
    funding: rec.funding,
    jobIds: rec.jobIds,
    requestId: rec.requestId,
    startedAtMs: rec.startedAtMs,
    stages: stages.map((s) => ({ ...s, detail: scrub(s.detail) })),
    result: result
      ? {
          ...result,
          coin: result.coin
            ? { value: (result.coin as { value: string }).value, color: (result.coin as { color: string }).color }
            : null,
          change: result.change
            ? { value: (result.change as { value: string }).value, color: (result.change as { color: string }).color }
            : null,
        }
      : null,
    error: rec.error ?? null,
    change: rec.change
      ? {
          value: (rec.change as { coin: { value: string } }).coin.value,
          secured: (rec.change as { secured: boolean }).secured,
          secureTx: (rec.change as { secureTx?: string }).secureTx ?? null,
        }
      : null,
    midnightFeesSpecks: fees,
  };
}

async function tokenOf(page: Page, symbol: string): Promise<{ address: string; decimals: number }> {
  const opt = page.getByTestId('deposit-token').locator(`option[value="${symbol}"]`);
  await expect(opt).toHaveCount(1);
  const regs: Record<string, string> = {
    stkA: '0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52',
    USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  };
  return { address: regs[symbol]!, decimals: 6 };
}

async function signal(name: string) {
  await mkdir(SIGNALS, { recursive: true });
  await writeFile(join(SIGNALS, name), new Date().toISOString());
}
async function waitForSignal(name: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await readFile(join(SIGNALS, name), 'utf8');
    } catch {
      if (Date.now() > deadline) throw new Error(`no ${name} signal`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

test(`live bridge phase: ${PHASE || '(none)'}`, async ({ page }) => {
  const wallet = await start(page);
  const dustBefore = await sponsorDust();
  const t0 = Date.now();

  if (PHASE === 'register') {
    await connect(page, 'accounts');
    await expect(page.getByTestId('no-account')).toBeVisible();
    await page.getByTestId('open-account').click();
    await expect(page.getByTestId('account-address')).toBeVisible({ timeout: 15 * 60_000 });
    const account = (await page.getByTestId('account-address').textContent())!.trim();
    await saveState(page);
    const rec = Object.values(await bankKeys(page, '/account'))[0] as Record<string, unknown>;
    await evidence('01-register', {
      phase: PHASE,
      account,
      device: wallet.address,
      txs: rec.txs ?? null,
      signatures: signatures(wallet),
      clickToActivatedSeconds: (Date.now() - t0) / 1000,
      sponsorDustSpecks: { before: dustBefore, after: await sponsorDust() },
    });
    expect(signatures(wallet)).toBe(1);
    return;
  }

  await connect(page, 'transfers');
  const account = await accountOf(page);
  const p = sepolia();

  if (PHASE === 'deposit' || PHASE === 'deposit-resume') {
    const token = await tokenOf(page, TOKEN);
    const depositAddress = (await page.getByTestId('deposit-address').textContent())!.trim();
    const before = {
      eoaToken: String(await erc20(token.address, p).balanceOf!(wallet.address)),
      eoaEth: String(await p.getBalance(wallet.address)),
      depositToken: String(await erc20(token.address, p).balanceOf!(depositAddress)),
      depositEth: String(await p.getBalance(depositAddress)),
      vaultToken: String(await erc20(token.address, p).balanceOf!(VAULT_EVM)),
    };
    await page.getByTestId('deposit-token').selectOption(TOKEN);
    await page.getByTestId('deposit-amount').fill(AMOUNT);
    await page.getByTestId('deposit-continue').click();
    await expect(page.getByTestId('deposit-held')).not.toHaveText(/—$/, { timeout: 60_000 });
    if (await page.getByTestId('send-tokens').isEnabled()) {
      await page.getByTestId('send-tokens').click();
      await expect(page.getByTestId('tokens-ready')).toBeVisible({ timeout: 5 * 60_000 });
    }
    if (await page.getByTestId('send-gas').isEnabled()) {
      await page.getByTestId('send-gas').click();
      await expect(page.getByTestId('gas-ready')).toBeVisible({ timeout: 5 * 60_000 });
    }
    const funded = { atS: Math.round((Date.now() - t0) / 1000), sends: sends(wallet) };
    const tStart = Date.now();
    await page.getByTestId('start-deposit').click();
    await expect(page.getByTestId('deposit-message')).toContainText('Deposit started', { timeout: 10 * 60_000 });

    let resume: Record<string, unknown> | null = null;
    if (PHASE === 'deposit-resume') {
      const card = page.locator('[data-testid=transfer][data-kind=deposit]').first();
      await expect(card.locator('[data-testid=transfer-stage][data-stage=started]')).toBeVisible({
        timeout: 10 * 60_000,
      });
      const startedAtS = Math.round((Date.now() - tStart) / 1000);
      await signal('kill-relay');
      await waitForSignal('relay-restarted', 15 * 60_000);
      await page.reload();
      await page.getByTestId('connect').click();
      await page.getByTestId('wallet-option').filter({ hasText: 'MN Test Wallet' }).click();
      const again = page.locator('[data-testid=transfer][data-kind=deposit]').first();
      await expect(again).toHaveAttribute('data-state', 'needs-resume', { timeout: 5 * 60_000 });
      const needsResumeAtS = Math.round((Date.now() - tStart) / 1000);
      await page.getByTestId('resume-transfer').first().click();
      await expect(again).toHaveAttribute('data-state', 'running', { timeout: 5 * 60_000 });
      resume = {
        startedSeenAtS: startedAtS,
        relayRestartedSignal: await readFile(join(SIGNALS, 'relay-restarted'), 'utf8'),
        needsResumeAtS,
        resumedAtS: Math.round((Date.now() - tStart) / 1000),
      };
    }

    const f = await follow(page, 'deposit', tStart);
    await saveState(page);
    await page.goto('/#accounts');
    await page
      .getByTestId('refresh-balances')
      .click()
      .catch(() => undefined);
    await page.waitForTimeout(5_000);
    const after = {
      eoaToken: String(await erc20(token.address, p).balanceOf!(wallet.address)),
      eoaEth: String(await p.getBalance(wallet.address)),
      depositToken: String(await erc20(token.address, p).balanceOf!(depositAddress)),
      depositEth: String(await p.getBalance(depositAddress)),
      vaultToken: String(await erc20(token.address, p).balanceOf!(VAULT_EVM)),
    };
    const coins = Object.values(await bankKeys(page, '/coins'))[0] as Array<{
      color: string;
      value: string;
      spent: boolean;
      inInbox: boolean;
      mtIndex: string | null;
    }>;
    await evidence(PHASE === 'deposit' ? `02-deposit-${TOKEN}` : `04-deposit-resume-${TOKEN}`, {
      phase: PHASE,
      account,
      token: TOKEN,
      amount: AMOUNT,
      eoa: wallet.address,
      depositAddress,
      sepoliaBefore: before,
      sepoliaAfter: after,
      vaultTokenDelta: String(BigInt(after.vaultToken) - BigInt(before.vaultToken)),
      funded,
      signatures: signatures(wallet),
      walletSends: sends(wallet),
      startToEndSeconds: Math.round((Date.now() - tStart) / 1000),
      stagesSeenByThePage: f.seen,
      resume,
      transfer: await publicTransfer(f.rec),
      outcome: f.outcome,
      accountCoins: (coins ?? []).map((c) => ({
        color: c.color,
        value: c.value,
        spent: c.spent,
        inInbox: c.inInbox,
        positioned: c.mtIndex !== null,
      })),
      sponsorDustSpecks: { before: dustBefore, after: await sponsorDust() },
    });
    expect(f.state).toBe('succeeded');
    expect(signatures(wallet)).toBe(PHASE === 'deposit' ? 1 : 2); // the start (+ the resume)
    p.destroy();
    return;
  }

  if (PHASE === 'withdraw') {
    const regs: Record<string, string> = {
      wStkA: '0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52',
      wUSDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    };
    const name = TOKEN.startsWith('w')
      ? TOKEN
      : TOKEN === 'USDC'
        ? 'wUSDC'
        : `w${TOKEN[0]!.toUpperCase()}${TOKEN.slice(1)}`;
    const erc = regs[name]!;
    const dest = process.env.LIVE_DEST ?? wallet.address;
    const before = {
      destToken: String(await erc20(erc, p).balanceOf!(dest)),
      vaultToken: String(await erc20(erc, p).balanceOf!(VAULT_EVM)),
      vaultEth: String(await p.getBalance(VAULT_EVM)),
    };
    const option = page.getByTestId('withdraw-token').locator('option', { hasText: name });
    await expect(option).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('withdraw-token').selectOption((await option.getAttribute('value'))!);
    const largest = (await page.getByTestId('withdraw-largest').textContent()) ?? '';
    await page.getByTestId('withdraw-amount').fill(AMOUNT);
    if (process.env.LIVE_DEST) await page.getByTestId('withdraw-dest').fill(dest);
    const tStart = Date.now();
    await page.getByTestId('withdraw-submit').click();
    await expect(page.getByTestId('withdraw-message')).toContainText('Withdrawal started', { timeout: 10 * 60_000 });
    const f = await follow(page, 'withdraw', tStart, { untilSecured: true });
    await saveState(page);
    const after = {
      destToken: String(await erc20(erc, p).balanceOf!(dest)),
      vaultToken: String(await erc20(erc, p).balanceOf!(VAULT_EVM)),
      vaultEth: String(await p.getBalance(VAULT_EVM)),
    };
    const coins = Object.values(await bankKeys(page, '/coins'))[0] as Array<{
      color: string;
      value: string;
      spent: boolean;
      inInbox: boolean;
      mtIndex: string | null;
    }>;
    await evidence(`03-withdraw-${name}-${AMOUNT}`, {
      phase: PHASE,
      account,
      token: name,
      amount: AMOUNT,
      largestSinglePaymentShown: largest,
      dest,
      sepoliaBefore: before,
      sepoliaAfter: after,
      destTokenDelta: String(BigInt(after.destToken) - BigInt(before.destToken)),
      vaultTokenDelta: String(BigInt(after.vaultToken) - BigInt(before.vaultToken)),
      vaultGasSpentWei: String(BigInt(before.vaultEth) - BigInt(after.vaultEth)),
      signatures: signatures(wallet),
      startToEndSeconds: Math.round((Date.now() - tStart) / 1000),
      stagesSeenByThePage: f.seen,
      transfer: await publicTransfer(f.rec),
      outcome: f.outcome,
      accountCoins: (coins ?? []).map((c) => ({
        color: c.color,
        value: c.value,
        spent: c.spent,
        inInbox: c.inInbox,
        positioned: c.mtIndex !== null,
      })),
      sponsorDustSpecks: { before: dustBefore, after: await sponsorDust() },
    });
    expect(f.state).toBe('succeeded');
    p.destroy();
    return;
  }

  throw new Error(`unknown LIVE_PHASE ${PHASE}`);
});
