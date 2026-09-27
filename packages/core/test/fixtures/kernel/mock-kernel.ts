// A mock offer-files kernel: answers the read routes the bank uses with the kernel's exact
// shapes and semantics (`ledger-v9` @ 5d46e8d, packages/node/api.ts): keyset paging on
// (blockHeight, offerId) newest first, `limit` capped at 100, `after_hash` resolved or refused
// with 400 INVALID_CURSOR, `token`/`direction` filters, 404 NOT_FOUND for an unknown offer,
// `base`/`quote` required on chart stats, CORS `*` on everything.
//
// It is a pure responder, so the Node tests serve it over HTTP (../../mock-kernel-server.ts)
// and the Playwright test serves it through `page.route`.

import { PAIRS, STATS, BOOK, COLOUR, matchesFilter, type WireOffer } from './book.js';

export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
};
const json = (status: number, value: unknown, extra: Record<string, string> = {}): MockResponse => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  body: JSON.stringify(value),
});

/** Newest first, as the kernel orders the book: (blockHeight, offerId) descending. */
function newestFirst(a: WireOffer, b: WireOffer): number {
  const ha = BigInt(a.blockHeight);
  const hb = BigInt(b.blockHeight);
  if (ha !== hb) return ha > hb ? -1 : 1;
  return a.offerId > b.offerId ? -1 : a.offerId < b.offerId ? 1 : 0;
}

export class KernelFixture {
  book: WireOffer[];
  /** Offers that left the book (a cursor on one still resolves, as in the kernel). */
  history: WireOffer[] = [];
  pairs: unknown[];
  stats: Record<string, object>;
  knownTokens: unknown[] = [];
  /** Every request seen: path and query. */
  readonly requests: Array<{ path: string; query: URLSearchParams }> = [];

  constructor(init: { book?: WireOffer[]; pairs?: unknown[]; stats?: Record<string, object> } = {}) {
    this.book = [...(init.book ?? BOOK)];
    this.pairs = init.pairs ?? PAIRS;
    this.stats = init.stats ?? {
      [COLOUR.wStkA]: STATS.wStkA,
      [COLOUR.wStkB]: STATS.wStkB,
      [COLOUR.wStkC]: STATS.wStkC,
    };
  }

  /** Answer one GET, as the kernel would. `target` is the path with its query string. */
  respond(target: string): MockResponse {
    const url = new URL(target, 'http://kernel.invalid');
    this.requests.push({ path: url.pathname, query: url.searchParams });
    const q = url.searchParams;
    if (url.pathname === '/v1/offers') return this.offers(q);
    if (url.pathname === '/v1/pairs') return json(200, this.pairs);
    if (url.pathname === '/v1/known-tokens') return json(200, this.knownTokens);
    if (url.pathname === '/v1/chart/stats') {
      const base = (q.get('base') ?? '').toLowerCase();
      const quote = (q.get('quote') ?? '').toLowerCase();
      if (!base || !quote) return json(400, { error: 'VALIDATION', reason: 'base and quote are required' });
      const s = this.stats[base] as { quote?: string } | undefined;
      if (s && s.quote === quote) return json(200, s);
      return json(200, { base, quote, last: 0, change24: 0, high: 0, low: 0, volume_base: 0, volume_quote: 0 });
    }
    const m = /^\/v1\/offers\/([^/]+)$/.exec(url.pathname);
    if (m && m[1] !== 'stream') {
      const hash = m[1]!.toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        return json(400, { error: 'INVALID_HASH', reason: 'expected 64 hex chars (sha256 of the raw offer bytes)' });
      }
      const live = this.book.find((o) => o.offerId === hash);
      const old = this.history.find((o) => o.offerId === hash);
      const o = live ?? old;
      if (!o) return json(404, { error: 'NOT_FOUND', offerId: hash });
      return json(200, {
        version: 1,
        offerId: o.offerId,
        offerBech32: `swapoffer1${o.offerId.slice(0, 16)}`,
        blockHeight: o.blockHeight,
        ttlSeconds: '1209600',
        computed: { ...o.computed, status: live ? 'live' : 'consumed' },
      });
    }
    return json(404, { error: 'NOT_FOUND' });
  }

  private offers(q: URLSearchParams): MockResponse {
    const raw = Number.parseInt(q.get('limit') ?? '', 10);
    let limit = Number.isFinite(raw) ? raw : 100;
    if (limit <= 0) limit = 100;
    if (limit > 100) limit = 100;
    const token = q.get('token') ?? '';
    const dirRaw = q.get('direction')?.toUpperCase();
    const direction = dirRaw === 'GIVING' || dirRaw === 'WANTING' ? dirRaw : undefined;
    let rows = this.book.filter((o) => matchesFilter(o, token || undefined, direction)).sort(newestFirst);
    const after = (q.get('after_hash') ?? '').toLowerCase();
    if (after) {
      if (!/^[0-9a-f]{64}$/.test(after)) {
        return json(400, { error: 'INVALID_CURSOR', reason: 'after_hash must be 64 hex chars (a next_cursor value)' });
      }
      const anchor = [...this.book, ...this.history].find((o) => o.offerId === after);
      if (!anchor) {
        return json(400, {
          error: 'INVALID_CURSOR',
          reason: 'unknown cursor — restart pagination from the first page',
        });
      }
      rows = rows.filter((o) => newestFirst(anchor, o) < 0);
    }
    const page = rows.slice(0, limit);
    return json(200, {
      offers: page,
      nextCursor: page.length === limit && page.length > 0 ? page[page.length - 1]!.offerId : null,
    });
  }
}

/** The kernel's first stream event. */
export const connectedEvent = (at = Date.now()) => `data: ${JSON.stringify({ type: 'connected', timestamp: at })}\n\n`;

/** One lifecycle event on the stream. */
export const streamEvent = (event: Record<string, unknown>, at = Date.now()) =>
  `data: ${JSON.stringify({ ...event, timestamp: at })}\n\n`;

export const STREAM_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  'access-control-allow-origin': '*',
};
