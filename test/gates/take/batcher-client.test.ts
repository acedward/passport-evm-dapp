import { describe, expect, it } from 'vitest';

import { BALANCER_TARGET, MAX_INPUT_CHARS, batcherBody, submitToBatcher } from './batcher-client.js';

const fixed = () => new Date('2026-09-27T20:00:00.000Z');

function fakeFetch(status: number, answer: unknown, seen: Array<{ url: string; body: unknown }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(typeof answer === 'string' ? answer : JSON.stringify(answer), { status });
  }) as typeof fetch;
}

describe('the batcher envelope', () => {
  it('is the zswap SPA body, byte for byte', () => {
    const { body, inputChars } = batcherBody({
      batcherUrl: 'http://batcher:3334',
      txHex: '0xABcd',
      address: 'mn_addr_undeployed1xyz',
      now: fixed,
    });
    expect(body).toEqual({
      data: {
        address: 'mn_addr_undeployed1xyz',
        addressType: 5,
        input: '{"tx":"abcd","txStage":"finalized"}',
        timestamp: '2026-09-27T20:00:00.000Z',
        target: BALANCER_TARGET,
      },
      confirmationLevel: 'wait-receipt',
      timeoutMs: 600_000,
    });
    expect(inputChars).toBe('{"tx":"abcd","txStage":"finalized"}'.length);
  });

  it('refuses a non-hex or oversized settlement before sending', () => {
    expect(() => batcherBody({ batcherUrl: 'x', txHex: 'zz', address: 'a' })).toThrow(/not hex/);
    const big = 'ab'.repeat(MAX_INPUT_CHARS / 2);
    expect(() => batcherBody({ batcherUrl: 'x', txHex: big, address: 'a' })).toThrow(/at most/);
  });
});

describe('submitting', () => {
  it('reports a settled take with its hash', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const r = await submitToBatcher({
      batcherUrl: 'http://batcher:3334/',
      txHex: 'ab',
      address: 'a',
      now: fixed,
      fetchImpl: fakeFetch(200, { success: true, transactionHash: '00ff' }, seen),
    });
    expect(r).toMatchObject({ ok: true, httpStatus: 200, transactionHash: '00ff' });
    expect(r.error).toBeUndefined();
    expect(seen[0]!.url).toBe('http://batcher:3334/send-input');
  });

  it('reports a refusal with the batcher text, whatever the HTTP status', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const refused = await submitToBatcher({
      batcherUrl: 'http://b',
      txHex: 'ab',
      address: 'a',
      fetchImpl: fakeFetch(200, { success: false, message: 'Transaction is not balanced' }, seen),
    });
    expect(refused).toMatchObject({ ok: false, httpStatus: 200, error: 'Transaction is not balanced' });
    const http = await submitToBatcher({
      batcherUrl: 'http://b',
      txHex: 'ab',
      address: 'a',
      fetchImpl: fakeFetch(400, { error: { code: 'X', detail: 'bad' } }, seen),
    });
    expect(http).toMatchObject({ ok: false, httpStatus: 400, error: '{"code":"X","detail":"bad"}' });
    const text = await submitToBatcher({
      batcherUrl: 'http://b',
      txHex: 'ab',
      address: 'a',
      fetchImpl: fakeFetch(502, 'Bad gateway', seen),
    });
    expect(text).toMatchObject({ ok: false, httpStatus: 502, error: 'Bad gateway', body: 'Bad gateway' });
  });
});
