// Reproduces plan 00039 P0.4's recorded outputs through what the dApp actually ships: the
// light-compiled contracts (scripts/compile-contracts.sh), the submodule's browser-safe modules
// and the two vendored shims. Any drift in the compile, the pin or a shim fails here.

import { sha256 } from '@noble/hashes/sha2.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';

import { bytesToHex as hex, hexToBytes as unhex } from '../src/hex.js';
import {
  EvmDevice,
  buildOpenSwapTypedData,
  buildTypedData,
  computeDigest,
  contractRecipient,
  deriveDepositEvmAddress,
  deriveVaultEvmAddress,
  depositPathBytes,
  eip191Digest,
  evmChallengeFor,
  evmDomainSaltFor,
  evmTypedMessage,
  generateEncKeyPairPortable,
  getMpcRootPublicKey,
  inboxWalkPortable,
  normaliseSecp256k1PublicKey,
  openEntryPortable,
  openSwapChallenge,
  openSwapDigest,
  openSwapMessage,
  predictChangeCoin,
  sealEntryPortable,
  signOpenSwapOffer,
  walletRecipient,
  type AuthRequest,
} from '../src/passport/index.js';
import { EXPECTED, F, KNOWN, withSeededRandom } from './fixtures/p04-vectors.js';

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

describe('encryption keys and inbox entries (browser-held secret)', () => {
  const fixedPub = x25519.getPublicKey(F.encSecretFixed);

  it('derives the same X25519 key pair as the spike', async () => {
    expect(hex(fixedPub)).toBe(EXPECTED.fixedEncPublicKey);
    const kp = await withSeededRandom('keypair', () => generateEncKeyPairPortable());
    expect(hex(kp.publicKey)).toBe(EXPECTED.seededKeyPairPublicKey);
    expect(hex(x25519.getPublicKey(kp.secretKey))).toBe(hex(kp.publicKey));
  });

  it('seals byte-identical 192-byte entries and opens them again', async () => {
    const entries: Uint8Array[] = [];
    for (let i = 0; i < F.plainCoins.length; i++) {
      entries.push(await withSeededRandom(`seal-${i}`, () => sealEntryPortable(fixedPub, F.plainCoins[i]!)));
    }
    expect(entries.every((e) => e.length === 192)).toBe(true);
    expect(hex(sha256(concat(entries)))).toBe(EXPECTED.sealedEntriesSha256);
    for (let i = 0; i < entries.length; i++) {
      const coin = await openEntryPortable(F.encSecretFixed, entries[i]!);
      expect(coin && { ...coin, nonce: hex(coin.nonce), color: hex(coin.color) }).toEqual({
        nonce: hex(F.plainCoins[i]!.nonce),
        color: hex(F.plainCoins[i]!.color),
        value: F.plainCoins[i]!.value,
      });
    }
  });

  it('opens nothing it should not', async () => {
    const good = await withSeededRandom('neg', () => sealEntryPortable(fixedPub, F.plainCoins[1]!));
    const tampered = Uint8Array.from(good);
    tampered[100]! ^= 1;
    expect(await openEntryPortable(F.encSecretFixed, tampered)).toBeNull();
    expect(await openEntryPortable(F.coin.nonce, good)).toBeNull();
    expect(await openEntryPortable(F.encSecretFixed, new Uint8Array(192))).toBeNull();
    expect(await openEntryPortable(F.encSecretFixed, good.slice(0, 191))).toBeNull();
  });

  it('walks an inbox and finds only its own entries', async () => {
    const otherPub = x25519.getPublicKey(F.coin.nonce);
    const entries = [
      await sealEntryPortable(fixedPub, F.plainCoins[0]!),
      await sealEntryPortable(otherPub, F.plainCoins[1]!),
      new Uint8Array(192),
      await sealEntryPortable(fixedPub, F.plainCoins[3]!),
    ];
    const ledger = {
      inbox_count: BigInt(entries.length),
      inbox: { member: (i: bigint) => i < BigInt(entries.length), lookup: (i: bigint) => entries[Number(i)]! },
    };
    const found = await inboxWalkPortable(ledger as never, F.encSecretFixed);
    expect(found.map((c) => c.value)).toEqual([F.plainCoins[0]!.value, F.plainCoins[3]!.value]);
  });
});

describe('EIP-712 and challenges through the light-compiled account', () => {
  const salt = evmDomainSaltFor('stagenet');
  const ctx = { contractAddress: F.account, authNonce: F.authNonce, evmDomainSalt: salt };
  const device = EvmDevice.fromPrivateKey(F.evmKey);

  it('reproduces the device identity, boot commitment and enrolment digest', () => {
    expect(hex(salt)).toBe(EXPECTED.salt);
    expect(hex(device.address)).toBe(EXPECTED.deviceAddress);
    expect(hex(device.bootCommitment(salt))).toBe(EXPECTED.bootCommitment);
    expect(hex(device.entryAt(F.account, 0n, F.useCounter))).toBe(EXPECTED.deviceEntry);
    expect(hex(eip191Digest(EvmDevice.enrolmentMessage()))).toBe(EXPECTED.enrolmentDigest);
  });

  const gated = async (request: AuthRequest) => {
    const challenge = evmChallengeFor(ctx, device.address, request);
    const { op, message } = evmTypedMessage(ctx, device.address, request, challenge);
    buildTypedData(F.account, salt, op, message);
    const h = computeDigest(F.account, salt, op, message);
    const auth = await device.sign(ctx, request, F.useCounter);
    expect(hex(auth.digest)).toBe(hex(h.digest));
    return { challenge: hex(challenge), digest: hex(h.digest), r: auth.sig.r.toString(16), s: auth.sig.s.toString(16) };
  };

  it('WithdrawShielded: challenge, digest and RFC 6979 signature', async () => {
    const got = await gated({
      op: 'withdrawShielded',
      recipient: F.recipientCoinPk,
      color: F.colour,
      amount: F.amount,
      coin: F.coin,
    } as AuthRequest);
    expect(got).toEqual(EXPECTED.withdrawShielded);
  });

  it('BridgeDepositStart and BridgeWithdrawStart', async () => {
    const dep = await gated({
      op: 'bridgeDepositStart',
      erc20: F.erc20,
      amount: F.amount,
      evm: F.evmTx,
    } as AuthRequest);
    expect({ challenge: dep.challenge, digest: dep.digest }).toEqual(EXPECTED.bridgeDepositStart);
    const wd = await gated({
      op: 'bridgeWithdrawStart',
      dest: F.dest,
      color: F.colour,
      amount: F.amount,
      erc20: F.erc20,
      coin: F.coin,
      evm: F.evmTx,
    } as AuthRequest);
    expect({ challenge: wd.challenge, digest: wd.digest }).toEqual(EXPECTED.bridgeWithdrawStart);
  });

  it('OpenSwapShielded through the vendored offer codec', async () => {
    const fixedPub = x25519.getPublicKey(F.encSecretFixed);
    const change = predictChangeCoin(F.coin, F.giveAmount);
    expect(change && hex(change.nonce)).toBe(EXPECTED.openSwap.changeNonce);
    expect(change?.value).toBe(2_500_000n);
    const want = { nonce: F.wantNonce, color: F.wantColour, value: F.wantAmount };
    const wantEntry = await withSeededRandom('offer-want', () => sealEntryPortable(fixedPub, want));
    const changeEntry = await withSeededRandom('offer-change', () => sealEntryPortable(fixedPub, change!));
    const call = {
      giveColor: F.colour,
      giveAmount: F.giveAmount,
      recipientKind: 0n,
      recipient: new Uint8Array(32),
      want,
      wantEntry,
      changeEntry,
      validUntil: F.validUntil,
    };
    const challenge = openSwapChallenge(F.account, device.address, F.authNonce, call, F.coin);
    expect(hex(challenge)).toBe(EXPECTED.openSwap.challenge);
    const message = openSwapMessage(F.account, device.address, F.authNonce, call, challenge);
    buildOpenSwapTypedData(salt, message);
    expect(hex(openSwapDigest(salt, message).digest)).toBe(EXPECTED.openSwap.digest);
    const auth = await signOpenSwapOffer(device, ctx, call, F.coin, F.useCounter);
    expect({ r: auth.sig.r.toString(16), s: auth.sig.s.toString(16) }).toEqual({
      r: EXPECTED.openSwap.r,
      s: EXPECTED.openSwap.s,
    });
  });
});

describe('deposit addresses through the vendored Signet derivation', () => {
  const root = normaliseSecp256k1PublicKey(KNOWN.mpcRoot);

  it('knows the stagenet MPC root', () => {
    expect(
      normaliseSecp256k1PublicKey(getMpcRootPublicKey('stagenet' as Parameters<typeof getMpcRootPublicKey>[0])),
    ).toBe(root);
  });

  it("reproduces AA 00037's wallet deposit address", () => {
    const r = walletRecipient(unhex(KNOWN.walletCoinPk));
    expect(hex(depositPathBytes(r))).toBe(KNOWN.walletDepositPath);
    expect(deriveDepositEvmAddress(root, KNOWN.vault, r)).toBe(KNOWN.walletDepositAddress);
  });

  it('derives an account (contract recipient) deposit address and the vault EVM account', () => {
    const r = contractRecipient(F.account);
    expect(hex(depositPathBytes(r))).toBe(EXPECTED.contractRecipient.depositPath);
    expect(deriveDepositEvmAddress(root, KNOWN.vault, r)).toBe(EXPECTED.contractRecipient.depositAddress);
    expect(deriveVaultEvmAddress(root, KNOWN.vault)).toBe(KNOWN.vaultEvmAddress);
  });
});
