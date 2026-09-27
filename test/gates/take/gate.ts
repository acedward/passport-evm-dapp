/* eslint-disable @typescript-eslint/no-explicit-any -- the Passport client, the faucet module and the
   wallet SDK are loaded at run time inside the stack image; their surfaces are untyped here on
   purpose (this file never runs in CI). */
// G-TAKE — can a Passport account TAKE someone else's open offer? (plan 00039, P2, LOCAL stack)
//
// A maker posts an open offer to the local kernel (give a "stock", want "USDC"; the stack's two
// shielded test colours, mapped to those roles below). A Passport account then tries to take it,
// in this order (plan G-TAKE.1b), and every attempt records the transaction's structure — the
// segment of each party's legs, every per-segment imbalance — and the exact answer of the batcher
// and, if the batcher refuses, of the node:
//
//   (a) the account's complementary `open_swap_shielded_with_evm`, proven the DEFAULT way, merged
//       with a WALLET maker's offer;
//   (b) the same, with the account call's transcript partitioned GUARANTEED, so its legs are
//       proven into segment 0, where a wallet's offer sits (partition.ts);
//   (c) against an ACCOUNT maker: its offer proven the default way (c1), and proven guaranteed (c2);
//   (d) the relay-assisted take (Q15 option A, relay-take.ts): happy path and "offer gone" refund.
//
// Commands (run-gate.sh runs them in the stack image, on the stack's network):
//   preflight                 read-only: endpoints, node version, codec cross-check, steering check
//   setup                     mint the USDC colour, move stock to the maker and USDC to the competitor
//   register                  two accounts (taker T, maker M) with the relay's runtime, L-ACC's sequence
//   fund                      deposit_shielded: USDC coins into T, stock into M
//   offer <label> <wallet|account-default|account-guaranteed>   post a maker offer to the kernel
//   take <label> <offer> <default|guaranteed> [--replay]       an atomic take by T (variants a, b, c)
//   relay-take <label> <offer> [--race]                         variant d (with --race: the refund)
//   status                    read-only: balances, walks, offer statuses
//
// SECRETS. Stack wallet seeds come from the stack's wallets.json (dev seeds, still never printed).
// The accounts' device keys and encryption secrets are generated here and kept only in
// GATE_STATE_DIR/gate-take-state.json (mode 600). Evidence files carry public values only.

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { inspect } from 'node:util';

import { contractCoinCommitment, contractCoinNullifier } from '../../../packages/core/src/coins.js';
import { IndexerClient, ledgerEventDecoder, zswapActivityOf } from '../../../relay/src/chain/indexer.js';
import { createLogger } from '../../../relay/src/log.js';
import { MemoryPrivateStateProvider } from '../../../relay/src/passport/private-state.js';
import { PassportRuntime } from '../../../relay/src/passport/runtime.js';
import { syncedKeys, type SponsorWalletHandle } from '../../../relay/src/passport/wallet-provider.js';
import { openFacadeWallet, type OpenedWallet } from '../../../relay/src/sponsor/facade.js';
import { submitToBatcher, type BatcherResult } from './batcher-client.js';
import { complementOf, mergeTake, planTake, TakeMergeError } from './merge.js';
import { decodeOffer, encodeOffer, offerIdOf } from './offer-codec.js';
import { steeringParameters, withPartitionParameters } from './partition.js';
import { relayAssistedTake, type OfferStatus, type RelayTakeSteps, type TakeOfferRef } from './relay-take.js';
import { describeTx, imbalancesBySegment } from './tx-structure.js';

// ---- configuration (public values) ---------------------------------------------------------------

const REPO = path.resolve(import.meta.dirname, '../../..');
const env = (k: string, d: string) => process.env[k] || d;
const OUT = env('GATE_EVIDENCE_DIR', '/out');
const STATE_DIR = env('GATE_STATE_DIR', '/state');
const STATE_FILE = path.join(STATE_DIR, 'gate-take-state.json');
const RECEIPT = env('STACK_RECEIPT', '/aa/out/aa-contracts.json');
const WALLETS = env('STACK_WALLETS', '/run/secrets/wallets.json');
const MANAGED = env('MIDNIGHT_MANAGED_PATH', path.join(REPO, 'vendor/passport/contract/contracts/managed'));
const FAUCET_MANAGED = env('FAUCET_MANAGED', '/aa/gtf/managed');
const VENDOR = path.join(REPO, 'vendor/passport/contract/src/wallet');
const NETWORK_ID = 'undeployed';
const NODE_WS = env('MIDNIGHT_NODE_WS_URL', 'ws://node:9944');
const NODE_HTTP = env('MIDNIGHT_NODE_HTTP_URL', 'http://node:9944');
const INDEXER = env('MIDNIGHT_INDEXER_URL', 'http://indexer:8088/api/v4/graphql');
const INDEXER_WS = env('MIDNIGHT_INDEXER_WS_URL', 'ws://indexer:8088/api/v4/graphql/ws');
const PROOF = env('MIDNIGHT_PROOF_SERVER_URL', 'http://proof-server-rc6:6300');
const KERNEL = env('KERNEL_URL', 'http://kernel:9999');
const BATCHER = env('BATCHER_URL', 'http://batcher:3334');
/** `GATE_KERNEL=0`: the reduced stack (`--with aa` only) — no kernel, batcher or Celestia. Offers
 *  are not posted, every settlement goes straight to the node (the sponsor or the taking wallet pays
 *  the DUST), and the refund race's competitor must pay its own DUST, so it is the funder. */
const KERNEL_ON = env('GATE_KERNEL', '1') !== '0';
/** Q19's default. */
const FEE_MARGIN = Number(env('SPONSOR_FEE_BLOCKS_MARGIN', '20'));
/** The roles of the stack's shielded test colours (config, as the plan asks). */
const STOCK_LABEL = env('STOCK_COLOUR_LABEL', 'shielded-a');
const USDC_LABEL = env('USDC_COLOUR_LABEL', 'shielded-b');
/** Stack wallets and their roles. None is held open by a stack service while the gate runs
 *  (run-gate.sh stops aa-console, the only service that holds genesis-3). */
const ROLES = {
  sponsor: env('SPONSOR_WALLET', 'lace-test'), // the relay's sponsor, and its taker wallet in (d)
  funder: env('FUNDER_WALLET', 'genesis-3'), // holds the stock colour, mints USDC
  maker: env('MAKER_WALLET', 'demo-alice'), // the wallet maker
  competitor: env('COMPETITOR_WALLET', 'demo-bob'), // takes an offer first, for the refund path
} as const;
type Role = keyof typeof ROLES;
/** Who takes an offer first in the refund race (see KERNEL_ON). */
const competitorRole = (): Role => (KERNEL_ON ? 'competitor' : 'funder');

/** 6 decimals, as the canonical wStk and wUSDC. */
const UNIT = 1_000_000n;
const OFFER_GIVE = 2n * UNIT; // the maker gives 2 stock
const OFFER_WANT = 3n * UNIT; // and wants 3 USDC
const ACCOUNT_USDC_COIN = 10n * UNIT;
const ACCOUNT_USDC_COINS = 3;
const MAKER_ACCOUNT_STOCK = 10n * UNIT;

const log = createLogger({ level: 'info' }, { service: 'gate-take' });
const say = (msg: string, fields: Record<string, unknown> = {}) => log.info(msg, fields);

// ---- small helpers --------------------------------------------------------------------------------

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const norm = (h: string) => h.replace(/^0x/, '').toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const secondsSince = (t: number) => Math.round((Date.now() - t) / 100) / 10;

const errorChain = (e: unknown): string => {
  const parts: string[] = [];
  let cur: any = e;
  for (let i = 0; i < 8 && cur; i++) {
    parts.push(String(cur?.message ?? cur));
    cur = cur?.cause;
  }
  return parts.join(' <- ');
};

const jsonSafe = (v: unknown): unknown =>
  JSON.parse(
    JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString(10) : x instanceof Uint8Array ? hex(x) : x)),
  );

function writeEvidence(name: string, body: Record<string, unknown>): void {
  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.json`);
  writeFileSync(
    file,
    `${JSON.stringify(jsonSafe({ gate: 'G-TAKE', step: name, at: new Date().toISOString(), ...body }), null, 2)}\n`,
  );
  say('evidence written', { file: path.basename(file) });
}

// ---- persistent state (outside the repository, mode 600) -----------------------------------------

interface AccountRecord {
  address: string;
  deviceKeyHex: string;
  deviceAddress: string;
  encPublicKeyHex: string;
  encSecretKeyHex: string;
}
interface OfferRecord {
  offerId: string;
  blob: string;
  maker: 'wallet' | 'account';
  /** The stack wallet that made a wallet offer. */
  makerRole?: Role;
  partition?: 'default' | 'guaranteed';
  give: { colour: string; amount: string };
  want: { colour: string; amount: string };
}
interface GateState {
  accounts: Record<string, AccountRecord>;
  offers: Record<string, OfferRecord>;
}

function loadState(): GateState {
  if (!existsSync(STATE_FILE)) return { accounts: {}, offers: {} };
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as GateState;
}
function saveState(s: GateState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  chmodSync(STATE_FILE, 0o600);
}

// ---- the stack ----------------------------------------------------------------------------------

function receipt(): any {
  return JSON.parse(readFileSync(RECEIPT, 'utf8'));
}
function colours(): { stock: string; usdc: string; stockDomain: string; usdcDomain: string } {
  const c = receipt().testFaucet?.colours ?? {};
  const stock = c[STOCK_LABEL];
  const usdc = c[USDC_LABEL];
  if (!stock?.color || !usdc?.color) throw new Error('the deploy receipt lacks the test colours');
  return {
    stock: norm(stock.color),
    usdc: norm(usdc.color),
    stockDomain: norm(stock.domain),
    usdcDomain: norm(usdc.domain),
  };
}

function seedOf(role: Role): string {
  const w = (JSON.parse(readFileSync(WALLETS, 'utf8')).wallets as any[]).find((x) => x.name === ROLES[role]);
  const seed = String(w?.seed ?? '').replace(/^0x/, '');
  if (!/^[0-9a-f]{64}([0-9a-f]{64})?$/i.test(seed)) throw new Error(`no usable seed for the ${role} wallet`);
  return seed;
}

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
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
  getJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// ---- the runtime and the wallets -----------------------------------------------------------------

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
const ledgerLib = () => import('@midnightntwrk/ledger-v9') as Promise<any>;
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
async function dustOf(w: Wallet): Promise<bigint> {
  return (await walletState(w)).dust.balance(new Date()) as bigint;
}
async function waitBalance(
  w: Wallet,
  colour: string,
  ok: (v: bigint) => boolean,
  label: string,
  timeoutMs = 300_000,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
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
const unshieldedAddressOf = (w: Wallet): string => w.handle.unshieldedKeystore.getBech32Address().asString();

// ---- node-direct submission (the path tried when the batcher refuses) -----------------------------

async function submitDirect(
  w: Wallet,
  tx: any,
): Promise<{
  ok: boolean;
  stage: string;
  txId?: string;
  error?: string;
  nodeErrorCode?: string | null;
  detail?: string;
}> {
  let stage = 'balance-dust';
  try {
    const recipe = await w.handle.wallet.balanceFinalizedTransaction(tx, keysOf(w), {
      ttl: new Date(Date.now() + 60_000),
      tokenKindsToBalance: ['dust'],
    });
    stage = 'finalize';
    const fin = await w.handle.wallet.finalizeRecipe(recipe);
    stage = 'submit';
    const id = await w.handle.wallet.submitTransaction(fin);
    return { ok: true, stage: 'submitted', txId: String(id) };
  } catch (e) {
    // The node's own code (e.g. `1010: Invalid Transaction: Custom error: 138`) sits deep in the cause.
    const detail = inspect(e, { depth: 8, breakLength: Infinity });
    const code = /Custom error: (\d+)/.exec(detail)?.[1] ?? null;
    return { ok: false, stage, error: errorChain(e), nodeErrorCode: code, detail: detail.slice(0, 3000) };
  }
}

// ---- the accounts ---------------------------------------------------------------------------------

async function countingDevice(keyHex: string): Promise<{ device: any; signatures: () => number }> {
  const signer = await vendor('signer.ts');
  const base = signer.privateKeyBackend(unhex(keyHex));
  let n = 0;
  const backend = {
    ...base,
    async signTypedData(a: unknown) {
      n += 1;
      return base.signTypedData(a);
    },
  };
  return { device: signer.EvmDevice.fromBackend(backend), signatures: () => n };
}

interface WalkedCoin {
  nonce: string;
  color: string;
  value: bigint;
  inboxIndex: string;
  mtIndex: string | null;
  spent: boolean;
}

/** The account's coins exactly as the bank's browser rebuilds them: the inbox walk (decrypted with
 *  the account's secret), each coin's exact leaf position and spent flag from the ledger's events. */
async function walkAccount(a: AccountRecord): Promise<{ coins: WalkedCoin[]; inboxCount: string; authNonce: string }> {
  const rt = await runtime();
  const l: any = await rt.ledgerState(a.address);
  if (!l) throw new Error('no account at that address');
  const deposit = await vendor('deposit.ts');
  const entries = await deposit.inboxWalkPortable(l, unhex(a.encSecretKeyHex));
  const indexer = new IndexerClient({ indexerUrl: INDEXER });
  const txs = await indexer.accountTransactions(a.address);
  const activity = zswapActivityOf(a.address, txs?.txs ?? [], await ledgerEventDecoder(), txs?.tip ?? 0);
  const coins = entries.map((c: any) => {
    const info = { nonce: hex(c.nonce), color: hex(c.color), value: String(c.value) };
    const com = contractCoinCommitment(info, a.address);
    const nul = contractCoinNullifier(info, a.address);
    const out = activity.outputs.find((o) => o.commitment === com);
    return {
      nonce: info.nonce,
      color: info.color,
      value: BigInt(c.value),
      inboxIndex: String(c.inboxIndex),
      mtIndex: out ? out.mtIndex : null,
      spent: activity.inputs.some((i) => i.nullifier === nul),
    };
  });
  return { coins, inboxCount: String(l.inbox_count), authNonce: String(l.auth_nonce) };
}
const holdings = (coins: WalkedCoin[]) => {
  const out: Record<string, string> = {};
  for (const c of coins) if (!c.spent) out[c.color] = (BigInt(out[c.color] ?? '0') + c.value).toString(10);
  return out;
};
/** Wait until the ledger reports the account's coin spent (its nullifier in a zswapInput event). */
async function waitSpent(a: AccountRecord, nonce: string, timeoutMs = 180_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const w = await walkAccount(a);
    if (w.coins.find((c) => c.nonce === nonce)?.spent) return true;
    if (Date.now() > deadline) return false;
    await sleep(4000);
  }
}

/** The smallest unspent, positioned coin of a colour that covers `min` (the bank's chooseCoin). */
function chooseCoin(coins: WalkedCoin[], colour: string, min: bigint): WalkedCoin {
  const c = coins
    .filter((x) => !x.spent && x.mtIndex !== null && x.color === norm(colour) && x.value >= min)
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))[0];
  if (!c) throw new Error(`no unspent coin of ${colour.slice(0, 12)}… covering ${min}`);
  return c;
}

async function connectAccount(w: Wallet, address: string, coin?: WalkedCoin, providersOverride?: (p: any) => any) {
  const rt = await runtime();
  const base: any = await rt.providers(w.handle, new MemoryPrivateStateProvider());
  const providers = providersOverride ? providersOverride(base) : base;
  const { witnesses, account } = rt.client as any;
  const store = coin
    ? witnesses.withCoin(witnesses.emptyCoinStore(), {
        nonce: unhex(coin.nonce),
        color: unhex(coin.color),
        value: coin.value,
        mtIndex: BigInt(coin.mtIndex!),
      })
    : witnesses.emptyCoinStore();
  const custody = await account.CustodyAccount.connect(providers, rt.compiledAccount(), address, store);
  return { custody, providers };
}

/** `deposit_shielded` from a wallet into an account, the entry sealed to the account's key. */
async function depositInto(
  w: Wallet,
  address: string,
  colour: string,
  value: bigint,
): Promise<{ txId: string; coin: any; seconds: number }> {
  const rt = await runtime();
  const l: any = await rt.ledgerState(address);
  const deposit = await vendor('deposit.ts');
  const coin = { nonce: new Uint8Array(randomBytes(32)), color: unhex(colour), value };
  const entry = await deposit.sealEntryPortable(Uint8Array.from(l.enc_key), coin);
  const { custody } = await connectAccount(w, address);
  const t0 = Date.now();
  const r = await custody.depositShielded(coin, entry);
  return {
    txId: String(r.txId),
    coin: { nonce: hex(coin.nonce), color: norm(colour), value: value.toString() },
    seconds: secondsSince(t0),
  };
}

// ---- the account's complementary (or maker) offer -------------------------------------------------

interface BuiltOffer {
  tx: any;
  bytes: Uint8Array;
  blob: string;
  offerId: string;
  proveMs: number;
  partition: 'default' | 'guaranteed';
  steering?: { fromPs: string; toPs: string };
  structure: ReturnType<typeof describeTx>;
  signatures: number;
  wantNonce: string;
  coin: { nonce: string; mtIndex: string; value: string };
}

/**
 * `open_swap_shielded_with_evm` (the open shape) for one of our accounts: give `give` out of
 * `coin`, want `want`. One EIP-712 signature from the account's EVM device. Proven, then BOUND
 * (the kernel's wire form; midnight-2-offers `aa-offer.ts`), never balanced or submitted.
 */
async function buildAccountOffer(o: {
  w: Wallet;
  account: AccountRecord;
  coin: WalkedCoin;
  give: { colour: string; amount: bigint };
  want: { colour: string; amount: bigint };
  partition: 'default' | 'guaranteed';
}): Promise<BuiltOffer> {
  const ledger = await ledgerLib();
  let steering: BuiltOffer['steering'];
  const override =
    o.partition === 'guaranteed'
      ? (p: any) => ({
          ...p,
          publicDataProvider: withPartitionParameters(p.publicDataProvider, (params: any) => {
            const s = steeringParameters(params, (b) => ledger.LedgerParameters.deserialize(b));
            steering = { fromPs: s.fromPs.toString(), toPs: s.toPs.toString() };
            return s.params;
          }),
        })
      : undefined;
  const { custody, providers } = await connectAccount(o.w, o.account.address, o.coin, override);
  const offer = await vendor('offer.ts');
  const { device, signatures } = await countingDevice(o.account.deviceKeyHex);
  const ctx = await custody.callContext();
  const counter = await custody.resolveUseCounter(device);
  const l = await custody.ledgerState();
  const held = await custody.heldCoin(unhex(o.give.colour));
  const want = { nonce: offer.freshWantNonce(), color: unhex(o.want.colour), value: o.want.amount };
  const change = offer.predictChangeCoin(held, o.give.amount);
  const entries = offer.offerInboxEntries(Uint8Array.from(l.enc_key), want, change);
  const call = {
    giveColor: unhex(o.give.colour),
    giveAmount: o.give.amount,
    recipientKind: offer.RECIPIENT_OPEN,
    recipient: new Uint8Array(32),
    want,
    wantEntry: entries.wantEntry,
    changeEntry: entries.changeEntry,
    validUntil: 0n,
  };
  const auth = await offer.signOpenSwapOffer(device, ctx, call, held, counter);
  const rt = await runtime();
  const built = await offer.buildOpenSwapOffer({
    providers,
    compiledContract: rt.compiledAccount(),
    accountAddress: o.account.address,
    privateStateId: custody.privateStateId,
    circuitId: 'open_swap_shielded_with_evm',
    call,
    authArgs: offer.offerAuthArgs(auth),
  });
  const bound = typeof built.proven.bind === 'function' ? built.proven.bind() : built.proven;
  const before = JSON.stringify(imbalancesBySegment(built.proven));
  const after = JSON.stringify(imbalancesBySegment(bound));
  if (before !== after) throw new Error(`binding changed the offer's imbalances: ${before} -> ${after}`);
  const bytes: Uint8Array = bound.serialize();
  return {
    tx: bound,
    bytes,
    blob: encodeOffer(bytes),
    offerId: offerIdOf(bytes),
    proveMs: built.proveMs,
    partition: o.partition,
    ...(steering ? { steering } : {}),
    structure: describeTx(bound),
    signatures: signatures(),
    wantNonce: hex(want.nonce),
    coin: { nonce: o.coin.nonce, mtIndex: String(o.coin.mtIndex), value: o.coin.value.toString() },
  };
}

// ---- the kernel ---------------------------------------------------------------------------------

async function postOffer(blob: string): Promise<{ offerId: string; attempts: number; answer: unknown }> {
  for (let attempt = 1; attempt <= 12; attempt++) {
    const r = await postJson(`${KERNEL}/v1/offers`, { offer: blob });
    if (r.status >= 200 && r.status < 300)
      return { offerId: String(r.body?.offerId ?? ''), attempts: attempt, answer: r.body };
    const msg = JSON.stringify(r.body);
    if (msg.includes('ROOT_UNKNOWN') && attempt < 12) {
      await sleep(10_000);
      continue;
    }
    throw new Error(`the kernel refused the offer (${r.status}): ${msg.slice(0, 600)}`);
  }
  throw new Error('unreachable');
}
async function kernelStatus(blob: string): Promise<{ status: OfferStatus; answer: unknown }> {
  // The reduced stack has no kernel: an offer counts as live, and only the node decides.
  if (!KERNEL_ON) return { status: 'live', answer: 'no kernel in the reduced stack' };
  const r = await postJson(`${KERNEL}/v1/offers/status`, { offer: blob });
  const s = String(r.body?.status ?? 'unknown');
  const status = (['live', 'consumed', 'cancelled', 'expired'].includes(s) ? s : 'unknown') as OfferStatus;
  return { status, answer: r.body };
}
async function waitStatus(
  blob: string,
  want: OfferStatus[],
  timeoutMs = 180_000,
): Promise<{ status: OfferStatus; answer: unknown; seconds: number }> {
  const t0 = Date.now();
  for (;;) {
    const s = await kernelStatus(blob);
    if (want.includes(s.status) || Date.now() - t0 > timeoutMs) return { ...s, seconds: secondsSince(t0) };
    await sleep(4000);
  }
}

// ---- commands ------------------------------------------------------------------------------------

async function preflight(): Promise<void> {
  const rt = await runtime();
  const r = receipt();
  const c = colours();
  const version = await postJson(NODE_HTTP, { jsonrpc: '2.0', id: 1, method: 'system_version', params: [] });
  const skipped = { status: 0, body: 'not run: the reduced stack has no kernel or batcher' };
  const kernelHealth = KERNEL_ON ? await getJson(`${KERNEL}/v1/health`) : skipped;
  const kernelConfig = KERNEL_ON ? await getJson(`${KERNEL}/v1/midnight/config`) : skipped;
  const batcherHealth = KERNEL_ON ? await getJson(`${BATCHER}/health`) : skipped;
  // The codec against the kernel's own library (present in this image, not a repo dependency).
  let codec: Record<string, unknown>;
  try {
    // Typed `string` so the compiler does not resolve it: the package is not a repo dependency.
    const spec: string = '@effectstream/mip-zswap-offer/mip5';
    const mip: any = await import(spec);
    const sample = new Uint8Array(randomBytes(4096));
    const theirs = mip.OfferFiles.encode(sample);
    codec = {
      checked: true,
      sameEncoding: theirs === encodeOffer(sample),
      sameDecoding: hex(mip.OfferFiles.decode(theirs)) === hex(decodeOffer(theirs)),
      sameOfferId: mip.OfferFiles.offerId(sample) === offerIdOf(sample),
    };
  } catch (e) {
    codec = { checked: false, error: errorChain(e) };
  }
  // The partition steering against the CHAIN's parameters.
  const pdp: any = (rt as any).shared.publicDataProvider;
  const states = await pdp.queryZSwapAndContractState(r.vault.address);
  const ledger = await ledgerLib();
  const s = steeringParameters(states[2], (b) => ledger.LedgerParameters.deserialize(b));
  const text = String(s.params.toString());
  writeEvidence('00-preflight', {
    nodeVersion: version.body?.result,
    kernel: { health: kernelHealth.body, networkId: kernelConfig.body?.networkId },
    batcher: batcherHealth.body,
    receipt: { vault: r.vault.address, faucet: r.testFaucet.address, colours: c },
    roles: { stock: STOCK_LABEL, usdc: USDC_LABEL, wallets: ROLES },
    codecCrossCheck: codec,
    steering: {
      chainMinTimeToDismissPs: s.fromPs.toString(),
      steeredMinTimeToDismissPs: s.toPs.toString(),
      steeredText: /min_time_to_dismiss:[^,\n]*/.exec(text)?.[0] ?? null,
    },
    feeMargin: FEE_MARGIN,
    stack: KERNEL_ON ? 'full (--with aa --with offerfiles)' : 'reduced (--with aa): no kernel, batcher or Celestia',
  });
}

async function setup(): Promise<void> {
  const c = colours();
  const r = receipt();
  const funder = await wallet('funder');
  const maker = await wallet('maker');
  // In the reduced stack the funder itself is the refund race's competitor (it pays its own DUST).
  const competitor = competitorRole() === 'funder' ? null : await wallet(competitorRole());
  const before = {
    funder: await balances(funder),
    maker: await balances(maker),
    competitor: competitor ? await balances(competitor) : null,
  };

  // 1. mint the USDC colour to the funder with the stack's test faucet.
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
    contractAddress: r.testFaucet.address,
    compiledContract: compiled,
    privateStateId: `faucet-${Date.now().toString(36)}`,
    initialPrivateState: {},
  });
  const MINT = 200n * UNIT;
  const usdcBefore = before.funder[c.usdc] ?? 0n;
  const t0 = Date.now();
  const mint = await faucet.callTx.mint_shielded(unhex(c.usdcDomain), MINT, new Uint8Array(randomBytes(32)), {
    bytes: unhex(funder.coinPublicKey),
  });
  await waitBalance(funder, c.usdc, (v) => v >= usdcBefore + MINT, 'the minted USDC');
  const mintTx = String(mint?.public?.txId ?? '');
  say('minted USDC', { tx: mintTx, seconds: secondsSince(t0) });

  // 2. stock to the maker wallet, USDC to the competitor, in one transfer.
  const makerAddr = (await walletState(maker)).shielded.address;
  const STOCK_TO_MAKER = 20n * UNIT;
  const USDC_TO_COMPETITOR = competitor ? 10n * UNIT : 0n;
  const outputs = [{ type: c.stock, receiverAddress: makerAddr, amount: STOCK_TO_MAKER }];
  if (competitor) {
    outputs.push({
      type: c.usdc,
      receiverAddress: (await walletState(competitor)).shielded.address,
      amount: USDC_TO_COMPETITOR,
    });
  }
  const recipe = await funder.handle.wallet.transferTransaction([{ type: 'shielded', outputs }], keysOf(funder), {
    ttl: new Date(Date.now() + 60_000),
    payFees: true,
  });
  const transferTx = await funder.handle.wallet.finalizeRecipe(recipe);
  const transferId = String(await funder.handle.wallet.submitTransaction(transferTx));
  await waitBalance(maker, c.stock, (v) => v >= (before.maker[c.stock] ?? 0n) + STOCK_TO_MAKER, 'the maker stock');
  if (competitor) {
    await waitBalance(
      competitor,
      c.usdc,
      (v) => v >= (before.competitor![c.usdc] ?? 0n) + USDC_TO_COMPETITOR,
      'the competitor USDC',
    );
  }
  const after = {
    funder: await balances(funder),
    maker: await balances(maker),
    competitor: competitor ? await balances(competitor) : null,
  };
  writeEvidence('01-setup', {
    colours: c,
    mint: { tx: mintTx, amount: MINT, colour: c.usdc },
    transfer: { tx: transferId, stockToMaker: STOCK_TO_MAKER, usdcToCompetitor: USDC_TO_COMPETITOR },
    balances: { before, after },
  });
}

/** The funder sends stock to another stack wallet (a second maker needs its own coin: two offers
 *  from one coin cannot both settle). */
async function give(role: Role, amount: bigint): Promise<void> {
  const c = colours();
  const funder = await wallet('funder');
  const to = await wallet(role);
  const before = (await balances(to))[c.stock] ?? 0n;
  const recipe = await funder.handle.wallet.transferTransaction(
    [
      {
        type: 'shielded',
        outputs: [{ type: c.stock, receiverAddress: (await walletState(to)).shielded.address, amount }],
      },
    ],
    keysOf(funder),
    { ttl: new Date(Date.now() + 60_000), payFees: true },
  );
  const tx = await funder.handle.wallet.finalizeRecipe(recipe);
  const id = String(await funder.handle.wallet.submitTransaction(tx));
  const after = await waitBalance(to, c.stock, (v) => v >= before + amount, `the stock at ${role}`);
  writeEvidence(`05-give-${role}`, { to: ROLES[role], stock: amount, tx: id, before, after });
}

async function register(): Promise<void> {
  const state = loadState();
  const sponsor = await wallet('sponsor');
  const rt = await runtime();
  const vaultAddress = norm(receipt().vault.address);
  const signer = await vendor('signer.ts');
  const deposit = await vendor('deposit.ts');
  const results: Record<string, unknown> = {};
  for (const label of ['T', 'M']) {
    if (state.accounts[label]) {
      results[label] = { skipped: 'already registered', address: state.accounts[label]!.address };
      continue;
    }
    const key = signer.scalarToBytesBE(signer.randomSecp256k1Scalar());
    const enc = deposit.generateEncKeyPairPortable();
    const { device } = await countingDevice(hex(key));
    const dustBefore = await dustOf(sponsor);
    const providers: any = await rt.providers(sponsor.handle, new MemoryPrivateStateProvider());
    const shape = (rt.client as any).shape;
    const waves = shape.accountWaves();
    const t0 = Date.now();
    // L-ACC's registration sequence (relay/src/actions/account-actions.ts registerExecutor).
    const dormant = await (rt.client as any).account.CustodyAccount.deployDormant(
      providers,
      rt.compiledAccount(),
      device,
      { publicKey: enc.publicKey, secretKey: undefined },
      {
        vaultAddress,
        waveOneCircuits: waves.waveOne,
        waveTwoCircuits: waves.waveTwo,
        armsInWaveTwo: [],
        retireAuthority: true,
      },
    );
    const tDeployed = Date.now();
    const activation = await dormant.activate(device, dormant.salt);
    const address = norm(String(dormant.address));
    const l: any = await rt.ledgerState(address);
    const readBack =
      !!l &&
      l.booted === true &&
      l.device_count === 1n &&
      hex(l.enc_key) === hex(enc.publicKey) &&
      hex(l.vault_address.bytes) === vaultAddress;
    if (!readBack) throw new Error(`account ${label} does not read back as expected`);
    state.accounts[label] = {
      address,
      deviceKeyHex: hex(key),
      deviceAddress: hex(device.address),
      encPublicKeyHex: hex(enc.publicKey),
      encSecretKeyHex: hex(enc.secretKey),
    };
    saveState(state);
    results[label] = {
      address,
      device: `0x${hex(device.address)}`,
      submitted: providers.walletProvider.submitted,
      activationTx: String(activation?.public?.txId ?? ''),
      seconds: { deploy: Math.round((tDeployed - t0) / 100) / 10, total: secondsSince(t0) },
      readBack,
      dustSpentSpecks: (dustBefore - (await dustOf(sponsor))).toString(),
    };
  }
  writeEvidence('02-register', { sequence: 'relay registerExecutor (L-ACC), in-process', accounts: results });
}

async function fund(): Promise<void> {
  const state = loadState();
  const c = colours();
  const funder = await wallet('funder');
  const T = state.accounts.T!;
  const M = state.accounts.M!;
  const deposits: unknown[] = [];
  for (let i = 0; i < ACCOUNT_USDC_COINS; i++) {
    deposits.push({ account: 'T', ...(await depositInto(funder, T.address, c.usdc, ACCOUNT_USDC_COIN)) });
  }
  deposits.push({ account: 'M', ...(await depositInto(funder, M.address, c.stock, MAKER_ACCOUNT_STOCK)) });
  await sleep(6000);
  writeEvidence('03-fund', {
    deposits,
    walks: { T: jsonSafe(await walkAccount(T)), M: jsonSafe(await walkAccount(M)) },
  });
}

async function makeOffer(label: string, kind: string, makerRole: Role = 'maker'): Promise<void> {
  const state = loadState();
  const c = colours();
  if (state.offers[label]) throw new Error(`offer ${label} exists`);
  const t0 = Date.now();
  let bytes: Uint8Array;
  let extra: Record<string, unknown>;
  let maker: OfferRecord['maker'];
  let partition: OfferRecord['partition'];
  if (kind === 'wallet') {
    maker = 'wallet';
    const w = await wallet(makerRole);
    const addr = (await walletState(w)).shielded.address;
    const recipe = await w.handle.wallet.initSwap(
      { shielded: { [c.stock]: OFFER_GIVE } },
      [{ type: 'shielded', outputs: [{ type: c.usdc, amount: OFFER_WANT, receiverAddress: addr }] }],
      keysOf(w),
      { ttl: new Date(Date.now() + 60 * 60_000), payFees: false },
    );
    const tx = await w.handle.wallet.finalizeTransaction(recipe.transaction);
    bytes = tx.serialize();
    extra = {
      makerWallet: ROLES[makerRole],
      makerInputs: [...(tx.guaranteedOffer?.inputs ?? [])].map((i: any) => String(i.nullifier)),
      structure: describeTx(tx),
    };
  } else if (kind === 'account-default' || kind === 'account-guaranteed') {
    maker = 'account';
    partition = kind === 'account-default' ? 'default' : 'guaranteed';
    const sponsor = await wallet('sponsor');
    const M = state.accounts.M!;
    const walk = await walkAccount(M);
    const coin = chooseCoin(walk.coins, c.stock, OFFER_GIVE);
    const built = await buildAccountOffer({
      w: sponsor,
      account: M,
      coin,
      give: { colour: c.stock, amount: OFFER_GIVE },
      want: { colour: c.usdc, amount: OFFER_WANT },
      partition,
    });
    bytes = built.bytes;
    extra = {
      makerAccount: M.address,
      proveMs: built.proveMs,
      partition,
      steering: built.steering ?? null,
      signatures: built.signatures,
      coin: built.coin,
      structure: built.structure,
    };
  } else {
    throw new Error('offer kind is wallet | account-default | account-guaranteed');
  }
  const blob = encodeOffer(bytes);
  const posted = KERNEL_ON ? await postOffer(blob) : null;
  const live = KERNEL_ON ? await waitStatus(blob, ['live'], 120_000) : 'not posted: the reduced stack has no kernel';
  state.offers[label] = {
    offerId: posted?.offerId || offerIdOf(bytes),
    blob,
    maker,
    ...(maker === 'wallet' ? { makerRole } : {}),
    ...(partition ? { partition } : {}),
    give: { colour: c.stock, amount: OFFER_GIVE.toString() },
    want: { colour: c.usdc, amount: OFFER_WANT.toString() },
  };
  saveState(state);
  writeEvidence(`04-offer-${label}`, {
    label,
    kind,
    offerId: state.offers[label]!.offerId,
    bytes: bytes.length,
    kernel: { post: posted, status: live },
    ...extra,
    seconds: secondsSince(t0),
  });
}

function makerTxOf(o: OfferRecord, ledger: any): any {
  return ledger.Transaction.deserialize('signature', 'proof', 'binding', decodeOffer(o.blob));
}

async function take(
  label: string,
  offerLabel: string,
  partition: 'default' | 'guaranteed',
  replay: boolean,
): Promise<void> {
  const state = loadState();
  const o = state.offers[offerLabel];
  if (!o) throw new Error(`no offer ${offerLabel}`);
  const ledger = await ledgerLib();
  const sponsor = await wallet('sponsor');
  const T = state.accounts.T!;
  const makerTx = makerTxOf(o, ledger);
  const makerStructure = describeTx(makerTx);
  const comp = complementOf(makerStructure.imbalances);
  const walkBefore = await walkAccount(T);
  const coin = chooseCoin(walkBefore.coins, comp.give.colour, comp.give.amount);
  const statusBefore = await kernelStatus(o.blob);
  const makerW = o.maker === 'wallet' ? await wallet(o.makerRole ?? 'maker') : null;
  const makerBalanceBefore = makerW ? await balances(makerW) : null;
  const makerWalkBefore = o.maker === 'account' ? await walkAccount(state.accounts.M!) : null;

  const t0 = Date.now();
  const built = await buildAccountOffer({
    w: sponsor,
    account: T,
    coin,
    give: comp.give,
    want: comp.want,
    partition,
  });
  const plan = planTake(makerTx, built.tx);
  const record: Record<string, unknown> = {
    label,
    offer: { label: offerLabel, offerId: o.offerId, maker: o.maker, partition: o.partition ?? 'wallet', statusBefore },
    maker: { legSegment: plan.makerLegSegment, structure: makerStructure },
    taker: {
      account: T.address,
      partition,
      steering: built.steering ?? null,
      proveMs: built.proveMs,
      signatures: built.signatures,
      coin: built.coin,
      offerId: built.offerId,
      legSegment: plan.takerLegSegment,
      structure: built.structure,
    },
    plan,
  };

  let merged: any = null;
  try {
    const m = mergeTake(makerTx, built.tx, { requireBalanced: false });
    merged = m.merged;
    record.merged = { balanced: m.balanced, residualLegs: m.residualLegs, structure: m.structure };
  } catch (e) {
    record.merged = { error: errorChain(e), code: e instanceof TakeMergeError ? e.code : 'ledger' };
  }

  if (merged) {
    const txHex = hex(merged.serialize());
    const b: BatcherResult | null = KERNEL_ON
      ? await submitToBatcher({ batcherUrl: BATCHER, txHex, address: unshieldedAddressOf(sponsor) })
      : null;
    record.batcher = b ? { ...b, body: trimBody(b.body) } : { skipped: 'the reduced stack has no batcher' };
    if (b) say('batcher answered', { ok: b.ok, status: b.httpStatus, error: b.error });
    if (!b?.ok) {
      const direct = await submitDirect(sponsor, merged);
      record.node = direct;
      say('node answered', direct);
    }
    const settled = b?.ok === true || (record.node as any)?.ok === true;
    if (settled) {
      const statusAfter = KERNEL_ON ? await waitStatus(o.blob, ['consumed'], 180_000) : 'no kernel';
      await waitSpent(T, coin.nonce);
      const walkAfter = await walkAccount(T);
      const makerBalanceAfter = makerW
        ? await waitBalance(
            makerW,
            comp.give.colour,
            (v) => v >= (makerBalanceBefore![comp.give.colour] ?? 0n) + comp.give.amount,
            'the maker USDC',
            180_000,
          ).then(() => balances(makerW))
        : null;
      const makerWalkAfter = o.maker === 'account' ? await walkAccount(state.accounts.M!) : null;
      const newCoins = walkAfter.coins.filter((x) => !walkBefore.coins.some((y) => y.nonce === x.nonce));
      const spentNow = walkAfter.coins.find((x) => x.nonce === coin.nonce)?.spent ?? false;
      record.verification = {
        seconds: secondsSince(t0),
        kernelStatus: statusAfter,
        takerSpentCoin: { nonce: coin.nonce, spent: spentNow },
        takerNewCoins: jsonSafe(newCoins),
        takerHoldings: { before: holdings(walkBefore.coins), after: holdings(walkAfter.coins) },
        takerInbox: { before: walkBefore.inboxCount, after: walkAfter.inboxCount },
        takerAuthNonce: { before: walkBefore.authNonce, after: walkAfter.authNonce },
        maker:
          o.maker === 'wallet'
            ? {
                wallet: ROLES[o.makerRole ?? 'maker'],
                before: jsonSafe(makerBalanceBefore),
                after: jsonSafe(makerBalanceAfter),
              }
            : {
                account: state.accounts.M!.address,
                before: holdings(makerWalkBefore!.coins),
                after: holdings(makerWalkAfter!.coins),
              },
      };
      if (replay) {
        const again = KERNEL_ON
          ? await submitToBatcher({ batcherUrl: BATCHER, txHex, address: unshieldedAddressOf(sponsor) })
          : null;
        const againDirect = await submitDirect(sponsor, merged);
        record.replay = {
          batcher: again ? { ...again, body: trimBody(again.body) } : { skipped: 'the reduced stack has no batcher' },
          node: againDirect,
        };
        say('replay answered', { batcher: again?.ok ?? 'skipped', node: againDirect.ok });
      }
    } else {
      const statusAfter = await kernelStatus(o.blob);
      const walkAfter = await walkAccount(T);
      record.verification = {
        settled: false,
        kernelStatusAfter: statusAfter,
        takerCoinStillUnspent: !(walkAfter.coins.find((x) => x.nonce === coin.nonce)?.spent ?? false),
        takerAuthNonce: { before: walkBefore.authNonce, after: walkAfter.authNonce },
      };
    }
  }
  writeEvidence(label, record);
}

const trimBody = (b: unknown): unknown => {
  const s = JSON.stringify(b ?? null);
  return s.length > 4000 ? `${s.slice(0, 4000)}… (${s.length} chars)` : b;
};

async function relayTake(label: string, offerLabel: string, race: boolean): Promise<void> {
  const state = loadState();
  const o = state.offers[offerLabel];
  if (!o) throw new Error(`no offer ${offerLabel}`);
  const ledger = await ledgerLib();
  const sponsor = await wallet('sponsor');
  const competitor = race ? await wallet(competitorRole()) : null;
  const T = state.accounts.T!;
  const makerTx = makerTxOf(o, ledger);
  const comp = complementOf(imbalancesBySegment(makerTx));
  const walkBefore = await walkAccount(T);
  const coin = chooseCoin(walkBefore.coins, comp.give.colour, comp.give.amount);
  const offerRef: TakeOfferRef = {
    offerId: o.offerId,
    blob: o.blob,
    give: { colour: comp.want.colour, amount: comp.want.amount }, // the maker gives the stock
    want: { colour: comp.give.colour, amount: comp.give.amount }, // and wants the USDC
  };
  const events: Array<Record<string, unknown>> = [];
  let signatures = 0;
  let statusCalls = 0;
  let competitorTake: unknown = null;

  /** An ordinary wallet taker. With the kernel's batcher: value legs only, the batcher pays the
   *  DUST (the zswap SPA's sequence). In the reduced stack: the wallet balances everything, DUST
   *  included (a short TTL: the node's fee window), and submits to the node. Never throws. */
  const takeAsWallet = async (
    w: Wallet,
    blob: string,
  ): Promise<{
    r: { ok: boolean; transactionHash?: string; error?: string; httpStatus?: number; path: string };
    structure?: unknown;
  }> => {
    const route = KERNEL_ON ? 'batcher' : 'node';
    try {
      const mtx = ledger.Transaction.deserialize('signature', 'proof', 'binding', decodeOffer(blob));
      const recipe = await w.handle.wallet.balanceFinalizedTransaction(mtx, keysOf(w), {
        ttl: new Date(Date.now() + (KERNEL_ON ? 60 * 60_000 : 60_000)),
        tokenKindsToBalance: KERNEL_ON ? ['shielded', 'unshielded'] : 'all',
      });
      const settlement = await w.handle.wallet.finalizeRecipe(recipe);
      const structure = describeTx(settlement);
      if (!KERNEL_ON) {
        const id = String(await w.handle.wallet.submitTransaction(settlement));
        return { r: { ok: true, transactionHash: id, path: route }, structure };
      }
      const b = await submitToBatcher({
        batcherUrl: BATCHER,
        txHex: hex(settlement.serialize()),
        address: unshieldedAddressOf(w),
      });
      return {
        r: {
          ok: b.ok,
          httpStatus: b.httpStatus,
          path: route,
          ...(b.transactionHash ? { transactionHash: b.transactionHash } : {}),
          ...(b.error ? { error: b.error } : {}),
        },
        structure,
      };
    } catch (e) {
      return { r: { ok: false, error: errorChain(e), path: route } };
    }
  };

  const steps: RelayTakeSteps = {
    async offerStatus(_id) {
      statusCalls += 1;
      if (race && statusCalls === 2 && competitor) {
        // The race: another taker gets there first, while the account's coin is with the bank.
        const before = (await balances(competitor))[offerRef.give.colour] ?? 0n;
        const c = await takeAsWallet(competitor, o.blob);
        competitorTake = { ok: c.r.ok, path: c.r.path, transactionHash: c.r.transactionHash, error: c.r.error };
        events.push({
          event: 'competitor-take',
          role: competitor.role,
          ok: c.r.ok,
          path: c.r.path,
          tx: c.r.transactionHash,
        });
        if (c.r.ok)
          await waitBalance(
            competitor,
            offerRef.give.colour,
            (v) => v >= before + offerRef.give.amount,
            'the competitor stock',
          );
        if (KERNEL_ON) await waitStatus(o.blob, ['consumed'], 120_000);
      }
      const s = await kernelStatus(o.blob);
      events.push({ event: 'offer-status', status: s.status });
      return s.status;
    },
    async takerBalance(colour) {
      return (await balances(sponsor))[norm(colour)] ?? 0n;
    },
    async withdrawWholeCoin(c) {
      const before = (await balances(sponsor))[norm(c.colour)] ?? 0n;
      const counted = await countingDevice(T.deviceKeyHex);
      const { custody } = await connectAccount(sponsor, T.address, coin);
      const t0 = Date.now();
      const r = await custody.withdrawShielded(counted.device, unhex(sponsor.coinPublicKey), unhex(c.colour), c.value);
      signatures += counted.signatures();
      await waitBalance(sponsor, c.colour, (v) => v >= before + c.value, 'the withdrawn coin at the taker wallet');
      events.push({
        event: 'withdrawn',
        tx: String(r.txId),
        change: r.change ? jsonSafe(r.change) : null,
        seconds: secondsSince(t0),
      });
      return { txId: String(r.txId) };
    },
    async takeAsWallet(offer) {
      const t0 = Date.now();
      const before = (await balances(sponsor))[offer.give.colour] ?? 0n;
      const { r, structure } = await takeAsWallet(sponsor, offer.blob);
      events.push({
        event: 'wallet-take',
        ok: r.ok,
        path: r.path,
        httpStatus: r.httpStatus,
        error: r.error,
        tx: r.transactionHash,
        structure,
        seconds: secondsSince(t0),
      });
      if (r.ok)
        await waitBalance(
          sponsor,
          offer.give.colour,
          (v) => v >= before + offer.give.amount,
          'the stock at the taker wallet',
        );
      return {
        ok: r.ok,
        ...(r.transactionHash ? { txHash: r.transactionHash } : {}),
        ...(r.error ? { error: r.error } : {}),
      };
    },
    async depositToAccount(colour, value, purpose) {
      const d = await depositInto(sponsor, T.address, colour, value);
      events.push({ event: 'deposit', purpose, ...d });
      return { txId: d.txId };
    },
    log: (event, detail) => say(`relay-take: ${event}`, detail ?? {}),
  };

  const dustBefore = await dustOf(sponsor);
  const t0 = Date.now();
  const result = await relayAssistedTake({ colour: coin.color, value: coin.value }, offerRef, steps);
  await sleep(5000);
  const walkAfter = await walkAccount(T);
  const statusAfter = await kernelStatus(o.blob);
  writeEvidence(label, {
    label,
    offer: { label: offerLabel, offerId: o.offerId, maker: o.maker },
    race,
    coin: { nonce: coin.nonce, value: coin.value, mtIndex: coin.mtIndex },
    result: jsonSafe(result),
    events: jsonSafe(events),
    competitorTake,
    signatures,
    seconds: secondsSince(t0),
    sponsorDustSpentSpecks: (dustBefore - (await dustOf(sponsor))).toString(),
    kernelStatusAfter: statusAfter,
    taker: {
      holdings: { before: holdings(walkBefore.coins), after: holdings(walkAfter.coins) },
      inbox: { before: walkBefore.inboxCount, after: walkAfter.inboxCount },
      newCoins: jsonSafe(walkAfter.coins.filter((x) => !walkBefore.coins.some((y) => y.nonce === x.nonce))),
    },
  });
}

async function status(): Promise<void> {
  const state = loadState();
  const out: Record<string, unknown> = {};
  for (const [k, a] of Object.entries(state.accounts)) {
    const wlk = await walkAccount(a);
    out[`account-${k}`] = {
      address: a.address,
      holdings: holdings(wlk.coins),
      coins: jsonSafe(wlk.coins),
      inbox: wlk.inboxCount,
      authNonce: wlk.authNonce,
    };
  }
  for (const [k, o] of Object.entries(state.offers))
    out[`offer-${k}`] = { offerId: o.offerId, ...(await kernelStatus(o.blob)) };
  for (const role of Object.keys(ROLES) as Role[]) out[`wallet-${role}`] = jsonSafe(await balances(await wallet(role)));
  writeEvidence(`status-${Date.now()}`, out);
}

// ---- main ------------------------------------------------------------------------------------------

const [cmd, ...args] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'preflight':
      await preflight();
      break;
    case 'setup':
      await setup();
      break;
    case 'register':
      await register();
      break;
    case 'fund':
      await fund();
      break;
    case 'offer':
      await makeOffer(args[0]!, args[1]!, (args[2] as Role | undefined) ?? 'maker');
      break;
    case 'give':
      await give(args[0] as Role, BigInt(args[1]!) * UNIT);
      break;
    case 'take':
      await take(args[0]!, args[1]!, args[2] === 'guaranteed' ? 'guaranteed' : 'default', args.includes('--replay'));
      break;
    case 'relay-take':
      await relayTake(args[0]!, args[1]!, args.includes('--race'));
      break;
    case 'status':
      await status();
      break;
    default:
      throw new Error(`unknown command ${String(cmd)}`);
  }
  await closeWallets();
  process.exit(0);
} catch (e) {
  log.error('gate step failed', { cmd, error: errorChain(e) });
  await closeWallets().catch(() => {});
  process.exit(1);
}
