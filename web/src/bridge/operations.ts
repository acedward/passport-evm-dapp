// The bridge as the browser runs it (plan L-BRG.1–.3; spec US5, US6, FR-009, FR-010).
//
// DEPOSIT (Sepolia → Midnight). The page derives the account's deposit address itself (the vault's
// `depositPath(right(account))` and Sig Network's derivation, vendored in @mnbank/core/passport),
// the wallet sends the ERC20 and the sweep's gas ETH to it (`eth_sendTransaction`, two
// transactions), the page runs the vault v0.3.0 preflight, and the wallet signs the start ONCE
// (EIP-712 `BridgeDepositStart`, which binds the Sepolia sweep's nonce and gas). The relay does the
// rest; the page follows the job, records every hash, and adds the coin when it lands.
//
// WITHDRAWAL (Midnight → Sepolia). One coin pays (Q9: at most the largest single coin); the page
// checks the vault's EVM account can pay the gas, and the wallet signs the start ONCE. A partial
// withdrawal's change comes back with 192 zero bytes in its inbox entry, so the page files it
// with `append_inbox_with_evm` (Q13 default A: one more signature), unless an offer is live.
//
// RESUME. The transfer and its vault request id live in local storage. After a reload the page
// polls the job again; when the relay no longer knows it (it restarted), the customer resumes it
// with one RelayAction signature, and the relay picks the request up by its id.

import {
  DEFAULT_EVM_GAS,
  buildRelayActionMessage,
  bytesToHex,
  chooseCoin,
  contractCoinCommitment,
  hexToBytes,
  localCoin,
  maxGasCostWei,
  queuedDepositPreflight,
  relayActionTypedData,
  withdrawPreflight,
  type BridgeClosedResponse,
  type BridgeDepositPayload,
  type BridgeQuote,
  type BridgeResult,
  type BridgeWithdrawPayload,
  type JobView,
  type NetworkProfile,
  type StoredCoin,
  type TokenEntry,
  type TokenRegistry,
} from '@mnbank/core';
import {
  bridgeDepositStartRequest,
  bridgeWithdrawStartRequest,
  contractRecipient,
  deriveDepositEvmAddress,
  gatedCall,
  normaliseSecp256k1PublicKey,
} from '@mnbank/core/passport';

import {
  OperationError,
  ensureChain,
  gatedContext,
  secureChange,
  signTypedData,
  syncAccount,
  type OperationEnv,
} from '../passport/operations.js';
import { readCoins } from '../passport/records.js';
import { jobErrorText } from '../relay/messages.js';
import {
  broadcast,
  inFlight,
  listTransfers,
  mergeStages,
  patchTransfer,
  readTransfer,
  stageDetail,
  writeTransfer,
  type TransferRecord,
} from './records.js';

export interface BridgeEnv extends OperationEnv {
  network: NetworkProfile;
}

/** A refusal before anything is signed or sent, with the exact reasons (spec US5 scenario 1). */
export class PreflightError extends OperationError {
  override name = 'PreflightError';
  constructor(readonly problems: string[]) {
    super(problems.join(' '));
  }
}

const lower = (s: string) => s.toLowerCase();
const hexQty = (v: bigint) => `0x${v.toString(16)}`;
const randomId = () => bytesToHex(crypto.getRandomValues(new Uint8Array(8)));

// ── The deposit address (derived here, never taken from the relay) ──────────────────

export function depositAddressOf(network: NetworkProfile, account: string): string {
  const b = network.bridge;
  if (!b.vaultAddress || !b.mpcRootPublicKey) throw new OperationError('This network has no bridge configured.');
  return deriveDepositEvmAddress(
    normaliseSecp256k1PublicKey(b.mpcRootPublicKey),
    b.vaultAddress,
    contractRecipient(hexToBytes(account, 32)),
  );
}

// ── Sepolia through the wallet's provider ─────────────────────────────────────────────

const quantity = (v: unknown): bigint => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v)) throw new OperationError('Sepolia returned a bad number.');
  return v === '0x' ? 0n : BigInt(v);
};

export async function sepoliaBalances(
  env: Pick<OperationEnv, 'provider'>,
  holder: string,
  erc20: string | null,
): Promise<{ eth: bigint; erc20: bigint | null }> {
  const eth = quantity(await env.provider.request({ method: 'eth_getBalance', params: [holder, 'latest'] }));
  if (!erc20) return { eth, erc20: null };
  const data = `0x70a08231${lower(holder).replace(/^0x/, '').padStart(64, '0')}`;
  const bal = quantity(await env.provider.request({ method: 'eth_call', params: [{ to: erc20, data }, 'latest'] }));
  return { eth, erc20: bal };
}

/** Send one Sepolia transaction from the connected wallet and wait for it to be mined. */
async function sendAndWait(env: BridgeEnv, tx: Record<string, string>, onHash: (h: string) => void): Promise<string> {
  await ensureChain(env);
  const hash = await env.provider.request({ method: 'eth_sendTransaction', params: [{ from: env.owner, ...tx }] });
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash))
    throw new OperationError('The wallet did not send the transaction.');
  onHash(hash);
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const r = (await env.provider
      .request({ method: 'eth_getTransactionReceipt', params: [hash] })
      .catch(() => null)) as {
      status?: string;
    } | null;
    if (r && r.status !== undefined) {
      if (r.status !== '0x1') throw new OperationError(`The Sepolia transaction ${hash} failed.`);
      return hash;
    }
    if (Date.now() > deadline)
      throw new OperationError(`The Sepolia transaction ${hash} is not mined after 10 minutes.`);
    await new Promise((res) => setTimeout(res, 3_000));
  }
}

// ── What earlier transfers of this account still need from the same deposit address ────

function ahead(env: BridgeEnv, account: string, erc20: string, except?: string) {
  const earlier = listTransfers(env.store, env.scope, account).filter(
    (t) =>
      t.kind === 'deposit' && t.id !== except && (t.state === 'running' || t.state === 'needs-resume') && !broadcast(t),
  );
  return {
    sameToken: earlier.filter((t) => lower(t.erc20) === lower(erc20)).reduce((n, t) => n + BigInt(t.amount), 0n),
    sweeps: earlier.length,
  };
}

/** A new start signs against the account's CURRENT auth nonce; one still being started would make
 *  it stale, so the page waits until every earlier start of the account has landed. */
function notStartedYet(env: BridgeEnv, account: string, except?: string): TransferRecord | undefined {
  return listTransfers(env.store, env.scope, account).find(
    (t) => t.id !== except && t.state === 'running' && !t.requestId,
  );
}

// ── Deposit ──────────────────────────────────────────────────────────────────────────

/** A new deposit, kept in this browser from the first funding transaction on. */
export function draftDeposit(env: BridgeEnv, account: string, token: TokenEntry, amount: bigint): TransferRecord {
  if (!token.sepoliaAddress || !token.vault) throw new OperationError(`${token.symbol} is not bridged.`);
  if (amount <= 0n) throw new OperationError('Enter an amount.');
  const now = Date.now();
  return writeTransfer(env.store, env.scope, {
    id: randomId(),
    kind: 'deposit',
    account,
    symbol: token.symbol,
    midnightName: token.midnightName,
    erc20: token.sepoliaAddress,
    colour: token.midnightColour,
    decimals: token.decimals,
    amount: amount.toString(10),
    depositAddress: depositAddressOf(env.network, account),
    createdAt: now,
    updatedAt: now,
    state: 'funding',
    jobIds: [],
    stages: [],
  });
}

// ── The funding transactions' arguments (security review F-B4) ──────────────────────────

/** Exactly what the deposit's two wallet transactions send, and where. */
export interface DepositFunding {
  account: string;
  /** Derived from the network and the account, never read from the stored record. */
  depositAddress: string;
  /** The ERC20 contract, from the bank's token registry. */
  erc20: string;
  symbol: string;
  decimals: number;
}

/**
 * The deposit's funding arguments, DERIVED here (security review F-B4): the deposit address from
 * the configured network and the transfer's account, the ERC20 from the token registry. A stored
 * record (which an Import may have written) only names the account and the token; if its own
 * copies of the address or the token disagree, nothing is sent.
 */
export function depositFunding(
  network: NetworkProfile,
  tokens: TokenRegistry | null,
  rec: TransferRecord,
): DepositFunding {
  if (rec.kind !== 'deposit') throw new OperationError('This transfer is not a deposit.');
  const account = lower(rec.account).replace(/^0x/, '');
  const depositAddress = depositAddressOf(network, account);
  if (rec.depositAddress !== undefined && lower(rec.depositAddress) !== lower(depositAddress)) {
    throw new OperationError(
      "This deposit names a deposit address that is not your account's, so nothing was sent. Cancel it and start again.",
    );
  }
  const token = (tokens?.tokens ?? []).find(
    (t) => t.sepoliaAddress !== '' && t.vault !== '' && lower(t.sepoliaAddress) === lower(rec.erc20),
  );
  if (!token || lower(token.midnightColour) !== lower(rec.colour) || token.decimals !== rec.decimals) {
    throw new OperationError(
      'This deposit names a token the bank does not bridge, so nothing was sent. Cancel it and start again.',
    );
  }
  return { account, depositAddress, erc20: token.sepoliaAddress, symbol: token.symbol, decimals: token.decimals };
}

/** The same, after checking on chain that the connected wallet is a device of that account (the
 *  page's account record can come from an Import too). */
async function verifiedDepositFunding(
  env: BridgeEnv,
  tokens: TokenRegistry | null,
  rec: TransferRecord,
): Promise<DepositFunding> {
  const f = depositFunding(env.network, tokens, rec);
  await gatedContext(env, f.account);
  return f;
}

/** What the deposit address still lacks for this deposit (after earlier queued ones). */
export async function depositShortfall(env: BridgeEnv, rec: TransferRecord, tokens: TokenRegistry | null) {
  const f = depositFunding(env.network, tokens, rec);
  return shortfallAt(env, rec, f);
}

async function shortfallAt(env: BridgeEnv, rec: TransferRecord, f: DepositFunding) {
  const held = await sepoliaBalances(env, f.depositAddress, f.erc20);
  const a = ahead(env, rec.account, rec.erc20, rec.id);
  const needToken = BigInt(rec.amount) + a.sameToken;
  const needGas = maxGasCostWei(DEFAULT_EVM_GAS) * BigInt(a.sweeps + 1);
  return {
    held,
    tokenShort: needToken > (held.erc20 ?? 0n) ? needToken - (held.erc20 ?? 0n) : 0n,
    gasShort: needGas > held.eth ? needGas - held.eth : 0n,
    ahead: a,
  };
}

/** Wallet transaction 1: the ERC20 the sweep will move (only what is missing), to the DERIVED
 *  deposit address, on the registry's contract (F-B4). */
export async function sendDepositTokens(
  env: BridgeEnv,
  rec: TransferRecord,
  tokens: TokenRegistry | null,
): Promise<string | null> {
  const f = await verifiedDepositFunding(env, tokens, rec);
  const { tokenShort } = await shortfallAt(env, rec, f);
  if (tokenShort === 0n) return null;
  const data = `0xa9059cbb${lower(f.depositAddress).slice(2).padStart(64, '0')}${tokenShort.toString(16).padStart(64, '0')}`;
  return sendAndWait(env, { to: f.erc20, data, value: '0x0' }, (h) =>
    patchTransfer(env.store, env.scope, rec.account, rec.id, (r) => ({ ...r, funding: { ...r.funding, tokenTx: h } })),
  );
}

/** Wallet transaction 2: the ETH the sweep's gas may cost (gasLimit × maxFeePerGas; only what is
 *  missing), to the DERIVED deposit address (F-B4). */
export async function sendDepositGas(
  env: BridgeEnv,
  rec: TransferRecord,
  tokens: TokenRegistry | null,
): Promise<string | null> {
  const f = await verifiedDepositFunding(env, tokens, rec);
  const { gasShort } = await shortfallAt(env, rec, f);
  if (gasShort === 0n) return null;
  return sendAndWait(env, { to: f.depositAddress, value: hexQty(gasShort) }, (h) =>
    patchTransfer(env.store, env.scope, rec.account, rec.id, (r) => ({ ...r, funding: { ...r.funding, gasTx: h } })),
  );
}

/**
 * The start: the preflight (the exact tokens and gas at the deposit address, nothing refused by the
 * vault v0.3.0 rule), then ONE signature, then the relay job. Refuses before signing with the
 * exact shortfall.
 */
export async function startDeposit(env: BridgeEnv, recIn: TransferRecord): Promise<TransferRecord> {
  const rec = readTransfer(env.store, env.scope, recIn.account, recIn.id) ?? recIn;
  const earlier = notStartedYet(env, rec.account, rec.id);
  if (earlier)
    throw new OperationError('Wait until your earlier transfer has started on Midnight (about two minutes).');
  const quote = await env.relay.bridgeQuote('deposit', rec.account, rec.erc20);
  if (lower(quote.payer) !== lower(depositAddressOf(env.network, rec.account))) {
    throw new OperationError('The bank quoted a different deposit address than this page derives. Nothing was signed.');
  }
  if (quote.accountOpen.length > 0 && quote.lane.running === 0) {
    throw new OperationError(
      `An earlier deposit of this account is still open (request ${quote.accountOpen[0]}); resume it under Pending transfers first.`,
    );
  }
  const a = ahead(env, rec.account, rec.erc20, rec.id);
  const held = {
    erc20: quote.payerErc20 === null ? 0n : BigInt(quote.payerErc20),
    eth: quote.payerEthWei === null ? 0n : BigInt(quote.payerEthWei),
  };
  const pre = queuedDepositPreflight({
    erc20Balance: held.erc20,
    ethBalance: held.eth,
    amount: BigInt(rec.amount),
    gas: DEFAULT_EVM_GAS,
    decimals: rec.decimals,
    aheadSameToken: a.sameToken,
    aheadSweeps: a.sweeps,
  });
  if (!pre.ok) throw new PreflightError(pre.problems.map((p) => `${p.charAt(0).toUpperCase()}${p.slice(1)}.`));

  const { state, counter } = await gatedContext(env, rec.account);
  const payload: BridgeDepositPayload = {
    erc20: rec.erc20,
    amount: rec.amount,
    evm: quote.evm,
    authNonce: state.authNonce,
  };
  const call = gatedCall(
    { account: rec.account, authNonce: BigInt(state.authNonce), evmDomainSalt: state.evmDomainSalt },
    env.owner,
    bridgeDepositStartRequest(payload),
  );
  const signature = await signTypedData(env, call.typedData);
  const job = await env.relay.submit('bridge-deposit', {
    account: rec.account,
    payload: payload as unknown as Record<string, unknown>,
    passportAuth: { owner: lower(env.owner), signature, useCounter: counter.toString(10) },
  });
  env.store.put(env.scope, 'roster', { useCounter: (counter + 1n).toString(10) }, { account: rec.account });
  return applyJob(env, { ...rec, state: 'running', jobIds: [...rec.jobIds, job.requestId] }, job);
}

// ── Withdrawal ───────────────────────────────────────────────────────────────────────

export async function startWithdraw(
  env: BridgeEnv,
  account: string,
  args: { token: TokenEntry; amount: bigint; dest: string },
): Promise<TransferRecord> {
  const { token, amount } = args;
  if (!token.sepoliaAddress || !token.vault) throw new OperationError(`${token.midnightName} is not bridged.`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(args.dest.trim())) throw new OperationError('Enter a Sepolia address (0x…).');
  const earlier = notStartedYet(env, account);
  if (earlier)
    throw new OperationError('Wait until your earlier transfer has started on Midnight (about two minutes).');
  const coin = chooseCoin(readCoins(env.store, env.scope, account), token.midnightColour, amount);
  const quote = await env.relay.bridgeQuote('withdraw', account, token.sepoliaAddress);
  checkWithdrawQuote(quote, amount);

  const { state, counter } = await gatedContext(env, account);
  const payload: BridgeWithdrawPayload = {
    dest: args.dest.trim(),
    color: token.midnightColour,
    erc20: token.sepoliaAddress,
    amount: amount.toString(10),
    coin: { nonce: coin.nonce, color: coin.color, value: coin.value, mtIndex: coin.mtIndex },
    evm: quote.evm,
    authNonce: state.authNonce,
  };
  const call = gatedCall(
    { account, authNonce: BigInt(state.authNonce), evmDomainSalt: state.evmDomainSalt },
    env.owner,
    bridgeWithdrawStartRequest(payload),
  );
  const signature = await signTypedData(env, call.typedData);
  const job = await env.relay.submit('bridge-withdraw', {
    account,
    payload: payload as unknown as Record<string, unknown>,
    passportAuth: { owner: lower(env.owner), signature, useCounter: counter.toString(10) },
  });
  env.store.put(env.scope, 'roster', { useCounter: (counter + 1n).toString(10) }, { account });
  const now = Date.now();
  const rec = writeTransfer(env.store, env.scope, {
    id: randomId(),
    kind: 'withdraw',
    account,
    symbol: token.symbol,
    midnightName: token.midnightName,
    erc20: token.sepoliaAddress,
    colour: token.midnightColour,
    decimals: token.decimals,
    amount: amount.toString(10),
    dest: payload.dest,
    spentCommitment: coin.commitment,
    createdAt: now,
    updatedAt: now,
    state: 'running',
    jobIds: [job.requestId],
    stages: [],
  });
  return applyJob(env, rec, job);
}

/** Refuse a withdrawal before signing when the vault's EVM account cannot pay (spec US6 scenario 1). */
export function checkWithdrawQuote(quote: BridgeQuote, amount: bigint): void {
  const pre = withdrawPreflight({
    vaultEthWei: quote.payerEthWei === null ? 0n : BigInt(quote.payerEthWei),
    vaultErc20: quote.payerErc20 === null ? null : BigInt(quote.payerErc20),
    amount,
    gas: DEFAULT_EVM_GAS,
  });
  if (!pre.ok) throw new PreflightError(pre.problems.map((p) => `${p.charAt(0).toUpperCase()}${p.slice(1)}.`));
  if (quote.openInVault > 0 && quote.lane.running === 0) {
    throw new OperationError(
      'Another withdrawal is still open in the vault and the bank is not processing it; try again in a few minutes.',
    );
  }
}

// ── Following a transfer, and resuming it ─────────────────────────────────────────────

/** Fold one view of the transfer's current job into the record. */
export function applyJob(env: BridgeEnv, rec: TransferRecord, job: JobView): TransferRecord {
  const stages = mergeStages(rec.stages, job.stages);
  const started = stageDetail({ stages }, 'started');
  const next: TransferRecord = {
    ...rec,
    stages,
    ...(started?.requestId ? { requestId: started.requestId } : {}),
    ...(started?.startedAtMs ? { startedAtMs: Number(started.startedAtMs) } : {}),
  };
  if (started?.changeNonce && started.changeColour && started.changeValue && !next.change) {
    next.change = {
      coin: { nonce: started.changeNonce, color: started.changeColour, value: started.changeValue },
      secured: false,
      ...(started.changeEntitlement ? { entitlement: started.changeEntitlement } : {}),
    };
  }
  if (job.state === 'succeeded') {
    next.state = 'succeeded';
    next.result = job.result as unknown as BridgeResult;
    delete next.error;
  } else if (job.state === 'failed') {
    const resumable = ['mpc-timeout', 'attestation-timeout'].includes(job.error?.code ?? '') && !!next.requestId;
    next.state = resumable ? 'needs-resume' : 'failed';
    next.error = job.error
      ? { code: job.error.code, message: jobErrorText(job.error, 'The bank could not complete this transfer.') }
      : { code: 'failed', message: 'The bank could not complete this transfer.' };
  } else {
    next.state = 'running';
  }
  return writeTransfer(env.store, env.scope, next);
}

/** How often a transfer waiting to be resumed asks whether the bank closed it meanwhile (ms). */
export const CLOSED_CHECK_MS = 60_000;

/**
 * The bank closed this transfer's request (a stale request it closed for the customer, Q21 A, or
 * one whose job this page lost): record the outcome. A coin it minted (a deposit, a refund) is
 * found by the inbox walk that follows every finished transfer.
 */
function closedByBank(env: BridgeEnv, rec: TransferRecord, c: BridgeClosedResponse): TransferRecord {
  const result: BridgeResult = {
    kind: c.kind,
    account: rec.account,
    requestId: c.requestId,
    startTx: null,
    attested: c.attested,
    evmTxHash: c.evmTxHash,
    settleTx: c.settleTx,
    settleCircuit: c.settleCircuit,
    coin: null,
    change: rec.change?.coin ?? null,
    entryMatchesCoin: true,
    closedBy: c.closedBy,
  };
  const next: TransferRecord = {
    ...rec,
    state: 'succeeded',
    result,
    stages: mergeStages(rec.stages, [
      {
        stage: c.settleCircuit === 'abandonDeposit' ? 'abandoned' : 'settled',
        at: c.closedAt,
        detail: { tx: c.settleTx, circuit: c.settleCircuit, ...(c.closedBy === 'relay' ? { by: 'bank' } : {}) },
      },
    ]),
  };
  delete next.error;
  return writeTransfer(env.store, env.scope, next);
}

/** Whether the bank closed `rec`'s request; null when not (or the bank cannot say). */
async function closedOutcome(env: BridgeEnv, rec: TransferRecord): Promise<BridgeClosedResponse | null> {
  if (!rec.requestId) return null;
  try {
    const c = await env.relay.bridgeClosed(rec.requestId);
    return c && c.kind === rec.kind ? c : null;
  } catch {
    return null; // the bank cannot say right now: the next poll asks again
  }
}

/**
 * One poll of a transfer in flight. When the relay no longer knows the job (it restarted), the
 * transfer becomes `needs-resume` if its start landed (unless the bank already closed it); the
 * vault is asked for this account's open requests first, in case the start landed while the relay
 * was going down. A transfer that needs resuming asks, about once a minute, whether the bank
 * closed it meanwhile (plan P4-A: the relay closes requests left open).
 */
export async function pollTransfer(env: BridgeEnv, recIn: TransferRecord): Promise<TransferRecord> {
  const rec = readTransfer(env.store, env.scope, recIn.account, recIn.id) ?? recIn;
  if (rec.state === 'needs-resume') {
    if (rec.closedCheckAt && Date.now() - rec.closedCheckAt < CLOSED_CHECK_MS) return rec;
    const c = await closedOutcome(env, rec);
    return c ? closedByBank(env, rec, c) : writeTransfer(env.store, env.scope, { ...rec, closedCheckAt: Date.now() });
  }
  if (rec.state !== 'running') return rec;
  const jobId = rec.jobIds.at(-1);
  if (!jobId) return rec;
  const job = await env.relay.job(jobId);
  if (job) return applyJob(env, rec, job);
  const closed = await closedOutcome(env, rec);
  if (closed) return closedByBank(env, rec, closed);
  let requestId = rec.requestId;
  if (!requestId) {
    const q = await env.relay.bridgeQuote(rec.kind, rec.account, rec.erc20).catch(() => null);
    const known = new Set(
      listTransfers(env.store, env.scope, rec.account)
        .map((t) => t.requestId)
        .filter(Boolean),
    );
    const candidates = (q?.accountOpen ?? []).filter((id) => !known.has(id));
    if (candidates.length === 1) requestId = candidates[0];
  }
  return writeTransfer(env.store, env.scope, {
    ...rec,
    ...(requestId ? { requestId } : {}),
    state: requestId ? 'needs-resume' : 'failed',
    error: requestId
      ? {
          code: 'job-lost',
          message: 'The bank restarted while your transfer was in progress. Resume it: nothing is lost.',
        }
      : {
          code: 'job-lost',
          message:
            'The bank restarted before your transfer started on Midnight. Nothing moved on Midnight; start it again.',
        },
  });
}

/** Resume a transfer by its vault request id: one RelayAction signature, then a new relay job. */
export async function resumeTransfer(env: BridgeEnv, recIn: TransferRecord): Promise<TransferRecord> {
  const rec = readTransfer(env.store, env.scope, recIn.account, recIn.id) ?? recIn;
  if (!rec.requestId) throw new OperationError('This transfer never started on Midnight; there is nothing to resume.');
  const payload = {
    kind: rec.kind,
    requestId: rec.requestId,
    ...(rec.startedAtMs ? { startedAtMs: String(rec.startedAtMs) } : {}),
  };
  const { nonce, maxTtlSeconds } = await env.relay.nonce();
  const message = buildRelayActionMessage({
    action: 'bridge-resume',
    network: env.scope.network,
    owner: env.owner,
    account: rec.account,
    payload,
    nonce,
    expiry: Math.floor(Date.now() / 1000) + Math.min(maxTtlSeconds, 300),
  });
  const signature = await signTypedData(env, relayActionTypedData(message, env.chainId));
  const job = await env.relay.submit('bridge-resume', { account: rec.account, payload, auth: { message, signature } });
  const next = { ...rec, state: 'running' as const, jobIds: [...rec.jobIds, job.requestId] };
  delete next.error;
  return applyJob(env, next, job);
}

// ── On completion: the coins (FR-005, FR-006) ─────────────────────────────────────────

/** Whether the account has a live offer (plan L-TRD keeps `offer` records); filing the change would
 *  cancel it (Q9, Q13 A), so the re-file waits. */
export function liveOffer(env: Pick<OperationEnv, 'store' | 'scope'>, account: string): boolean {
  return env.store.list(env.scope).some(
    (r) =>
      r.parsed.kind === 'offer' &&
      !r.parsed.scope.global &&
      r.parsed.scope.account === account &&
      ['live', 'open', 'posted'].includes(String((r.record?.data as { status?: unknown } | undefined)?.status)) &&
      // Plan L-TRD: an offer past its intent's TTL can never settle, so it no longer blocks.
      !(Number((r.record?.data as { expiresAt?: unknown } | undefined)?.expiresAt ?? Infinity) <= Date.now()),
  );
}

/**
 * Apply a finished transfer to the coin list (idempotent): the spent coin is marked, a minted coin
 * (a deposit, or a refund) and a withdrawal's change are added; the next inbox walk confirms each
 * one's exact position.
 */
export function applyCoins(env: BridgeEnv, rec: TransferRecord): void {
  if (rec.state !== 'succeeded' || !rec.result) return;
  const r = rec.result;
  const coins = readCoins(env.store, env.scope, rec.account);
  const key = (c: { nonce: string; color: string }) => `${c.color}:${c.nonce}`;
  const have = new Set(coins.map(key));
  const next: StoredCoin[] = coins.map((c) =>
    rec.spentCommitment && c.commitment === rec.spentCommitment && !c.spent
      ? { ...c, spent: true, ...(r.startTx ? { spentTx: r.startTx } : {}) }
      : c,
  );
  if (r.coin && !have.has(key(r.coin))) {
    next.push({
      ...localCoin(r.coin, rec.account, 'inbox', r.settleTx),
      inInbox: r.entryMatchesCoin,
      ...(r.coinEntitlement ? { appendEntitlement: r.coinEntitlement } : {}),
    });
  }
  const change = r.change ?? rec.change?.coin ?? null;
  const changeEntitlement = r.changeEntitlement ?? rec.change?.entitlement;
  if (change && !have.has(key(change)))
    next.push({
      ...localCoin(change, rec.account, 'change', r.startTx ?? undefined),
      ...(changeEntitlement ? { appendEntitlement: changeEntitlement } : {}),
    });
  env.store.put(env.scope, 'coins', next, { account: rec.account });
}

/** Q13 A: file the change's inbox entry (one more signature), unless an offer is live. */
export async function secureTransferChange(env: BridgeEnv, recIn: TransferRecord): Promise<TransferRecord> {
  const rec = readTransfer(env.store, env.scope, recIn.account, recIn.id) ?? recIn;
  const change = rec.change;
  if (!change || change.secured) return rec;
  if (liveOffer(env, rec.account)) {
    return writeTransfer(env.store, env.scope, {
      ...rec,
      change: {
        ...change,
        deferredReason: 'Your live offer would be cancelled by another signed call; this waits until it settles.',
      },
    });
  }
  await syncAccount(env, rec.account);
  const known =
    readCoins(env.store, env.scope, rec.account).find(
      (c) => c.commitment === contractCoinCommitment(change.coin, rec.account),
    ) ?? localCoin(change.coin, rec.account, 'change');
  const entitlement = known.appendEntitlement ?? change.entitlement ?? rec.result?.changeEntitlement;
  const coin = entitlement ? { ...known, appendEntitlement: entitlement } : known;
  if (coin.inInbox) {
    return writeTransfer(env.store, env.scope, { ...rec, change: { ...change, secured: true } });
  }
  const { txId } = await secureChange(env, rec.account, coin);
  await syncAccount(env, rec.account);
  return writeTransfer(env.store, env.scope, { ...rec, change: { coin: change.coin, secured: true, secureTx: txId } });
}

/** Everything still moving for this account, oldest first (what the watcher follows). */
export const pendingTransfers = (env: Pick<OperationEnv, 'store' | 'scope'>, account: string) =>
  listTransfers(env.store, env.scope, account).filter(inFlight).reverse();
