/* eslint-disable @typescript-eslint/no-explicit-any -- the Passport client, the vault package and the
   Midnight SDK are loaded at run time from the pinned tree inside the gate image; their surfaces are
   untyped here on purpose (this file never runs in CI). */
// G-BRIDGE — the first account-path bridge on Midnight stagenet (plan 00039, P2).
//
// A Passport account deposits 1 stkA from Sepolia through the witness-free ERC20 vault and Sig
// Network's live MPC (account -> vault -> Signet singleton), and then withdraws 1 wStkA back.
// Every step is its own command and its own process, because every step is an irreversible
// transaction on a public network and the MPC round trip takes about 20 minutes. State between
// steps lives OUTSIDE the repository (GATE_STATE_DIR, mode 700), and a relay resumes by request id.
//
//   preflight          read-only: stagenet version, the MPC constants, the vault, Sepolia
//   keys-verify        read-only: the managed bundles against expectedVk, PR #4's record and the
//                      verifier keys deployed on stagenet
//   deploy             Midnight: a fresh EVM-only bridge account (two waves, authority retired),
//                      activated, bound to the vault; prints its Sepolia deposit address
//   fund               Sepolia: 1 stkA and the sweep's gas ETH to the deposit address
//   deposit-start      Midnight: bridge_deposit_start_with_evm (one device signature)
//   relay-deposit      the MPC signs, the signed sweep is broadcast, finality, attestation
//   deposit-complete   Midnight: bridge_deposit_complete, then the inbox walk
//   withdraw-gas       Sepolia: gas ETH for the vault's own EVM account, only if it lacks it
//   withdraw-start     Midnight: bridge_withdraw_start_with_evm (one device signature)
//   relay-withdraw     as relay-deposit, for the vault's transfer to the destination
//   withdraw-complete  Midnight: bridge_withdraw_complete (or the refund on a never-executed transfer)
//   status             read-only: where everything stands
//
// THE REQUEST ID is matched as the vault's own driver matches it — the ids new between a read
// before and a read after the start, whose stored derivation path is ours — never as Passport's
// AccountBridge does ("the newest open id in the shared vault"). See relay-compose.ts.
//
// SECRETS. The sponsor wallet's mnemonic file and the Sepolia key file are mounted read-only
// and read in this process only; nothing about them is printed. The account's device is a test
// EOA generated here and written, before it is used, to GATE_STATE_DIR/gate-bridge-device.key
// (mode 600, exclusive create). The account's encryption secret and its private coin store live
// in GATE_STATE_DIR/gate-bridge-state.json (mode 600). Evidence files carry public values only.
//
// Run it through run-gate.sh, which holds the shared funding-wallet lock, starts the pinned
// proof server and mounts everything read-only.

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import {
  fromResumableJson,
  isSignatureTimeout,
  matchNewRequest,
  normaliseHex,
  relayOptionsFor,
  remainingSignatureBudgetMs,
  toResumableJson,
  type BridgeKind,
} from './relay-compose.js';

// ---- the network (public values; acedward/passport PR #4 "Canonical addresses") -----------------

const EXPECTED_NODE_VERSION = process.env.EXPECTED_NODE_VERSION ?? '2.0.0-d9729c13';
const VAULT_ADDRESS = '7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637';
const VAULT_EVM_ADDRESS = '0x648216975e722494bFF92E88FFc68C8F8d438FaA';
const SINGLETON_ADDRESS = '1df4ce25fc9f9c03dc6f4d0eb12ddf3d0db094995d4c70aca1142eebb3b77a5d';
const MPC_ROOT_POINT =
  '047dd8ecafa5d9c921485b6ac33476870e98c3378e395f3c8fae92ce4943d8432847f591ab25ca454effb522ec2eaf04b7e1c83ba65ae731ea98dd52eb7d458dd4';
const OUTPUT_CACHE_URL = 'https://storage.googleapis.com/midnight-cache-storage-testnet/v1/stagenet';
const STKA_ERC20 = '0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52';
const WSTKA_COLOUR = '5eb2a3cebb2ebe7ba910c78f62c9e28e0d74acbd00c810730def3578860e6a02';
const FUNDER = '0x484738A67858305Edfc139B194Ed430Fe4D8e56b';
const SEPOLIA_CHAIN_ID = 11155111n;
const EXPLORER = 'https://sig-net.github.io/explorer/midnight/explorer?networkId=stagenet';
const ACCOUNT_SOURCE_SHA256 = '44cff904f6ed58440b2534f64c429e0d422bfae082dbe8c82465002fb50e9fcf';

/** 1 stkA (6 decimals): the gate's whole deposit and whole withdrawal. */
const AMOUNT = 1_000_000n;

/** EIP-1559 fields the device signs and the MPC signs verbatim: AA 00037's proven values. */
const EVM_GAS = {
  gasLimit: BigInt(process.env.EVM_GAS_LIMIT ?? '100000'),
  maxFeePerGas: BigInt(process.env.EVM_MAX_FEE_PER_GAS ?? '10000000000'),
  maxPriorityFeePerGas: BigInt(process.env.EVM_MAX_PRIORITY_FEE_PER_GAS ?? '1000000000'),
  keyVersion: 1n,
};
const SWEEP_GAS_WEI = EVM_GAS.gasLimit * EVM_GAS.maxFeePerGas;

/** Caps for this gate (Q8): Sepolia ETH out of the funder, DUST out of the sponsor. */
const CAP_ETH_WEI = 20_000_000_000_000_000n; // 0.02 ETH
const CAP_DUST_SPECKS = 100n * 10n ** 15n; // 100 DUST

// ---- where things are -----------------------------------------------------------------------------

const PASSPORT = process.env.PASSPORT_CONTRACT_DIR ?? '/aa/g/contract';
const VAULT_PKG = path.join(PASSPORT, 'contracts', 'erc20-vault');
const MANAGED = path.join(PASSPORT, 'contracts', 'managed');
const STATE_DIR = process.env.GATE_STATE_DIR ?? '/state';
const STATE_FILE = path.join(STATE_DIR, 'gate-bridge-state.json');
const DEVICE_KEY_FILE = path.join(STATE_DIR, 'gate-bridge-device.key');
const EVIDENCE_DIR = process.env.GATE_EVIDENCE_DIR ?? '/evidence';

const setDefault = (name: string, value: string) => {
  if (!process.env[name]) process.env[name] = value;
};
// Set BEFORE the client's wallet modules load: they read their configuration at module load.
setDefault('MIDNIGHT_NETWORK', 'stagenet');
setDefault('MIDNIGHT_NETWORK_ID', 'stagenet');
setDefault('INDEXER_URL', 'https://indexer.stagenet.shielded.tools/api/v4/graphql');
setDefault('INDEXER_WS_URL', 'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws');
setDefault('MIDNIGHT_NODE_URL', 'https://rpc.stagenet.shielded.tools');
setDefault('MIDNIGHT_PROOF_SERVER_URL', 'http://127.0.0.1:6300');
setDefault('PROOF_SERVER_URL', process.env.MIDNIGHT_PROOF_SERVER_URL ?? 'http://127.0.0.1:6300');
setDefault('FEE_BLOCKS_MARGIN', '5');
setDefault('TX_TTL_MS', '60000');
setDefault('MIDNIGHT_MANAGED_PATH', MANAGED);
const INDEXER_URL = process.env.INDEXER_URL!;
const INDEXER_WS_URL = process.env.INDEXER_WS_URL!;
const NODE_URL = process.env.MIDNIGHT_NODE_URL!;
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';

// ---- the pinned client, loaded at run time --------------------------------------------------------

const load = (specifier: string): Promise<any> => import(specifier);
const lib = {
  nodeWallet: () => load(path.join(PASSPORT, 'src/node/wallet.ts')),
  account: () => load(path.join(PASSPORT, 'src/wallet/account.ts')),
  bridge: () => load(path.join(PASSPORT, 'src/wallet/bridge.ts')),
  signer: () => load(path.join(PASSPORT, 'src/wallet/signer.ts')),
  inbox: () => load(path.join(PASSPORT, 'src/wallet/inbox.ts')),
  witnesses: () => load(path.join(PASSPORT, 'src/wallet/witnesses.ts')),
  discovery: () => load(path.join(PASSPORT, 'src/wallet/discovery.ts')),
  capture: () => load(path.join(PASSPORT, 'src/wallet/capture.ts')),
  vault: () => load(path.join(VAULT_PKG, 'src/index.ts')),
  relayer: () => load(path.join(VAULT_PKG, 'src/relayer.ts')),
  preflight: () => load(path.join(VAULT_PKG, 'src/preflight.ts')),
  sdk: () => load(path.join(VAULT_PKG, 'src/signet-sdk.ts')),
  artefacts: () => load(path.join(VAULT_PKG, 'deploy/artefacts.ts')),
  vaultWallet: () => load(path.join(VAULT_PKG, 'deploy/wallet.ts')),
};

// ---- small helpers --------------------------------------------------------------------------------

type Json = Record<string, any>;

class StopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StopError';
  }
}

const t0 = Date.now();
const nowUtc = () => new Date().toISOString();
const log = (line: string) => console.log(`[${nowUtc()} +${Math.round((Date.now() - t0) / 1000)}s] ${line}`);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sha256File = (file: string) => sha256(readFileSync(file));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const fromHex = (value: string) => Uint8Array.from(Buffer.from(normaliseHex(value), 'hex'));
const dust = (specks: bigint) => (Number(specks) / 1e15).toFixed(6);
const eth = (wei: bigint) => (Number(wei) / 1e18).toFixed(9);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function publicJson(value: unknown): string {
  return `${JSON.stringify(
    value,
    (_key, v: unknown) => {
      if (typeof v === 'bigint') return v.toString();
      if (v instanceof Uint8Array) return hex(v);
      if (v !== null && typeof v === 'object' && (v as any).type === 'Buffer' && Array.isArray((v as any).data)) {
        return Buffer.from((v as any).data).toString('hex');
      }
      return v;
    },
    2,
  )}\n`;
}

/** Merge `body` into evidence/<name>.json. Public values only. */
function evidence(name: string, body: Json): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, `${name}.json`);
  const existing = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Json) : {};
  writeFileSync(file, publicJson({ ...existing, ...body, writtenUtc: nowUtc() }));
  log(`evidence -> ${name}.json`);
}

// ---- state (secrets: mode 600, never in the repository or the evidence) ---------------------------

interface SepoliaTx {
  label: string;
  hash: string;
  block: number;
  status: number;
  valueWei: string;
  feeWei: string;
}

interface DustEntry {
  step: string;
  beforeSpecks: string;
  afterSpecks: string;
  txFeesSpecks: Record<string, string>;
}

interface FlowRecord {
  requestId?: string;
  startTxId?: string;
  startedAtMs?: number;
  evmNonce?: string;
  erc20Before?: Record<string, string>;
  relayProgress?: Json[];
  relay?: unknown;
  settleTxId?: string;
  [key: string]: unknown;
}

interface GateState {
  version: 1;
  network: 'stagenet';
  /** Written BEFORE the deploy, so a crash after it still leaves the secret. */
  pending?: { encSecretHex: string; encPublicHex: string; deviceAddress: string };
  account?: {
    address: string;
    encSecretHex: string;
    encPublicHex: string;
    deviceAddress: string;
    depositAddress: string;
    depositPathHex: string;
    deployedUtc: string;
  };
  coinStore?: any;
  sepoliaTxs?: SepoliaTx[];
  dustLog?: DustEntry[];
  deposit?: FlowRecord;
  withdraw?: FlowRecord;
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function loadState(): GateState {
  if (!existsSync(STATE_FILE)) return { version: 1, network: 'stagenet' };
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as GateState;
}

function saveState(state: GateState): void {
  ensurePrivateDir(STATE_DIR);
  writeFileSync(STATE_FILE, publicJson(state), { mode: 0o600 });
  chmodSync(STATE_FILE, 0o600);
}

const SECP256K1_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

/** The account's device: a throwaway test EOA, generated once, stored at mode 600 before use. */
function deviceKey(create: boolean): Uint8Array {
  if (existsSync(DEVICE_KEY_FILE)) {
    const m = /^(?:0x)?([0-9a-fA-F]{64})\s*$/.exec(readFileSync(DEVICE_KEY_FILE, 'utf8'));
    if (m === null) throw new Error(`${DEVICE_KEY_FILE} is not a 32-byte hex key`);
    return fromHex(m[1]!);
  }
  if (!create) throw new Error(`no device key at ${DEVICE_KEY_FILE}: run deploy first`);
  let key: Uint8Array;
  do {
    key = new Uint8Array(randomBytes(32));
  } while (BigInt(`0x${hex(key)}`) === 0n || BigInt(`0x${hex(key)}`) >= SECP256K1_N);
  ensurePrivateDir(STATE_DIR);
  const content = `0x${hex(key)}\n`;
  writeFileSync(DEVICE_KEY_FILE, content, { mode: 0o600, flag: 'wx' });
  chmodSync(DEVICE_KEY_FILE, 0o600);
  if (readFileSync(DEVICE_KEY_FILE, 'utf8') !== content) throw new Error('device key file: read-back differs');
  if ((statSync(DEVICE_KEY_FILE).mode & 0o777) !== 0o600) throw new Error('device key file: mode is not 600');
  log(`a fresh device key was generated and stored at ${DEVICE_KEY_FILE} (mode 600)`);
  return key;
}

// ---- chain helpers ------------------------------------------------------------------------------------

async function nodeRpc(method: string): Promise<unknown> {
  const res = await fetch(NODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
  });
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined) throw new Error(`node ${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function gql(query: string, variables: Json = {}): Promise<any> {
  const res = await fetch(INDEXER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: any; errors?: unknown[] };
  if (body.errors !== undefined && body.errors.length > 0) throw new Error(`indexer: ${JSON.stringify(body.errors)}`);
  return body.data;
}

/** A Midnight transaction by its midnight-js id: hash, block, DUST fee, commitment window. */
async function txInfo(identifier: string): Promise<Json> {
  const data = await gql(
    `query($offset: TransactionOffset!) { transactions(offset: $offset) {
       hash block { height timestamp }
       ... on RegularTransaction { fee transactionResult { status } zswapStartIndex zswapEndIndex }
     } }`,
    { offset: { identifier: normaliseHex(identifier) } },
  );
  const t = (data?.transactions ?? [])[0];
  if (t === undefined) throw new Error(`the indexer has no transaction ${identifier}`);
  return {
    identifier: normaliseHex(identifier),
    hash: t.hash,
    blockHeight: t.block?.height,
    blockUtc: t.block?.timestamp === undefined ? undefined : new Date(Number(t.block.timestamp)).toISOString(),
    blockMs: t.block?.timestamp === undefined ? undefined : Number(t.block.timestamp),
    status: t.transactionResult?.status,
    feeSpecks: t.fee,
    feeDust: t.fee === undefined || t.fee === null ? undefined : dust(BigInt(t.fee)),
    zswapStartIndex: t.zswapStartIndex,
    zswapEndIndex: t.zswapEndIndex,
  };
}

/** Retry `txInfo` while the indexer catches up with a transaction that just finalised. */
async function txInfoEventually(identifier: string): Promise<Json> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await txInfo(identifier);
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
}

async function sepolia(): Promise<{ ethers: any; provider: any }> {
  const { ethers } = await load('ethers');
  return { ethers, provider: new ethers.JsonRpcProvider(SEPOLIA_RPC, undefined, { staticNetwork: true }) };
}

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
];

async function erc20Balance(ethers: any, provider: any, holder: string): Promise<bigint> {
  return (await new ethers.Contract(STKA_ERC20, ERC20_ABI, provider).balanceOf(holder)) as bigint;
}

/** The owner's Sepolia funder, from its key file, in THIS process only. */
async function sepoliaFunder(ethers: any, provider: any): Promise<any> {
  const file = process.env.SEPOLIA_KEY_FILE ?? '/secrets/sepolia';
  const line = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .find((l) => /^\s*SK\s*=/.test(l));
  if (line === undefined) throw new Error('the Sepolia key file has no SK= line');
  const value = normaliseHex(
    line
      .replace(/^\s*SK\s*=\s*/, '')
      .trim()
      .replace(/^['"]|['"]$/g, ''),
  );
  const wallet = new ethers.Wallet(`0x${value}`, provider);
  if (String(wallet.address).toLowerCase() !== FUNDER.toLowerCase()) {
    throw new Error(`the Sepolia key file does not derive the expected funder ${FUNDER}`);
  }
  const { chainId } = await provider.getNetwork();
  if (BigInt(chainId) !== SEPOLIA_CHAIN_ID) throw new Error(`the EVM RPC is chain ${String(chainId)}, not Sepolia`);
  return wallet;
}

function sepoliaSpentWei(state: GateState): bigint {
  return (state.sepoliaTxs ?? []).reduce((sum, t) => sum + BigInt(t.valueWei) + BigInt(t.feeWei), 0n);
}

/** Send one Sepolia transaction from the funder, inside the cap, and record it. */
async function funderSend(
  state: GateState,
  label: string,
  build: () => Promise<any>,
  valueWei: bigint,
  provider: any,
): Promise<SepoliaTx> {
  const fees = await provider.getFeeData();
  const worstFee = 100_000n * BigInt(fees.maxFeePerGas ?? fees.gasPrice ?? 0n);
  if (sepoliaSpentWei(state) + valueWei + worstFee > CAP_ETH_WEI) {
    throw new StopError(
      `a Sepolia send (${label}) could take the gate past its 0.02 ETH cap (spent ${eth(sepoliaSpentWei(state))})`,
    );
  }
  const latest = await provider.getTransactionCount(FUNDER, 'latest');
  const pending = await provider.getTransactionCount(FUNDER, 'pending');
  if (pending > latest) {
    throw new StopError(`the funder has ${pending - latest} transaction(s) in flight: another sender is active, wait`);
  }
  const sent = await build();
  const receipt = await sent.wait(1);
  const fee = BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n);
  const tx: SepoliaTx = {
    label,
    hash: receipt.hash,
    block: receipt.blockNumber,
    status: receipt.status,
    valueWei: valueWei.toString(),
    feeWei: fee.toString(),
  };
  state.sepoliaTxs = [...(state.sepoliaTxs ?? []), tx];
  saveState(state);
  log(`sepolia ${label}: ${tx.hash} block ${tx.block} status ${tx.status} value ${eth(valueWei)} fee ${eth(fee)} ETH`);
  if (tx.status !== 1) throw new StopError(`the Sepolia ${label} transaction reverted: ${tx.hash}`);
  return tx;
}

// ---- the Midnight side ----------------------------------------------------------------------------------

async function openWallet(): Promise<any> {
  await lib.nodeWallet(); // sets the network id and the WebSocket global first
  const vw = await lib.vaultWallet(); // live DUST parameters, fee margin 5, the mnemonic file
  const ctx = await vw.createWallet(vw.walletSeedFromEnv());
  await vw.syncWallet(ctx, 'the sponsor wallet');
  return ctx;
}

async function closeWallet(ctx: any): Promise<void> {
  try {
    await ctx?.wallet?.stop?.();
  } catch {
    // closing is best effort; the process exits next
  }
}

async function dustSpecks(ctx: any): Promise<bigint> {
  const Rx = await load('rxjs');
  const s: any = await Rx.firstValueFrom(ctx.wallet.state().pipe(Rx.filter((x: any) => x.isSynced)));
  try {
    return BigInt(s.dust?.balance?.(new Date()) ?? 0);
  } catch {
    return -1n;
  }
}

function recordDust(state: GateState, step: string, before: bigint, after: bigint, fees: Record<string, string>) {
  state.dustLog = [
    ...(state.dustLog ?? []),
    { step, beforeSpecks: before.toString(), afterSpecks: after.toString(), txFeesSpecks: fees },
  ];
  saveState(state);
  const paid = Object.values(fees).reduce((sum, v) => sum + BigInt(v), 0n);
  log(
    `DUST ${step}: ${dust(before)} -> ${dust(after)} (drop ${dust(before - after)}); fees required ${dust(paid)}; gate total ${dust(dustPaidSpecks(state))}`,
  );
}

/**
 * DUST spent so far, counted against the cap. The indexer's `fee` is what a transaction required;
 * the ledger consumes the whole declared fee (the estimate times 1.046^margin), which shows as the
 * balance drop. So each step counts the larger of the two.
 */
function dustPaidSpecks(state: GateState): bigint {
  return (state.dustLog ?? []).reduce((sum, d) => {
    const fees = Object.values(d.txFeesSpecks).reduce((s, v) => s + BigInt(v), 0n);
    const drop = BigInt(d.beforeSpecks) - BigInt(d.afterSpecks);
    return sum + (drop > fees ? drop : fees);
  }, 0n);
}

function assertDustCap(state: GateState): void {
  if (dustPaidSpecks(state) > CAP_DUST_SPECKS - 20n * 10n ** 15n) {
    throw new StopError(`the gate has paid ${dust(dustPaidSpecks(state))} DUST; the next step could pass the cap`);
  }
}

async function compiledAccount(): Promise<any> {
  const { CompiledContract } = await load('@midnight-ntwrk/compact-js');
  const { contractForBridgeAccount } = await lib.bridge();
  const { makeWitnesses } = await lib.witnesses();
  const nw = await lib.nodeWallet();
  // The dApp's account shape (plan P0.5): the bridge circuits and the offer circuit.
  return CompiledContract.make('account', contractForBridgeAccount(['evm'], { withSwap: true })).pipe(
    CompiledContract.withWitnesses(makeWitnesses()),
    CompiledContract.withCompiledFileAssets(nw.zkConfigPath),
  );
}

function bridgeConfig(): Json {
  return {
    vaultAddress: VAULT_ADDRESS,
    signetContractAddress: SINGLETON_ADDRESS,
    mpcRootPublicKey: `0x${MPC_ROOT_POINT}`,
    erc20: STKA_ERC20,
    evmRpcUrl: SEPOLIA_RPC,
  };
}

async function connectAccount(state: GateState, providers: any): Promise<{ account: any; bridge: any; device: any }> {
  if (state.account === undefined) throw new Error('no account in the state file: run deploy first');
  const { CustodyAccount } = await lib.account();
  const { AccountBridge } = await lib.bridge();
  const { EvmDevice } = await lib.signer();
  const { emptyCoinStore } = await lib.witnesses();
  const store = state.coinStore ?? emptyCoinStore(fromHex(state.account.encSecretHex));
  store.encSecretKeyHex ??= state.account.encSecretHex;
  const account = await CustodyAccount.connect(providers, await compiledAccount(), state.account.address, store);
  const device = EvmDevice.fromPrivateKey(deviceKey(false));
  await device.enrol?.();
  const bridge = new AccountBridge(account, bridgeConfig(), fromHex(state.account.encPublicHex));
  return { account, bridge, device };
}

/** The request ids open in one direction of the vault, and each one's stored derivation path. */
async function openRequests(
  bridge: any,
  kind: BridgeKind,
): Promise<{ ids: string[]; pathOf: (id: string) => string | undefined }> {
  const { toSignBidirectionalEventIndex } = await lib.sdk();
  const l = await bridge.vaultState();
  const index = toSignBidirectionalEventIndex(kind === 'deposit' ? l.depositEventMap : l.withdrawEventMap);
  const records = new Map<string, any>();
  for (const [id, record] of index.entries()) records.set(normaliseHex(String(id)), record);
  return {
    ids: [...records.keys()],
    pathOf: (id: string) => {
      const p = records.get(normaliseHex(id))?.path;
      return p === undefined ? undefined : typeof p === 'string' ? p : hex(p);
    },
  };
}

async function vaultRelayConstants(): Promise<any> {
  const vault = await lib.vault();
  const sdk = await lib.sdk();
  return {
    vaultAddress: VAULT_ADDRESS,
    signetAddress: SINGLETON_ADDRESS,
    depositRequestsPath: vault.VAULT_DEPOSIT_REQUESTS_PATH,
    withdrawRequestsPath: vault.VAULT_WITHDRAW_REQUESTS_PATH,
    responseSchema: vault.pureCircuits.vaultResponseSchema(),
    mpcResponseKey: sdk.deriveMidnightResponseKey(
      sdk.normaliseSecp256k1PublicKey(`0x${MPC_ROOT_POINT}`),
      VAULT_ADDRESS,
    ),
  };
}

// ---- commands -------------------------------------------------------------------------------------------

async function cmdPreflight(): Promise<void> {
  const version = String(await nodeRpc('system_version'));
  const chain = String(await nodeRpc('system_chain'));
  const out: Json = { at: nowUtc(), node: { url: NODE_URL, version, chain, expected: EXPECTED_NODE_VERSION } };
  if (version !== EXPECTED_NODE_VERSION) {
    evidence('g0-preflight', { ...out, verdict: 'STOP: the stagenet node version changed' });
    throw new StopError(`stagenet runs ${version}, expected ${EXPECTED_NODE_VERSION}: stop and ask`);
  }
  await lib.nodeWallet();
  const sdk = await lib.sdk();
  const vault = await lib.vault();
  const { vaultColour } = await lib.bridge();
  const { indexerPublicDataProvider } = await load('@midnight-ntwrk/midnight-js-indexer-public-data-provider');

  const root = normaliseHex(sdk.normaliseSecp256k1PublicKey(sdk.getMpcRootPublicKey('stagenet')));
  const singleton = normaliseHex(String(sdk.getSignetContractAddress('stagenet')));
  const cacheUrl = String(sdk.getMpcOutputCacheUrl('stagenet'));
  const vaultEvm = String(vault.deriveVaultEvmAddress(root, VAULT_ADDRESS));
  const responseKey = sdk.deriveMidnightResponseKey(root, VAULT_ADDRESS);
  const colour = hex(vaultColour(VAULT_ADDRESS, STKA_ERC20));

  const pdp = indexerPublicDataProvider(INDEXER_URL, INDEXER_WS_URL);
  const cs = await pdp.queryContractState(VAULT_ADDRESS);
  if (!cs) throw new StopError(`no contract state at the vault ${VAULT_ADDRESS}`);
  const l = vault.ledger(cs.data);
  const vaultLedger = {
    initialised: String(l.initialised),
    evmChainId: String(l.evmChainId),
    vaultEvmAddress: `0x${hex(l.vaultEvmAddress)}`,
    mpcResponseKeyMatches: l.mpcResponseKey.x === responseKey.x && l.mpcResponseKey.y === responseKey.y,
    signetRequestNonce: String(l.signetRequestNonce),
    openDeposits: [...sdk.toSignBidirectionalEventIndex(l.depositEventMap).keys()].map(String),
    openWithdrawals: [...sdk.toSignBidirectionalEventIndex(l.withdrawEventMap).keys()].map(String),
  };

  const { ethers, provider } = await sepolia();
  let sepoliaFacts: Json;
  try {
    const net = await provider.getNetwork();
    const block = await provider.getBlock('latest');
    sepoliaFacts = {
      chainId: String(net.chainId),
      block: block?.number,
      baseFeeGwei: block?.baseFeePerGas === undefined ? undefined : Number(block.baseFeePerGas) / 1e9,
      funder: {
        address: FUNDER,
        eth: eth(await provider.getBalance(FUNDER)),
        stkA: String(await erc20Balance(ethers, provider, FUNDER)),
        nonceLatest: await provider.getTransactionCount(FUNDER, 'latest'),
        noncePending: await provider.getTransactionCount(FUNDER, 'pending'),
      },
      vaultEvm: {
        address: VAULT_EVM_ADDRESS,
        eth: eth(await provider.getBalance(VAULT_EVM_ADDRESS)),
        stkA: String(await erc20Balance(ethers, provider, VAULT_EVM_ADDRESS)),
        nonceLatest: await provider.getTransactionCount(VAULT_EVM_ADDRESS, 'latest'),
      },
    };
  } finally {
    provider.destroy();
  }

  const checks: Record<string, boolean> = {
    nodeVersion: version === EXPECTED_NODE_VERSION,
    mpcRoot: root === MPC_ROOT_POINT,
    singleton: singleton === SINGLETON_ADDRESS,
    outputCache: cacheUrl === OUTPUT_CACHE_URL,
    vaultEvmDerivation: vaultEvm.toLowerCase() === VAULT_EVM_ADDRESS.toLowerCase(),
    vaultEvmOnLedger: vaultLedger.vaultEvmAddress.toLowerCase() === VAULT_EVM_ADDRESS.toLowerCase(),
    vaultInitialised: vaultLedger.initialised === '1',
    vaultSepolia: vaultLedger.evmChainId === SEPOLIA_CHAIN_ID.toString(),
    responseKey: vaultLedger.mpcResponseKeyMatches,
    wStkAColour: colour === WSTKA_COLOUR,
    sepolia: sepoliaFacts.chainId === SEPOLIA_CHAIN_ID.toString(),
  };
  const ok = Object.values(checks).every(Boolean);
  evidence('g0-preflight', {
    ...out,
    mpc: { root: `0x${root}`, singleton, outputCacheUrl: cacheUrl },
    vault: { address: VAULT_ADDRESS, derivedEvmAddress: vaultEvm, ledger: vaultLedger },
    wStkA: { erc20: STKA_ERC20, colour },
    sepolia: sepoliaFacts,
    evmGas: EVM_GAS,
    checks,
    verdict: ok ? 'GO' : 'STOP',
  });
  log(`preflight: ${ok ? 'GO' : 'STOP'} ${JSON.stringify(checks)}`);
  if (!ok) throw new StopError('preflight failed');
}

async function cmdKeysVerify(): Promise<void> {
  await lib.nodeWallet();
  const ledger = await load('@midnightntwrk/ledger-v9');
  const { fingerprintDeployArtefacts } = await lib.artefacts();
  const record = JSON.parse(readFileSync(path.join(VAULT_PKG, 'deployments', 'stagenet-vault.json'), 'utf8'));

  const bundles: Json = {};
  const problems: string[] = [];
  for (const bundle of ['account', 'Erc20Vault', 'SignetSigner']) {
    const dir = path.join(MANAGED, bundle);
    const expectedVk: Record<string, string> = (await load(path.join(dir, 'contract', 'index.js'))).expectedVk ?? {};
    const keysDir = path.join(dir, 'keys');
    const files = readdirSync(keysDir).sort();
    const verifiers: Record<string, { sha256: string; matchesExpectedVk: boolean }> = {};
    for (const f of files.filter((n) => n.endsWith('.verifier'))) {
      const id = f.replace(/\.verifier$/, '');
      const digest = sha256File(path.join(keysDir, f));
      verifiers[id] = { sha256: digest, matchesExpectedVk: expectedVk[id] === digest };
      if (expectedVk[id] !== digest)
        problems.push(`${bundle}/${id}: verifier key differs from the compiled expectedVk`);
    }
    for (const id of Object.keys(expectedVk)) {
      if (verifiers[id] === undefined) problems.push(`${bundle}/${id}: no verifier key file`);
    }
    const provers: Record<string, { bytes: number; sha256: string }> = {};
    for (const f of files.filter((n) => n.endsWith('.prover'))) {
      const file = path.join(keysDir, f);
      provers[f.replace(/\.prover$/, '')] = { bytes: statSync(file).size, sha256: sha256File(file) };
    }
    bundles[bundle] = {
      contractInfoSha256: sha256File(path.join(dir, 'compiler', 'contract-info.json')),
      verifiers,
      provers,
    };
  }

  // The account: the pinned source, and every prover key the gate's calls need.
  const accountSource = sha256File(path.join(VAULT_PKG, 'managed', 'account.compact'));
  if (accountSource !== ACCOUNT_SOURCE_SHA256) problems.push(`account.compact sha256 ${accountSource}`);
  for (const id of [
    'activate_initial_device_with_evm',
    'bridge_deposit_start_with_evm',
    'bridge_deposit_complete',
    'bridge_withdraw_start_with_evm',
    'bridge_withdraw_complete',
    'bridge_withdraw_refund',
    'append_inbox_with_evm',
  ]) {
    if (bundles.account.provers[id] === undefined) problems.push(`account/${id}: no prover key`);
  }

  // The vault and the singleton: PR #4's deployment record, artefact by artefact.
  const fingerprints = fingerprintDeployArtefacts();
  const recorded = record.artefacts;
  const againstRecord: Json = {};
  for (const [name, ours, theirs] of [
    ['vault', fingerprints.vault, recorded.vault],
    ['signetSigner', fingerprints.signetSigner, recorded.signetSigner],
  ] as const) {
    const same = {
      verifierKeys: JSON.stringify(ours.verifierKeys) === JSON.stringify(theirs.verifierKeys),
      zkir: JSON.stringify(ours.zkir) === JSON.stringify(theirs.zkir),
      contractInfo: ours.contractInfoSha256 === theirs.contractInfoSha256,
      source: ours.sourceSha256 === theirs.sourceSha256,
      fingerprint: ours.fingerprint === theirs.fingerprint,
    };
    againstRecord[name] = { ours: ours.fingerprint, recorded: theirs.fingerprint, ...same };
    if (!same.verifierKeys) problems.push(`${name}: verifier keys differ from PR #4's record`);
    if (!same.fingerprint) problems.push(`${name}: artefact fingerprint differs from PR #4's record`);
  }

  // The verifier keys actually deployed on stagenet.
  const onChain: Json = {};
  for (const [name, address, bundle] of [
    ['vault', VAULT_ADDRESS, 'Erc20Vault'],
    ['singleton', SINGLETON_ADDRESS, 'SignetSigner'],
  ] as const) {
    const data = await gql(`{ contractAction(address: "${address}") { state } }`);
    const state = ledger.ContractState.deserialize(Buffer.from(data.contractAction.state, 'hex'));
    const deployed: Record<string, string> = {};
    for (const op of state.operations()) {
      const id = typeof op === 'string' ? op : hex(op as Uint8Array);
      const vk = state.operation(op)?.verifierKey;
      if (vk) deployed[id] = sha256(vk);
    }
    const ours = Object.fromEntries(
      Object.entries(bundles[bundle].verifiers).map(([k, v]: [string, any]) => [k, v.sha256]),
    );
    const equal =
      JSON.stringify(
        Object.keys(deployed)
          .sort()
          .map((k) => [k, deployed[k]]),
      ) ===
      JSON.stringify(
        Object.keys(ours)
          .sort()
          .map((k) => [k, ours[k]]),
      );
    onChain[name] = { address, deployed, equal };
    if (!equal) problems.push(`${name}: our verifier keys differ from the ones deployed at ${address}`);
  }

  const verdict = problems.length === 0 ? 'VERIFIED' : 'MISMATCH';
  evidence('g0-keys', {
    at: nowUtc(),
    source:
      'midnight-2-offers/aa-contracts image (acedward/passport ee1ffed, compactc 0.34.0, runtime 0.19.0), copied to the host',
    accountSourceSha256: accountSource,
    bundles,
    againstPr4Record: againstRecord,
    onChain,
    problems,
    verdict,
  });
  log(`keys: ${verdict}${problems.length > 0 ? `: ${problems.join('; ')}` : ''}`);
  if (problems.length > 0) throw new StopError('the key bundles do not verify');
}

async function cmdDeploy(): Promise<void> {
  const state = loadState();
  if (state.account !== undefined) {
    log(`the account is already deployed at ${state.account.address}`);
    return;
  }
  assertDustCap(state);
  const { EvmDevice } = await lib.signer();
  const { generateEncKeyPair } = await lib.inbox();
  const { CustodyAccount } = await lib.account();
  const { bridgeWaves, depositAddressFor } = await lib.bridge();
  const vault = await lib.vault();

  const device = EvmDevice.fromPrivateKey(deviceKey(true));
  await device.enrol?.();
  let encSecretHex = state.pending?.encSecretHex;
  let encPublicHex = state.pending?.encPublicHex;
  if (encSecretHex === undefined || encPublicHex === undefined) {
    const enc = generateEncKeyPair();
    encSecretHex = hex(enc.secretKey);
    encPublicHex = hex(enc.publicKey);
    state.pending = { encSecretHex, encPublicHex, deviceAddress: String(device.addressHex) };
    saveState(state);
  }
  const encKeys = { secretKey: fromHex(encSecretHex), publicKey: fromHex(encPublicHex) };
  const waves = bridgeWaves({ withSwap: true });
  log(
    `device ${String(device.addressHex)}; wave 1 ${waves.waveOne.length} ops, wave 2 ${waves.waveTwo.length} + retire`,
  );

  const ctx = await openWallet();
  try {
    const nw = await lib.nodeWallet();
    const providers = await nw.createProviders(ctx, nw.zkConfigPath);
    const dustBefore = await dustSpecks(ctx);
    const tDeploy = Date.now();
    const dormant = await CustodyAccount.deployDormant(providers, await compiledAccount(), device, encKeys, {
      vaultAddress: VAULT_ADDRESS,
      waveOneCircuits: waves.waveOne,
      waveTwoCircuits: waves.waveTwo,
      armsInWaveTwo: [],
      retireAuthority: true,
    });
    const deploySeconds = (Date.now() - tDeploy) / 1000;
    log(`deployed both waves: ${dormant.address} (${deploySeconds.toFixed(1)} s)`);
    const depositAddress = depositAddressFor(bridgeConfig(), dormant.address);
    const depositPathHex = hex(vault.depositPathBytes(vault.contractRecipient(fromHex(dormant.address))));
    state.account = {
      address: dormant.address,
      encSecretHex,
      encPublicHex,
      deviceAddress: String(device.addressHex),
      depositAddress,
      depositPathHex,
      deployedUtc: nowUtc(),
    };
    delete state.pending;
    saveState(state);

    const tActivate = Date.now();
    const activation: any = await dormant.activate(device, dormant.salt);
    const activateSeconds = (Date.now() - tActivate) / 1000;
    const activationTxId = String(activation?.public?.txId ?? activation?.txId ?? '');
    log(`activated: ${activationTxId} (${activateSeconds.toFixed(1)} s)`);
    const account = dormant.finish();

    const l: any = await account.ledgerState();
    const entry = device.entryAt(fromHex(dormant.address), l.device_epoch, 0n);
    const contractState: any = await providers.publicDataProvider.queryContractState(dormant.address);
    const authority = contractState?.maintenanceAuthority;
    const readBack = {
      booted: l.booted === true,
      deviceCount: Number(l.device_count),
      deviceEntryLive: l.devices.member(entry) === true,
      encKeyMatches: hex(l.enc_key) === encPublicHex,
      vaultAddressMatches: hex(l.vault_address.bytes) === VAULT_ADDRESS,
      authNonce: String(l.auth_nonce),
      round: String(l.round),
      inboxCount: String(l.inbox_count),
      authorityCommitteeSize: Array.isArray(authority?.committee) ? authority.committee.length : null,
      authorityThreshold: authority?.threshold === undefined ? null : Number(authority.threshold),
    };
    const pass =
      readBack.booted &&
      readBack.deviceCount === 1 &&
      readBack.deviceEntryLive &&
      readBack.encKeyMatches &&
      readBack.vaultAddressMatches &&
      readBack.authorityCommitteeSize === 0;

    // Every transaction the account has, from the indexer: the deploy, the update, the activation.
    const { enumerateContractActions } = await lib.capture();
    const actions: any[] = await enumerateContractActions(dormant.address).catch(() => []);
    const fees: Record<string, string> = {};
    const txs: Json[] = [];
    for (const a of actions) {
      const id = a.identifiers?.[0];
      const info = id === undefined ? { hash: a.txHash } : await txInfoEventually(id);
      txs.push({ kind: a.kind, entryPoint: a.entryPoint, ...info });
      if (info.feeSpecks !== undefined)
        fees[`${a.kind}:${a.entryPoint ?? ''}:${String(info.hash)}`] = String(info.feeSpecks);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const dustAfter = await dustSpecks(ctx);
    recordDust(state, 'deploy+activate', dustBefore, dustAfter, fees);
    evidence('g1-account', {
      step: 'G-BRIDGE.1 deploy + activate',
      network: 'stagenet',
      account: dormant.address,
      device: String(device.addressHex),
      encPublicKey: encPublicHex,
      boundVault: VAULT_ADDRESS,
      shape: "contractForBridgeAccount(['evm'], { withSwap: true }) / bridgeWaves({ withSwap: true })",
      waveOne: waves.waveOne,
      waveTwo: waves.waveTwo,
      authorityRetired: readBack.authorityCommitteeSize === 0,
      deploySeconds,
      activateSeconds,
      activationTxId,
      transactions: txs,
      readBack,
      depositAddress,
      depositPath: depositPathHex,
      depositAddressDerivation: 'deriveEvmAddress(MPC root, vault, hex(depositPath(right(account))))',
      dust: { beforeSpecks: dustBefore, afterSpecks: dustAfter, feesPaidSpecks: fees },
      verdict: pass ? 'PASS' : 'FAIL',
    });
    log(`account ${dormant.address}: ${pass ? 'PASS' : 'FAIL'}; deposit address ${depositAddress}`);
    if (!pass) throw new StopError(`the account read-back failed: ${JSON.stringify(readBack)}`);
  } finally {
    await closeWallet(ctx);
  }
}

async function cmdFund(): Promise<void> {
  const state = loadState();
  if (state.account === undefined) throw new Error('run deploy first');
  const to = state.account.depositAddress;
  const { ethers, provider } = await sepolia();
  try {
    const funder = await sepoliaFunder(ethers, provider);
    const before = { eth: await provider.getBalance(to), stkA: await erc20Balance(ethers, provider, to) };
    const funderBefore = { eth: await provider.getBalance(FUNDER), stkA: await erc20Balance(ethers, provider, FUNDER) };
    const txs: SepoliaTx[] = [];
    if (before.stkA < AMOUNT) {
      const token = new ethers.Contract(STKA_ERC20, ERC20_ABI, funder);
      txs.push(
        await funderSend(
          state,
          'stkA -> deposit address',
          () => token.transfer(to, AMOUNT - before.stkA),
          0n,
          provider,
        ),
      );
    } else log(`${to} already holds ${String(before.stkA)} stkA`);
    if (before.eth < SWEEP_GAS_WEI) {
      const top = SWEEP_GAS_WEI - before.eth;
      txs.push(
        await funderSend(
          state,
          'sweep gas -> deposit address',
          () => funder.sendTransaction({ to, value: top }),
          top,
          provider,
        ),
      );
    } else log(`${to} already holds ${eth(before.eth)} ETH`);
    const after = { eth: await provider.getBalance(to), stkA: await erc20Balance(ethers, provider, to) };
    const { depositPreflight } = await lib.preflight();
    const pre = depositPreflight({
      erc20Balance: after.stkA,
      amount: AMOUNT,
      ethBalance: after.eth,
      gasLimit: EVM_GAS.gasLimit,
      maxFeePerGas: EVM_GAS.maxFeePerGas,
      decimals: 6,
    });
    evidence('g1-fund', {
      step: 'G-BRIDGE.1 fund the deposit address (Sepolia)',
      depositAddress: to,
      amountStkA: AMOUNT,
      sweepGas: { ...EVM_GAS, maxCostWei: SWEEP_GAS_WEI },
      transactions: txs.map((t) => ({ ...t, explorer: `https://sepolia.etherscan.io/tx/${t.hash}` })),
      depositAddressBefore: { wei: before.eth, stkA: before.stkA },
      depositAddressAfter: { wei: after.eth, stkA: after.stkA },
      funderBefore: { wei: funderBefore.eth, stkA: funderBefore.stkA },
      vaultV030Preflight: { ok: pre.ok, problems: pre.problems, maxGasCostWei: pre.maxGasCostWei },
      sepoliaSpentSoFarWei: sepoliaSpentWei(state),
    });
    if (!pre.ok) throw new StopError(`the vault's deposit preflight refuses: ${pre.problems.join('; ')}`);
  } finally {
    provider.destroy();
  }
}

async function cmdDepositStart(): Promise<void> {
  const state = loadState();
  if (state.account === undefined) throw new Error('run deploy first');
  if (state.deposit?.requestId !== undefined) {
    log(`a deposit request is already open: ${state.deposit.requestId}; relay or complete it`);
    return;
  }
  assertDustCap(state);
  const depositAddress = state.account.depositAddress;
  const { ethers, provider } = await sepolia();
  let evmNonce: bigint;
  const erc20Before: Record<string, string> = {};
  try {
    const { depositPreflight } = await lib.preflight();
    const pre = depositPreflight({
      erc20Balance: await erc20Balance(ethers, provider, depositAddress),
      amount: AMOUNT,
      ethBalance: await provider.getBalance(depositAddress),
      gasLimit: EVM_GAS.gasLimit,
      maxFeePerGas: EVM_GAS.maxFeePerGas,
      decimals: 6,
    });
    if (!pre.ok) throw new StopError(`the vault's deposit preflight refuses: ${pre.problems.join('; ')}`);
    evmNonce = BigInt(await provider.getTransactionCount(depositAddress, 'pending'));
    erc20Before.vaultEvm = String(await erc20Balance(ethers, provider, VAULT_EVM_ADDRESS));
    erc20Before.depositAddress = String(await erc20Balance(ethers, provider, depositAddress));
  } finally {
    provider.destroy();
  }
  log(`preflight ok: ${depositAddress} nonce ${evmNonce}`);

  const ctx = await openWallet();
  try {
    const nw = await lib.nodeWallet();
    const providers = await nw.createProviders(ctx, nw.zkConfigPath);
    const { bridge, device } = await connectAccount(state, providers);
    const dustBefore = await dustSpecks(ctx);
    const before = await openRequests(bridge, 'deposit');
    const tStart = Date.now();
    const start = await bridge.startDeposit(device, AMOUNT, { ...EVM_GAS, nonce: evmNonce });
    const startSeconds = (Date.now() - tStart) / 1000;
    const after = await openRequests(bridge, 'deposit');
    const match = matchNewRequest({
      before: before.ids,
      after: after.ids,
      pathOf: after.pathOf,
      expectedPathHex: state.account.depositPathHex,
    });
    const info = await txInfoEventually(start.txId);
    state.deposit = {
      requestId: match.requestId,
      startTxId: start.txId,
      startedAtMs: info.blockMs ?? Date.now(),
      evmNonce: evmNonce.toString(),
      erc20Before,
      relayProgress: [],
    };
    saveState(state);
    log(`deposit request ${match.requestId} (start ${start.txId}, ${startSeconds.toFixed(1)} s)`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const dustAfter = await dustSpecks(ctx);
    recordDust(state, 'deposit-start', dustBefore, dustAfter, {
      [`bridge_deposit_start_with_evm:${String(info.hash)}`]: String(info.feeSpecks),
    });
    evidence('g1-deposit', {
      step: 'G-BRIDGE.1 bridge_deposit_start_with_evm',
      shape: 'account -> vault.startDeposit -> SignetSigner.signBidirectional (one transaction, three contract calls)',
      account: state.account.address,
      depositAddress,
      amountStkA: AMOUNT,
      evmNonce,
      evmGas: EVM_GAS,
      requestId: match.requestId,
      requestIdMatch: {
        rule: 'new between the reads before and after the start, and the stored path is depositPath(right(account))',
        freshIds: match.freshIds,
        storedPath: after.pathOf(match.requestId),
        clientNewestOpenId: normaliseHex(String(start.requestId)),
        clientNewestOpenIdAgrees: normaliseHex(String(start.requestId)) === match.requestId,
      },
      startTx: { ...info, seconds: startSeconds },
      erc20Before,
      explorer: EXPLORER,
      stopRule: 'the MPC must sign within 20 minutes of this transaction',
    });
  } finally {
    await closeWallet(ctx);
  }
}

async function relay(kind: BridgeKind): Promise<void> {
  const state = loadState();
  const rec = kind === 'deposit' ? state.deposit : state.withdraw;
  if (rec?.requestId === undefined || state.account === undefined) throw new Error(`no open ${kind} request`);
  if (rec.relay !== undefined) {
    log(`the ${kind} relay already finished: ${String((rec.relay as any)?.kind)}`);
    return;
  }
  await lib.nodeWallet();
  const { relayRequest } = await lib.relayer();
  const { indexerPublicDataProvider } = await load('@midnight-ntwrk/midnight-js-indexer-public-data-provider');
  const expectedSigner = kind === 'deposit' ? state.account.depositAddress : VAULT_EVM_ADDRESS;
  const signed = (rec.relayProgress ?? []).some((p) => p.stage === 'signed');
  const signatureTimeoutMs = signed
    ? 20 * 60_000
    : remainingSignatureBudgetMs(rec.startedAtMs ?? Date.now(), Date.now());
  const evidenceName = kind === 'deposit' ? 'g1-deposit' : 'g2-withdraw';
  log(
    `relay ${kind} ${rec.requestId}: the MPC must sign as ${expectedSigner}; ${Math.round(signatureTimeoutMs / 1000)} s left`,
  );
  const options = relayOptionsFor({
    kind,
    requestId: rec.requestId,
    expectedSigner,
    vault: await vaultRelayConstants(),
    endpoints: {
      indexerUrl: INDEXER_URL,
      evmRpcUrl: SEPOLIA_RPC,
      outputCache: { networkId: 'stagenet', cacheUrl: OUTPUT_CACHE_URL },
    },
    publicDataProvider: indexerPublicDataProvider(INDEXER_URL, INDEXER_WS_URL),
    signatureTimeoutMs,
    onProgress: (p: any) => {
      const sinceStartS = rec.startedAtMs === undefined ? undefined : Math.round((Date.now() - rec.startedAtMs) / 1000);
      rec.relayProgress = [...(rec.relayProgress ?? []), { ...p, atUtc: nowUtc(), sinceStartS }];
      saveState(state);
      evidence(evidenceName, { relayProgress: rec.relayProgress });
    },
    log: (line: string) => log(line.trim()),
  });
  try {
    const result: any = await relayRequest(options);
    rec.relay = toResumableJson(result);
    saveState(state);
    const summary = {
      kind: result.kind,
      outputOrigin: result.outputOrigin,
      evmTxHash: result.evmTxHash,
      evmBlock: result.evmBlock,
      evmStatus: result.evmStatus,
      signedTxHash: result.signedTxHash,
      signedTxSender: result.signedTxSender,
      signedTxNonce: result.signedTxNonce,
      signatureAfterS: Math.round(result.signatureAfterMs / 1000),
      attestationAfterS: Math.round(result.attestationAfterMs / 1000),
      finalizedBlockSeen: result.finalizedBlockSeen,
      evmExplorer:
        result.evmTxHash === undefined ? undefined : `https://sepolia.etherscan.io/tx/${String(result.evmTxHash)}`,
    };
    evidence(evidenceName, { relayResult: summary });
    log(`relay ${kind}: attested ${String(result.kind)}; evm tx ${String(result.evmTxHash ?? '(not broadcast)')}`);
  } catch (error) {
    if (isSignatureTimeout(error)) {
      const sinceStartS = rec.startedAtMs === undefined ? undefined : Math.round((Date.now() - rec.startedAtMs) / 1000);
      evidence(evidenceName, {
        stopRule: {
          triggered: true,
          reason: `no MPC signature within 20 minutes of the start (${String(sinceStartS)} s)`,
          requestId: rec.requestId,
          startTxId: rec.startTxId,
          explorer: EXPLORER,
          atUtc: nowUtc(),
        },
      });
      throw new StopError(`STOP RULE: the MPC did not sign ${rec.requestId} within 20 minutes of the start`);
    }
    throw error;
  }
}

/** The coin a settle claimed: its position in the commitment tree, from the settle's window. */
async function claimedPosition(txId: string): Promise<{ mtIndex: bigint; window: [number, number] }> {
  const info = await txInfoEventually(txId);
  const start = Number(info.zswapStartIndex);
  const end = Number(info.zswapEndIndex);
  if (end - start !== 1) {
    throw new StopError(
      `the settle ${txId} created ${end - start} commitments, expected exactly 1: resolve the index first`,
    );
  }
  return { mtIndex: BigInt(start), window: [start, end] };
}

async function cmdDepositComplete(): Promise<void> {
  const state = loadState();
  const rec = state.deposit;
  if (rec?.requestId === undefined || state.account === undefined) throw new Error('no open deposit request');
  if (rec.settleTxId !== undefined) {
    log(`the deposit already settled: ${rec.settleTxId}`);
    return;
  }
  if (rec.relay === undefined) await relay('deposit');
  const fresh = loadState();
  const relayResult: any = fromResumableJson(fresh.deposit!.relay);
  assertDustCap(fresh);

  const ctx = await openWallet();
  try {
    const nw = await lib.nodeWallet();
    const providers = await nw.createProviders(ctx, nw.zkConfigPath);
    const { account, bridge } = await connectAccount(fresh, providers);
    const { randomNonce } = await lib.bridge();
    const { withCoin, emptyCoinStore } = await lib.witnesses();
    const { inboxWalk } = await lib.discovery();
    const dustBefore = await dustSpecks(ctx);
    const planned = await bridge.plannedCoin('deposit', rec.requestId, randomNonce());
    const tSettle = Date.now();
    const settle = await bridge.completeDeposit(rec.requestId, relayResult, planned);
    const settleSeconds = (Date.now() - tSettle) / 1000;
    const info = await txInfoEventually(settle.txId);
    fresh.deposit!.settleTxId = settle.txId;
    saveState(fresh);
    log(
      `bridge_deposit_complete ${settle.txId} (${settleSeconds.toFixed(1)} s); claimed ${String(settle.coin?.value)}`,
    );

    let coinRecord: Json | null = null;
    if (settle.coin !== null) {
      const position = await claimedPosition(settle.txId);
      const coin = {
        nonce: settle.coin.nonce,
        color: settle.coin.color,
        value: BigInt(settle.coin.value),
        mtIndex: position.mtIndex,
      };
      await account.putCoin(coin);
      fresh.coinStore = withCoin(fresh.coinStore ?? emptyCoinStore(fromHex(state.account.encSecretHex)), coin);
      saveState(fresh);
      coinRecord = { colour: hex(coin.color), value: coin.value, mtIndex: position.mtIndex, window: position.window };
    }

    const l: any = await account.ledgerState();
    const walk: any[] = inboxWalk(l, fromHex(state.account.encSecretHex));
    const found = walk.find((c) => hex(c.color) === WSTKA_COLOUR && BigInt(c.value) === AMOUNT);

    const { ethers, provider } = await sepolia();
    let sepoliaAfter: Json;
    try {
      sepoliaAfter = {
        vaultEvmStkA: String(await erc20Balance(ethers, provider, VAULT_EVM_ADDRESS)),
        depositAddressStkA: String(await erc20Balance(ethers, provider, state.account.depositAddress)),
        depositAddressWei: String(await provider.getBalance(state.account.depositAddress)),
      };
    } finally {
      provider.destroy();
    }
    const vaultDelta = BigInt(sepoliaAfter.vaultEvmStkA) - BigInt(rec.erc20Before?.vaultEvm ?? '0');
    const checks = {
      attestedSuccess: relayResult.kind === 'success',
      claimedACoin: settle.coin !== null,
      entryMatchesCoin: settle.entryMatchesCoin === true,
      claimedIsOneWStkA:
        coinRecord !== null && coinRecord.colour === WSTKA_COLOUR && BigInt(coinRecord.value) === AMOUNT,
      inboxEntryDecrypts: found !== undefined,
      vaultEvmGainedExactlyOne: vaultDelta === AMOUNT,
      depositAddressEmptied: sepoliaAfter.depositAddressStkA === '0',
    };
    const pass = Object.values(checks).every(Boolean);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const dustAfter = await dustSpecks(ctx);
    recordDust(fresh, 'deposit-complete', dustBefore, dustAfter, {
      [`bridge_deposit_complete:${String(info.hash)}`]: String(info.feeSpecks),
    });
    evidence('g1-deposit', {
      completeTx: { ...info, seconds: settleSeconds },
      claimedCoin: coinRecord,
      inboxWalk: {
        inboxCount: String(l.inbox_count),
        entries: walk.map((c) => ({ inboxIndex: c.inboxIndex, colour: hex(c.color), value: c.value })),
        wStkAEntryDecrypts: found !== undefined,
      },
      sepoliaAfter,
      vaultEvmStkADelta: vaultDelta,
      checks,
      verdict: pass ? 'PASS' : 'FAIL',
    });
    log(`deposit round trip: ${pass ? 'PASS' : 'FAIL'} ${JSON.stringify(checks)}`);
    if (!pass) throw new StopError('the deposit round trip did not verify');
  } finally {
    await closeWallet(ctx);
  }
}

async function cmdWithdrawGas(): Promise<void> {
  const state = loadState();
  const { ethers, provider } = await sepolia();
  try {
    const held = await provider.getBalance(VAULT_EVM_ADDRESS);
    const out: Json = { vaultEvm: VAULT_EVM_ADDRESS, heldWei: held, neededWei: SWEEP_GAS_WEI };
    if (held >= SWEEP_GAS_WEI) {
      log(`the vault's EVM account holds ${eth(held)} ETH: enough for gasLimit x maxFeePerGas ${eth(SWEEP_GAS_WEI)}`);
      evidence('g2-withdraw', { gas: { ...out, topUp: null } });
      return;
    }
    const funder = await sepoliaFunder(ethers, provider);
    const target = BigInt(arg('wei') ?? String(SWEEP_GAS_WEI + SWEEP_GAS_WEI / 2n));
    const tx = await funderSend(
      state,
      'withdraw gas -> vault EVM account',
      () => funder.sendTransaction({ to: VAULT_EVM_ADDRESS, value: target - held }),
      target - held,
      provider,
    );
    evidence('g2-withdraw', {
      gas: { ...out, topUp: { ...tx, explorer: `https://sepolia.etherscan.io/tx/${tx.hash}` } },
    });
  } finally {
    provider.destroy();
  }
}

async function cmdWithdrawStart(): Promise<void> {
  const state = loadState();
  if (state.account === undefined) throw new Error('run deploy first');
  if (state.deposit?.settleTxId === undefined) throw new Error('the deposit has not settled');
  if (state.withdraw?.requestId !== undefined) {
    log(`a withdrawal request is already open: ${state.withdraw.requestId}`);
    return;
  }
  assertDustCap(state);
  const held = state.coinStore?.coins?.[WSTKA_COLOUR];
  if (held === undefined || BigInt(held.value) < AMOUNT)
    throw new Error('the account holds no wStkA coin of 1 or more');
  const dest = FUNDER;
  const { ethers, provider } = await sepolia();
  let evmNonce: bigint;
  const erc20Before: Record<string, string> = {};
  try {
    const gas = await provider.getBalance(VAULT_EVM_ADDRESS);
    if (gas < SWEEP_GAS_WEI)
      throw new StopError(`the vault's EVM account holds ${eth(gas)} ETH: run withdraw-gas first`);
    const vaultStkA = await erc20Balance(ethers, provider, VAULT_EVM_ADDRESS);
    if (vaultStkA < AMOUNT) throw new StopError(`the vault's EVM account holds only ${String(vaultStkA)} stkA`);
    evmNonce = BigInt(await provider.getTransactionCount(VAULT_EVM_ADDRESS, 'pending'));
    erc20Before.vaultEvm = String(vaultStkA);
    erc20Before.destination = String(await erc20Balance(ethers, provider, dest));
  } finally {
    provider.destroy();
  }

  const ctx = await openWallet();
  try {
    const nw = await lib.nodeWallet();
    const providers = await nw.createProviders(ctx, nw.zkConfigPath);
    const { account, bridge, device } = await connectAccount(state, providers);
    const vault = await lib.vault();
    const { withoutCoin } = await lib.witnesses();
    const before = await openRequests(bridge, 'withdraw');
    if (before.ids.length > 0) {
      throw new StopError(
        `the vault already has ${before.ids.length} open withdrawal(s): they share its EVM nonce, wait`,
      );
    }
    const dustBefore = await dustSpecks(ctx);
    const tStart = Date.now();
    const start = await bridge.startWithdraw(device, dest, AMOUNT, { ...EVM_GAS, nonce: evmNonce });
    const startSeconds = (Date.now() - tStart) / 1000;
    const after = await openRequests(bridge, 'withdraw');
    const match = matchNewRequest({
      before: before.ids,
      after: after.ids,
      pathOf: after.pathOf,
      expectedPathHex: hex(vault.vaultPathBytes()),
    });
    const info = await txInfoEventually(start.txId);
    await account.dropCoin(fromHex(WSTKA_COLOUR));
    state.coinStore = withoutCoin(state.coinStore, fromHex(WSTKA_COLOUR));
    const change =
      start.change === null ? null : { colour: hex(start.change.color), value: BigInt(start.change.value) };
    state.withdraw = {
      requestId: match.requestId,
      startTxId: start.txId,
      startedAtMs: info.blockMs ?? Date.now(),
      evmNonce: evmNonce.toString(),
      erc20Before,
      relayProgress: [],
      destination: dest,
      change: change === null ? null : { colour: change.colour, value: change.value.toString() },
    };
    saveState(state);
    log(
      `withdraw request ${match.requestId} (start ${start.txId}, ${startSeconds.toFixed(1)} s); change ${String(change?.value ?? 'none')}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const dustAfter = await dustSpecks(ctx);
    recordDust(state, 'withdraw-start', dustBefore, dustAfter, {
      [`bridge_withdraw_start_with_evm:${String(info.hash)}`]: String(info.feeSpecks),
    });
    evidence('g2-withdraw', {
      step: 'G-BRIDGE.2 bridge_withdraw_start_with_evm',
      shape:
        'account.sendShielded -> vault.startWithdraw (claims that coin) -> SignetSigner.signBidirectional (one transaction)',
      account: state.account.address,
      destination: dest,
      amountWStkA: AMOUNT,
      evmNonce,
      evmGas: EVM_GAS,
      requestId: match.requestId,
      requestIdMatch: {
        rule: "new between the reads before and after the start, and the stored path is the vault's own path",
        freshIds: match.freshIds,
        storedPath: after.pathOf(match.requestId),
        clientNewestOpenId: normaliseHex(String(start.requestId)),
        clientNewestOpenIdAgrees: normaliseHex(String(start.requestId)) === match.requestId,
      },
      startTx: { ...info, seconds: startSeconds },
      changeCoin: change,
      changeNote:
        change === null
          ? 'the whole 1 wStkA coin was spent: no change coin, so no zero-byte inbox entry to re-file (Q13 does not apply)'
          : 'change left with a zero-byte inbox entry: re-file it with append_inbox_with_evm (Q13 default A)',
      erc20Before,
      explorer: EXPLORER,
    });
  } finally {
    await closeWallet(ctx);
  }
}

async function cmdWithdrawComplete(): Promise<void> {
  const state = loadState();
  const rec = state.withdraw;
  if (rec?.requestId === undefined || state.account === undefined) throw new Error('no open withdrawal');
  if (rec.settleTxId !== undefined) {
    log(`the withdrawal already settled: ${rec.settleTxId}`);
    return;
  }
  if (rec.relay === undefined) await relay('withdraw');
  const fresh = loadState();
  const relayResult: any = fromResumableJson(fresh.withdraw!.relay);
  assertDustCap(fresh);

  const ctx = await openWallet();
  try {
    const nw = await lib.nodeWallet();
    const providers = await nw.createProviders(ctx, nw.zkConfigPath);
    const { account, bridge } = await connectAccount(fresh, providers);
    const { randomNonce } = await lib.bridge();
    const { inboxWalk } = await lib.discovery();
    const dustBefore = await dustSpecks(ctx);
    const never = relayResult.kind === 'never-executed';
    const tSettle = Date.now();
    const settle = never
      ? await bridge.refundWithdraw(
          rec.requestId,
          relayResult,
          await bridge.plannedCoin('withdraw', rec.requestId, randomNonce()),
        )
      : await bridge.completeWithdraw(
          rec.requestId,
          relayResult,
          await bridge.plannedCoin('withdraw', rec.requestId, randomNonce()),
        );
    const settleSeconds = (Date.now() - tSettle) / 1000;
    const info = await txInfoEventually(settle.txId);
    fresh.withdraw!.settleTxId = settle.txId;
    saveState(fresh);
    log(
      `${never ? 'bridge_withdraw_refund' : 'bridge_withdraw_complete'} ${settle.txId} (${settleSeconds.toFixed(1)} s)`,
    );

    const { ethers, provider } = await sepolia();
    let sepoliaAfter: Json;
    try {
      sepoliaAfter = {
        destinationStkA: String(await erc20Balance(ethers, provider, String(rec.destination))),
        vaultEvmStkA: String(await erc20Balance(ethers, provider, VAULT_EVM_ADDRESS)),
        vaultEvmWei: String(await provider.getBalance(VAULT_EVM_ADDRESS)),
      };
    } finally {
      provider.destroy();
    }
    const destDelta = BigInt(sepoliaAfter.destinationStkA) - BigInt(rec.erc20Before?.destination ?? '0');
    const vaultDelta = BigInt(sepoliaAfter.vaultEvmStkA) - BigInt(rec.erc20Before?.vaultEvm ?? '0');
    const l: any = await account.ledgerState();
    const walk: any[] = inboxWalk(l, fromHex(state.account.encSecretHex));
    const checks = {
      attestedSuccess: relayResult.kind === 'success',
      mintedNothingBack: settle.coin === null,
      destinationGainedExactlyOne: destDelta === AMOUNT,
      vaultEvmLostExactlyOne: vaultDelta === -AMOUNT,
      localCoinStoreHasNoWStkA: fresh.coinStore?.coins?.[WSTKA_COLOUR] === undefined,
    };
    const pass = Object.values(checks).every(Boolean);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const dustAfter = await dustSpecks(ctx);
    recordDust(fresh, 'withdraw-complete', dustBefore, dustAfter, {
      [`${never ? 'bridge_withdraw_refund' : 'bridge_withdraw_complete'}:${String(info.hash)}`]: String(info.feeSpecks),
    });
    evidence('g2-withdraw', {
      completeTx: {
        ...info,
        seconds: settleSeconds,
        circuit: never ? 'bridge_withdraw_refund' : 'bridge_withdraw_complete',
      },
      refundedCoin: settle.coin === null ? null : { colour: hex(settle.coin.color), value: settle.coin.value },
      sepoliaAfter,
      destinationStkADelta: destDelta,
      vaultEvmStkADelta: vaultDelta,
      inboxWalk: {
        inboxCount: String(l.inbox_count),
        entries: walk.map((c) => ({ inboxIndex: c.inboxIndex, colour: hex(c.color), value: c.value })),
        note: 'the inbox is append-only: the deposit entry stays; the coin it describes was spent by the withdrawal start',
      },
      checks,
      verdict: pass ? 'PASS' : 'FAIL',
    });
    log(`withdrawal: ${pass ? 'PASS' : 'FAIL'} ${JSON.stringify(checks)}`);
    if (!pass) throw new StopError('the withdrawal did not verify');
  } finally {
    await closeWallet(ctx);
  }
}

async function cmdStatus(): Promise<void> {
  const state = loadState();
  const out: Json = {
    at: nowUtc(),
    account:
      state.account === undefined
        ? null
        : { address: state.account.address, depositAddress: state.account.depositAddress },
    deposit:
      state.deposit === undefined
        ? null
        : {
            requestId: state.deposit.requestId,
            settled: state.deposit.settleTxId !== undefined,
            stages: (state.deposit.relayProgress ?? []).map((p) => p.stage),
          },
    withdraw:
      state.withdraw === undefined
        ? null
        : {
            requestId: state.withdraw.requestId,
            settled: state.withdraw.settleTxId !== undefined,
            stages: (state.withdraw.relayProgress ?? []).map((p) => p.stage),
          },
    sepoliaSpentEth: eth(sepoliaSpentWei(state)),
    sepoliaTxs: state.sepoliaTxs ?? [],
    dustPaid: dust(dustPaidSpecks(state)),
    dustLog: state.dustLog ?? [],
  };
  log(publicJson(out));
}

// ---- main -------------------------------------------------------------------------------------------------

const COMMANDS: Record<string, () => Promise<void>> = {
  preflight: cmdPreflight,
  'keys-verify': cmdKeysVerify,
  deploy: cmdDeploy,
  fund: cmdFund,
  'deposit-start': cmdDepositStart,
  'relay-deposit': () => relay('deposit'),
  'deposit-complete': cmdDepositComplete,
  'withdraw-gas': cmdWithdrawGas,
  'withdraw-start': cmdWithdrawStart,
  'relay-withdraw': () => relay('withdraw'),
  'withdraw-complete': cmdWithdrawComplete,
  status: cmdStatus,
};

const command = process.argv[2] ?? '';
const run = COMMANDS[command];
if (run === undefined) {
  console.error(`usage: gate.ts <${Object.keys(COMMANDS).join('|')}>`);
  process.exit(2);
}
run().then(
  () => {
    log(`${command}: done in ${Math.round((Date.now() - t0) / 1000)} s`);
    setTimeout(() => process.exit(0), 500).unref();
  },
  (error: unknown) => {
    const stop = error instanceof StopError;
    console.error(`\n${command}: ${stop ? 'STOPPED' : 'FAILED'}: ${String((error as Error)?.stack ?? error)}`);
    setTimeout(() => process.exit(stop ? 3 : 1), 500).unref();
  },
);
