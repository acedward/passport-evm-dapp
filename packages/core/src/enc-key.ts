// The account's inbox encryption key pair is X25519 (the Passport client's portable codec,
// vendor/passport/contract/src/wallet/deposit.ts `generateEncKeyPairPortable`). This light helper
// recomputes the public key from the secret, so an Import can check that a secret record is a
// consistent pair before it is written (security review F-B5).

import { x25519 } from '@noble/curves/ed25519.js';

import { bytesToHex, hexToBytes } from './hex.js';

/** The X25519 public key (64 hex) of a 32-byte secret key (64 hex, with or without 0x). */
export function encPublicKeyOf(secretKeyHex: string): string {
  return bytesToHex(x25519.getPublicKey(hexToBytes(secretKeyHex, 32)));
}
