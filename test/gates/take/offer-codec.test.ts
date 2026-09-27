import { describe, expect, it } from 'vitest';

import { OFFER_HRP, OfferCodecError, decodeOffer, encodeOffer, offerIdOf } from './offer-codec.js';

// Computed with @effectstream/mip-zswap-offer 0.4.0-v9.0 (`OfferFiles.encode` / `offerId`), the
// kernel's own codec, inside the stack image: bytes[i] = (i * 37 + 11) & 0xff, i < 120.
const VECTOR_BYTES = Uint8Array.from({ length: 120 }, (_, i) => (i * 37 + 11) & 0xff);
const VECTOR_BLOB =
  'swapoffer1pvc9275lcn5suv6c0k3v0mq3xedcpfw2au2rjh5r4rxly9euvxr2h584rglkfzdw60up6sn83jcad7eqg44gldxelc35smvjklwqzfjtwz2m4hcy99888x9augrjc5tkn0qw2z3023ueaslgp5e9wl9pcm43qd2607jvnmsn8pwc9f7v7ytrkcy94t8lgxf7atkhzf';
const VECTOR_ID = '5df24dd802ac26132ce608dcb5f09841eef039ee0f152acf98d26d17fe4e88e6';

describe('the swapoffer1 codec', () => {
  it('matches the kernel library byte for byte', () => {
    expect(encodeOffer(VECTOR_BYTES)).toBe(VECTOR_BLOB);
    expect(Array.from(decodeOffer(VECTOR_BLOB))).toEqual(Array.from(VECTOR_BYTES));
    expect(offerIdOf(VECTOR_BYTES)).toBe(VECTOR_ID);
  });

  it('round-trips transactions far longer than bech32 allows', () => {
    const bytes = Uint8Array.from({ length: 30_000 }, (_, i) => (i * 7) & 0xff);
    const blob = encodeOffer(bytes);
    expect(blob.startsWith(`${OFFER_HRP}1`)).toBe(true);
    expect(blob.length).toBeGreaterThan(90);
    expect(decodeOffer(`  ${blob}\n`)).toEqual(bytes);
  });

  it('refuses another prefix, a broken checksum and empty input', () => {
    const other = VECTOR_BLOB.replace(/^swapoffer1/, 'swapofer1');
    expect(() => decodeOffer(other)).toThrow(OfferCodecError);
    const flipped = VECTOR_BLOB.slice(0, -1) + (VECTOR_BLOB.endsWith('q') ? 'p' : 'q');
    expect(() => decodeOffer(flipped)).toThrow(OfferCodecError);
    expect(() => encodeOffer(new Uint8Array(0))).toThrow(OfferCodecError);
  });

  it('hashes the bytes, never the string', () => {
    expect(offerIdOf(decodeOffer(VECTOR_BLOB))).toBe(VECTOR_ID);
    expect(offerIdOf(new TextEncoder().encode(VECTOR_BLOB))).not.toBe(VECTOR_ID);
  });
});
