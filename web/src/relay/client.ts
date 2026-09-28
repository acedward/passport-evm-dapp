// The browser's client for the MN Bank relay: nonces, the one action route, job polling (the
// browser keeps the request id, so a job resumes after a reload, Q5), and the account's public
// chain reads. Every response is validated against the shared schemas.

import {
  API_PATHS,
  AccountStateViewSchema,
  ApiErrorSchema,
  BridgeClosedResponseSchema,
  BridgeQuoteSchema,
  HealthResponseSchema,
  type BridgeClosedResponse,
  type HealthResponse,
  type BridgeKind,
  type BridgeQuote,
  InboxPageSchema,
  JobViewSchema,
  NonceResponseSchema,
  ZswapActivitySchema,
  type AccountStateView,
  type ActionRequest,
  type InboxPage,
  type JobView,
  type NonceResponse,
  type RelayActionName,
  type ZswapActivity,
} from '@mnbank/core';

import { relayErrorText } from './messages.js';

/** A refusal or failure of the relay. `message` is the customer's sentence (./messages.ts);
 *  `relayMessage` is what the relay said. */
export class RelayError extends Error {
  override name = 'RelayError';
  readonly relayMessage: string;
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(relayErrorText({ status, code, message, ...(detail ? { detail } : {}), retryAfterSeconds }));
    this.relayMessage = message;
  }
}

export class RelayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`;
  }

  private async call(path: string, init?: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), { cache: 'no-store', ...init });
    } catch {
      throw new RelayError(0, 'unreachable', 'The bank could not be reached.');
    }
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const e = ApiErrorSchema.safeParse(body);
      const retry = Number(res.headers.get('retry-after') ?? '');
      const retryAfter = Number.isFinite(retry) && retry > 0 ? retry : null;
      throw e.success
        ? new RelayError(res.status, e.data.error.code, e.data.error.message, e.data.error.detail, retryAfter)
        : new RelayError(res.status, 'error', '', undefined, retryAfter);
    }
    return body;
  }

  async nonce(): Promise<NonceResponse> {
    return NonceResponseSchema.parse(await this.call(API_PATHS.nonce));
  }

  async submit(action: RelayActionName, request: ActionRequest): Promise<JobView> {
    const body = (await this.call(API_PATHS.action(action), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })) as { job?: unknown };
    return JobViewSchema.parse(body.job);
  }

  /** The job, or null when the relay no longer knows it (expired, or restarted). */
  async job(requestId: string): Promise<JobView | null> {
    try {
      const body = (await this.call(API_PATHS.job(requestId))) as { job?: unknown };
      return JobViewSchema.parse(body.job);
    } catch (e) {
      if (e instanceof RelayError && e.status === 404) return null;
      throw e;
    }
  }

  /** Poll a job until it finishes; `onUpdate` sees every state. */
  async waitForJob(
    requestId: string,
    onUpdate: (job: JobView) => void,
    opts: { intervalMs?: number; signal?: AbortSignal } = {},
  ): Promise<JobView> {
    const interval = opts.intervalMs ?? 2_000;
    for (;;) {
      if (opts.signal?.aborted) throw new RelayError(0, 'aborted', 'stopped waiting');
      const job = await this.job(requestId);
      if (!job)
        throw new RelayError(404, 'job-lost', 'The bank no longer knows this request (it expired or restarted).');
      onUpdate(job);
      if (job.state === 'succeeded' || job.state === 'failed') return job;
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  async accountState(account: string): Promise<AccountStateView | null> {
    try {
      return AccountStateViewSchema.parse(await this.call(API_PATHS.accountState(account)));
    } catch (e) {
      if (e instanceof RelayError && e.status === 404) return null;
      throw e;
    }
  }

  async inbox(account: string, from = 0, limit = 500): Promise<InboxPage> {
    return InboxPageSchema.parse(await this.call(`${API_PATHS.accountInbox(account)}?from=${from}&limit=${limit}`));
  }

  /** The Sepolia fields a bridge start signs, with the nonce the relay reserves (plan L-BRG). */
  async bridgeQuote(kind: BridgeKind, account: string, erc20?: string): Promise<BridgeQuote> {
    const q = new URLSearchParams({ kind, account });
    if (erc20) q.set('erc20', erc20);
    return BridgeQuoteSchema.parse(await this.call(`${API_PATHS.bridgeQuote}?${q.toString()}`));
  }

  /** The bank's health (FR-013): what is paused and why (plan P4-A error states). A down relay
   *  answers 503 with the same body. */
  async health(): Promise<HealthResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(API_PATHS.health), { cache: 'no-store' });
    } catch {
      throw new RelayError(0, 'unreachable', 'The bank could not be reached.');
    }
    const body: unknown = await res.json().catch(() => null);
    const h = HealthResponseSchema.safeParse(body);
    if (!h.success) throw new RelayError(res.status, 'error', '');
    return h.data;
  }

  /** How the bank closed a transfer recently, or null when it did not (plan P4-A, Q21 A). */
  async bridgeClosed(requestId: string): Promise<BridgeClosedResponse | null> {
    try {
      return BridgeClosedResponseSchema.parse(await this.call(API_PATHS.bridgeClosed(requestId)));
    } catch (e) {
      if (e instanceof RelayError && e.status === 404) return null;
      throw e;
    }
  }

  async zswap(account: string): Promise<ZswapActivity> {
    return ZswapActivitySchema.parse(await this.call(API_PATHS.accountZswap(account)));
  }
}
