// The passport-call verifier (for lanes that accept a gated call's own signature, one prompt per
// action), and the sponsor key derivation over the pinned wallet SDK (no network).

import { SigningKey, Wallet, getBytes, hexlify, keccak256, randomBytes, toUtf8Bytes } from 'ethers';
import { describe, expect, it } from 'vitest';

import { DigestReplayGuard, verifyPassportCall, type AccountDirectory } from '../src/auth/verifiers.js';
import { deriveSponsorKeys } from '../src/sponsor/facade.js';

const ACCOUNT = 'cd'.repeat(32);

function setup(opts: { devices?: string[]; authNonce?: bigint } = {}) {
  const device = Wallet.createRandom();
  const digest = getBytes(keccak256(toUtf8Bytes(`call-${hexlify(randomBytes(8))}`)));
  const signature = new SigningKey(device.privateKey).sign(digest).serialized;
  const directory: AccountDirectory = {
    isLiveDevice: async (account, address) =>
      account === ACCOUNT && (opts.devices ?? [device.address]).includes(address),
    currentAuthNonce: async () => opts.authNonce ?? 7n,
  };
  const digestOf = () => ({ account: ACCOUNT, digest, authNonce: 7n });
  return { device, digest, signature, directory, digestOf, replay: new DigestReplayGuard(600) };
}

describe('verifyPassportCall', () => {
  it('accepts a live device signing the current auth nonce, once', async () => {
    const s = setup();
    const r = await verifyPassportCall(
      { signature: s.signature, expectedAccount: ACCOUNT },
      s.digestOf,
      s.directory,
      s.replay,
    );
    expect(r).toMatchObject({ ok: true, signer: s.device.address, kind: 'passport-call', account: ACCOUNT });
    expect(await verifyPassportCall({ signature: s.signature }, s.digestOf, s.directory, s.replay)).toMatchObject({
      ok: false,
      code: 'replayed',
    });
  });

  it('refuses a signer that is not a live device of the account', async () => {
    const s = setup({ devices: [Wallet.createRandom().address] });
    expect(await verifyPassportCall({ signature: s.signature }, s.digestOf, s.directory, s.replay)).toMatchObject({
      ok: false,
      code: 'wrong-signer',
    });
  });

  it('refuses a stale authorisation (the account moved on)', async () => {
    const s = setup({ authNonce: 8n });
    expect(await verifyPassportCall({ signature: s.signature }, s.digestOf, s.directory, s.replay)).toMatchObject({
      ok: false,
      code: 'expired',
    });
  });

  it('refuses missing or garbage signatures, bad arguments and another account', async () => {
    const s = setup();
    expect(await verifyPassportCall({ signature: undefined }, s.digestOf, s.directory, s.replay)).toMatchObject({
      code: 'malformed',
    });
    expect(
      await verifyPassportCall({ signature: `0x${'00'.repeat(65)}` }, s.digestOf, s.directory, s.replay),
    ).toMatchObject({ code: 'bad-signature' });
    const bad = () => {
      throw new Error('bad args');
    };
    expect(await verifyPassportCall({ signature: s.signature }, bad, s.directory, s.replay)).toMatchObject({
      code: 'malformed',
    });
    expect(
      await verifyPassportCall(
        { signature: s.signature, expectedAccount: 'ef'.repeat(32) },
        s.digestOf,
        s.directory,
        s.replay,
      ),
    ).toMatchObject({ code: 'wrong-account' });
  });
});

describe('sponsor keys', () => {
  it('derive three 32-byte role keys from a seed with the pinned HD wallet, deterministically', async () => {
    const hd = await import('@midnightntwrk/wallet-sdk-hd');
    const seed = hexlify(randomBytes(64)).slice(2);
    const a = deriveSponsorKeys(hd, seed);
    const b = deriveSponsorKeys(hd, seed);
    expect(a.zswap).toHaveLength(32);
    expect(a.night).toHaveLength(32);
    expect(a.dust).toHaveLength(32);
    expect(hexlify(a.zswap)).toBe(hexlify(b.zswap));
    expect(hexlify(a.zswap)).not.toBe(hexlify(a.dust));
  });
});
