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

import {
  BRIDGE_ERRORS,
  depositPreflight,
  matchesGasPolicy,
  maxGasCostWei,
  evmTxParamsJson,
  withdrawPreflight,
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
import type { BridgeBackend, RelayOutcome, RelayProgress, SettleCircuit, StartAuth } from './backend.js';
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
}

interface LaneNonce {
  signedNonce: bigint;
  /** The request's Sepolia transaction was broadcast (its nonce is spent or in the mempool). */
  broadcast: boolean;
}

export class BridgeService {
  /** The nonce the running request of each lane signed ("withdrawal" or "deposit:<account>"). */
  private readonly laneNonces = new Map<string, LaneNonce>();
  /** Vault request ids a job of this relay is driving right now (a second resume is refused). */
  private readonly active = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: BridgeServiceDeps) {
    this.now = deps.now ?? Date.now;
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
    const openInVault =
      open === null
        ? 0
        : kind === 'deposit'
          ? open.ids.filter((id) => normaliseHex(open.pathOf(id) ?? '') === be.depositPathHex(account)).length
          : open.ids.length;
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
        ...(start.change ? { changeValue: start.change.value } : {}),
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
      });
    } finally {
      this.laneNonces.delete(laneKey);
    }
  }

  // ── Resume ─────────────────────────────────────────────────────────────────

  private async runResume(account: string, body: BridgeResumePayload, ctx: JobContext): Promise<BridgeResult> {
    const be = this.backend();
    const requestId = normaliseHex(body.requestId);
    const view = await be.settleView(body.kind, requestId);
    if (!view) {
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
    });
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

  private async finish(
    be: BridgeBackend,
    ctx: JobContext,
    r: {
      kind: BridgeKind;
      account: string;
      requestId: string;
      startedAtMs: number;
      startTx: string | null;
      change: BridgeResult['change'];
      laneKey: string | null;
      resumed: boolean;
    },
  ): Promise<BridgeResult> {
    if (this.active.has(r.requestId)) {
      throw new PublicError(BRIDGE_ERRORS.inProgress, 'this transfer is already being processed');
    }
    this.active.add(r.requestId);
    try {
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
          onProgress: (p) => this.onProgress(ctx, r.laneKey, p),
        });
      } catch (e) {
        this.deps.log.warn('bridge relay failed', { requestId: r.requestId, error: e });
        if (isSignatureTimeout(e)) {
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

      let circuit: SettleCircuit;
      if (r.kind === 'deposit') {
        if (relay.kind === 'never-executed') {
          throw new PublicError(
            'deposit-never-executed',
            `the sweep of request ${r.requestId} never ran on Sepolia; your tokens are still at the deposit address. The request must be abandoned in the vault before this account deposits again (ask the bank)`,
          );
        }
        circuit = 'bridge_deposit_complete';
      } else {
        circuit = relay.kind === 'never-executed' ? 'bridge_withdraw_refund' : 'bridge_withdraw_complete';
      }
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
      };
    } finally {
      this.active.delete(r.requestId);
    }
  }

  private onProgress(ctx: JobContext, laneKey: string | null, p: RelayProgress): void {
    const s = (ms: number) => String(Math.round(ms / 1000));
    switch (p.stage) {
      case 'signed':
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
