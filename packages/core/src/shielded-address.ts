// A Midnight shielded wallet address (`mn_shield-addr_<network>1…`), as the wallet SDK encodes it
// (@midnightntwrk/wallet-sdk-address-format `ShieldedAddress`): bech32m over the wallet's coin
// public key (32 bytes) followed by its encryption public key (32 bytes). A payment to a wallet
// needs both: the coin is owned by the coin key, and its ciphertext is sealed to the encryption key
// so the wallet can find it (midnight-js refuses a recipient whose encryption key it cannot resolve).

import { bech32m } from '@scure/base';

import { bytesToHex } from './hex.js';

export class ShieldedAddressError extends Error {
  override name = 'ShieldedAddressError';
}

export interface ShieldedAddress {
  coinPublicKey: string;
  encryptionPublicKey: string;
  network: string;
}

/** Decode a shielded address for `network` ('mainnet' has no network segment). */
export function parseShieldedAddress(text: string, network: string): ShieldedAddress {
  let decoded: { prefix: string; bytes: Uint8Array };
  try {
    decoded = bech32m.decodeToBytes(text.trim() as `${string}1${string}`);
  } catch {
    throw new ShieldedAddressError('This is not a Midnight address.');
  }
  const [prefix, type, net = 'mainnet'] = decoded.prefix.split('_');
  if (prefix !== 'mn' || type !== 'shield-addr')
    throw new ShieldedAddressError('This is not a shielded wallet address.');
  if (net !== network) throw new ShieldedAddressError(`This address is for the ${net} network, not ${network}.`);
  if (decoded.bytes.length !== 64) throw new ShieldedAddressError('This shielded address has the wrong length.');
  return {
    coinPublicKey: bytesToHex(decoded.bytes.slice(0, 32)),
    encryptionPublicKey: bytesToHex(decoded.bytes.slice(32)),
    network: net,
  };
}

/** Encode (tests, and showing an address the bank knows). */
export function formatShieldedAddress(a: Omit<ShieldedAddress, 'network'>, network: string): string {
  const bytes = new Uint8Array(64);
  const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
  bytes.set(hex(a.coinPublicKey), 0);
  bytes.set(hex(a.encryptionPublicKey), 32);
  const prefix = network === 'mainnet' ? 'mn_shield-addr' : `mn_shield-addr_${network}`;
  return bech32m.encode(prefix, bech32m.toWords(bytes), false);
}
