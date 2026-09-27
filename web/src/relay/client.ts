// The browser's client for the MN Bank relay: nonces, the one action route, job polling (the
// browser keeps the request id, so a job resumes after a reload, Q5), and the account's public
// chain reads. Every response is validated against the shared schemas.

import {
  API_PATHS,
  AccountStateViewSchema,
  ApiErrorSchema,
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

export class RelayError extends Error {
  override name = 'RelayError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
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
      throw new RelayError(0, 'unreachable', 'The bank could not be reached. Check your connection and try again.');
    }
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const e = ApiErrorSchema.safeParse(body);
      throw e.success
        ? new RelayError(res.status, e.data.error.code, e.data.error.message, e.data.error.detail)
        : new RelayError(res.status, 'error', `The bank answered ${res.status}.`);
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

  async zswap(account: string): Promise<ZswapActivity> {
    return ZswapActivitySchema.parse(await this.call(API_PATHS.accountZswap(account)));
  }
}
