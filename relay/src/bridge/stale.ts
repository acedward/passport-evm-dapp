// The stale-request closer (plan P4-A, Q21 default A): the relay closes bridge requests their
// owners left open, because an open request blocks others:
//   - an open WITHDRAWAL blocks every customer's withdrawal (they all pay from the vault's one EVM
//     account, so the relay starts none while one is open);
//   - an open DEPOSIT blocks its account's deposits (they share the account's deposit address).
//
// At start-up and then on a timer it reads the vault's open requests. A request is STALE when no
// job of this relay drives it and it has been open for `staleAfterMs` since this relay first saw
// it (a customer normally resumes within that time; a live job is never touched). For each stale
// request whose recipient is an MN Bank account (a booted Passport account sealed to this vault),
// it queues an internal `bridge-close` job on the request's own lane:
//   - withdrawal: the resumable relayer loop, then the permissionless settle
//     (`bridge_withdraw_complete` or `bridge_withdraw_refund`); any coin it mints goes to the
//     account the vault's settle view names, with its inbox entry sealed to the account's public
//     key, so nothing can be redirected;
//   - deposit: only when the MPC has ALREADY attested it never-executed, the vault's permissionless
//     `abandonDeposit` (nothing is minted or moved; the tokens stay at the deposit address, where
//     the account's next deposit sweeps them). Any other deposit is its owner's to resume.
// Requests of wallets or other contracts (for example the vault's own tests) are never touched.
//
// WHAT THE SPONSOR PAYS FOR, AND THE CAP. Each close is ONE transaction the sponsor pays the DUST
// fee of: the settle, or `abandonDeposit`. Reading the vault and running the relayer loop costs no
// DUST (the Sepolia gas of a withdrawal's transfer is the vault's own EVM account's, as for every
// withdrawal). A griefer could start requests to accounts and abandon them, so the spend is capped:
//   - at most `maxPerDay` closes paid for in any rolling 24 hours (default 24);
//   - never while the sponsor holds less than `minSponsorDustSpecks` (default twice the level at
//     which the relay refuses customers' actions), so customers' own actions keep priority;
//   - one close at a time, and a request whose close failed waits `retryAfterMs` before another.
// Every permitted spend is counted at the moment the sponsor is about to pay, and /health reports
// the count, the cap, the newest closes and why the closer is holding back.

import type { BridgeKind, JobActionName, JobLane } from '@mnbank/core';

import type { Logger } from '../log.js';
import { PublicError, type JobExecutor, type JobContext } from '../queue/jobs.js';
import type { SponsorStatus } from '../sponsor/session.js';
import type { BridgeBackend } from './backend.js';
import { normaliseHex } from './relay-compose.js';
import type { BridgeService, PermitSpend, StaleCloseOutcome } from './service.js';

export interface StaleCloserConfig {
  enabled: boolean;
  /** How often to scan the vault (ms). */
  intervalMs: number;
  /** How long a request must be seen open, undriven, before the relay closes it (ms). */
  staleAfterMs: number;
  /** Closes the sponsor pays for in any rolling 24 hours. */
  maxPerDay: number;
  /** The sponsor's DUST below which the closer spends nothing (specks). */
  minSponsorDustSpecks: bigint;
  /** After a close fails, how long before that request is tried again (ms). */
  retryAfterMs: number;
}

export interface StaleCloserDeps {
  config: StaleCloserConfig;
  service: Pick<BridgeService, 'isDriving' | 'closeStale'>;
  backend: () => BridgeBackend | null;
  /** Queue an internal job on a lane (the job queue's `submit`); null when the queue is full. */
  submit: (sub: {
    action: JobActionName;
    lane: JobLane;
    account?: string;
    payload: unknown;
    executor: JobExecutor;
  }) => { requestId: string } | null;
  /** Wait for a queued job to finish (the job queue's `settled`). */
  settled: (jobId: string) => Promise<unknown>;
  sponsor: () => SponsorStatus;
  /** Whether `account` is an MN Bank account: a booted Passport account sealed to this vault. */
  isBankAccount: (account: string) => Promise<boolean>;
  log: Logger;
  now?: () => number;
}

export interface StaleCloseRecord {
  kind: BridgeKind;
  requestId: string;
  circuit: string;
  tx: string;
  at: number;
}

export interface StaleCloserStatus {
  enabled: boolean;
  lastScanAt: number | null;
  open: { deposit: number; withdraw: number };
  waiting: number;
  closing: number;
  closed24h: number;
  maxPerDay: number;
  recent: StaleCloseRecord[];
  paused: string | null;
}

const DAY_MS = 86_400_000;
const KINDS: readonly BridgeKind[] = ['withdraw', 'deposit'];

interface Tracked {
  kind: BridgeKind;
  firstSeenMs: number;
  /** Not before this time (a failed or skipped attempt backs off). */
  nextTryMs: number;
  /** Known not to be an MN Bank account's request (never touched). */
  foreign: boolean;
  /** The account its settle view names, once read. */
  account: string | null;
}

export class StaleRequestCloser {
  private readonly tracked = new Map<string, Tracked>();
  private readonly spends: number[] = [];
  private readonly recent: StaleCloseRecord[] = [];
  private readonly closing = new Set<string>();
  private openCount = { deposit: 0, withdraw: 0 };
  private lastScanAt: number | null = null;
  private paused: string | null = null;
  private scanning: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: StaleCloserDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Scan now (start-up), then every `intervalMs`. */
  start(): void {
    if (!this.deps.config.enabled || this.timer) return;
    void this.scan();
    this.timer = setInterval(() => void this.scan(), this.deps.config.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): StaleCloserStatus {
    this.prune();
    const now = this.now();
    let waiting = 0;
    for (const [id, t] of this.tracked) {
      if (!t.foreign && !this.closing.has(id) && now - t.firstSeenMs >= this.deps.config.staleAfterMs) waiting++;
    }
    return {
      enabled: this.deps.config.enabled,
      lastScanAt: this.lastScanAt === null ? null : Math.floor(this.lastScanAt / 1000),
      open: { ...this.openCount },
      waiting,
      closing: this.closing.size,
      closed24h: this.spends.length,
      maxPerDay: this.deps.config.maxPerDay,
      recent: this.recent.map((r) => ({ ...r })),
      paused: this.paused,
    };
  }

  /** One pass: read the vault, track what is open, and queue at most one close. Re-entrant calls
   *  wait for the pass in progress. */
  scan(): Promise<void> {
    if (!this.deps.config.enabled) return Promise.resolve();
    if (!this.scanning) {
      this.scanning = this.scanOnce()
        .catch((e: unknown) => this.deps.log.warn('stale-request scan failed', { error: e }))
        .finally(() => {
          this.scanning = null;
        });
    }
    return this.scanning;
  }

  private prune(): void {
    const since = this.now() - DAY_MS;
    while (this.spends.length > 0 && this.spends[0]! <= since) this.spends.shift();
  }

  /** Why the sponsor may not pay for a close now, or null when it may. */
  private spendRefusal(): string | null {
    this.prune();
    if (this.spends.length >= this.deps.config.maxPerDay) {
      return `the daily cap of ${this.deps.config.maxPerDay} closes is reached`;
    }
    const s = this.deps.sponsor();
    if (!s.synced) return 'the sponsor wallet is not synced';
    if (s.dustSpecks !== null && s.dustSpecks < this.deps.config.minSponsorDustSpecks) {
      return "the sponsor's DUST is below the closer's reserve";
    }
    return null;
  }

  private readonly permitSpend: PermitSpend = (circuit) => {
    const refusal = this.spendRefusal();
    if (refusal) {
      this.paused = refusal;
      throw new PublicError('close-budget', `the bank did not pay for ${circuit}: ${refusal}`);
    }
    this.spends.push(this.now());
  };

  private async scanOnce(): Promise<void> {
    const be = this.deps.backend();
    if (!be) return;
    const now = this.now();
    const seen = new Set<string>();
    for (const kind of KINDS) {
      const open = await be.openRequests(kind);
      this.openCount[kind === 'deposit' ? 'deposit' : 'withdraw'] = open.ids.length;
      for (const raw of open.ids) {
        const id = normaliseHex(raw);
        seen.add(id);
        if (!this.tracked.has(id))
          this.tracked.set(id, { kind, firstSeenMs: now, nextTryMs: 0, foreign: false, account: null });
      }
    }
    for (const id of [...this.tracked.keys()]) if (!seen.has(id)) this.tracked.delete(id);
    this.lastScanAt = now;

    if (this.closing.size > 0) return; // one close at a time
    // Withdrawals first: an open one blocks every customer's withdrawal.
    const candidates = [...this.tracked.entries()]
      .filter(
        ([id, t]) =>
          !t.foreign &&
          now - t.firstSeenMs >= this.deps.config.staleAfterMs &&
          now >= t.nextTryMs &&
          !this.deps.service.isDriving(id),
      )
      .sort(([, a], [, b]) => (a.kind === b.kind ? a.firstSeenMs - b.firstSeenMs : a.kind === 'withdraw' ? -1 : 1));
    for (const [id, t] of candidates) {
      if (!t.account) {
        const view = await be.settleView(t.kind, id).catch(() => null);
        if (!view) continue; // settled meanwhile; the next scan forgets it
        if (view.account === null || !(await this.deps.isBankAccount(view.account).catch(() => false))) {
          t.foreign = true;
          continue;
        }
        t.account = view.account;
      }
      const refusal = this.spendRefusal();
      this.paused = refusal;
      if (refusal) return;
      this.queue(id, t);
      return;
    }
    this.paused = null;
  }

  private queue(id: string, t: Tracked): void {
    const executor: JobExecutor = async (_payload, ctx: JobContext) => {
      const out: StaleCloseOutcome = await this.deps.service.closeStale(
        { kind: t.kind, requestId: id },
        ctx,
        this.permitSpend,
      );
      if (out.outcome === 'closed') {
        this.recent.unshift({
          kind: t.kind,
          requestId: id,
          circuit: out.result.settleCircuit,
          tx: out.result.settleTx,
          at: Math.floor(this.now() / 1000),
        });
        this.recent.splice(5);
        this.tracked.delete(id);
        this.deps.log.info('stale bridge request closed', {
          kind: t.kind,
          requestId: id,
          circuit: out.result.settleCircuit,
        });
        return { outcome: 'closed', kind: t.kind, requestId: id, circuit: out.result.settleCircuit };
      }
      if (out.outcome === 'skipped') {
        // Nothing to do yet (a deposit not attested never-executed, …): look again later.
        t.nextTryMs = this.now() + this.deps.config.retryAfterMs;
        return { outcome: 'skipped', kind: t.kind, requestId: id, reason: out.reason };
      }
      this.tracked.delete(id);
      return { outcome: 'gone', kind: t.kind, requestId: id };
    };
    const job = this.deps.submit({
      action: 'bridge-close',
      lane: t.kind === 'withdraw' ? 'withdrawal' : 'deposit',
      ...(t.kind === 'deposit' && t.account ? { account: t.account } : {}),
      payload: { kind: t.kind, requestId: id },
      executor,
    });
    if (!job) return;
    this.closing.add(id);
    this.deps.log.info('closing a stale bridge request', { kind: t.kind, requestId: id, job: job.requestId });
    void this.deps
      .settled(job.requestId)
      .then((view) => {
        const v = view as { state?: string; error?: { code?: string } } | undefined;
        if (v?.state === 'failed') {
          t.nextTryMs = this.now() + this.deps.config.retryAfterMs;
          this.deps.log.warn('closing a stale bridge request failed', { requestId: id, code: v.error?.code });
        }
      })
      .finally(() => {
        this.closing.delete(id);
      });
  }
}

/** Whether `account` is a booted Passport account sealed to `vaultAddress` (its ledger says so). */
export function bankAccountChecker(
  ledgerState: (account: string) => Promise<{ booted: boolean; vault_address: { bytes: Uint8Array } } | null>,
  vaultAddress: string,
): (account: string) => Promise<boolean> {
  const vault = normaliseHex(vaultAddress);
  return async (account) => {
    const l = await ledgerState(account);
    return !!l && l.booted && Buffer.from(l.vault_address.bytes).toString('hex') === vault;
  };
}
