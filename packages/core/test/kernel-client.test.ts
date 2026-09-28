// Plan L-MKT.1: the kernel client against a mock kernel over real HTTP (random port >= 10000),
// serving the exact shapes the staging kernel returns.

import { readFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  KernelClient,
  KernelError,
  SseParser,
  parseOffersPage,
  parseRetryAfter,
  type StreamEvent,
} from '../src/index.js';
import { BOOK, COLOUR, leg, offerRow, type WireOffer } from './fixtures/kernel/book.js';
import { KernelFixture } from './fixtures/kernel/mock-kernel.js';
import { startMockKernel, type MockKernelServer } from './mock-kernel-server.js';

const STAGING = new URL('./fixtures/kernel/staging-2026-09-27/', import.meta.url);
const staging = async (name: string) => readFile(new URL(name, STAGING), 'utf8');

let kernel: MockKernelServer;
const fast = (extra: Partial<ConstructorParameters<typeof KernelClient>[0]> = {}) =>
  new KernelClient({
    baseUrl: kernel.url,
    timeoutMs: 500,
    backoffMs: 20,
    maxBackoffMs: 2_000,
    random: () => 1,
    ...extra,
  });

beforeEach(async () => {
  kernel = await startMockKernel();
});
afterEach(async () => {
  await kernel.close();
});

describe('the captured staging responses parse', () => {
  it('an empty book, no pairs, the known tokens, zero stats', async () => {
    expect(parseOffersPage(JSON.parse(await staging('offers-limit5.json')))).toEqual({
      offers: [],
      nextCursor: null,
      skipped: 0,
    });
    const f = new KernelFixture({ book: [], pairs: JSON.parse(await staging('pairs.json')) });
    f.knownTokens = JSON.parse(await staging('known-tokens.json'));
    f.stats = {};
    await kernel.close();
    kernel = await startMockKernel(f);
    const c = fast();
    expect(await c.pairs()).toEqual([]);
    const known = await c.knownTokens();
    expect(known.map((t) => t.name)).toEqual(['NIGHT', 'TWBTC', 'TWETH', 'TWUSDC', 'TWUSDM', 'UTWUSDC', 'UTWBTC']);
    expect(known.find((t) => t.name === 'NIGHT')?.token_color).toBe(COLOUR.NIGHT);
    const stats = await c.chartStats(COLOUR.wStkA, COLOUR.wUSDC);
    expect(stats).toMatchObject({ base: COLOUR.wStkA, quote: COLOUR.wUSDC, last: '0', volume_base: '0' });
    // The mock's zero-stats answer is byte-identical to what staging sent for this pair.
    const served = kernel.fixture.respond(`/v1/chart/stats?base=${COLOUR.wStkA}&quote=${COLOUR.wUSDC}`).body;
    expect(served).toBe(await staging('chart-stats-wstka-wusdc.json'));
  });

  it('the stream’s first event', async () => {
    const items = new SseParser().push(await staging('offers-stream-first-event.txt'));
    expect(items).toHaveLength(1);
    expect(items[0]!.kind === 'message' && JSON.parse(items[0]!.message.data)).toMatchObject({ type: 'connected' });
  });
});

describe('GET /v1/offers', () => {
  it('reads a page with the legs as exact bigints', async () => {
    const page = await fast().offersPage({ limit: 5 });
    expect(page.offers).toHaveLength(5);
    expect(page.nextCursor).toBe(page.offers[4]!.offerId);
    const newest = BOOK[0]!;
    expect(page.offers[0]).toMatchObject({ offerId: newest.offerId, blockHeight: newest.blockHeight });
    expect(typeof page.offers[0]!.computed.gives[0]!.amount).toBe('bigint');
    expect(kernel.fixture.requests.at(-1)?.query.get('limit')).toBe('5');
  });

  it('walks every page with the keyset cursor, and de-duplicates', async () => {
    const many: WireOffer[] = [];
    for (let n = 1; n <= 250; n++) many.push(offerRow(1000 + n, [leg(COLOUR.wStkA, n)], [leg(COLOUR.wUSDC, n * 2)]));
    kernel.fixture.book = many;
    const all = await fast().allOffers();
    expect(all).toMatchObject({ complete: true, pages: 3, skipped: 0 });
    expect(new Set(all.offers.map((o) => o.offerId)).size).toBe(250);
    const q = kernel.fixture.requests.filter((r) => r.path === '/v1/offers').map((r) => r.query);
    expect(q.map((x) => x.get('limit'))).toEqual(['100', '100', '100']);
    expect(q[0]!.get('after_hash')).toBeNull();
    expect(q[1]!.get('after_hash')).toBe(all.offers[99]!.offerId);
    expect(q[2]!.get('after_hash')).toBe(all.offers[199]!.offerId);
  });

  it('a full last page ends with an empty follow-up page', async () => {
    kernel.fixture.book = BOOK.slice(0, 4);
    const all = await fast().allOffers({ pageSize: 2 });
    expect(all).toMatchObject({ complete: true, pages: 3 });
    expect(all.offers).toHaveLength(4);
  });

  it('stops at maxPages and says the book is incomplete', async () => {
    const all = await fast().allOffers({ pageSize: 2, maxPages: 2 });
    expect(all).toMatchObject({ complete: false, pages: 2 });
    expect(all.offers).toHaveLength(4);
  });

  it('passes the token and direction filters, normalised', async () => {
    const c = fast();
    const giving = await c.offersPage({ token: `0x${COLOUR.wStkA.toUpperCase()}`, direction: 'GIVING' });
    const q = kernel.fixture.requests.at(-1)!.query;
    expect([q.get('token'), q.get('direction')]).toEqual([COLOUR.wStkA, 'GIVING']);
    expect(giving.offers.every((o) => o.computed.gives.some((l) => l.token === COLOUR.wStkA))).toBe(true);
    expect(giving.offers).toHaveLength(3);
    const wanting = await c.offersPage({ token: COLOUR.wStkA, direction: 'WANTING' });
    expect(wanting.offers).toHaveLength(2);
    const usdc = await c.allOffers({ token: COLOUR.wUSDC });
    expect(usdc.offers).toHaveLength(9); // every offer with a wUSDC leg, whatever its layer
  });

  it('refuses bad queries before sending them', async () => {
    const c = fast();
    await expect(c.offersPage({ limit: 101 })).rejects.toThrow(RangeError);
    await expect(c.offersPage({ limit: 0 })).rejects.toThrow(RangeError);
    await expect(c.offersPage({ direction: 'GIVING' })).rejects.toThrow(/needs a token/);
    await expect(c.offersPage({ token: 'nope' })).rejects.toThrow();
    expect(kernel.fixture.requests).toHaveLength(0);
  });

  it('an unknown cursor is the kernel’s 400 INVALID_CURSOR, not a silent first page', async () => {
    const err = await fast()
      .offersPage({ afterHash: 'ab'.repeat(32) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KernelError);
    expect(err).toMatchObject({ kind: 'http', details: { status: 400, code: 'INVALID_CURSOR' } });
  });

  it('skips and counts a row it cannot read; refuses a broken envelope', async () => {
    const good = offerRow(1, [leg(COLOUR.wStkA, 1)], [leg(COLOUR.wUSDC, 1)]);
    const page = parseOffersPage({
      offers: [
        good,
        { ...good, offerId: 'x' },
        { ...good, computed: { ...good.computed, gives: [{ token: COLOUR.wStkA, amount: '-1', type: 'SHIELDED' }] } },
        { ...good, computed: { ...good.computed, gives: [{ token: COLOUR.wStkA, amount: 1e30, type: 'SHIELDED' }] } },
      ],
      nextCursor: null,
    });
    expect(page.offers).toHaveLength(1);
    expect(page.skipped).toBe(3);
    expect(() => parseOffersPage({ offers: 'no' })).toThrow(KernelError);
    expect(() => parseOffersPage({ offers: [], nextCursor: 'nope' })).toThrow(KernelError);
  });

  it('refuses a kernel that repeats a cursor (no endless loop)', async () => {
    const c = new KernelClient({
      baseUrl: 'http://127.0.0.1:1',
      fetch: async () =>
        new Response(
          JSON.stringify({
            offers: [offerRow(1, [leg(COLOUR.wStkA, 1)], [leg(COLOUR.wUSDC, 1)])],
            nextCursor: 'cd'.repeat(32),
          }),
          {
            status: 200,
          },
        ),
    });
    await expect(c.allOffers({ pageSize: 1 })).rejects.toMatchObject({ kind: 'invalid-response' });
  });
});

describe('GET /v1/offers/:offerId, /v1/pairs, /v1/chart/stats', () => {
  it('one offer with its string; null when unknown', async () => {
    const c = fast();
    const id = BOOK[0]!.offerId;
    const o = await c.offer(id.toUpperCase());
    expect(o).toMatchObject({ offerId: id, offerBech32: expect.stringMatching(/^swapoffer1/), ttlSeconds: '1209600' });
    expect(await c.offer('12'.repeat(32))).toBeNull();
  });

  it('pairs with numeric-string prices; stats oriented to the asked base', async () => {
    const c = fast();
    const pairs = await c.pairs();
    expect(pairs.find((p) => p.base_color === COLOUR.wUSDC)).toMatchObject({
      quote_color: COLOUR.wStkB,
      trade_count: 1,
      last_price: '102.04081632653061224490',
    });
    const s = await c.chartStats(COLOUR.wStkA, COLOUR.wUSDC);
    expect(s).toMatchObject({ base: COLOUR.wStkA, last: '1.02', volume_base: '30000000' });
    const req = kernel.fixture.requests.at(-1)!;
    expect([req.path, req.query.get('base'), req.query.get('quote')]).toEqual([
      '/v1/chart/stats',
      COLOUR.wStkA,
      COLOUR.wUSDC,
    ]);
  });

  it('a response in the wrong shape is invalid, not guessed at', async () => {
    kernel.fixture.pairs = [{ pair_key: 'x' }];
    await expect(fast().pairs()).rejects.toMatchObject({ kind: 'invalid-response' });
    kernel.fault('/v1/pairs', { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>' });
    await expect(fast().pairs()).rejects.toMatchObject({ kind: 'invalid-response' });
  });
});

describe('timeouts, retries and back-off', () => {
  it('times out a kernel that never answers, after retrying', async () => {
    kernel.fault('/v1/pairs', 'hang', 3);
    const t0 = Date.now();
    await expect(fast({ timeoutMs: 150, retries: 2 }).pairs()).rejects.toMatchObject({ kind: 'timeout' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(3 * 150);
  });

  it('retries a dropped connection and a 503, then succeeds', async () => {
    kernel.fault('/v1/pairs', 'drop', 1);
    kernel.fault('/v1/pairs', { status: 503 }, 1);
    expect(await fast().pairs()).toHaveLength(3);
  });

  it('a stopped kernel is a network error', async () => {
    await kernel.stop();
    await expect(fast({ retries: 1 }).pairs()).rejects.toMatchObject({ kind: 'network' });
    await kernel.resume();
    expect(await fast().pairs()).toHaveLength(3);
  });

  it('429: honours Retry-After, cools every later request down, then succeeds', async () => {
    kernel.fault('/v1/pairs', { status: 429, headers: { 'retry-after': '1' }, body: '{"error":"RATE_LIMITED"}' }, 1);
    const c = fast({ maxBackoffMs: 5_000 });
    const t0 = Date.now();
    expect(await c.pairs()).toHaveLength(3);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
  });

  it('429 without a readable Retry-After (the browser under CORS) backs off exponentially', async () => {
    kernel.fault('/v1/pairs', { status: 429, body: '{"error":"RATE_LIMITED"}' }, 5);
    const c = fast({ retries: 2, backoffMs: 50 });
    const err = await c.pairs().catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'rate-limited', details: { status: 429, code: 'RATE_LIMITED' } });
    // The cool-down outlives the error, so the next refresh waits it out.
    expect(c.cooldownRemaining()).toBeGreaterThan(0);
  });

  it('a 4xx other than 429 is not retried', async () => {
    kernel.fault('/v1/pairs', { status: 400, body: '{"error":"VALIDATION"}' }, 5);
    await expect(fast().pairs()).rejects.toMatchObject({ kind: 'http', details: { status: 400, code: 'VALIDATION' } });
    expect(kernel.log.filter((p) => p === '/v1/pairs')).toHaveLength(1);
  });

  it('aborting cancels at once', async () => {
    kernel.fault('/v1/pairs', 'hang', 1);
    const ctrl = new AbortController();
    const p = fast({ timeoutMs: 5_000 }).pairs(ctrl.signal);
    setTimeout(() => ctrl.abort(), 50);
    await expect(p).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('reads Retry-After as seconds or a date', () => {
    expect(parseRetryAfter('5', 0)).toBe(5_000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter('soon', 0)).toBeNull();
  });
});

describe('GET /v1/offers/stream', () => {
  it('delivers the kernel’s events and heartbeats, and stops on abort', async () => {
    const events: StreamEvent[] = [];
    let beats = 0;
    let opened = false;
    const ctrl = new AbortController();
    const done = fast().offerStream(
      { onOpen: () => (opened = true), onEvent: (e) => events.push(e), onHeartbeat: () => beats++ },
      ctrl.signal,
    );
    await until(() => kernel.streams.size === 1 && events.length === 1);
    kernel.heartbeat();
    kernel.broadcast({
      type: 'offer_indexed',
      offerId: 7,
      offerHash: 'ab'.repeat(32),
      blockHeight: '12',
      gives: [],
      wants: [],
    });
    kernel.broadcast({ type: 'offer_consumed', offerId: 7, offerHash: 'ab'.repeat(32) });
    await until(() => events.length === 3 && beats === 1);
    expect(opened).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['connected', 'offer_indexed', 'offer_consumed']);
    expect(events[1]).toMatchObject({ offerHash: 'ab'.repeat(32), blockHeight: '12' });
    ctrl.abort();
    await expect(done).resolves.toBeUndefined();
  });

  it('503 SSE_CAPACITY surfaces with its Retry-After', async () => {
    kernel.fault('/v1/offers/stream', {
      status: 503,
      headers: { 'retry-after': '5', 'content-type': 'application/json' },
      body: '{"error":"SSE_CAPACITY"}',
    });
    await expect(fast().offerStream({ onEvent: () => undefined })).rejects.toMatchObject({
      kind: 'http',
      details: { status: 503, retryAfterMs: 5_000 },
    });
  });

  it('a silent stream is dropped after the idle limit', async () => {
    const p = fast({ streamIdleMs: 200 }).offerStream({ onEvent: () => undefined });
    await expect(p).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('the server closing the stream resolves', async () => {
    const p = fast().offerStream({ onEvent: () => undefined });
    await until(() => kernel.streams.size === 1);
    for (const s of kernel.streams) s.end();
    await expect(p).resolves.toBeUndefined();
  });
});

describe('the SSE parser', () => {
  it('handles split chunks, CRLF, multi-line data, comments and unknown fields', () => {
    const p = new SseParser();
    expect(p.push('data: {"a"')).toEqual([]);
    expect(p.push(':1}\r')).toEqual([]);
    const out = p.push('\n\r\n: heartbeat\n\nevent: x\nid: 3\nretry: 10\ndata: l1\ndata:l2\nfoo: bar\n\n');
    expect(out).toEqual([
      { kind: 'message', message: { event: 'message', data: '{"a":1}', id: null } },
      { kind: 'comment', text: 'heartbeat' },
      { kind: 'message', message: { event: 'x', data: 'l1\nl2', id: '3' } },
    ]);
  });
});

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}
