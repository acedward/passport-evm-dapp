// The MIP-0005 offer-file codec: a proven, imbalanced Midnight transaction as `swapoffer1…`.
//
// The kernel's `POST /v1/offers` takes `{"offer": "swapoffer1…"}` and `GET /v1/offers/:id` returns
// the same string as `offerBech32` (plan finding 12). The encoding is bech32m with the
// human-readable part `swapoffer` over the raw `Transaction.serialize()` bytes, WITHOUT bech32's
// 90-character limit; the offer id is the lowercase hex SHA-256 of those bytes, never of the string.
//
// Written against @effectstream/mip-zswap-offer 0.4.0-v9.0 (`src/mip5/OfferFiles.ts`), which is
// what the kernel uses; G-TAKE cross-checked it against that package inside the stack image, and
// offer-file.test.ts pins one vector from it. Moved here from test/gates/take/offer-codec.ts (plan
// L-TRD) and made browser-safe: SHA-256 from @noble/hashes instead of node:crypto.

import { sha256 } from '@noble/hashes/sha2.js';
import { bech32m } from '@scure/base';

import { bytesToHex } from '../hex.js';

export const OFFER_HRP = 'swapoffer';

/** `@scure/base` takes `false` to skip the 90-character limit. */
const NO_LIMIT = false as const;

export class OfferCodecError extends Error {
  override name = 'OfferCodecError';
}

/** Raw transaction bytes → `swapoffer1…`. */
export function encodeOffer(transactionBytes: Uint8Array): string {
  if (!(transactionBytes instanceof Uint8Array) || transactionBytes.length === 0) {
    throw new OfferCodecError('an offer is a non-empty byte string');
  }
  return bech32m.encode(OFFER_HRP, bech32m.toWords(transactionBytes), NO_LIMIT);
}

/** `swapoffer1…` → raw transaction bytes. Throws on a wrong prefix or a bad checksum. */
export function decodeOffer(text: string): Uint8Array {
  const trimmed = String(text ?? '').trim();
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32m.decode(trimmed as `${string}1${string}`, NO_LIMIT);
  } catch (e) {
    throw new OfferCodecError(`not a bech32m offer: ${(e as Error).message}`);
  }
  if (decoded.prefix !== OFFER_HRP) {
    throw new OfferCodecError(`expected the "${OFFER_HRP}" prefix, found "${decoded.prefix}"`);
  }
  return Uint8Array.from(bech32m.fromWords(decoded.words));
}

/** The kernel's offer id: SHA-256 of the raw bytes, lowercase hex. */
export function offerIdOf(transactionBytes: Uint8Array): string {
  return bytesToHex(sha256(transactionBytes));
}
