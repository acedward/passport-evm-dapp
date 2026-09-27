/* eslint-disable @typescript-eslint/no-explicit-any -- the wallet SDK, the stack's test faucet and the
   Passport client are loaded at run time inside the stack image; their surfaces are untyped here on
   purpose (this file never runs in CI's hosted jobs). */
// P4-C, the local end-to-end (plan 00039): the stack-side half that a browser cannot do. It runs in
// a Bun 1.3.11 container on the stack's network (test/stack/run-e2e.sh starts it), from the Docker
// check runner's source volume (its node_modules), with the account key cache mounted where the
// relay mounts it and the stack's test-faucet artefacts copied into the volume.
//
//   colours   the stack's two shielded test colours (from the deploy receipt) and a THIRD colour
//             the test faucet can mint, all recomputed offline with ledger-v9's rawTokenType and
//             checked against the receipt. Prints `COLOURS {json}` (public values).
//   seed      after the page registered accounts A and B (E2E_ACCOUNT_A, E2E_ACCOUNT_B):
//               1. the funder mints the USDC colour and the second stock's colour (test faucet);
//               2. the funder sends the bid maker (a stack wallet) USDC and stock, in one transfer;
//               3. deposit_shielded: 10 stock into A, 10 USDC into B (third-party deposits, each
//                  entry sealed to the account's enc_key);
//               4. the wallet maker posts two offers to the LOCAL kernel: a BID (give 1.9 USDC,
//                  want 2 stock: 0.95 USDC per stock) and a stock-to-stock offer (give 1 stock,
//                  want 1 of the second stock), which every USDC price must ignore.
//             Prints `SEEDED {json}` (public values: colours, transactions, offer ids, coins).
//
// SECRETS. The stack wallets' seeds come from the stack's own wallets.json (development seeds, still
// never printed). Nothing else is secret here: the accounts' secrets stay in the browser.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '../../relay/src/log.js';
import { MemoryPrivateStateProvider } from '../../relay/src/passport/private-state.js';
import { PassportRuntime } from '../../relay/src/passport/runtime.js';
import { syncedKeys, type SponsorWalletHandle } from '../../relay/src/passport/wallet-provider.js';
import { openFacadeWallet, type OpenedWallet } from '../../relay/src/sponsor/facade.js';
import { encodeOffer } from '../../packages/core/src/market/offer-file.js';

const REPO = path.resolve(import.meta.dirname, '../..');
const env = (k: string, d: string) => process.env[k] || d;
const RECEIPT = env('STACK_RECEIPT', '/aa/out/aa-contracts.json');
const WALLETS = env('STACK_WALLETS', '/run/secrets/wallets.json');
const MANAGED = env('MIDNIGHT_MANAGED_PATH', path.join(REPO, 'vendor/passport/contract/contracts/managed'));
const FAUCET_MANAGED = env('FAUCET_MANAGED', path.join(REPO, '.e2e-faucet/managed'));
const VENDOR = path.join(REPO, 'vendor/passport/contract/src/wallet');
const NETWORK_ID = 'undeployed';
const NODE_WS = env('MIDNIGHT_NODE_WS_URL', 'ws://node:9944');
const INDEXER = env('MIDNIGHT_INDEXER_URL', 'http://indexer:8088/api/v4/graphql');
const INDEXER_WS = env('MIDNIGHT_INDEXER_WS_URL', 'ws://indexer:8088/api/v4/graphql/ws');
const PROOF = env('MIDNIGHT_PROOF_SERVER_URL', 'http://proof-server-rc6:6300');
const KERNEL = env('KERNEL_URL', 'http://kernel:9999');
const FEE_MARGIN = Number(env('SPONSOR_FEE_BLOCKS_MARGIN', '20'));

const STOCK_LABEL = env('STOCK_COLOUR_LABEL', 'shielded-a');
const USDC_LABEL = env('USDC_COLOUR_LABEL', 'shielded-b');
/** The second stock's faucet domain: 32 bytes, ASCII, zero-padded (like the stack's own labels). */
const STOCK2_DOMAIN_TEXT = env('STOCK2_DOMAIN', 'mnbank-e2e:stock-2');

/** Stack wallets and their roles: none is held open by a stack service while this runs
 *  (run-e2e.sh stops aa-console, the one service that holds genesis-3). */
const ROLES = {
  funder: env('FUNDER_WALLET', 'genesis-3'), // holds the stock colour; mints the others
  maker: env('MAKER_WALLET', 'demo-alice'), // the wallet that posts the seeded bid
} as const;
type Role = keyof typeof ROLES;

/** 6 decimals, as the canonical wStk and wUSDC. */
const UNIT = 1_000_000n;
const units = (k: string, d: string) => BigInt(Math.round(Number(env(k, d)) * 1e6));
const FUND_STOCK_A = units('E2E_FUND_STOCK', '10'); // stock into account A (the maker)
const FUND_USDC_B = units('E2E_FUND_USDC', '10'); // USDC into account B (the taker)
const MINT_USDC = 200n * UNIT;
const MINT_STOCK2 = 100n * UNIT;
const MAKER_USDC = 20n * UNIT;
const MAKER_STOCK = 10n * UNIT;
const BID_GIVE_USDC = units('E2E_BID_GIVE_USDC', '1.9');
const BID_WANT_STOCK = units('E2E_BID_WANT_STOCK', '2');
const S2S_GIVE = 1n * UNIT;
const S2S_WANT = 1n * UNIT;
/** Wallet offers' TTL: long enough for a run and a re-run on the same stack. */
const OFFER_TTL_MS = Number(env('E2E_OFFER_TTL_MINUTES', '180')) * 60_000;

const log = createLogger({ level: 'info' }, { service: 'e2e-seed' });
const say = (msg: string, fields: Record<string, unknown> = {}) => log.info(msg, fields);

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const norm = (h: string) => h.replace(/^0x/, '').toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const secondsSince = (t: number) => Math.round((Date.now() - t) / 100) / 10;
const jsonSafe = (v: unknown): unknown =>
  JSON.parse(
    JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString(10) : x instanceof Uint8Array ? hex(x) : x)),
  );

// ---- the stack ------------------------------------------------------------------------------------

function receipt(): any {
  return JSON.parse(readFileSync(RECEIPT, 'utf8'));
}

function seedOf(role: Role): string {
  const w = (JSON.parse(readFileSync(WALLETS, 'utf8')).wallets as any[]).find((x) => x.name === ROLES[role]);
  const seed = String(w?.seed ?? '').replace(/^0x/, '');
  if (!/^[0-9a-f]{64}([0-9a-f]{64})?$/i.test(seed)) throw new Error(`no usable seed for the ${role} wallet`);
  return seed;
}

function domainBytes(text: string): Uint8Array {
  const b = new Uint8Array(32);
  const t = new TextEncoder().encode(text);
  if (t.length > 32) throw new Error('a faucet domain is at most 32 bytes');
  b.set(t);
  return b;
}

interface Colours {
  stock: string;
  usdc: string;
  stock2: string;
  stockDomain: string;
  usdcDomain: string;
  stock2Domain: string;
  faucet: string;
  vault: string;
}

/** The three colours, recomputed with ledger-v9 and checked against the receipt. */
async function colours(): Promise<Colours> {
  const r = receipt();
  const c = r.testFaucet?.colours ?? {};
  const faucet = norm(String(r.testFaucet?.address ?? ''));
  const stock = c[STOCK_LABEL];
  const usdc = c[USDC_LABEL];
  if (!faucet || !stock?.color || !usdc?.color) throw new Error('the deploy receipt lacks the test faucet colours');
  const ledger: any = await import('@midnightntwrk/ledger-v9');
  const colourOf = (domain: Uint8Array) => norm(String(ledger.rawTokenType(domain, faucet)));
  for (const [label, entry] of [
    [STOCK_LABEL, stock],
    [USDC_LABEL, usdc],
  ] as const) {
    const got = colourOf(unhex(entry.domain));
    if (got !== norm(entry.color)) {
      throw new Error(`rawTokenType does not reproduce the receipt's ${label} colour (${got} != ${norm(entry.color)})`);
    }
  }
  const d2 = domainBytes(STOCK2_DOMAIN_TEXT);
  return {
    stock: norm(stock.color),
    usdc: norm(usdc.color),
    stock2: colourOf(d2),
    stockDomain: norm(stock.domain),
    usdcDomain: norm(usdc.domain),
    stock2Domain: hex(d2),
    faucet,
    vault: norm(String(r.vault?.address ?? '')),
  };
}

// ---- the runtime and the wallets -------------------------------------------------------------------

let runtimePromise: Promise<PassportRuntime> | null = null;
const runtime = () =>
  (runtimePromise ??= PassportRuntime.load({
    managedPath: MANAGED,
    networkId: NETWORK_ID,
    indexerUrl: INDEXER,
    indexerWsUrl: INDEXER_WS,
    proofServerUrl: PROOF,
    txTtlMs: 60_000,
    log,
  }));
const vendor = (m: string): Promise<any> => import(path.join(VENDOR, m));

interface Wallet {
  role: Role;
  handle: SponsorWalletHandle & { wallet: any; unshieldedKeystore: any };
  opened: OpenedWallet;
  coinPublicKey: string;
  encryptionPublicKey: string;
}
const wallets = new Map<Role, Promise<Wallet>>();
function wallet(role: Role): Promise<Wallet> {
  let w = wallets.get(role);
  if (!w) {
    w = (async () => {
      const t0 = Date.now();
      const opened = await openFacadeWallet(
        seedOf(role),
        {
          networkId: NETWORK_ID,
          indexerUrl: INDEXER,
          indexerWsUrl: INDEXER_WS,
          nodeWsUrl: NODE_WS,
          proofServerUrl: PROOF,
        },
        { feeBlocksMargin: FEE_MARGIN },
      );
      const handle = opened.handle as Wallet['handle'];
      const keys = await syncedKeys(handle);
      say('wallet synced', { role, seconds: secondsSince(t0) });
      return { role, handle, opened, ...keys };
    })();
    wallets.set(role, w);
  }
  return w;
}
async function closeWallets(): Promise<void> {
  for (const w of wallets.values()) await (await w).opened.stop().catch(() => {});
  wallets.clear();
}
async function walletState(w: Wallet): Promise<any> {
  const Rx = await import('rxjs');
  return Rx.firstValueFrom(w.handle.wallet.state().pipe(Rx.filter((s: any) => s.isSynced === true)));
}
async function balances(w: Wallet): Promise<Record<string, bigint>> {
  const s = await walletState(w);
  const out: Record<string, bigint> = {};
  for (const [k, v] of Object.entries(s.shielded.balances as Record<string, bigint>)) out[norm(k)] = v;
  return out;
}
async function waitBalance(w: Wallet, colour: string, ok: (v: bigint) => boolean, label: string): Promise<bigint> {
  const deadline = Date.now() + 300_000;
  for (;;) {
    const v = (await balances(w))[norm(colour)] ?? 0n;
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} (${w.role} holds ${v})`);
    await sleep(3000);
  }
}
const keysOf = (w: Wallet) => ({
  shieldedSecretKeys: w.handle.shieldedSecretKeys,
  dustSecretKey: w.handle.dustSecretKey,
});

// ---- the kernel ------------------------------------------------------------------------------------

async function kernelJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, body };
}
const postJson = (url: string, body: unknown) =>
  kernelJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function postOffer(blob: string): Promise<{ offerId: string; attempts: number }> {
  for (let attempt = 1; attempt <= 12; attempt++) {
    const r = await postJson(`${KERNEL}/v1/offers`, { offer: blob });
    if (r.status >= 200 && r.status < 300) return { offerId: String(r.body?.offerId ?? ''), attempts: attempt };
    const msg = JSON.stringify(r.body);
    // The kernel may not have seen the Zswap root the offer's inputs prove against yet.
    if (msg.includes('ROOT_UNKNOWN') && attempt < 12) {
      await sleep(10_000);
      continue;
    }
    throw new Error(`the kernel refused the offer (${r.status}): ${msg.slice(0, 600)}`);
  }
  throw new Error('unreachable');
}
async function waitLive(offerId: string, timeoutMs = 180_000): Promise<{ status: string; seconds: number }> {
  const t0 = Date.now();
  for (;;) {
    const r = await kernelJson(`${KERNEL}/v1/offers/${offerId}/status`);
    const status = String(r.body?.status ?? 'unknown');
    if (status === 'live' || Date.now() - t0 > timeoutMs) return { status, seconds: secondsSince(t0) };
    await sleep(3000);
  }
}

// ---- steps ------------------------------------------------------------------------------------------

/** The funder mints `amount` of the faucet colour with `domain` to itself. */
async function mint(funder: Wallet, domain: string, colour: string, amount: bigint): Promise<string> {
  const rt = await runtime();
  const { NodeZkConfigProvider, nodeZkConfigRegistry } =
    (await import('@midnight-ntwrk/midnight-js-node-zk-config-provider')) as any;
  const { httpClientProofProvider } = (await import('@midnight-ntwrk/midnight-js-http-client-proof-provider')) as any;
  const { CompiledContract } = (await import('@midnight-ntwrk/compact-js')) as any;
  const { findDeployedContract } = (await import('@midnight-ntwrk/midnight-js-contracts')) as any;
  const FaucetModule: any = await import(path.join(FAUCET_MANAGED, 'faucet/contract/index.js'));
  const base: any = await rt.providers(funder.handle, new MemoryPrivateStateProvider());
  const providers = {
    ...base,
    zkConfigProvider: new NodeZkConfigProvider(path.join(FAUCET_MANAGED, 'faucet')),
    proofProvider: httpClientProofProvider(PROOF, await nodeZkConfigRegistry(FAUCET_MANAGED), { timeout: 900_000 }),
  };
  const compiled = CompiledContract.make('faucet', FaucetModule.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(path.join(FAUCET_MANAGED, 'faucet')),
  );
  const faucet = await findDeployedContract(providers, {
    contractAddress: receipt().testFaucet.address,
    compiledContract: compiled,
    privateStateId: `faucet-${Date.now().toString(36)}`,
    initialPrivateState: {},
  });
  const before = (await balances(funder))[colour] ?? 0n;
  const t0 = Date.now();
  const r = await faucet.callTx.mint_shielded(unhex(domain), amount, new Uint8Array(randomBytes(32)), {
    bytes: unhex(funder.coinPublicKey),
  });
  await waitBalance(funder, colour, (v) => v >= before + amount, `the minted ${colour.slice(0, 8)}…`);
  const tx = String(r?.public?.txId ?? '');
  say('minted', { colour, tx, seconds: secondsSince(t0) });
  return tx;
}

/** `deposit_shielded` from the funder into an account, the entry sealed to the account's key. */
async function depositInto(funder: Wallet, account: string, colour: string, value: bigint) {
  const rt = await runtime();
  const l: any = await rt.ledgerState(account);
  if (!l?.booted) throw new Error(`account ${account} is not active`);
  const deposit = await vendor('deposit.ts');
  const coin = { nonce: new Uint8Array(randomBytes(32)), color: unhex(colour), value };
  const entry = await deposit.sealEntryPortable(Uint8Array.from(l.enc_key), coin);
  const providers: any = await rt.providers(funder.handle, new MemoryPrivateStateProvider());
  const { account: accountLib, witnesses } = rt.client as any;
  const custody = await accountLib.CustodyAccount.connect(
    providers,
    rt.compiledAccount(),
    account,
    witnesses.emptyCoinStore(),
  );
  const t0 = Date.now();
  const r = await custody.depositShielded(coin, entry);
  return {
    account,
    txId: String(r.txId),
    coin: { nonce: hex(coin.nonce), color: colour, value: value.toString() },
    seconds: secondsSince(t0),
  };
}

/** A wallet maker's open offer (no DUST: `payFees: false`), posted to the kernel. */
async function walletOffer(maker: Wallet, label: string, give: [string, bigint], want: [string, bigint]) {
  const addr = (await walletState(maker)).shielded.address;
  const t0 = Date.now();
  const recipe = await maker.handle.wallet.initSwap(
    { shielded: { [give[0]]: give[1] } },
    [{ type: 'shielded', outputs: [{ type: want[0], amount: want[1], receiverAddress: addr }] }],
    keysOf(maker),
    { ttl: new Date(Date.now() + OFFER_TTL_MS), payFees: false },
  );
  const tx = await maker.handle.wallet.finalizeTransaction(recipe.transaction);
  const blob = encodeOffer(tx.serialize());
  const posted = await postOffer(blob);
  const live = await waitLive(posted.offerId);
  if (live.status !== 'live') throw new Error(`the ${label} offer is ${live.status}, not live`);
  say('offer live', { label, offerId: posted.offerId, seconds: secondsSince(t0) });
  return {
    label,
    maker: ROLES[maker.role],
    offerId: posted.offerId,
    give: { colour: give[0], amount: give[1].toString() },
    want: { colour: want[0], amount: want[1].toString() },
    postAttempts: posted.attempts,
    liveAfterSeconds: live.seconds,
    seconds: secondsSince(t0),
  };
}

async function seed(): Promise<void> {
  const t0 = Date.now();
  const A = norm(env('E2E_ACCOUNT_A', ''));
  const B = norm(env('E2E_ACCOUNT_B', ''));
  if (!/^[0-9a-f]{64}$/.test(A) || !/^[0-9a-f]{64}$/.test(B)) throw new Error('E2E_ACCOUNT_A/B must be accounts');
  const c = await colours();
  const funder = await wallet('funder');
  const maker = await wallet('maker');
  const timings: Record<string, number> = {};

  // 1. the USDC colour and the second stock's colour, minted to the funder.
  let t = Date.now();
  const mintUsdc = await mint(funder, c.usdcDomain, c.usdc, MINT_USDC);
  const mintStock2 = await mint(funder, c.stock2Domain, c.stock2, MINT_STOCK2);
  timings.mintSeconds = secondsSince(t);

  // 2. the bid maker's coins, in one transfer (the funder pays the fee).
  t = Date.now();
  const makerBefore = await balances(maker);
  const makerAddr = (await walletState(maker)).shielded.address;
  const recipe = await funder.handle.wallet.transferTransaction(
    [
      {
        type: 'shielded',
        outputs: [
          { type: c.usdc, receiverAddress: makerAddr, amount: MAKER_USDC },
          { type: c.stock, receiverAddress: makerAddr, amount: MAKER_STOCK },
        ],
      },
    ],
    keysOf(funder),
    { ttl: new Date(Date.now() + 60_000), payFees: true },
  );
  const transferTx = await funder.handle.wallet.finalizeRecipe(recipe);
  const transferId = String(await funder.handle.wallet.submitTransaction(transferTx));
  await waitBalance(maker, c.usdc, (v) => v >= (makerBefore[c.usdc] ?? 0n) + MAKER_USDC, 'the maker USDC');
  await waitBalance(maker, c.stock, (v) => v >= (makerBefore[c.stock] ?? 0n) + MAKER_STOCK, 'the maker stock');
  timings.makerTransferSeconds = secondsSince(t);

  // 3. third-party deposits into the two accounts (one at a time: one funder wallet).
  t = Date.now();
  const depositA = await depositInto(funder, A, c.stock, FUND_STOCK_A);
  const depositB = await depositInto(funder, B, c.usdc, FUND_USDC_B);
  timings.depositsSeconds = secondsSince(t);

  // 4. the wallet maker's offers on the LOCAL kernel.
  t = Date.now();
  const bid = await walletOffer(maker, 'bid', [c.usdc, BID_GIVE_USDC], [c.stock, BID_WANT_STOCK]);
  const stockToStock = await walletOffer(maker, 'stock-to-stock', [c.stock, S2S_GIVE], [c.stock2, S2S_WANT]);
  timings.offersSeconds = secondsSince(t);
  timings.totalSeconds = secondsSince(t0);

  const out = {
    colours: c,
    mints: { usdc: { tx: mintUsdc, amount: MINT_USDC }, stock2: { tx: mintStock2, amount: MINT_STOCK2 } },
    makerTransfer: { tx: transferId, usdc: MAKER_USDC, stock: MAKER_STOCK, maker: ROLES.maker },
    deposits: { A: depositA, B: depositB },
    offers: { bid, stockToStock },
    timings,
  };
  console.log(`SEEDED ${JSON.stringify(jsonSafe(out))}`);
}

const [cmd] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'colours':
      console.log(`COLOURS ${JSON.stringify(await colours())}`);
      break;
    case 'seed':
      await seed();
      break;
    default:
      throw new Error('usage: e2e-seed.ts colours | seed');
  }
} finally {
  await closeWallets();
}
process.exit(0);
