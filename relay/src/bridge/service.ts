// The bridge in both directions, as the relay runs it (plan L-BRG.1, .2, .4; spec US5, US6).
//
// THE LANES (plan P1.3). A deposit holds its account's deposit lane for its whole round trip
// (start, the MPC's signature, the sweep, finality, the attestation, the settle): every deposit
// of an account is swept FROM the same derived address, so their Sepolia nonces are one sequence.
// A withdrawal holds the global withdrawal lane the same way: every withdrawal is paid FROM the
// vault's one EVM account. Proofs take the prover lane only around each proof (ctx.prove).
//
// THE NONCE THE CUSTOMER SIGNS. The EIP-1559 fields of the transaction the MPC will sign are
// part of the device's signature, nonce included. `quote` tells the page the nonce to sign: the
// payer's pending nonce, or one past the nonce the running request of that lane signed while its
// transaction is not yet on Sepolia, plus one per request already waiting in the lane. When a
// request reaches the head of its lane, the relay refuses it BEFORE any Midnight transaction
// unless its signed nonce is exactly the payer's pending nonce (then the customer signs again).
//
// BEFORE ANY MIDNIGHT TRANSACTION (spec US5 scenario 1, US6 scenario 1):
//   - deposit: no earlier deposit of this account still open in the vault (resume it first); the
//     vault v0.3.0 preflight: the deposit address holds the amount of the ERC20 and gasLimit ×
//     maxFeePerGas of ETH;
//   - withdrawal: no other withdrawal open in the vault; the vault's EVM account holds the gas and
//     the ERC20; the coin covers the amount.
//
// THE REQUEST ID is matched as the vault's own driver does (relay-compose.ts): new between a read
// before and a read after the start, and carrying this account's deposit path (or the vault's own
// path). Never "the newest open id in the shared vault".
//
// RESUME. Job state is in memory (Q5). After a restart the page sends `bridge-resume` with the
// vault request id; the settle views name the account the request belongs to, and the relayer
// loop is resumable, so the relay picks the request up wherever it was.
//
// REFUND. A withdrawal attested `never-executed` settles with `bridge_withdraw_refund` (the coin
// is minted back); one attested `returned-false` settles with `bridge_withdraw_complete`, which
// re-mints it too. A deposit attested `returned-false` closes with nothing minted.
//
// A NEVER-EXECUTED DEPOSIT (plan P4-A, Q21 A). The account has no settle for the 5-byte
// never-executed marker; the vault's permissionless `abandonDeposit` closes it (nothing minted,
// the tokens stay at the deposit address, where the account's next deposit can sweep them). The
// job that sees the marker calls it at once, so the account is never left blocked.
//
// STALE REQUESTS (Q21 A). A request whose owner never comes back (the relay restarted and the page
// never resumed it) is closed by ./stale.ts through `closeStale`: a withdrawal runs the resumable
// relayer loop and the settle pinned to the account in the vault's settle view; a deposit already
// attested never-executed is abandoned. One request is driven by one run at a time (`running`): a
// resume that finds the bank already completing it waits for that run and reports its outcome.

import {
  BRIDGE_ERRORS,
  depositPreflight,
  matchesGasPolicy,
  maxGasCostWei,
  evmTxParamsJson,
  withdrawPreflight,
  type BridgeClosedResponse,
  type BridgeDepositPayload,
  type BridgeKind,
  type BridgeQuote,
  type BridgeResult,
  type BridgeResumePayload,
  type BridgeWithdrawPayload,
  type EvmGasPolicy,
  type JobLane,
  type TokenEntry,
  type TokenRegistry,
} from '@mnbank/core';

import type { Logger } from '../log.js';
import { PublicError, type JobContext, type JobExecutor } from '../queue/jobs.js';
import type { Attestation, BridgeBackend, RelayOutcome, RelayProgress, SettleCircuit, StartAuth } from './backend.js';
import {
  MPC_SIGNATURE_BUDGET_MS,
  RequestMatchError,
  isSignatureTimeout,
  matchNewRequest,
  normaliseHex,
  remainingSignatureBudgetMs,
} from './relay-compose.js';

/** A start whose Passport signature the relay verified again when its turn came. */
export interface VerifiedStart<P> {
  account: string;
  payload: P;
  auth: StartAuth;
  digestHex: string;
}

export interface BridgeServiceDeps {
  /** The live backend, or null when the relay cannot bridge (no keys, no vault, no Sepolia RPC). */
  backend: () => BridgeBackend | null;
  /** How many requests hold or wait for a lane. */
  laneLoad: (lane: JobLane, account?: string) => { running: number; waiting: number };
  gas: EvmGasPolicy;
  tokens: TokenRegistry;
  /** The vault every account seals (64 hex). */
  vaultAddress: string;
  /** Re-verify a start's own Passport signature against the account's state NOW (the executors
   *  run it when the request's turn comes; throws PublicError when it no longer holds). */
  verifyStart: {
    deposit: (raw: unknown) => Promise<VerifiedStart<BridgeDepositPayload>>;
    withdraw: (raw: unknown) => Promise<VerifiedStart<BridgeWithdrawPayload>>;
  };
  /** Forget a start's digest in the replay guard (the job failed, so the customer may retry). */
  releaseDigest: (digestHex: string) => void;
  /** Whether `signer` is a live device of `account` (a resume spends DUST; only owners may ask). */
  isDevice?: (account: string, signer: string) => Promise<boolean>;
  log: Logger;
  now?: () => number;
  /** How long a finished request's outcome is remembered for GET /v1/bridge/closed (ms). */
  closedTtlMs?: number;
}

/** Called right before the sponsor pays for closing somebody else's request (a settle or an
 *  `abandonDeposit`); throws a PublicError to refuse (the stale closer's budget, Q21 A). */
export type PermitSpend = (circuit: SettleCircuit | 'abandonDeposit') => void;

/** What one stale-request close did. */
export type StaleCloseOutcome =
  { outcome: 'closed'; result: BridgeResult } | { outcome: 'gone' } | { outcome: 'skipped'; reason: string };

interface LaneNonce {
  signedNonce: bigint;
  /** The request's Sepolia transaction was broadcast (its nonce is spent or in the mempool). */
  broadcast: boolean;
  /** Set when a stale close recorded it (from the MPC's signature), so only that close clears it. */
  closer?: string;
}

interface ClosedEntry {
  /** What the public route shows. */
  response: BridgeClosedResponse;
  /** The whole outcome, coin included: only a resume by a device of the account gets it. */
  result: BridgeResult;
  expiresAtMs: number;
}

/** One run of a request from its relayer loop to its settle. */
interface DriveInput {
  kind: BridgeKind;
  account: string;
  requestId: string;
  startedAtMs: number;
  startTx: string | null;
  change: BridgeResult['change'];
  laneKey: string | null;
  resumed: boolean;
  closedBy: 'owner' | 'relay';
  /** A resume waits for a run of the same request already in progress. */
  join: boolean;
  /** Asked before the sponsor pays for a stale close (Q21 A); absent for the owner's own jobs. */
  permitSpend?: PermitSpend;
}

const MAX_CLOSED_ENTRIES = 2_000;
const DAY_MS = 86_400_000;

export class BridgeService {
  /** The nonce the running request of each lane signed ("withdrawal" or "deposit:<account>"). */
  private readonly laneNonces = new Map<string, LaneNonce>();
  /** Vault request ids a job of this relay is driving right now, with the run's outcome (a resume
   *  of one waits for it; a second start of the same id is refused). */
  private readonly running = new Map<string, Promise<BridgeResult>>();
  /** Recently finished requests (GET /v1/bridge/closed), public facts only. */
  private readonly closed = new Map<string, ClosedEntry>();
  /** The MPC as this relay saw it (health, plan P4-A). */
  private readonly mpcSeen: { lastSignatureAfterMs: number | null; timeouts: number[] } = {
    lastSignatureAfterMs: null,
    timeouts: [],
  };
  private readonly now: () => number;

  constructor(private readonly deps: BridgeServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Whether a job of this relay is driving `requestId` now. */
  isDriving(requestId: string): boolean {
    return this.running.has(normaliseHex(requestId));
  }

  /** How a request this relay finished recently ended, or null (unknown, or forgotten). */
  closedOutcome(requestId: string): BridgeClosedResponse | null {
    const e = this.closedEntry(requestId);
    return e ? { ...e.response } : null;
  }

  private closedEntry(requestId: string): ClosedEntry | null {
    const id = normaliseHex(requestId);
    const e = this.closed.get(id);
    if (!e) return null;
    if (e.expiresAtMs <= this.now()) {
      this.closed.delete(id);
      return null;
    }
    return e;
  }

  /** The MPC's recent behaviour, for /health. */
  mpcStatus(): { lastSignatureAfterSeconds: number | null; timeouts24h: number; inFlight: number } {
    const since = this.now() - DAY_MS;
    this.mpcSeen.timeouts = this.mpcSeen.timeouts.filter((t) => t > since);
    return {
      lastSignatureAfterSeconds:
        this.mpcSeen.lastSignatureAfterMs === null ? null : Math.round(this.mpcSeen.lastSignatureAfterMs / 1000),
      timeouts24h: this.mpcSeen.timeouts.length,
      inFlight: this.running.size,
    };
  }

  private remember(r: BridgeResult): void {
    const now = this.now();
    for (const [id, e] of this.closed) if (e.expiresAtMs <= now) this.closed.delete(id);
    while (this.closed.size >= MAX_CLOSED_ENTRIES) {
      const oldest = this.closed.keys().next().value;
      if (oldest === undefined) break;
      this.closed.delete(oldest);
    }
    this.closed.set(r.requestId, {
      expiresAtMs: now + (this.deps.closedTtlMs ?? DAY_MS),
      result: r,
      response: {
        requestId: r.requestId,
        kind: r.kind,
        closedAt: Math.floor(now / 1000),
        closedBy: r.closedBy ?? 'owner',
        attested: r.attested,
        settleCircuit: r.settleCircuit,
        settleTx: r.settleTx,
        evmTxHash: r.evmTxHash,
        minted: r.coin !== null,
      },
    });
  }

  private backend(): BridgeBackend {
    const be = this.deps.backend();
    if (!be) throw new PublicError('not-available', 'the bank cannot bridge right now (it has no bridge configured)');
    return be;
  }

  available(): boolean {
    return this.deps.backend() !== null;
  }

  private token(erc20: string): TokenEntry {
    const t = this.deps.tokens.bySepoliaAddress(erc20);
    if (!t || t.vault !== this.deps.vaultAddress) {
      throw new PublicError(BRIDGE_ERRORS.unknownToken, 'the bank does not bridge this token');
    }
    return t;
  }

  private checkGas(evm: BridgeDepositPayload['evm']): void {
    if (!matchesGasPolicy(evm, this.deps.gas)) {
      throw new PublicError(
        BRIDGE_ERRORS.gasPolicy,
        "the signed Sepolia gas fields are not the bank's (ask for a new quote and sign again)",
      );
    }
  }

  // ── The quote ──────────────────────────────────────────────────────────────

  /** The fields to sign for a new request, with the nonce this relay reserves for it. */
  async quote(kind: BridgeKind, accountRaw: string, erc20?: string): Promise<BridgeQuote> {
    const be = this.backend();
    const account = normaliseHex(accountRaw);
    if (erc20 !== undefined) this.token(erc20);
    const payer = kind === 'deposit' ? be.depositAddress(account) : be.vaultEvmAddress;
    const lane: JobLane = kind === 'deposit' ? 'deposit' : 'withdrawal';
    const load = this.deps.laneLoad(lane, account);
    const laneKey = kind === 'deposit' ? `deposit:${account}` : 'withdrawal';
    const pending = await be.evm.nonce(payer, 'pending');
    const running = this.laneNonces.get(laneKey);
    let next = pending;
    if (running && !running.broadcast && running.signedNonce + 1n > next) next = running.signedNonce + 1n;
    next += BigInt(load.waiting);

    const [eth, tokenBal, open] = await Promise.all([
      be.evm.ethBalance(payer).catch(() => null),
      erc20 === undefined ? Promise.resolve(null) : be.evm.erc20Balance(erc20, payer).catch(() => null),
      be.openRequests(kind).catch(() => null),
    ]);
    const mine =
      open === null
        ? []
        : kind === 'deposit'
          ? open.ids.filter((id) => normaliseHex(open.pathOf(id) ?? '') === be.depositPathHex(account))
          : (
              await Promise.all(
                open.ids.map(async (id) =>
                  (await be.settleView('withdraw', id).catch(() => null))?.account === account ? id : null,
                ),
              )
            ).filter((id): id is string => id !== null);
    const openInVault = open === null ? 0 : kind === 'deposit' ? mine.length : open.ids.length;
    return {
      kind,
      account,
      payer,
      vaultEvmAddress: be.vaultEvmAddress,
      erc20: erc20 ?? null,
      evm: evmTxParamsJson(this.deps.gas, next),
      maxGasCostWei: maxGasCostWei(this.deps.gas).toString(10),
      payerEthWei: eth === null ? null : eth.toString(10),
      payerErc20: tokenBal === null ? null : tokenBal.toString(10),
      lane: load,
      openInVault,
      accountOpen: mine,
    };
  }

  // ── The executors ──────────────────────────────────────────────────────────

  readonly depositExecutor: JobExecutor = async (raw, ctx) => {
    const v = await this.deps.verifyStart.deposit(raw);
    try {
      return (await this.runDeposit(v, ctx)) as unknown as Record<string, unknown>;
    } catch (e) {
      this.deps.releaseDigest(v.digestHex);
      throw e;
    }
  };

  readonly withdrawExecutor: JobExecutor = async (raw, ctx) => {
    const v = await this.deps.verifyStart.withdraw(raw);
    try {
      return (await this.runWithdraw(v, ctx)) as unknown as Record<string, unknown>;
    } catch (e) {
      this.deps.releaseDigest(v.digestHex);
      throw e;
    }
  };

  readonly resumeExecutor: JobExecutor = async (raw, ctx) => {
    const body = raw as BridgeResumePayload & { account?: string; signer?: string };
    const account = normaliseHex(body.account ?? '');
    if (!/^[0-9a-f]{64}$/.test(account) || !body.requestId) throw new PublicError('bad-request', 'nothing to resume');
    if (this.deps.isDevice && body.signer && !(await this.deps.isDevice(account, body.signer))) {
      throw new PublicError('unauthorised', 'only a device of this account can resume its transfers');
    }
    return (await this.runResume(account, body, ctx)) as unknown as Record<string, unknown>;
  };

  // ── Deposit ────────────────────────────────────────────────────────────────

  private async runDeposit(v: VerifiedStart<BridgeDepositPayload>, ctx: JobContext): Promise<BridgeResult> {
    const be = this.backend();
    const { account, payload } = v;
    const token = this.token(payload.erc20);
    this.checkGas(payload.evm);
    const amount = BigInt(payload.amount);
    const depositAddress = be.depositAddress(account);
    const path = be.depositPathHex(account);
    const laneKey = `deposit:${account}`;

    const before = await be.openRequests('deposit');
    const stillOpen = before.ids.filter((id) => normaliseHex(before.pathOf(id) ?? '') === path);
    if (stillOpen.length > 0) {
      throw new PublicError(
        BRIDGE_ERRORS.openRequest,
        `an earlier deposit of this account is still open in the vault (request ${stillOpen[0]}): resume it before starting another`,
      );
    }
    const signedNonce = BigInt(payload.evm.nonce);
    const [pending, erc20Balance, ethBalance] = await Promise.all([
      be.evm.nonce(depositAddress, 'pending'),
      be.evm.erc20Balance(payload.erc20, depositAddress),
      be.evm.ethBalance(depositAddress),
    ]);
    ctx.stage('preflight', {
      depositAddress,
      token: token.symbol,
      erc20Balance: erc20Balance.toString(10),
      ethBalance: ethBalance.toString(10),
      evmNonce: pending.toString(10),
    });
    if (signedNonce !== pending) {
      throw new PublicError(
        BRIDGE_ERRORS.staleNonce,
        `the deposit address's Sepolia nonce is now ${pending}, not the ${signedNonce} you signed: sign again`,
      );
    }
    const pre = depositPreflight({
      erc20Balance,
      amount,
      ethBalance,
      gasLimit: this.deps.gas.gasLimit,
      maxFeePerGas: this.deps.gas.maxFeePerGas,
      decimals: token.decimals,
    });
    if (!pre.ok) throw new PublicError(BRIDGE_ERRORS.preflight, pre.problems.join('; '));

    this.laneNonces.set(laneKey, { signedNonce, broadcast: false });
    try {
      const start = await ctx.prove(() => {
        ctx.stage('starting', { circuit: 'bridge_deposit_start_with_evm' });
        return be.startDeposit({ account, payload, auth: v.auth });
      });
      const requestId = await this.matchRequest(be, 'deposit', before.ids, path);
      const facts = await be.txFacts(start.txId).catch(() => null);
      const startedAtMs = facts?.blockMs ?? this.now();
      ctx.stage('started', {
        tx: start.txId,
        ...(facts?.hash ? { txHash: facts.hash } : {}),
        requestId,
        startedAtMs: String(startedAtMs),
        depositAddress,
        amount: amount.toString(10),
        erc20: payload.erc20,
      });
      return await this.finish(be, ctx, {
        kind: 'deposit',
        account,
        requestId,
        startedAtMs,
        startTx: start.txId,
        change: null,
        laneKey,
        resumed: false,
        closedBy: 'owner',
        join: false,
      });
    } finally {
      this.laneNonces.delete(laneKey);
    }
  }

  // ── Withdrawal ─────────────────────────────────────────────────────────────

  private async runWithdraw(v: VerifiedStart<BridgeWithdrawPayload>, ctx: JobContext): Promise<BridgeResult> {
    const be = this.backend();
    const { account, payload } = v;
    const token = this.token(payload.erc20);
    this.checkGas(payload.evm);
    const colour = normaliseHex(payload.color);
    if (colour !== token.midnightColour || colour !== be.colourOf(payload.erc20)) {
      throw new PublicError(BRIDGE_ERRORS.unknownToken, "the colour is not the vault's colour for this token");
    }
    if (normaliseHex(payload.coin.color) !== colour) {
      throw new PublicError('bad-request', 'the coin is not of the colour being withdrawn');
    }
    const amount = BigInt(payload.amount);
    if (BigInt(payload.coin.value) < amount) {
      throw new PublicError('bad-request', 'the coin does not cover the amount (one coin per payment)');
    }

    const before = await be.openRequests('withdraw');
    if (before.ids.length > 0) {
      throw new PublicError(
        BRIDGE_ERRORS.openRequest,
        'another withdrawal is still being processed by the vault; try again in a few minutes',
      );
    }
    const signedNonce = BigInt(payload.evm.nonce);
    const [pending, vaultEthWei, vaultErc20] = await Promise.all([
      be.evm.nonce(be.vaultEvmAddress, 'pending'),
      be.evm.ethBalance(be.vaultEvmAddress),
      be.evm.erc20Balance(payload.erc20, be.vaultEvmAddress),
    ]);
    ctx.stage('preflight', {
      vaultEvmAddress: be.vaultEvmAddress,
      token: token.symbol,
      vaultEthWei: vaultEthWei.toString(10),
      vaultErc20: vaultErc20.toString(10),
      evmNonce: pending.toString(10),
    });
    if (signedNonce !== pending) {
      throw new PublicError(
        BRIDGE_ERRORS.staleNonce,
        `the vault account's Sepolia nonce is now ${pending}, not the ${signedNonce} you signed: sign again`,
      );
    }
    const pre = withdrawPreflight({ vaultEthWei, vaultErc20, amount, gas: this.deps.gas });
    if (!pre.ok) throw new PublicError(BRIDGE_ERRORS.preflight, pre.problems.join('; '));

    const laneKey = 'withdrawal';
    this.laneNonces.set(laneKey, { signedNonce, broadcast: false });
    try {
      const start = await ctx.prove(() => {
        ctx.stage('starting', { circuit: 'bridge_withdraw_start_with_evm' });
        return be.startWithdraw({ account, payload, auth: v.auth });
      });
      const requestId = await this.matchRequest(be, 'withdraw', before.ids, be.vaultPathHex());
      const facts = await be.txFacts(start.txId).catch(() => null);
      const startedAtMs = facts?.blockMs ?? this.now();
      ctx.stage('started', {
        tx: start.txId,
        ...(facts?.hash ? { txHash: facts.hash } : {}),
        requestId,
        startedAtMs: String(startedAtMs),
        dest: payload.dest,
        amount: amount.toString(10),
        erc20: payload.erc20,
        // The change's description, recorded at once: if the relay restarts before the settle, the
        // page still knows the coin (its inbox entry is 192 zero bytes until re-filed, Q13).
        ...(start.change
          ? { changeValue: start.change.value, changeNonce: start.change.nonce, changeColour: start.change.color }
          : {}),
      });
      return await this.finish(be, ctx, {
        kind: 'withdraw',
        account,
        requestId,
        startedAtMs,
        startTx: start.txId,
        change: start.change,
        laneKey,
        resumed: false,
        closedBy: 'owner',
        join: false,
      });
    } finally {
      this.laneNonces.delete(laneKey);
    }
  }

  // ── Resume ─────────────────────────────────────────────────────────────────

  private async runResume(account: string, body: BridgeResumePayload, ctx: JobContext): Promise<BridgeResult> {
    const be = this.backend();
    const requestId = normaliseHex(body.requestId);
    // The bank may be completing it right now (a stale close, or another resume): wait for that run.
    const inFlight = this.running.get(requestId);
    if (inFlight) {
      const r = await this.join(ctx, requestId, inFlight);
      if (r.account !== account)
        throw new PublicError(BRIDGE_ERRORS.notOpen, 'this request does not belong to this account');
      return r;
    }
    const view = await be.settleView(body.kind, requestId);
    if (!view) {
      const done = this.closedEntry(requestId);
      if (done && done.result.kind === body.kind && done.result.account === account) {
        // Closed by this relay already (for example as a stale request, Q21 A): report how it ended.
        ctx.stage('already-closed', {
          requestId,
          circuit: done.result.settleCircuit,
          tx: done.result.settleTx,
          by: done.result.closedBy ?? 'owner',
        });
        return { ...done.result };
      }
      throw new PublicError(
        BRIDGE_ERRORS.notOpen,
        'the vault holds no open request with this id: it has already been settled (refresh your balances)',
      );
    }
    if (view.account !== account) {
      throw new PublicError(BRIDGE_ERRORS.notOpen, 'this request does not belong to this account');
    }
    ctx.stage('resumed', { requestId, kind: body.kind });
    return this.finish(be, ctx, {
      kind: body.kind,
      account,
      requestId,
      startedAtMs: body.startedAtMs ? Number(body.startedAtMs) : this.now(),
      startTx: null,
      change: null,
      laneKey: null,
      resumed: true,
      closedBy: 'owner',
      join: true,
    });
  }

  // ── Stale requests (plan P4-A, Q21 A) ──────────────────────────────────────

  /**
   * Close a request its owner left open, if it is an account's and there is something safe to do:
   *   - a WITHDRAWAL: the resumable relayer loop, then the permissionless settle, whose mint (a
   *     refund) goes to the account the vault's settle view names: nothing can be redirected;
   *   - a DEPOSIT already attested never-executed: the vault's permissionless `abandonDeposit`
   *     (nothing is minted or moved). Any other deposit is its owner's to resume: skipped.
   * `permitSpend` is asked right before the sponsor pays (the closer's budget).
   */
  async closeStale(
    input: { kind: BridgeKind; requestId: string },
    ctx: JobContext,
    permitSpend: PermitSpend,
  ): Promise<StaleCloseOutcome> {
    const be = this.backend();
    const requestId = normaliseHex(input.requestId);
    if (this.running.has(requestId)) return { outcome: 'skipped', reason: 'a job of this relay is driving it' };
    const view = await be.settleView(input.kind, requestId);
    if (!view) return { outcome: 'gone' };
    if (view.account === null) return { outcome: 'skipped', reason: 'its recipient is not a contract' };
    const account = view.account;

    if (input.kind === 'deposit') {
      const att = await be.attestation('deposit', requestId);
      if (!att) return { outcome: 'skipped', reason: 'not attested yet' };
      if (att.kind !== 'never-executed')
        return { outcome: 'skipped', reason: `attested ${att.kind}: its owner completes it` };
      const result = await this.exclusive(ctx, requestId, false, () =>
        this.abandon(be, ctx, {
          account,
          requestId,
          attestation: att,
          startTx: null,
          evmTxHash: null,
          closedBy: 'relay',
          permitSpend,
        }),
      );
      return { outcome: 'closed', result };
    }

    ctx.stage('resumed', { requestId, kind: 'withdraw', by: 'bank' });
    try {
      const result = await this.finish(be, ctx, {
        kind: 'withdraw',
        account,
        requestId,
        startedAtMs: this.now(),
        startTx: null,
        change: null,
        laneKey: 'withdrawal',
        resumed: true,
        closedBy: 'relay',
        join: false,
        permitSpend,
      });
      return { outcome: 'closed', result };
    } finally {
      if (this.laneNonces.get('withdrawal')?.closer === requestId) this.laneNonces.delete('withdrawal');
    }
  }

  // ── Shared: the request id, the relayer loop and the settle ────────────────

  private async matchRequest(
    be: BridgeBackend,
    kind: BridgeKind,
    before: readonly string[],
    expectedPathHex: string,
  ): Promise<string> {
    // The indexer may lag the transaction by a block: read again a few times before giving up.
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      const after = await be.openRequests(kind);
      try {
        return matchNewRequest({ before, after: after.ids, pathOf: after.pathOf, expectedPathHex }).requestId;
      } catch (e) {
        lastError = e;
        if (!(e instanceof RequestMatchError) || e.freshIds.length > 0) break;
        await new Promise((r) => setTimeout(r, attempt === 0 ? 0 : 3_000));
      }
    }
    this.deps.log.warn('bridge request match failed', { kind, error: lastError });
    throw new PublicError(
      BRIDGE_ERRORS.requestMatch,
      'the start landed but its request could not be identified in the vault; the bank will look into it',
    );
  }

  /** Run `fn` as THE run of `requestId` (one at a time); a caller that may join waits for a run
   *  already in progress instead. Every finished run is remembered for GET /v1/bridge/closed. */
  private async exclusive(
    ctx: JobContext,
    requestId: string,
    join: boolean,
    fn: () => Promise<BridgeResult>,
  ): Promise<BridgeResult> {
    const existing = this.running.get(requestId);
    if (existing) {
      if (!join) throw new PublicError(BRIDGE_ERRORS.inProgress, 'this transfer is already being processed');
      return this.join(ctx, requestId, existing);
    }
    const run = fn();
    this.running.set(requestId, run);
    try {
      const r = await run;
      this.remember(r);
      return r;
    } finally {
      this.running.delete(requestId);
    }
  }

  private async join(ctx: JobContext, requestId: string, run: Promise<BridgeResult>): Promise<BridgeResult> {
    ctx.stage('joined', { requestId });
    return { ...(await run) };
  }

  private async finish(be: BridgeBackend, ctx: JobContext, r: DriveInput): Promise<BridgeResult> {
    return this.exclusive(ctx, r.requestId, r.join, () => this.drive(be, ctx, r));
  }

  private async drive(be: BridgeBackend, ctx: JobContext, r: DriveInput): Promise<BridgeResult> {
    const expectedSigner = r.kind === 'deposit' ? be.depositAddress(r.account) : be.vaultEvmAddress;
    // The stop rule counts from the START; a resume (the MPC may still sign late) gets a full budget.
    const signatureTimeoutMs = r.resumed
      ? MPC_SIGNATURE_BUDGET_MS
      : Math.max(60_000, remainingSignatureBudgetMs(r.startedAtMs, this.now()));
    let relay: RelayOutcome;
    try {
      relay = await be.relay({
        kind: r.kind,
        requestId: r.requestId,
        expectedSigner,
        signatureTimeoutMs,
        onProgress: (p) => this.onProgress(ctx, r.laneKey, p, r.closedBy === 'relay' ? r.requestId : undefined),
      });
    } catch (e) {
      this.deps.log.warn('bridge relay failed', { requestId: r.requestId, error: e });
      if (isSignatureTimeout(e)) {
        this.mpcSeen.timeouts.push(this.now());
        throw new PublicError(
          BRIDGE_ERRORS.mpcTimeout,
          `the MPC has not signed request ${r.requestId} within 20 minutes; nothing moved on Sepolia. Resume it later, or ask the bank`,
        );
      }
      throw new PublicError(
        BRIDGE_ERRORS.attestationTimeout,
        `the bank lost track of request ${r.requestId} while waiting for Sepolia and the MPC; your transfer is safe: resume it`,
      );
    }
    ctx.stage('attested', {
      kind: relay.kind,
      ...(relay.evmTxHash ? { evmTx: relay.evmTxHash } : {}),
      signatureAfterS: String(Math.round(relay.signatureAfterMs / 1000)),
      attestationAfterS: String(Math.round(relay.attestationAfterMs / 1000)),
    });

    if (r.kind === 'deposit' && relay.kind === 'never-executed') {
      // The account has no settle for the never-executed marker; the vault's abandonDeposit closes
      // the request so this account can deposit again (Q21 A). The tokens stay at the address.
      return this.abandon(be, ctx, {
        account: r.account,
        requestId: r.requestId,
        attestation: { kind: relay.kind, event: relay.event, serializedOutput: relay.serializedOutput },
        startTx: r.startTx,
        evmTxHash: relay.evmTxHash ?? null,
        closedBy: r.closedBy,
        ...(r.permitSpend ? { permitSpend: r.permitSpend } : {}),
      });
    }
    const circuit: SettleCircuit =
      r.kind === 'deposit'
        ? 'bridge_deposit_complete'
        : relay.kind === 'never-executed'
          ? 'bridge_withdraw_refund'
          : 'bridge_withdraw_complete';
    r.permitSpend?.(circuit);
    const settle = await ctx.prove(() => {
      ctx.stage('settling', { circuit });
      return be.settle({ kind: r.kind, circuit, account: r.account, requestId: r.requestId, relay });
    });
    const facts = await be.txFacts(settle.txId).catch(() => null);
    ctx.stage('settled', {
      tx: settle.txId,
      ...(facts?.hash ? { txHash: facts.hash } : {}),
      circuit,
      ...(settle.coin ? { coinValue: settle.coin.value } : {}),
      ...(r.closedBy === 'relay' ? { by: 'bank' } : {}),
    });
    return {
      kind: r.kind,
      account: r.account,
      requestId: r.requestId,
      startTx: r.startTx,
      attested: relay.kind,
      evmTxHash: relay.evmTxHash ?? null,
      settleTx: settle.txId,
      settleCircuit: circuit,
      coin: settle.coin,
      change: r.change,
      entryMatchesCoin: settle.entryMatchesCoin,
      closedBy: r.closedBy,
    };
  }

  /** `abandonDeposit` for a deposit attested never-executed (the vault's, permissionless). */
  private async abandon(
    be: BridgeBackend,
    ctx: JobContext,
    a: {
      account: string;
      requestId: string;
      attestation: Attestation;
      startTx: string | null;
      evmTxHash: string | null;
      closedBy: 'owner' | 'relay';
      permitSpend?: PermitSpend;
    },
  ): Promise<BridgeResult> {
    a.permitSpend?.('abandonDeposit');
    const done = await ctx.prove(() => {
      ctx.stage('abandoning', { circuit: 'abandonDeposit', requestId: a.requestId });
      return be.abandonDeposit({ requestId: a.requestId, attestation: a.attestation });
    });
    const facts = await be.txFacts(done.txId).catch(() => null);
    ctx.stage('abandoned', {
      tx: done.txId,
      ...(facts?.hash ? { txHash: facts.hash } : {}),
      circuit: 'abandonDeposit',
      ...(a.closedBy === 'relay' ? { by: 'bank' } : {}),
    });
    this.deps.log.info('never-executed deposit abandoned', { requestId: a.requestId, by: a.closedBy });
    return {
      kind: 'deposit',
      account: a.account,
      requestId: a.requestId,
      startTx: a.startTx,
      attested: 'never-executed',
      evmTxHash: a.evmTxHash,
      settleTx: done.txId,
      settleCircuit: 'abandonDeposit',
      coin: null,
      change: null,
      entryMatchesCoin: true,
      closedBy: a.closedBy,
    };
  }

  private onProgress(ctx: JobContext, laneKey: string | null, p: RelayProgress, closer?: string): void {
    const s = (ms: number) => String(Math.round(ms / 1000));
    switch (p.stage) {
      case 'signed':
        this.mpcSeen.lastSignatureAfterMs = p.afterMs;
        // A stale close holds the withdrawal lane without having signed anything itself: record the
        // nonce the MPC signed for it, so a quote meanwhile promises the next one.
        if (closer && laneKey && !this.laneNonces.has(laneKey)) {
          this.laneNonces.set(laneKey, { signedNonce: BigInt(p.nonce), broadcast: false, closer });
        }
        ctx.stage('mpc-signed', {
          signedTx: p.signedTxHash,
          from: p.from,
          evmNonce: String(p.nonce),
          afterS: s(p.afterMs),
        });
        return;
      case 'broadcast': {
        if (laneKey) {
          const n = this.laneNonces.get(laneKey);
          if (n) n.broadcast = true;
        }
        ctx.stage('evm-broadcast', {
          evmTx: p.evmTxHash,
          evmBlock: String(p.evmBlock),
          evmStatus: String(p.evmStatus ?? ''),
          afterS: s(p.afterMs),
        });
        return;
      }
      case 'not-broadcast':
        ctx.stage('evm-not-broadcast', { reason: p.reason.slice(0, 200), afterS: s(p.afterMs) });
        return;
      case 'finalized':
        ctx.stage('evm-final', {
          evmBlock: String(p.evmBlock),
          finalizedBlock: String(p.finalizedBlock),
          afterS: s(p.afterMs),
        });
        return;
      case 'attested':
        // Recorded with the result's details once the loop returns.
        return;
    }
  }
}

export const bridgeLaneOf = (kind: BridgeKind): JobLane => (kind === 'deposit' ? 'deposit' : 'withdrawal');
