/* eslint-disable @typescript-eslint/no-explicit-any -- the Passport client and the wallet SDK are
   loaded at run time; their surfaces are untyped here on purpose (this file never runs in CI). */
// L-TRD.0 — the take path, LIVE on the staging exchange (plan 00039, L-TRD.0; Q20).
//
// G-TAKE proved at the ledger (a reduced local stack) that an account takes an offer in ONE
// transaction when every account offer is proven with a fully guaranteed transcript. What it could
// not run is the exchange: the kernel accepting such an offer and marking it consumed, and the
// batcher's `midnight-balancer` paying the DUST for the merged take. This driver runs exactly that,
// on stagenet, THROUGH THE RELAY'S OWN CODE (the register executor, the `passport-call` authoriser,
// and the `open-swap` / `take` executors, called in-process), with the browser's half (the typed
// data a wallet signs) built by the same shared module the page uses:
//
//   preflight   read-only: node version, the exchange and batcher health, the chain's LIVE ledger
//               parameters (min_time_to_dismiss) and the partition steering against them
//   window      one live window under the shared funding lock (run-live.sh holds it):
//                 A      the G-BRIDGE test account (reused: a second registration would cost about
//                        60 DUST more than the Q8 cap allows), funded with ONE 2-wUSDC coin by
//                        deposit_shielded from the sponsor
//                 (b)    A takes the best wStkA/wUSDC ask of the staging book (a wallet maker's
//                        ladder offer, legs in segment 0) through the take executor: the maker check,
//                        the guaranteed proof, the merge, cost(params, true) and the batcher; then
//                        the kernel's status transition and A's inbox walk
//                 B      a new account, registered by the relay's register executor (one RelayAction
//                        signature) and funded with one 1-wUSDC coin, for (c2)
//               each step is skipped when the state file says it is done (re-runnable)
//   c2          A offers 10 wStkA at 0.02 (the open-swap executor), B takes it (the take executor)
//   verify      read-only: kernel status, both accounts' inbox walks, the settling transaction
//   replay      re-submits the settled take to the batcher: it must be refused
//
// SECRETS. The sponsor's mnemonic file is mounted read-only and read in this process only. B's
// device key is generated here and written to TRD_STATE_DIR/l-trd-B.key (mode 600, exclusive
// create) BEFORE it is used; A's is the G-BRIDGE gate's `gate-bridge-device.key`, read in place.
// Encryption secrets stay in the state files (mode 600). Evidence carries public values only.

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { Wallet } from 'ethers';

import {
  buildRelayActionMessage,
  contractCoinCommitment,
  contractCoinNullifier,
  fundWithOneCoin,
  orderLegs,
  parsePrice,
  relayActionTypedData,
  STAGENET,
  stagenetRegistry,
  takeLegs,
  type OpenSwapPayload,
  type StoredCoin,
  type TakePayload,
} from '@mnbank/core';
import {
  evmDeviceEntry,
  findEvmUseCounter,
  inboxWalkPortable,
  offerInboxEntriesPortable,
  openSwapGatedCall,
  predictChangeCoin,
} from '@mnbank/core/passport';

import { registerExecutor } from '../../../relay/src/actions/account-actions.js';
import { AppendEntitlements, entitlementKey } from '../../../relay/src/actions/entitlements.js';
import { passportCallAuthoriser } from '../../../relay/src/auth/passport-call.js';
import { DigestReplayGuard } from '../../../relay/src/auth/verifiers.js';
import { IndexerClient, ledgerEventDecoder, zswapActivityOf } from '../../../relay/src/chain/indexer.js';
import { parseSponsorSeed } from '../../../relay/src/config.js';
import { createLogger } from '../../../relay/src/log.js';
import { PassportRuntime } from '../../../relay/src/passport/runtime.js';
import { FacadeSponsorSession, openFacadeWallet } from '../../../relay/src/sponsor/facade.js';
import type { JobContext } from '../../../relay/src/queue/jobs.js';
import { submitToBatcher } from '../../../relay/src/trade/batcher-client.js';
import { openSwapExecutor, takeExecutor, type TradeDeps } from '../../../relay/src/trade/executors.js';
import { proveGuaranteedOffer, type ProvenAccountOffer } from '../../../relay/src/trade/account-offer.js';
import { mergeForSettlement, readCost } from '../../../relay/src/trade/settle.js';
import { steeringParameters } from '../../../relay/src/trade/partition.js';
import { describeTx } from '../../../relay/src/trade/tx-structure.js';

// ---- configuration (public values) ----------------------------------------------------------------

const env = (k: string, d: string) => process.env[k] || d;
const STATE_DIR = env('TRD_STATE_DIR', '/state');
const STATE_FILE = path.join(STATE_DIR, 'l-trd-state.json');
const B_KEY_FILE = path.join(STATE_DIR, 'l-trd-B.key');
const A_KEY_FILE = path.join(STATE_DIR, 'gate-bridge-device.key');
const A_STATE_FILE = path.join(STATE_DIR, 'gate-bridge-state.json');
const EVIDENCE = env('TRD_EVIDENCE_DIR', '/evidence');
const WALLET_FILE = env('STAGENET_WALLET_FILE', '/secrets/stagenet');
const MANAGED = env('MIDNIGHT_MANAGED_PATH', '/app/vendor/passport/contract/contracts/managed');
const PROOF = env('MIDNIGHT_PROOF_SERVER_URL', 'http://127.0.0.1:6300');
const NET = STAGENET;
const EXPECTED_NODE = env('EXPECTED_NODE_VERSION', '2.0.0-d9729c13');
const FEE_MARGIN = Number(env('SPONSOR_FEE_BLOCKS_MARGIN', '20'));
/** Q8: at most 100 DUST out of the sponsor per run; stop before a step would cross 90. */
const DUST_CAP_SPECKS = 100n * 10n ** 15n;
const DUST_STOP_SPECKS = 90n * 10n ** 15n;
const REGISTRATION_ESTIMATE_SPECKS = 62n * 10n ** 15n;

const registry = stagenetRegistry();
const STOCK = registry.byColour('5eb2a3cebb2ebe7ba910c78f62c9e28e0d74acbd00c810730def3578860e6a02')!;
const USDC = registry.usdc();
const UNIT = 1_000_000n;
/** (b): A takes the best ladder ask (100 wStkA for about 1.04 wUSDC) from one 2-wUSDC coin. */
const FUND_A_USDC = 2n * UNIT;
/** (c2): B is funded with one 1-wUSDC coin to take A's own offer. */
const FUND_B_USDC = 1n * UNIT;
/** (c2): A sells 10 of the wStkA it bought at 0.02 (above the ladder, so no stranger takes it
 *  first): it wants 0.20 wUSDC. Quote prices here are cents (the owner: wUSDC is the quote). */
const C2_QTY = 10n * UNIT;
const C2_PRICE = '0.02';

const log = createLogger({ level: 'info' }, { service: 'l-trd0' });
const say = (msg: string, fields: Record<string, unknown> = {}) => log.info(msg, fields);

// ---- helpers ------------------------------------------------------------------------------------

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const norm = (h: string) => h.replace(/^0x/, '').toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const secondsSince = (t: number) => Math.round((Date.now() - t) / 100) / 10;
const dust = (specks: bigint) => (Number(specks) / 1e15).toFixed(6);

const errorChain = (e: unknown): string => {
  const parts: string[] = [];
  let cur: any = e;
  for (let i = 0; i < 8 && cur; i++) {
    parts.push(`${cur?.code ? `[${String(cur.code)}] ` : ''}${String(cur?.message ?? cur)}`);
    cur = cur?.cause;
  }
  return parts.join(' <- ');
};

const jsonSafe = (v: unknown): unknown =>
  JSON.parse(
    JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString(10) : x instanceof Uint8Array ? hex(x) : x)),
  );

/** Merge `body` into evidence/<name>.json (public values only). */
function evidence(name: string, body: Record<string, unknown>): void {
  mkdirSync(EVIDENCE, { recursive: true });
  const file = path.join(EVIDENCE, `${name}.json`);
  const existing = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  writeFileSync(
    file,
    `${JSON.stringify(jsonSafe({ lane: 'L-TRD.0', step: name, ...existing, ...body, writtenUtc: new Date().toISOString() }), null, 2)}\n`,
  );
  say('evidence written', { file: path.basename(file) });
}

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, body };
}

// ---- state (mode 600, outside the repository) ---------------------------------------------------

interface AccountRef {
  address: string;
  /** Where its device key and encryption secret live (never copied). */
  source: 'gate-bridge' | 'l-trd';
  encSecretHex?: string;
  encPublicHex?: string;
  device: string;
}
interface TakeState {
  offerId: string;
  by: 'A' | 'B';
  result?: unknown;
  error?: string;
  mergedHex?: string;
  at: string;
}
interface TrdState {
  accounts: Partial<Record<'A' | 'B', AccountRef>>;
  funded: Partial<Record<'A' | 'B', { txId: string; colour: string; value: string; nonce: string }>>;
  /** (c2): A's own offer. */
  offer?: { offerId: string; payload: OpenSwapPayload; result: unknown; madeAt: string };
  /** `ladder`: (b), A takes the best wallet-maker ask; `c2`: B takes A's offer. */
  takes: Partial<Record<'ladder' | 'c2', TakeState>>;
  dust: Array<{ step: string; beforeSpecks: string; afterSpecks: string }>;
  /** The sponsor's unshielded address (public): the batcher submitter of the take. */
  submitter?: string;
}
function loadState(): TrdState {
  if (!existsSync(STATE_FILE)) return { accounts: {}, funded: {}, takes: {}, dust: [] };
  const s = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as TrdState;
  s.takes ??= {};
  return s;
}
function saveState(s: TrdState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  chmodSync(STATE_FILE, 0o600);
}
function readKey(file: string): string {
  const k = readFileSync(file, 'utf8').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`no device key in ${path.basename(file)}`);
  return k;
}
/** The encryption secret of an account (A's from the G-BRIDGE state file, read in place). */
function encSecretOf(a: AccountRef): Uint8Array {
  if (a.source === 'gate-bridge') {
    const g = JSON.parse(readFileSync(A_STATE_FILE, 'utf8'));
    return unhex(String(g.account.encSecretHex));
  }
  return unhex(a.encSecretHex!);
}
function deviceOf(label: 'A' | 'B'): Wallet {
  return new Wallet(readKey(label === 'A' ? A_KEY_FILE : B_KEY_FILE));
}

// ---- the runtime, the sponsor, the walk ------------------------------------------------------------

let rtPromise: Promise<PassportRuntime> | null = null;
const runtime = () =>
  (rtPromise ??= PassportRuntime.load({
    managedPath: MANAGED,
    networkId: NET.midnightNetworkId,
    indexerUrl: NET.midnight.indexerUrl,
    indexerWsUrl: NET.midnight.indexerWsUrl,
    proofServerUrl: PROOF,
    txTtlMs: 60_000,
    log,
  }));

let sponsorSession: FacadeSponsorSession | null = null;
async function sponsor(): Promise<FacadeSponsorSession> {
  if (sponsorSession) return sponsorSession;
  const seedHex = parseSponsorSeed(readFileSync(WALLET_FILE, 'utf8'));
  const s = new FacadeSponsorSession(
    {
      seedHex,
      endpoints: {
        networkId: NET.midnightNetworkId,
        indexerUrl: NET.midnight.indexerUrl,
        indexerWsUrl: NET.midnight.indexerWsUrl,
        nodeWsUrl: NET.midnight.nodeWsUrl,
        proofServerUrl: PROOF,
      },
      feeBlocksMargin: FEE_MARGIN,
      // run-live.sh holds the shared funding lock for the whole window.
      fundingLockFile: null,
      purpose: 'aa-00039 L-TRD.0',
    },
    openFacadeWallet,
    log.child({ component: 'sponsor' }),
  );
  const t0 = Date.now();
  await s.start();
  for (;;) {
    if (s.status().synced) break;
    if (s.status().state === 'error') throw new Error(`the sponsor wallet failed: ${s.status().error ?? ''}`);
    if (Date.now() - t0 > 15 * 60_000) throw new Error('the sponsor wallet did not sync within 15 minutes');
    await sleep(3000);
  }
  say('sponsor synced', { seconds: secondsSince(t0) });
  sponsorSession = s;
  return s;
}
async function stopSponsor(): Promise<void> {
  const s = sponsorSession as FacadeSponsorSession | null;
  await s?.stop().catch(() => {});
}
const sponsorDust = async () => (await sponsor()).status().dustSpecks ?? 0n;

/** The sponsor's shielded balances, per colour. */
async function sponsorBalances(): Promise<Record<string, bigint>> {
  const Rx = await import('rxjs');
  return (await sponsor()).withWallet(async (w: any) => {
    const st: any = await Rx.firstValueFrom(w.wallet.state().pipe(Rx.filter((s: any) => s.isSynced === true)));
    const out: Record<string, bigint> = {};
    for (const [k, v] of Object.entries(st.shielded.balances as Record<string, bigint>)) out[norm(k)] = v;
    return out;
  });
}

interface Walked {
  coins: StoredCoin[];
  inboxCount: string;
  authNonce: string;
}
/** The account's coins exactly as the bank's browser rebuilds them. */
async function walk(a: AccountRef): Promise<Walked> {
  const rt = await runtime();
  const l: any = await rt.ledgerState(a.address);
  if (!l) throw new Error('no account at that address');
  const entries = await inboxWalkPortable(l, encSecretOf(a));
  const indexer = new IndexerClient({ indexerUrl: NET.midnight.indexerUrl });
  const txs = await indexer.accountTransactions(a.address);
  const activity = zswapActivityOf(a.address, txs?.txs ?? [], await ledgerEventDecoder(), txs?.tip ?? 0);
  const coins: StoredCoin[] = entries.map((c: any) => {
    const info = { nonce: hex(c.nonce), color: hex(c.color), value: String(c.value) };
    const commitment = contractCoinCommitment(info, a.address);
    const nullifier = contractCoinNullifier(info, a.address);
    const out = activity.outputs.find((o) => o.commitment === commitment);
    const spentBy = activity.inputs.find((i) => i.nullifier === nullifier);
    return {
      ...info,
      mtIndex: out ? String(out.mtIndex) : null,
      commitment,
      origin: 'inbox' as const,
      inInbox: true,
      inboxIndex: String(c.inboxIndex),
      ...(out ? { createdTx: out.txHash } : {}),
      spent: !!spentBy,
      ...(spentBy ? { spentTx: spentBy.txHash } : {}),
    };
  });
  return { coins, inboxCount: String(l.inbox_count), authNonce: String(l.auth_nonce) };
}
const holdings = (coins: StoredCoin[]) => {
  const out: Record<string, string> = {};
  for (const c of coins) if (!c.spent) out[c.color] = (BigInt(out[c.color] ?? '0') + BigInt(c.value)).toString(10);
  return out;
};
async function waitWalk(a: AccountRef, ok: (w: Walked) => boolean, label: string, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const w = await walk(a);
    if (ok(w)) return w;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(5000);
  }
}

/** A job context for calling a relay executor in-process: stages go to the log and the evidence. */
function jobContext(name: string, stages: Array<Record<string, unknown>>): JobContext {
  return {
    requestId: randomBytes(16).toString('hex'),
    log: log.child({ job: name }),
    stage(stage: string, detail?: Record<string, string>) {
      stages.push({ stage, at: new Date().toISOString(), ...(detail ?? {}) });
      say(`${name}: ${stage}`, detail ?? {});
    },
    prove: <T>(fn: () => Promise<T>) => fn(),
  };
}

// ---- preflight (read-only) -----------------------------------------------------------------------

async function preflight(): Promise<void> {
  const version = await getJson(NET.midnight.nodeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_version', params: [] }),
  });
  const nodeVersion = String(version.body?.result ?? '');
  const kernelHealth = await getJson(`${NET.zswap.kernelUrl}/v1/health`);
  const kernelConfig = await getJson(`${NET.zswap.kernelUrl}/v1/midnight/config`);
  const batcherHealth = await getJson(`${NET.zswap.batcherUrl}/health`);
  const book = await getJson(`${NET.zswap.kernelUrl}/v1/offers?limit=20`);
  const rt = await runtime();
  const pdp: any = (rt as any).shared.publicDataProvider;
  const states = await pdp.queryZSwapAndContractState(NET.bridge.vaultAddress);
  const ledger: any = await import('@midnightntwrk/ledger-v9');
  const params = states[2];
  const s = steeringParameters(params, (b: Uint8Array) => ledger.LedgerParameters.deserialize(b));
  const text = String(params.toString());
  evidence('00-preflight', {
    nodeVersion,
    nodeVersionAsPinned: nodeVersion === EXPECTED_NODE,
    kernel: { health: kernelHealth.body, networkId: kernelConfig.body?.networkId, indexer: kernelConfig.body?.indexer },
    batcher: { status: batcherHealth.status, body: batcherHealth.body },
    book: { status: book.status, offers: Array.isArray(book.body?.offers) ? book.body.offers.length : null },
    liveParameters: {
      minTimeToDismissPs: s.fromPs.toString(),
      steeredMinTimeToDismissPs: s.toPs.toString(),
      text: text.length > 3000 ? `${text.slice(0, 3000)}…` : text,
    },
    tokens: { stock: STOCK.midnightColour, usdc: USDC.midnightColour },
    feeMargin: FEE_MARGIN,
  });
  if (nodeVersion !== EXPECTED_NODE) throw new Error(`stagenet runs ${nodeVersion}, not ${EXPECTED_NODE}: stop`);
}

// ---- the live window ------------------------------------------------------------------------------

async function recordDust(state: TrdState, step: string, before: bigint): Promise<void> {
  // The facade's view lags by a sync cycle; give it one.
  await sleep(8000);
  const after = await sponsorDust();
  state.dust.push({ step, beforeSpecks: before.toString(), afterSpecks: after.toString() });
  saveState(state);
  const spent = state.dust.reduce((t, d) => t + (BigInt(d.beforeSpecks) - BigInt(d.afterSpecks)), 0n);
  say('dust', { step, spent: dust(before - after), total: dust(spent) });
  if (spent > DUST_CAP_SPECKS) throw new Error(`the run spent ${dust(spent)} DUST, over the cap: stop`);
}
const dustSpent = (state: TrdState) =>
  state.dust.reduce((t, d) => t + (BigInt(d.beforeSpecks) - BigInt(d.afterSpecks)), 0n);

async function ensureAccounts(state: TrdState, which: 'A' | 'B'): Promise<void> {
  const rt = await runtime();
  if (which === 'A' && !state.accounts.A) {
    const g = JSON.parse(readFileSync(A_STATE_FILE, 'utf8'));
    const address = norm(String(g.account.address));
    const l: any = await rt.ledgerState(address);
    if (!l?.booted) throw new Error('the G-BRIDGE account is not active');
    const device = deviceOf('A').address.toLowerCase();
    state.accounts.A = { address, source: 'gate-bridge', device };
    saveState(state);
    evidence('01-accounts', {
      A: {
        address,
        device,
        reused:
          'the G-BRIDGE gate account (same MN Bank shape, same vault); a second registration would cost ~60 DUST over the Q8 cap',
        authNonce: String(l.auth_nonce),
        inboxCount: String(l.inbox_count),
      },
    });
  }
  if (which === 'B' && !state.accounts.B?.address) {
    if (dustSpent(state) + REGISTRATION_ESTIMATE_SPECKS > DUST_STOP_SPECKS)
      throw new Error('no DUST budget left to register B');
    // The device key is written BEFORE it is used (exclusive create, mode 600).
    if (!existsSync(B_KEY_FILE)) {
      const w = Wallet.createRandom();
      writeFileSync(B_KEY_FILE, `${w.privateKey}\n`, { mode: 0o600, flag: 'wx' });
      chmodSync(B_KEY_FILE, 0o600);
    }
    const device = deviceOf('B');
    const { generateEncKeyPairPortable } = await import('@mnbank/core/passport');
    // Keep the secret before anything leaves the process (the browser's order, L-ACC.1); a retry
    // after a failed registration reuses the pending key pair.
    const kp = state.accounts.B?.encSecretHex
      ? { secretKey: unhex(state.accounts.B.encSecretHex), publicKey: unhex(state.accounts.B.encPublicHex!) }
      : generateEncKeyPairPortable();
    const pending: AccountRef = {
      address: '',
      source: 'l-trd',
      encSecretHex: hex(kp.secretKey),
      encPublicHex: hex(kp.publicKey),
      device: device.address.toLowerCase(),
    };
    state.accounts.B = pending;
    saveState(state);
    const payload = { encPublicKey: pending.encPublicHex! };
    const message = buildRelayActionMessage({
      action: 'register',
      network: NET.name,
      owner: device.address,
      payload,
      nonce: `0x${randomBytes(32).toString('hex')}`,
      expiry: Math.floor(Date.now() / 1000) + 300,
    });
    const td = relayActionTypedData(message, NET.evm.chainId);
    const { EIP712Domain: _d, ...types } = td.types as unknown as Record<string, Array<{ name: string; type: string }>>;
    const signature = await device.signTypedData(td.domain, types, td.message);
    const s = await sponsor();
    const before = await sponsorDust();
    const stages: Array<Record<string, unknown>> = [];
    const t0 = Date.now();
    const exec = registerExecutor({
      runtime: () => rt,
      sponsor: s,
      vaultAddress: NET.bridge.vaultAddress,
      network: NET.name,
      chainId: NET.evm.chainId,
      replay: new DigestReplayGuard(3600),
      // Registration issues no append entitlement (security review F-B3); the executor needs the store.
      entitlements: new AppendEntitlements({
        key: entitlementKey(null),
        network: NET.name,
        ttlSeconds: 3600,
        maxPerAccountPerDay: 1,
      }),
      log,
    });
    const result: any = await exec(
      { ...payload, auth: { message, signature }, signer: device.address.toLowerCase() },
      jobContext('register', stages),
    );
    state.accounts.B = { ...pending, address: String(result.account) };
    saveState(state);
    await recordDust(state, 'register-B', before);
    evidence('01-accounts', {
      B: {
        address: result.account,
        device: result.device,
        txs: result.txs,
        seconds: result.seconds,
        clickToActivatedSeconds: secondsSince(t0),
        signatures: 1,
        stages,
        dustSpent: dust(before - BigInt(state.dust.at(-1)!.afterSpecks)),
      },
    });
  }
}

async function fundOne(state: TrdState, label: 'A' | 'B', colour: string, value: bigint): Promise<void> {
  if (state.funded[label]) return;
  const a = state.accounts[label]!;
  const rt = await runtime();
  const s = await sponsor();
  const balances = await sponsorBalances();
  if ((balances[colour] ?? 0n) < value) {
    throw new Error(`the sponsor holds ${balances[colour] ?? 0n} of ${colour.slice(0, 12)}…, needs ${value}`);
  }
  const l: any = await rt.ledgerState(a.address);
  const { sealEntryPortable } = await import('@mnbank/core/passport');
  const coin = { nonce: new Uint8Array(randomBytes(32)), color: unhex(colour), value };
  const entry = await sealEntryPortable(Uint8Array.from(l.enc_key), coin);
  const before = await sponsorDust();
  const t0 = Date.now();
  const r: any = await s.withWallet(async (w: any) => {
    const providers = await rt.providers(w);
    const custody = await (rt.client as any).account.CustodyAccount.connect(providers, rt.compiledAccount(), a.address);
    return custody.depositShielded(coin, entry);
  });
  state.funded[label] = { txId: String(r.txId), colour, value: value.toString(), nonce: hex(coin.nonce) };
  saveState(state);
  await recordDust(state, `fund-${label}`, before);
  const w = await waitWalk(
    a,
    (x) => x.coins.some((c) => c.nonce === hex(coin.nonce) && c.mtIndex !== null),
    `the deposit into ${label}`,
  );
  evidence('02-fund', {
    [label]: {
      account: a.address,
      txId: String(r.txId),
      colour,
      value: value.toString(),
      seconds: secondsSince(t0),
      coin: w.coins.find((c) => c.nonce === hex(coin.nonce)),
      holdings: holdings(w.coins),
      sponsorBalanceBefore: (balances[colour] ?? 0n).toString(),
    },
  });
}

/** The browser's half of a trade call: the payload and ONE signature, built as the page builds it. */
async function signedTrade(
  label: 'A' | 'B',
  give: { colour: string; amount: bigint },
  want: { colour: string; amount: bigint },
): Promise<{ payload: OpenSwapPayload; passportAuth: Record<string, string>; coin: StoredCoin }> {
  const a = loadState().accounts[label]!;
  const rt = await runtime();
  const w = await walk(a);
  const token = registry.byColour(give.colour)!;
  const funded = fundWithOneCoin(w.coins, give, token);
  if (!funded.ok) throw new Error(`${label} cannot fund the trade: ${funded.reason}`);
  const coin = funded.coin;
  const l: any = await rt.ledgerState(a.address);
  const device = deviceOf(label);
  const devices = [...l.devices].map((d: Uint8Array) => hex(d));
  const counter = findEvmUseCounter(devices, a.address, device.address, BigInt(l.device_epoch));
  if (counter === null) throw new Error(`${label}'s device is not live on the account`);
  const wantCoin = { nonce: new Uint8Array(randomBytes(32)), color: unhex(want.colour), value: want.amount };
  const change = predictChangeCoin(
    { nonce: unhex(coin.nonce), color: unhex(coin.color), value: BigInt(coin.value), mt_index: BigInt(coin.mtIndex) },
    give.amount,
  );
  const entries = await offerInboxEntriesPortable(Uint8Array.from(l.enc_key), wantCoin, change);
  const payload: OpenSwapPayload = {
    giveColor: norm(give.colour),
    giveAmount: give.amount.toString(),
    wantColor: norm(want.colour),
    wantAmount: want.amount.toString(),
    wantNonce: hex(wantCoin.nonce),
    wantEntry: hex(entries.wantEntry),
    changeEntry: hex(entries.changeEntry),
    validUntil: '0',
    coin: { nonce: coin.nonce, color: coin.color, value: coin.value, mtIndex: coin.mtIndex },
    authNonce: String(l.auth_nonce),
  };
  const call = openSwapGatedCall(
    { account: a.address, authNonce: BigInt(l.auth_nonce), evmDomainSalt: hex(l.evm_domain_salt) },
    device.address,
    payload,
  );
  const td = call.typedData as any;
  const { EIP712Domain: _d, ...types } = td.types;
  const signature = await device.signTypedData(td.domain, types, td.message);
  // The device entry the call consumes must be live (the relay checks the same).
  if (!devices.includes(evmDeviceEntry(a.address, device.address, BigInt(l.device_epoch), counter)))
    throw new Error('the use counter is not live');
  return {
    payload,
    passportAuth: { owner: device.address.toLowerCase(), signature, useCounter: counter.toString(10) },
    coin,
  };
}

/** Run a trade action exactly as the relay's route would: authorise, then execute. */
async function runTrade(
  action: 'open-swap' | 'take',
  label: 'A' | 'B',
  payload: Record<string, unknown>,
  passportAuth: Record<string, string>,
  deps: TradeDeps,
  stages: Array<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const rt = await runtime();
  const account = loadState().accounts[label]!.address;
  const authorise = passportCallAuthoriser(() => rt, deps.replay);
  const outcome = await authorise({ action } as never, { account, payload, passportAuth } as never);
  if (!outcome.ok) throw new Error(`the relay refused the ${action} authorisation: ${JSON.stringify(outcome)}`);
  const exec = action === 'open-swap' ? openSwapExecutor(deps) : takeExecutor(deps);
  return exec({ ...payload, passportAuth, account, signer: outcome.signer }, jobContext(action, stages));
}

async function tradeDeps(captured: { offers: ProvenAccountOffer[] }): Promise<TradeDeps> {
  const rt = await runtime();
  return {
    runtime: () => rt,
    sponsor: await sponsor(),
    kernelUrl: NET.zswap.kernelUrl,
    batcherUrl: NET.zswap.batcherUrl,
    batcherTarget: NET.zswap.batcherTarget,
    replay: new DigestReplayGuard(3600),
    log,
    // Capture what the executor proves, for the evidence (the proof itself is untouched).
    prove: async (o) => {
      const p = await proveGuaranteedOffer(o);
      captured.offers.push(p);
      return p;
    },
  };
}

async function makeOffer(state: TrdState): Promise<void> {
  if (state.offer) return;
  const legs = orderLegs('sell', STOCK, USDC, C2_QTY, parsePrice(C2_PRICE, USDC));
  const { payload, passportAuth, coin } = await signedTrade('A', legs.give, legs.want);
  const captured = { offers: [] as ProvenAccountOffer[] };
  const deps = await tradeDeps(captured);
  const stages: Array<Record<string, unknown>> = [];
  const before = await sponsorDust();
  const t0 = Date.now();
  let result: Record<string, unknown>;
  try {
    result = await runTrade('open-swap', 'A', payload as never, passportAuth, deps, stages);
  } catch (e) {
    const p = captured.offers[0];
    evidence('05-c2-offer', {
      refused: errorChain(e),
      stages,
      proven: p ? { offerId: p.offerId, bytes: p.bytes.length, structure: p.structure, steering: p.steering } : null,
    });
    throw e;
  }
  const p = captured.offers[0]!;
  const rt = await runtime();
  const pdp: any = (rt as any).shared.publicDataProvider;
  const params = (await pdp.queryZSwapAndContractState(state.accounts.A!.address))[2];
  state.offer = { offerId: String(result.offerId), payload, result, madeAt: new Date().toISOString() };
  saveState(state);
  await recordDust(state, 'offer-A', before);
  evidence('05-c2-offer', {
    order: { side: 'sell', quantity: '10', price: C2_PRICE, give: legs.give, want: legs.want, rounded: legs.rounded },
    maker: state.accounts.A!.address,
    coin: { nonce: coin.nonce, value: coin.value, mtIndex: coin.mtIndex },
    signatures: 1,
    result,
    stages,
    seconds: secondsSince(t0),
    offer: {
      offerId: p.offerId,
      bytes: p.bytes.length,
      blobChars: p.blob.length,
      steering: p.steering,
      structure: p.structure,
      expiresAt: new Date(p.expiresAt).toISOString(),
      costAlone: readCost(p.tx, params),
    },
  });
}

/**
 * `by` takes the whole offer `offerId` from the book, as the page does: the complement of its legs,
 * paid from one coin, through the relay's take executor (maker check, guaranteed proof, merge,
 * cost(params, true), the batcher).
 */
async function takeAs(state: TrdState, key: 'ladder' | 'c2', by: 'A' | 'B', offerId: string, name: string) {
  if (state.takes[key]?.result) return;
  const kernel = await getJson(`${NET.zswap.kernelUrl}/v1/offers/${offerId}`);
  if (kernel.status !== 200) throw new Error(`the kernel does not list the offer (${kernel.status})`);
  const g = kernel.body.computed.gives[0];
  const w = kernel.body.computed.wants[0];
  const entry = {
    side: norm(g.token) === norm(STOCK.midnightColour) ? ('ask' as const) : ('bid' as const),
    stockRaw: BigInt(norm(g.token) === norm(STOCK.midnightColour) ? g.amount : w.amount),
    usdcRaw: BigInt(norm(g.token) === norm(STOCK.midnightColour) ? w.amount : g.amount),
  };
  const legs = takeLegs(entry, STOCK, USDC);
  const { payload, passportAuth, coin } = await signedTrade(by, legs.give, legs.want);
  const takePayload: TakePayload = { ...payload, offerId };
  const captured = { offers: [] as ProvenAccountOffer[] };
  const deps = await tradeDeps(captured);
  const stages: Array<Record<string, unknown>> = [];
  const before = await sponsorDust();
  const walkA = await walk(state.accounts.A!);
  const walkB = state.accounts.B?.address ? await walk(state.accounts.B) : null;
  const statusBefore = (await getJson(`${NET.zswap.kernelUrl}/v1/offers/${offerId}/status`)).body;
  const t0 = Date.now();
  let result: Record<string, unknown> | null = null;
  let error: string | null = null;
  try {
    result = await runTrade('take', by, takePayload as never, passportAuth, deps, stages);
  } catch (e) {
    error = errorChain(e);
  }
  // The same merge, recomputed here for the evidence (deterministic): structure, cost, bytes.
  let merged: Record<string, unknown> | null = null;
  const taker = captured.offers[0];
  if (taker) {
    try {
      const ledger: any = await import('@midnightntwrk/ledger-v9');
      const { decodeOffer } = await import('@mnbank/core');
      const makerTx = ledger.Transaction.deserialize(
        'signature',
        'proof',
        'binding',
        decodeOffer(kernel.body.offerBech32),
      );
      const rt = await runtime();
      const pdp: any = (rt as any).shared.publicDataProvider;
      const params = (await pdp.queryZSwapAndContractState(state.accounts[by]!.address))[2];
      const m = mergeForSettlement(makerTx, taker.tx as never, params);
      const bytes: Uint8Array = (m.merged as any).serialize();
      merged = {
        bytes: bytes.length,
        structure: m.structure,
        plan: m.plan,
        cost: m.cost,
        makerStructure: describeTx(makerTx),
        makerCostAlone: readCost(makerTx, params),
        takerCostAlone: readCost(taker.tx, params),
      };
      state.takes[key] = { offerId, by, mergedHex: hex(bytes), at: new Date().toISOString() };
    } catch (e) {
      merged = { error: errorChain(e) };
    }
  }
  state.takes[key] = {
    ...(state.takes[key] ?? { offerId, by, at: new Date().toISOString() }),
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
  };
  saveState(state);
  // The kernel's status transition, as the page would see it.
  const transitions: Array<{ at: string; status: unknown }> = [
    { at: new Date(t0).toISOString(), status: statusBefore },
  ];
  if (result) {
    for (let i = 0; i < 45; i++) {
      const st = (await getJson(`${NET.zswap.kernelUrl}/v1/offers/${offerId}/status`)).body;
      if (JSON.stringify(st) !== JSON.stringify(transitions.at(-1)!.status))
        transitions.push({ at: new Date().toISOString(), status: st });
      if (st?.status === 'consumed') break;
      await sleep(4000);
    }
  }
  // The taker's walk: the wanted coin and the change arrive with inbox entries.
  const walkAfter = result
    ? await waitWalk(
        state.accounts[by]!,
        (x) => x.coins.some((c) => c.nonce === payload.wantNonce && c.mtIndex !== null),
        'the bought coin in the taker walk',
      ).catch(() => null)
    : null;
  await recordDust(state, `take-${key}`, before);
  evidence(name, {
    offerId,
    kernelStatusTransitions: transitions,
    after: walkAfter
      ? {
          holdings: holdings(walkAfter.coins),
          inbox: walkAfter.inboxCount,
          authNonce: walkAfter.authNonce,
          boughtCoin: walkAfter.coins.find((c) => c.nonce === payload.wantNonce) ?? null,
          spentCoin: walkAfter.coins.find((c) => c.nonce === coin.nonce) ?? null,
        }
      : null,
    book: {
      side: entry.side,
      stockRaw: entry.stockRaw,
      usdcRaw: entry.usdcRaw,
      kernelStatus: kernel.body.computed?.status,
    },
    taker: { label: by, account: state.accounts[by]!.address },
    legs: { give: legs.give, want: legs.want },
    coin: { nonce: coin.nonce, value: coin.value, mtIndex: coin.mtIndex },
    signatures: 1,
    stages,
    result,
    error,
    seconds: secondsSince(t0),
    takerOffer: taker
      ? { offerId: taker.offerId, bytes: taker.bytes.length, steering: taker.steering, structure: taker.structure }
      : null,
    merged,
    before: {
      A: { holdings: holdings(walkA.coins), inbox: walkA.inboxCount, authNonce: walkA.authNonce },
      B: walkB ? { holdings: holdings(walkB.coins), inbox: walkB.inboxCount, authNonce: walkB.authNonce } : null,
    },
  });
  if (error) throw new Error(`the take failed: ${error}`);
}

/** The best ask on the book for wStkA against wUSDC: the lowest wUSDC per wStkA, whole offer. */
async function bestLadderAsk(state: TrdState): Promise<{ offerId: string; stockRaw: bigint; usdcRaw: bigint }> {
  const book = await getJson(`${NET.zswap.kernelUrl}/v1/offers?limit=100`);
  const own = new Set([state.offer?.offerId].filter(Boolean));
  const asks = ((book.body?.offers ?? []) as any[])
    .filter((o) => o.computed?.gives?.length === 1 && o.computed?.wants?.length === 1)
    .map((o) => ({ o, g: o.computed.gives[0], w: o.computed.wants[0] }))
    .filter(
      ({ o, g, w }) =>
        !own.has(o.offerId) &&
        g.type === 'SHIELDED' &&
        w.type === 'SHIELDED' &&
        norm(g.token) === norm(STOCK.midnightColour) &&
        norm(w.token) === norm(USDC.midnightColour),
    )
    .map(({ o, g, w }) => ({ offerId: String(o.offerId), stockRaw: BigInt(g.amount), usdcRaw: BigInt(w.amount) }))
    // Lowest price first: usdc_a / stock_a < usdc_b / stock_b.
    .sort((a, b) => (a.usdcRaw * b.stockRaw < b.usdcRaw * a.stockRaw ? -1 : 1));
  evidence('03-ladder-book', {
    offers: (book.body?.offers ?? []).length,
    asks: asks.map((a) => ({ offerId: a.offerId, stockRaw: a.stockRaw, usdcRaw: a.usdcRaw })),
  });
  if (!asks[0]) throw new Error('no wStkA/wUSDC ask on the book');
  return asks[0];
}

async function liveWindow(): Promise<void> {
  const state = loadState();
  state.submitter = await (
    await sponsor()
  ).withWallet(async (w: any) => String(w.unshieldedKeystore.getBech32Address().asString()));
  saveState(state);
  // (b): the reused account A takes ONE ladder ask (a wallet maker's legs sit in segment 0).
  await ensureAccounts(state, 'A');
  await fundOne(state, 'A', USDC.midnightColour, FUND_A_USDC);
  if (!state.takes.ladder?.result) {
    const ask = state.takes.ladder?.offerId ? { offerId: state.takes.ladder.offerId } : await bestLadderAsk(state);
    await takeAs(state, 'ladder', 'A', ask.offerId, '04-take-ladder');
  }
  // (c2) needs a second account: registered and funded now, the offer and its take run through
  // the UI (test/stack/run-trade-live.sh) or with the `c2` command.
  if (dustSpent(state) + REGISTRATION_ESTIMATE_SPECKS + 3n * 10n ** 15n <= DUST_STOP_SPECKS) {
    await ensureAccounts(state, 'B');
    await fundOne(state, 'B', USDC.midnightColour, FUND_B_USDC);
  } else {
    say('not enough DUST budget left for a second account: (c2) is skipped', { spent: dust(dustSpent(state)) });
  }
  await verify();
}

/** (c2) by the driver: A offers 10 wStkA at 0.02, B takes it whole. */
async function c2(): Promise<void> {
  const state = loadState();
  if (!state.accounts.B?.address) throw new Error('B is not registered');
  await makeOffer(state);
  await takeAs(state, 'c2', 'B', state.offer!.offerId, '06-c2-take');
  await verify();
}

// ---- verification and replay (read-only / batcher) -------------------------------------------------

async function verify(): Promise<void> {
  const state = loadState();
  const out: Record<string, unknown> = {};
  for (const [key, t] of Object.entries(state.takes)) {
    const st = await getJson(`${NET.zswap.kernelUrl}/v1/offers/${t.offerId}/status`);
    out[`take-${key}`] = {
      offerId: t.offerId,
      by: t.by,
      kernelStatus: st.body,
      result: t.result ?? null,
      error: t.error ?? null,
    };
  }
  for (const label of ['A', 'B'] as const) {
    const a = state.accounts[label];
    if (!a?.address) continue;
    const w = await walk(a);
    out[label] = {
      address: a.address,
      holdings: holdings(w.coins),
      inbox: w.inboxCount,
      authNonce: w.authNonce,
      coins: w.coins,
    };
  }
  const txHash = (state.takes.ladder?.result as any)?.txHash;
  if (txHash) {
    const q = await getJson(NET.midnight.indexerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($h: HexEncoded!) { transactions(offset: { hash: $h }) { hash block { height timestamp } ... on RegularTransaction { fee } } }`,
        variables: { h: norm(txHash) },
      }),
    });
    out.settlingTransaction = q.body?.data ?? q.body;
  }
  evidence('07-verify', out);
}

async function replay(): Promise<void> {
  const state = loadState();
  const take = state.takes.ladder;
  if (!take?.mergedHex || !take.result) throw new Error('no settled take to replay');
  // The submitter address the take used (public, recorded during the window): no wallet needed.
  const address = state.submitter;
  if (!address) throw new Error('the window did not record the submitter address');
  const r = await submitToBatcher({
    batcherUrl: NET.zswap.batcherUrl,
    txHex: take.mergedHex,
    address,
    timeoutMs: 180_000,
  });
  evidence('08-replay', {
    offerId: take.offerId,
    batcher: { ok: r.ok, httpStatus: r.httpStatus, error: r.error, transactionHash: r.transactionHash ?? null },
    refused: !r.ok,
  });
}

// ---- main ------------------------------------------------------------------------------------------

const [cmd] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'preflight':
      await preflight();
      break;
    case 'window':
      await liveWindow();
      break;
    case 'c2':
      await c2();
      break;
    case 'verify':
      await verify();
      break;
    case 'replay':
      await replay();
      break;
    default:
      throw new Error(`unknown command ${String(cmd)}`);
  }
  await stopSponsor();
  process.exit(0);
} catch (e) {
  log.error('L-TRD.0 step failed', { cmd, error: errorChain(e) });
  await stopSponsor();
  process.exit(1);
}
