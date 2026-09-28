// The browser decodes a payee's shielded address itself (packages/core/src/shielded-address.ts);
// this checks it against the wallet SDK's own codec (@midnightntwrk/wallet-sdk-address-format).

import {
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from '@midnightntwrk/wallet-sdk-address-format';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { ShieldedAddressError, formatShieldedAddress, parseShieldedAddress } from '@mnbank/core';

describe('shielded addresses', () => {
  it('decodes what the wallet SDK encodes, and encodes what it decodes', () => {
    for (const network of ['undeployed', 'stagenet', 'preprod']) {
      const cpk = randomBytes(32).toString('hex');
      const epk = randomBytes(32).toString('hex');
      const sdk = MidnightBech32m.encode(
        network,
        new ShieldedAddress(
          ShieldedCoinPublicKey.fromHexString(cpk),
          new ShieldedEncryptionPublicKey(Buffer.from(epk, 'hex')),
        ),
      ).asString();
      expect(parseShieldedAddress(sdk, network)).toEqual({ coinPublicKey: cpk, encryptionPublicKey: epk, network });
      expect(formatShieldedAddress({ coinPublicKey: cpk, encryptionPublicKey: epk }, network)).toBe(sdk);
    }
  });

  it('refuses another network, another kind of address, and garbage', () => {
    const a = formatShieldedAddress(
      { coinPublicKey: '11'.repeat(32), encryptionPublicKey: '22'.repeat(32) },
      'stagenet',
    );
    expect(() => parseShieldedAddress(a, 'undeployed')).toThrow(/stagenet network/);
    expect(() => parseShieldedAddress('hello', 'undeployed')).toThrow(ShieldedAddressError);
    const cpkOnly = ShieldedCoinPublicKey.codec
      .encode('undeployed', ShieldedCoinPublicKey.fromHexString('33'.repeat(32)))
      .asString();
    expect(() => parseShieldedAddress(cpkOnly, 'undeployed')).toThrow(/not a shielded wallet address/);
  });
});
