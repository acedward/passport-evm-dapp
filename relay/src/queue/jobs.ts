// The relay's job queue (plan P1.3). Jobs live in memory only (Q5: no per-user storage); the
// browser keeps the request id and resumes by polling GET /v1/jobs/:requestId.
//
// Three lanes:
//   - prover:     one job at a time across the relay. Every sponsor-paid call (register,
//                 withdraw, append-inbox, open-swap, take) holds it for its whole run: the proof
//                 server proves one circuit at a time (a k=18 proof needs about 8 GB), and the one
//                 sponsor wallet balances one transaction at a time.
//   - deposit:    one bridge deposit at a time PER ACCOUNT (they share the account's deposit
//                 address and its nonce on Sepolia).
//   - withdrawal: one bridge withdrawal at a time across the WHOLE relay (they share the vault's
//                 single EVM account and its nonce).
// A bridge job holds its lane for its whole run (about 20 minutes, mostly waiting for the MPC
// and Sepolia finality) and takes the prover lane only around its proofs, through ctx.prove().
//
// When a job finishes, its payload (which can hold the coin it spends) is dropped at once; only
// the public outcome is kept, until the TTL.

import { randomBytes } from 'node:crypto';

import type { JobActionName, JobLane, JobStage, JobState, JobView } from '@mnbank/core';

import type { Logger } from '../log.js';
import { FifoLock } from './fifo-lock.js';

/** An error whose code and message may be shown to the customer. Anything else is reported as
 *  an internal error, and its details go to the (redacted) log only. */
export class PublicError extends Error {
  override name = 'PublicError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface JobContext {
  readonly requestId: string;
  readonly log: Logger;
  /** Record a stage with public details only (hashes, ids, heights). */
  stage(name: string, detail?: Record<string, string>): void;
  /** Run `fn` while holding the prover lane (re-entrant inside a prover-lane job). */
  prove<T>(fn: () => Promise<T>): Promise<T>;
}

export type JobExecutor = (payload: unknown, ctx: JobContext) => Promise<Record<string, unknown>>;

export interface JobSubmission {
  /** A route's action, or an internal job the relay runs on its own (plan P4-A: `bridge-close`). */
  action: JobActionName;
  lane: JobLane;
  /** The deposit lane's account (64 hex); ignored by the other lanes. */
  account?: string;
  payload: unknown;
  executor: JobExecutor;
}

interface JobRecord {
  requestId: string;
  action: JobActionName;
  lane: JobLane;
  laneKey: string;
  state: JobState;
  stages: JobStage[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  payload: unknown;
  executor: JobExecutor | null;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  settled: Promise<void>;
}

export interface QueueStats {
  jobs: number;
  lanes: Record<JobLane, { running: number; waiting: number }>;
}

export interface JobQueueOptions {
  ttlSeconds: number;
  maxJobs: number;
  log: Logger;
  now?: () => number;
}

export class JobQueue {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly prover = new FifoLock();
  private readonly withdrawal = new FifoLock();
  private readonly deposits = new Map<string, FifoLock>();
  private readonly now: () => number;

  constructor(private readonly options: JobQueueOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Queue a job; null when the relay already holds its maximum number of jobs. */
  submit(sub: JobSubmission): JobView | null {
    if (this.jobs.size >= this.options.maxJobs) this.sweep();
    if (this.jobs.size >= this.options.maxJobs) return null;
    if (sub.lane === 'deposit' && !sub.account) throw new Error('a deposit job needs its account');
    const requestId = randomBytes(16).toString('hex');
    const now = this.now();
    let settle!: () => void;
    const rec: JobRecord = {
      requestId,
      action: sub.action,
      lane: sub.lane,
      laneKey: sub.lane === 'deposit' ? `deposit:${sub.account!.replace(/^0x/, '').toLowerCase()}` : sub.lane,
      state: 'queued',
      stages: [{ stage: 'queued', at: now }],
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.options.ttlSeconds,
      payload: sub.payload,
      executor: sub.executor,
      settled: new Promise((r) => (settle = r)),
    };
    this.jobs.set(requestId, rec);
    void this.run(rec).finally(settle);
    return this.view(rec);
  }

  get(requestId: string): JobView | undefined {
    const rec = this.jobs.get(requestId);
    if (!rec) return undefined;
    if (rec.state !== 'queued' && rec.state !== 'running' && rec.expiresAt <= this.now()) {
      this.jobs.delete(requestId);
      return undefined;
    }
    return this.view(rec);
  }

  /** Resolves when the job has finished (tests and shutdown). */
  async settled(requestId: string): Promise<JobView | undefined> {
    await this.jobs.get(requestId)?.settled;
    return this.get(requestId);
  }

  stats(): QueueStats {
    let depRunning = 0;
    let depWaiting = 0;
    for (const lock of this.deposits.values()) {
      depRunning += lock.running;
      depWaiting += lock.waiting;
    }
    return {
      jobs: this.jobs.size,
      lanes: {
        prover: { running: this.prover.running, waiting: this.prover.waiting },
        deposit: { running: depRunning, waiting: depWaiting },
        withdrawal: { running: this.withdrawal.running, waiting: this.withdrawal.waiting },
      },
    };
  }

  /** The jobs holding and waiting for one lane (the deposit lane is per account). */
  laneLoad(lane: JobLane, account?: string): { running: number; waiting: number } {
    const lock =
      lane === 'prover'
        ? this.prover
        : lane === 'withdrawal'
          ? this.withdrawal
          : this.deposits.get(`deposit:${(account ?? '').replace(/^0x/, '').toLowerCase()}`);
    return lock ? { running: lock.running, waiting: lock.waiting } : { running: 0, waiting: 0 };
  }

  /** Forget finished jobs past their TTL. Queued and running jobs are never dropped. */
  sweep(): void {
    const now = this.now();
    for (const [id, rec] of this.jobs) {
      if ((rec.state === 'succeeded' || rec.state === 'failed') && rec.expiresAt <= now) this.jobs.delete(id);
    }
  }

  private laneLock(rec: JobRecord): FifoLock {
    if (rec.lane === 'prover') return this.prover;
    if (rec.lane === 'withdrawal') return this.withdrawal;
    let lock = this.deposits.get(rec.laneKey);
    if (!lock) {
      lock = new FifoLock();
      this.deposits.set(rec.laneKey, lock);
    }
    return lock;
  }

  private stage(rec: JobRecord, name: string, detail?: Record<string, string>): void {
    const at = this.now();
    rec.stages.push(detail ? { stage: name, at, detail } : { stage: name, at });
    rec.updatedAt = at;
  }

  private async run(rec: JobRecord): Promise<void> {
    const log = this.options.log.child({ requestId: rec.requestId, action: rec.action, lane: rec.lane });
    const lane = this.laneLock(rec);
    const releaseLane = await lane.acquire(rec.requestId);
    let holdsProver = rec.lane === 'prover';
    rec.state = 'running';
    this.stage(rec, 'running');
    const ctx: JobContext = {
      requestId: rec.requestId,
      log,
      stage: (name, detail) => this.stage(rec, name, detail),
      prove: async <T>(fn: () => Promise<T>): Promise<T> => {
        if (holdsProver) return fn();
        this.stage(rec, 'waiting-for-prover');
        const release = await this.prover.acquire(rec.requestId);
        holdsProver = true;
        try {
          this.stage(rec, 'proving');
          return await fn();
        } finally {
          holdsProver = false;
          release();
        }
      },
    };
    try {
      const executor = rec.executor;
      if (!executor) throw new Error('job has no executor');
      rec.result = await executor(rec.payload, ctx);
      rec.state = 'succeeded';
      this.stage(rec, 'succeeded');
      log.info('job succeeded');
    } catch (e) {
      rec.state = 'failed';
      rec.error =
        e instanceof PublicError
          ? { code: e.code, message: e.message }
          : { code: 'internal-error', message: 'the relay could not complete this request' };
      this.stage(rec, 'failed');
      log.warn('job failed', { error: e });
    } finally {
      rec.payload = undefined;
      rec.executor = null;
      rec.expiresAt = this.now() + this.options.ttlSeconds;
      releaseLane();
      if (rec.lane === 'deposit' && lane.idle) this.deposits.delete(rec.laneKey);
    }
  }

  private view(rec: JobRecord): JobView {
    const position = rec.state === 'queued' ? this.laneLock(rec).position(rec.requestId) : undefined;
    const last = rec.stages[rec.stages.length - 1];
    return {
      requestId: rec.requestId,
      action: rec.action,
      lane: rec.lane,
      state: rec.state,
      stage: last?.stage ?? rec.state,
      stages: rec.stages.map((s) => ({ ...s, ...(s.detail ? { detail: { ...s.detail } } : {}) })),
      ...(position !== undefined && position > 0 ? { position } : {}),
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      expiresAt: rec.expiresAt,
      ...(rec.result ? { result: { ...rec.result } } : {}),
      ...(rec.error ? { error: { ...rec.error } } : {}),
    };
  }
}
