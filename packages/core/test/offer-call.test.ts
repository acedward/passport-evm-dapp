// Plan L-TRD: one trade = one wallet signature. The OpenSwapShielded typed data the wallet signs
// and the digest the relay rebuilds are the same thing, bound to the coin (mt_index included) and
// to every term of the offer. Also: the kernel client's two new calls (status, publish).

import { TypedDataEncoder, Wallet, recoverAddress } from 'ethers';
import { describe, expect, it } from 'vitest';

import { KernelClient } from '../src/market/kernel-client.js';
import { openSwapArgs, openSwapGatedCall } from '../src/passport/index.js';
import type { OpenSwapPayload } from '../src/trade.js';

const ACCOUNT = '5e'.repeat(32);
const SALT = '9a'.repeat(32);
const ctx = { account: ACCOUNT, authNonce: 2n, evmDomainSalt: SALT };
const payload: OpenSwapPayload = {
  giveColor: 'a1'.repeat(32),
  giveAmount: '2000000',
  wantColor: 'b2'.repeat(32),
  wantAmount: '2100000',
  wantNonce: '11'.repeat(32),
  wantEntry: '22'.repeat(192),
  changeEntry: '00'.repeat(192),
  validUntil: '0',
  coin: { nonce: '33'.repeat(32), color: 'a1'.repeat(32), value: '3000000', mtIndex: '9' },
  authNonce: '2',
};

const ethersDigest = (td: { domain: object; types: object; message: object }) => {
  const { EIP712Domain: _d, ...types } = td.types as Record<string, never>;
  return TypedDataEncoder.hash(td.domain as never, types, td.message as never);
};

describe('openSwapGatedCall', () => {
  it('builds OpenSwapShielded typed data whose EIP-712 hash is the relay’s digest, and a wallet signature recovers', async () => {
    const w = Wallet.createRandom();
    const call = openSwapGatedCall(ctx, w.address, payload);
    const td = call.typedData as unknown as { primaryType: string; domain: object; types: object; message: object };
    expect(td.primaryType).toBe('OpenSwapShielded');
    expect(ethersDigest(td)).toBe(call.digestHex);
    const { EIP712Domain: _d, ...types } = td.types as Record<string, never>;
    const sig = await w.signTypedData(td.domain as never, types, td.message as never);
    expect(recoverAddress(call.digestHex, sig)).toBe(w.address);
  });

  it('binds every term: the coin (mt_index, value), both legs, the want nonce, the entries, the nonce and the owner', () => {
    const owner = `0x${'77'.repeat(20)}`;
    const base = openSwapGatedCall(ctx, owner, payload).digestHex;
    const variants: Array<Partial<OpenSwapPayload>> = [
      { coin: { ...payload.coin, mtIndex: '10' } },
      { coin: { ...payload.coin, value: '3000001' } },
      { giveAmount: '2000001' },
      { wantAmount: '2100001' },
      { wantColor: 'b3'.repeat(32) },
      { wantNonce: '12'.repeat(32) },
      { wantEntry: '23'.repeat(192) },
      { changeEntry: '01'.repeat(192) },
    ];
    for (const v of variants) expect(openSwapGatedCall(ctx, owner, { ...payload, ...v }).digestHex).not.toBe(base);
    expect(openSwapGatedCall({ ...ctx, authNonce: 3n }, owner, payload).digestHex).not.toBe(base);
    expect(openSwapGatedCall(ctx, `0x${'78'.repeat(20)}`, payload).digestHex).not.toBe(base);
  });

  it('is always the OPEN shape (anyone may take it)', () => {
    const { call, coin } = openSwapArgs(payload);
    expect(call.recipientKind).toBe(0n);
    expect(call.recipient).toEqual(new Uint8Array(32));
    expect(coin.mt_index).toBe(9n);
    expect(call.want.value).toBe(2_100_000n);
  });
});

describe('the kernel client: offer status and publishing', () => {
  const answer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const client = (f: (url: string, init: RequestInit) => Promise<Response>) =>
    new KernelClient({ baseUrl: 'http://kernel.test', fetch: f, retries: 0, timeoutMs: 1000 });
  const id = 'ab'.repeat(32);

  it('reads a status, and maps an unexpected word to unknown', async () => {
    const seen: string[] = [];
    const k = client(async (url) => {
      seen.push(url);
      return answer(200, { offerId: id, status: url.includes('ab') ? 'consumed' : 'x' });
    });
    expect(await k.offerStatus(id)).toBe('consumed');
    expect(seen[0]).toBe(`http://kernel.test/v1/offers/${id}/status`);
    const odd = client(async () => answer(200, { offerId: id, status: 'weird' }));
    expect(await odd.offerStatus(id)).toBe('unknown');
    const nf = client(async () => answer(200, { offerId: id, status: 'not_found' }));
    expect(await nf.offerStatus(id)).toBe('not_found');
  });

  it('publishes with {"offer": …}; a 409 duplicate counts as accepted; a refusal carries the code', async () => {
    let body = '';
    const ok = client(async (_u, init) => {
      body = String(init.body);
      return answer(200, { success: true, offerId: id });
    });
    expect(await ok.postOffer('swapoffer1xyz')).toMatchObject({ accepted: true, duplicate: false, offerId: id });
    expect(JSON.parse(body)).toEqual({ offer: 'swapoffer1xyz' });
    const dup = client(async () => answer(409, { error: 'DUPLICATE_OFFER', offerId: id, status: 'live' }));
    expect(await dup.postOffer('swapoffer1xyz')).toMatchObject({ accepted: true, duplicate: true });
    const bad = client(async () => answer(400, { error: 'ROOT_UNKNOWN', reason: 'root not synced' }));
    expect(await bad.postOffer('swapoffer1xyz')).toMatchObject({
      accepted: false,
      code: 'ROOT_UNKNOWN',
      reason: 'root not synced',
      status: 400,
    });
  });
});
