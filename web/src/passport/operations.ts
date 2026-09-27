// The account operations, as the browser runs them (plan L-ACC): open an account, rebuild its
// coins from chain data, and the two gated calls of this lane (a withdrawal, and re-filing its
// change in the inbox, Q13). Each asks the wallet for exactly ONE signature.
//
// The browser is the source of truth (Q5): the encryption secret is generated and kept here,
// the inbox is decrypted here, every coin is kept here, and the relay receives only public keys,
// signatures and, for a spend, the one coin that spend consumes (research finding 2).

import {
  RELAY_ACTIONS,
  buildRelayActionMessage,
  bytesToHex,
  chooseCoin,
  hexToBytes,
  localCoin,
  parseShieldedAddress,
  reconcileCoins,
  relayActionTypedData,
  type AccountStateView,
  type AppendInboxPayload,
  type JobView,
  type RegisterResult,
  type StoredCoin,
  type WithdrawPayload,
  type WithdrawResult,
} from '@mnbank/core';
import {
  appendInboxRequest,
  findEvmUseCounter,
  gatedCall,
  generateEncKeyPairPortable,
  openEntryPortable,
  sealEntryPortable,
  withdrawRequest,
} from '@mnbank/core/passport';

import type { RelayClient } from '../relay/client.js';
import { recordKey, type WalletScope } from '../store/schema.js';
import type { LocalStore } from '../store/store.js';
import type { Eip1193Provider } from '../wallet/eip1193.js';
import {
  readCoins,
  readRoster,
  readSecret,
  type AccountRecord,
  type JobAction,
  type JobRecord,
  type SecretRecord,
} from './records.js';

export class OperationError extends Error {
  override name = 'OperationError';
}

export interface OperationEnv {
  relay: RelayClient;
  store: LocalStore;
  /** This wallet on this network. */
  scope: WalletScope;
  provider: Eip1193Provider;
  /** The connected EOA (checksummed or lowercase). */
  owner: string;
  chainId: number;
  /** Where the job's progress goes (stages, queue position). */
  onJob?: (job: JobView) => void;
}

const lower = (s: string) => s.toLowerCase();

export async function signTypedData(env: OperationEnv, typedData: unknown): Promise<string> {
  const sig = await env.provider.request({
    method: 'eth_signTypedData_v4',
    params: [
      lower(env.owner),
      JSON.stringify(typedData, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString(10) : v)),
    ],
  });
  if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(sig))
    throw new OperationError('The wallet returned no signature.');
  return sig;
}

function putJob(
  env: OperationEnv,
  account: string | null,
  job: JobView,
  action: JobAction,
  context?: Record<string, unknown>,
) {
  const rec: JobRecord = {
    requestId: job.requestId,
    action,
    startedAt: Date.now(),
    state: job.state,
    stage: job.stage,
    ...(context ? { context } : {}),
  };
  env.store.put(env.scope, 'job', rec, { account, id: job.requestId });
}

function updateJob(env: OperationEnv, account: string | null, job: JobView) {
  const key = recordKey(env.scope, 'job', { account, id: job.requestId });
  const prev = env.store.get<JobRecord>(key)?.data;
  if (prev)
    env.store.put(env.scope, 'job', { ...prev, state: job.state, stage: job.stage }, { account, id: job.requestId });
  env.onJob?.(job);
}

const dropJob = (env: OperationEnv, account: string | null, requestId: string) =>
  env.store.remove(recordKey(env.scope, 'job', { account, id: requestId }));

// ── Open an account (L-ACC.1) ─────────────────────────────────────────────────────

/**
 * Register: generate the encryption key pair here (the secret is stored BEFORE anything leaves
 * the page), ask the wallet for ONE signature (the RelayAction, which is also the enrolment: the
 * relay recovers the device's public key from it), and wait while the relay deploys both waves,
 * seals the vault, retires the authority and activates. Resumes a registration in flight.
 */
export async function openAccount(env: OperationEnv, vault: string): Promise<AccountRecord> {
  const { relay, store, scope } = env;
  let secret = readSecret(store, scope, null);
  const inFlight = findJobs(env, null, 'register')[0];
  let requestId = inFlight?.requestId;

  if (!requestId) {
    if (!secret) {
      const kp = generateEncKeyPairPortable();
      secret = { encSecretKey: bytesToHex(kp.secretKey), encPublicKey: bytesToHex(kp.publicKey), pending: true };
      store.put(scope, 'secret', secret, { account: null });
    }
    const payload = { encPublicKey: secret.encPublicKey };
    const { nonce, maxTtlSeconds } = await relay.nonce();
    const message = buildRelayActionMessage({
      action: 'register',
      network: scope.network,
      owner: env.owner,
      payload,
      nonce,
      expiry: Math.floor(Date.now() / 1000) + Math.min(maxTtlSeconds, 300),
    });
    const signature = await signTypedData(env, relayActionTypedData(message, env.chainId));
    const job = await relay.submit('register', { payload, auth: { message, signature } });
    putJob(env, null, job, 'register');
    env.onJob?.(job);
    requestId = job.requestId;
  }
  if (!secret) throw new OperationError('The registration in progress has lost its key in this browser.');

  const done = await relay.waitForJob(requestId, (j) => updateJob(env, null, j));
  dropJob(env, null, requestId);
  if (done.state !== 'succeeded' || !done.result) {
    throw new OperationError(done.error?.message ?? 'The account could not be opened.');
  }
  const r = done.result as unknown as RegisterResult;
  const account = r.account.toLowerCase();
  const record: AccountRecord = {
    address: account,
    device: r.device,
    network: scope.network,
    vault,
    createdAt: Date.now(),
    txs: r.txs,
  };
  const finalSecret: SecretRecord = { encSecretKey: secret.encSecretKey, encPublicKey: secret.encPublicKey };
  store.put(scope, 'secret', finalSecret, { account });
  store.put(scope, 'account', record, { account });
  store.put(scope, 'roster', { useCounter: '0' }, { account });
  store.put(scope, 'coins', [], { account });
  store.remove(recordKey(scope, 'secret', { account: null }));
  return record;
}

export function findJobs(env: Pick<OperationEnv, 'store' | 'scope'>, account: string | null, action?: JobAction) {
  const out: JobRecord[] = [];
  for (const r of env.store.list(env.scope)) {
    if (r.parsed.kind !== 'job' || r.parsed.scope.global || !r.record) continue;
    if (r.parsed.scope.account !== account) continue;
    const j = r.record.data as JobRecord;
    if (!action || j.action === action) out.push(j);
  }
  return out;
}

// ── Rebuild the coins from chain data (L-ACC.2, L-ACC.4) ────────────────────────────

export interface SyncResult {
  state: AccountStateView;
  coins: StoredCoin[];
  /** Inbox entries that did not open with this browser's secret (not ours, or poisoned). */
  unreadable: number;
}

/**
 * The inbox walk: read every entry (the relay serves the ciphertexts), decrypt HERE with the
 * account's secret, then reconcile with the ledger's own record of the account's leaves (the
 * exact `mt_index` of each coin) and spends (nullifiers). Coins that only this browser knows
 * (a withdrawal's change not yet filed, Q13) are kept.
 */
export async function syncAccount(env: OperationEnv, account: string): Promise<SyncResult> {
  const { relay, store, scope } = env;
  const secret = readSecret(store, scope, account);
  if (!secret)
    throw new OperationError('This browser does not hold the account secret. Import your export to use it here.');
  const state = await relay.accountState(account);
  if (!state) throw new OperationError('The bank cannot find this account on the network.');
  const sk = hexToBytes(secret.encSecretKey, 32);
  const inbox: Array<{ nonce: string; color: string; value: string; inboxIndex: string }> = [];
  let unreadable = 0;
  const total = Number(state.inboxCount);
  for (let from = 0; from < total; from += 500) {
    const page = await relay.inbox(account, from, 500);
    for (const [i, entry] of page.entries.entries()) {
      if (!entry) continue;
      const coin = await openEntryPortable(sk, hexToBytes(entry, 192));
      if (!coin) {
        unreadable++;
        continue;
      }
      inbox.push({
        nonce: bytesToHex(coin.nonce),
        color: bytesToHex(coin.color),
        value: coin.value.toString(10),
        inboxIndex: String(from + i),
      });
    }
  }
  const activity = await relay.zswap(account);
  const coins = reconcileCoins({
    account,
    inbox,
    outputs: activity.outputs,
    inputs: activity.inputs,
    previous: readCoins(store, scope, account),
  });
  store.put(scope, 'coins', coins, { account });
  return { state, coins, unreadable };
}

// ── The two gated calls of this lane (L-ACC.3, L-ACC.4, L-ACC.5) ─────────────────────

export async function gatedContext(env: OperationEnv, account: string) {
  const state = await env.relay.accountState(account);
  if (!state || !state.booted) throw new OperationError('The account is not active.');
  const hint = BigInt(readRoster(env.store, env.scope, account)?.useCounter ?? '0');
  const counter = findEvmUseCounter(state.devices, account, env.owner, BigInt(state.deviceEpoch), hint);
  if (counter === null) throw new OperationError('This wallet is not a device of this account.');
  return { state, counter };
}

async function submitGated(
  env: OperationEnv,
  account: string,
  action: 'withdraw' | 'append-inbox',
  payload: WithdrawPayload | AppendInboxPayload,
  typedData: unknown,
  counter: bigint,
  context: Record<string, unknown>,
): Promise<JobView> {
  if (!RELAY_ACTIONS.includes(action)) throw new OperationError('unknown action');
  const signature = await signTypedData(env, typedData);
  const job = await env.relay.submit(action, {
    account,
    payload: payload as unknown as Record<string, unknown>,
    passportAuth: { owner: lower(env.owner), signature, useCounter: counter.toString(10) },
  });
  putJob(env, account, job, action, context);
  env.onJob?.(job);
  const done = await env.relay.waitForJob(job.requestId, (j) => updateJob(env, account, j));
  dropJob(env, account, job.requestId);
  if (done.state !== 'succeeded') throw new OperationError(done.error?.message ?? 'The bank could not complete this.');
  env.store.put(env.scope, 'roster', { useCounter: (counter + 1n).toString(10) }, { account });
  return done;
}

/** A payee: a shielded wallet address (`mn_shield-addr_…`, both keys), or a bare 32-byte coin
 *  public key (only the bank's own wallet can be paid that way: nothing is sealed to it). */
export function recipientOf(text: string, network: string): { coinPublicKey: string; encryptionPublicKey?: string } {
  const t = text.trim();
  if (/^mn_/i.test(t)) {
    const a = parseShieldedAddress(t, network);
    return { coinPublicKey: a.coinPublicKey, encryptionPublicKey: a.encryptionPublicKey };
  }
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(t)) return { coinPublicKey: t.replace(/^0x/, '').toLowerCase() };
  throw new OperationError('Enter a shielded wallet address (mn_shield-addr_…).');
}

/**
 * Pay `amount` of `color` from ONE coin to a shielded wallet (its address). The
 * browser picks the coin (the smallest that covers it, Q9) and resolves its exact position first,
 * so the wallet is asked once. The change comes back from the relay and is kept here; it has no
 * inbox entry until `secureChange` files one (Q13).
 */
export async function withdrawToWallet(
  env: OperationEnv,
  account: string,
  args: { color: string; amount: bigint; recipient: string },
): Promise<{ txId: string; change: StoredCoin | null }> {
  const to = recipientOf(args.recipient, env.scope.network);
  const coins = readCoins(env.store, env.scope, account);
  const coin = chooseCoin(coins, args.color, args.amount);
  const { state, counter } = await gatedContext(env, account);
  const payload: WithdrawPayload = {
    recipient: to.coinPublicKey,
    ...(to.encryptionPublicKey ? { recipientEncryptionKey: to.encryptionPublicKey } : {}),
    color: coin.color,
    amount: args.amount.toString(10),
    coin: { nonce: coin.nonce, color: coin.color, value: coin.value, mtIndex: coin.mtIndex },
    authNonce: state.authNonce,
  };
  const call = gatedCall(
    { account, authNonce: BigInt(state.authNonce), evmDomainSalt: state.evmDomainSalt },
    env.owner,
    withdrawRequest(payload),
  );
  const done = await submitGated(env, account, 'withdraw', payload, call.typedData, counter, {
    spent: coin.commitment,
  });
  const result = done.result as unknown as WithdrawResult;
  const change = result.change ? localCoin(result.change, account, 'change', result.txId) : null;
  // The spent coin is marked now; the next sync confirms it from the ledger's nullifier.
  const next = readCoins(env.store, env.scope, account).map((c) =>
    c.commitment === coin.commitment ? { ...c, spent: true, spentTx: result.txId } : c,
  );
  if (change) next.push(change);
  env.store.put(env.scope, 'coins', next, { account });
  return { txId: result.txId, change };
}

/**
 * File an inbox entry for a coin that has none (Q13 default A: a withdrawal's change), so the
 * chain alone can restore it: the entry is sealed HERE to the account's own public key, and the
 * wallet signs the `AppendInbox` call once.
 */
export async function secureChange(env: OperationEnv, account: string, coin: StoredCoin): Promise<{ txId: string }> {
  const { state, counter } = await gatedContext(env, account);
  const entry = await sealEntryPortable(hexToBytes(state.encKey, 32), {
    nonce: hexToBytes(coin.nonce, 32),
    color: hexToBytes(coin.color, 32),
    value: BigInt(coin.value),
  });
  const payload: AppendInboxPayload = { entry: bytesToHex(entry), authNonce: state.authNonce };
  const call = gatedCall(
    { account, authNonce: BigInt(state.authNonce), evmDomainSalt: state.evmDomainSalt },
    env.owner,
    appendInboxRequest(payload),
  );
  const done = await submitGated(env, account, 'append-inbox', payload, call.typedData, counter, {
    coin: coin.commitment,
  });
  return { txId: String((done.result as { txId?: unknown } | undefined)?.txId ?? '') };
}

/** Coins that exist only in this browser (no inbox entry yet): shown as "not yet secured". */
export const unsecuredCoins = (coins: readonly StoredCoin[]) => coins.filter((c) => !c.spent && !c.inInbox);
