// A read-only client for the offer-files kernel (the ZSwap exchange's API), shared by the web
// app and the tests. The browser calls the kernel directly: it serves CORS `*`.
//
// It never uses `/v1/prices` or `/v1/quote` (reference prices from CoinGecko or manual rows):
// the bank's prices come from the live offers only (spec FR-007).
//
// Failure handling:
// - every request has a timeout (the body read included);
// - 429 (the kernel allows 600 requests a minute per IP) sets a cool-down that every later
//   request waits out, honouring Retry-After when the browser may read it (CORS does not
//   expose it, so the browser falls back to exponential back-off);
// - network errors, timeouts, 429, 502, 503 and 504 are retried a few times, then surface as a
//   `KernelError`, which the UI shows as "exchange unavailable".

import { normaliseHex32 } from '../hex.js';
import { SseParser } from './sse.js';
import {
  type ChartStats,
  ChartStatsSchema,
  type KnownToken,
  KnownTokensSchema,
  type OfferDetail,
  OfferDetailSchema,
  type OfferRow,
  OfferRowSchema,
  OffersPageSchema,
  type Pair,
  PairsSchema,
  type StreamEvent,
  StreamEventSchema,
} from './wire.js';

export type KernelErrorKind = 'timeout' | 'network' | 'http' | 'rate-limited' | 'invalid-response' | 'aborted';

export class KernelError extends Error {
  override name = 'KernelError';
  constructor(
    readonly kind: KernelErrorKind,
    message: string,
    readonly details: { status?: number; code?: string; retryAfterMs?: number } = {},
  ) {
    super(message);
  }
}

export type OfferDirection = 'GIVING' | 'WANTING';

/** The part of `fetch` the client uses (GET with headers and a signal). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OffersQuery {
  /** Only offers with a leg of this colour (64 hex, any case, with or without 0x). */
  token?: string;
  /** With `token`: only offers that GIVE it, or only offers that WANT it. */
  direction?: OfferDirection;
  /** Page size, 1–100 (the kernel caps at 100). */
  limit?: number;
  /** The previous page's `nextCursor`. */
  afterHash?: string;
}

export interface OffersPage {
  offers: OfferRow[];
  nextCursor: string | null;
  /** Rows the bank could not read (skipped, never guessed at). */
  skipped: number;
}

export interface AllOffers {
  offers: OfferRow[];
  /** False when `maxPages` stopped the walk before the kernel said the book was exhausted. */
  complete: boolean;
  pages: number;
  skipped: number;
}

export interface OfferStreamHandlers {
  /** The stream is open (HTTP 200, event-stream). */
  onOpen?(): void;
  /** One event, parsed (`connected`, `offer_indexed`, `offer_consumed`, …). */
  onEvent(event: StreamEvent): void;
  /** The kernel's keep-alive comment (every 30 s). */
  onHeartbeat?(): void;
}

export interface KernelClientOptions {
  /** The kernel's base URL, for example https://stagenet.api-zswap.zkdojo.com */
  baseUrl: string;
  fetch?: FetchLike;
  /** Per-request timeout, headers and body, in ms (default 10 s). */
  timeoutMs?: number;
  /** Retries after the first attempt, for network errors, timeouts, 429 and 5xx (default 2). */
  retries?: number;
  /** First back-off step in ms (default 1 s); doubles per attempt, with jitter. */
  backoffMs?: number;
  /** Longest back-off or cool-down in ms (default 60 s). */
  maxBackoffMs?: number;
  /** The offer stream is dropped after this long without a byte (default 75 s; the kernel sends a
   *  heartbeat every 30 s). */
  streamIdleMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);

function abortError(): KernelError {
  return new KernelError('aborted', 'the request was cancelled');
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Retry-After as milliseconds from now: delta-seconds or an HTTP date; null if absent/invalid. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null || value.trim() === '') return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function errorCode(text: string): string | undefined {
  try {
    const j = JSON.parse(text) as { error?: unknown };
    return typeof j.error === 'string' ? j.error : undefined;
  } catch {
    return undefined;
  }
}

/** Parse one `GET /v1/offers` response. Rows that do not parse are skipped and counted. */
export function parseOffersPage(json: unknown): OffersPage {
  const env = OffersPageSchema.safeParse(json);
  if (!env.success) throw new KernelError('invalid-response', 'the offer list is not in the expected shape');
  const offers: OfferRow[] = [];
  let skipped = 0;
  for (const raw of env.data.offers) {
    const row = OfferRowSchema.safeParse(raw);
    if (row.success) offers.push(row.data);
    else skipped++;
  }
  return { offers, nextCursor: env.data.nextCursor, skipped };
}

export class KernelClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly streamIdleMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  /** No request is sent before this time (set by a 429). */
  private cooldownUntil = 0;

  constructor(options: KernelClientOptions) {
    let base: URL;
    try {
      base = new URL(options.baseUrl);
    } catch {
      throw new RangeError(`not a URL: ${options.baseUrl}`);
    }
    if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new RangeError('the kernel URL must be http(s)');
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    // Bound to globalThis: a bare `fetch` reference called as a method fails in some browsers.
    this.fetchImpl = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.retries = options.retries ?? 2;
    this.backoffMs = options.backoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.streamIdleMs = options.streamIdleMs ?? 75_000;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /** Milliseconds until the 429 cool-down ends (0 when none). */
  cooldownRemaining(): number {
    return Math.max(0, this.cooldownUntil - this.now());
  }

  private backoff(attempt: number): number {
    const full = Math.min(this.maxBackoffMs, this.backoffMs * 2 ** attempt);
    return Math.round(full * (0.5 + this.random() / 2));
  }

  private url(path: string, query: Record<string, string | undefined> = {}): string {
    const q = Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined);
    const qs = q.length === 0 ? '' : `?${new URLSearchParams(q).toString()}`;
    return `${this.baseUrl}${path}${qs}`;
  }

  /** One GET with the timeout covering headers and body. */
  private async fetchOnce(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ status: number; retryAfter: string | null; text: string }> {
    if (signal?.aborted) throw abortError();
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, this.timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: ctrl.signal,
      });
      const text = await res.text();
      return { status: res.status, retryAfter: res.headers.get('retry-after'), text };
    } catch {
      if (signal?.aborted) throw abortError();
      if (timedOut) throw new KernelError('timeout', `no answer from the exchange within ${this.timeoutMs} ms`);
      throw new KernelError('network', 'the exchange could not be reached');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async waitCooldown(signal?: AbortSignal): Promise<void> {
    const wait = this.cooldownRemaining();
    if (wait > 0) await this.sleep(wait, signal);
  }

  /** GET a JSON document, with the retry and back-off rules above. `null` for an allowed 404. */
  private async getJson(
    path: string,
    query: Record<string, string | undefined>,
    signal?: AbortSignal,
    allow404 = false,
  ) {
    const url = this.url(path, query);
    for (let attempt = 0; ; attempt++) {
      await this.waitCooldown(signal);
      let res: { status: number; retryAfter: string | null; text: string };
      try {
        res = await this.fetchOnce(url, signal);
      } catch (e) {
        const err = e as KernelError;
        if (err.kind === 'aborted' || attempt >= this.retries) throw err;
        await this.sleep(this.backoff(attempt), signal);
        continue;
      }
      if (res.status >= 200 && res.status < 300) {
        try {
          return JSON.parse(res.text) as unknown;
        } catch {
          throw new KernelError('invalid-response', `${path}: the exchange sent something that is not JSON`, {
            status: res.status,
          });
        }
      }
      if (res.status === 404 && allow404) return null;
      const code = errorCode(res.text);
      if (RETRY_STATUSES.has(res.status)) {
        const hinted = parseRetryAfter(res.retryAfter, this.now());
        const delay = Math.min(this.maxBackoffMs, hinted ?? this.backoff(attempt));
        if (res.status === 429) this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + delay);
        if (attempt < this.retries) {
          // A 429 is waited out by waitCooldown at the top of the loop.
          if (res.status !== 429) await this.sleep(delay, signal);
          continue;
        }
        throw new KernelError(
          res.status === 429 ? 'rate-limited' : 'http',
          res.status === 429 ? 'the exchange is rate-limiting this browser' : `the exchange answered ${res.status}`,
          { status: res.status, code, retryAfterMs: delay },
        );
      }
      throw new KernelError('http', `${path}: the exchange answered ${res.status}${code ? ` (${code})` : ''}`, {
        status: res.status,
        code,
      });
    }
  }

  /** `GET /v1/offers`: one page of the live book, newest first. */
  async offersPage(query: OffersQuery = {}, signal?: AbortSignal): Promise<OffersPage> {
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('limit must be 1–100');
    if (query.direction !== undefined && query.token === undefined) {
      throw new RangeError('a direction filter needs a token');
    }
    const json = await this.getJson(
      '/v1/offers',
      {
        token: query.token === undefined ? undefined : normaliseHex32(query.token),
        direction: query.direction,
        limit: String(limit),
        after_hash: query.afterHash === undefined ? undefined : normaliseHex32(query.afterHash),
      },
      signal,
    );
    return parseOffersPage(json);
  }

  /** Every live offer matching the filters, following `nextCursor` (keyset paging) up to
   *  `maxPages`. Rows are de-duplicated by offer id. */
  async allOffers(
    query: Omit<OffersQuery, 'afterHash' | 'limit'> & { pageSize?: number; maxPages?: number } = {},
    signal?: AbortSignal,
  ): Promise<AllOffers> {
    const maxPages = query.maxPages ?? 20;
    const seenCursors = new Set<string>();
    const byId = new Map<string, OfferRow>();
    let cursor: string | undefined;
    let skipped = 0;
    for (let pages = 1; ; pages++) {
      const page = await this.offersPage(
        { token: query.token, direction: query.direction, limit: query.pageSize ?? 100, afterHash: cursor },
        signal,
      );
      skipped += page.skipped;
      for (const o of page.offers) if (!byId.has(o.offerId)) byId.set(o.offerId, o);
      if (page.nextCursor === null || page.offers.length === 0) {
        return { offers: [...byId.values()], complete: true, pages, skipped };
      }
      if (seenCursors.has(page.nextCursor)) {
        throw new KernelError('invalid-response', 'the offer list repeats a page cursor');
      }
      seenCursors.add(page.nextCursor);
      if (pages >= maxPages) return { offers: [...byId.values()], complete: false, pages, skipped };
      cursor = page.nextCursor;
    }
  }

  /** `GET /v1/offers/:offerId`: one offer with its `swapoffer1…` string; null if unknown. */
  async offer(offerId: string, signal?: AbortSignal): Promise<OfferDetail | null> {
    const json = await this.getJson(`/v1/offers/${normaliseHex32(offerId)}`, {}, signal, true);
    if (json === null) return null;
    const parsed = OfferDetailSchema.safeParse(json);
    if (!parsed.success) throw new KernelError('invalid-response', 'the offer is not in the expected shape');
    return parsed.data;
  }

  /** `GET /v1/pairs`: every pair with fills or open (non-basket) offers. */
  async pairs(signal?: AbortSignal): Promise<Pair[]> {
    const parsed = PairsSchema.safeParse(await this.getJson('/v1/pairs', {}, signal));
    if (!parsed.success) throw new KernelError('invalid-response', 'the pair list is not in the expected shape');
    return parsed.data;
  }

  /** `GET /v1/chart/stats?base=&quote=`: 24 h statistics re-oriented to `base`. */
  async chartStats(base: string, quote: string, signal?: AbortSignal): Promise<ChartStats> {
    const parsed = ChartStatsSchema.safeParse(
      await this.getJson('/v1/chart/stats', { base: normaliseHex32(base), quote: normaliseHex32(quote) }, signal),
    );
    if (!parsed.success) throw new KernelError('invalid-response', 'the pair statistics are not in the expected shape');
    return parsed.data;
  }

  /** `GET /v1/known-tokens`: the names the exchange has registered for colours. */
  async knownTokens(signal?: AbortSignal): Promise<KnownToken[]> {
    const parsed = KnownTokensSchema.safeParse(await this.getJson('/v1/known-tokens', {}, signal));
    if (!parsed.success) throw new KernelError('invalid-response', 'the token list is not in the expected shape');
    return parsed.data;
  }

  /**
   * `GET /v1/offers/stream`: read the kernel's server-sent events until the server closes the
   * stream (resolves) or it fails (rejects with a KernelError: no answer within the timeout, a
   * non-200 answer such as 503 when the stream slots are full, or silence for `streamIdleMs`).
   * Abort `signal` to stop; that resolves.
   */
  async offerStream(handlers: OfferStreamHandlers, signal?: AbortSignal): Promise<void> {
    await this.waitCooldown(signal);
    const ctrl = new AbortController();
    let why: 'connect' | 'idle' | null = null;
    let timer = setTimeout(() => {
      why = 'connect';
      ctrl.abort();
    }, this.timeoutMs);
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        why = 'idle';
        ctrl.abort();
      }, this.streamIdleMs);
    };
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(this.url('/v1/offers/stream'), {
          method: 'GET',
          headers: { accept: 'text/event-stream' },
          signal: ctrl.signal,
        });
      } catch {
        if (signal?.aborted) return;
        if (why === 'connect') throw new KernelError('timeout', 'the offer stream did not open in time');
        throw new KernelError('network', 'the offer stream could not be reached');
      }
      const type = res.headers.get('content-type') ?? '';
      if (res.status !== 200 || !type.includes('text/event-stream') || !res.body) {
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), this.now()) ?? undefined;
        await res.body?.cancel().catch(() => undefined);
        throw new KernelError(res.status === 429 ? 'rate-limited' : 'http', `the offer stream answered ${res.status}`, {
          status: res.status,
          retryAfterMs,
        });
      }
      arm();
      handlers.onOpen?.();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          if (signal?.aborted) return;
          if (why === 'idle') throw new KernelError('timeout', 'the offer stream went quiet');
          throw new KernelError('network', 'the offer stream was interrupted');
        }
        if (chunk.done) return;
        arm();
        for (const item of parser.push(decoder.decode(chunk.value, { stream: true }))) {
          if (item.kind === 'comment') {
            handlers.onHeartbeat?.();
            continue;
          }
          let data: unknown;
          try {
            data = JSON.parse(item.message.data);
          } catch {
            continue; // not JSON: not an event we know
          }
          const ev = StreamEventSchema.safeParse(data);
          if (ev.success) handlers.onEvent(ev.data);
        }
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      ctrl.abort();
    }
  }
}
