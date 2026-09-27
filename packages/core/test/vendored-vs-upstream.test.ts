// The two vendored shims (Q18 option B) against the upstream modules they copy, on Node, where
// upstream loads. Any drift, in either direction, fails CI: a re-pin that changes upstream
// offer.ts or the vault's derivation must re-vendor the shim.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { x25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';

import * as upOffer from '../../../vendor/passport/contract/src/wallet/offer.js';
import * as upVault from '../../../vendor/passport/contract/contracts/erc20-vault/src/index.js';
import { openInboxEntry } from '../../../vendor/passport/contract/src/wallet/inbox.js';
import { EvmDevice, evmDomainSaltFor, openEntryPortable } from '../src/passport/index.js';
import * as offer from '../src/passport/vendor/offer-codec.js';
import * as derive from '../src/passport/vendor/signet-derive.js';
import { bytesToHex as hex, hexToBytes as unhex } from '../src/hex.js';
import { F, KNOWN } from './fixtures/p04-vectors.js';

const upstreamPath = (p: string) => fileURLToPath(new URL(`../../../vendor/passport/contract/${p}`, import.meta.url));

describe('offer-codec.ts vs upstream src/wallet/offer.ts', () => {
  it('exports the same names, minus the documented omissions and replacements', () => {
    const omitted = new Set([
      // section 3: the envelope (relay-side)
      'OFFER_MAGIC',
      'sha256Hex',
      'makeTerms',
      'encodeEnvelope',
      'OfferEnvelopeError',
      'decodeEnvelope',
      'writeEnvelope',
      'readEnvelope',
      'offerExpired',
      'offerSecondsLeft',
      // section 4: imbalance reading (relay-side)
      'ImbalanceUnreadableError',
      'shieldedLabel',
      'segmentsOf',
      'readAllImbalances',
      'nonDustDeficits',
      'nonDustSurpluses',
      'makerAttachedDust',
      'OfferPlacementError',
      'expectedPlacement',
      'requirePlacement',
      'legSegmentOf',
      // section 5: the ledger-v9 builder (relay-side) and its re-exports
      'buildOpenSwapOffer',
      'fromHex',
      'toHex',
      'hexToBytes',
      'bytesToHex',
      // replaced by offerInboxEntriesPortable
      'offerInboxEntries',
    ]);
    const upstream = Object.keys(upOffer)
      .filter((k) => !omitted.has(k))
      .sort();
    const vendored = Object.keys(offer)
      .filter((k) => k !== 'offerInboxEntriesPortable')
      .sort();
    expect(vendored).toEqual(upstream);
  });

  it('every function body is textually the upstream one (except the two marked changes)', () => {
    const up = readFileSync(upstreamPath('src/wallet/offer.ts'), 'utf8');
    const ours = readFileSync(fileURLToPath(new URL('../src/passport/vendor/offer-codec.ts', import.meta.url)), 'utf8');
    // Upstream sections 1 and 2, minus the two replaced functions, appear verbatim in ours.
    const start = up.indexOf('// 1. The eighth type: OpenSwapShielded');
    const end = up.indexOf('// 3. The offer envelope');
    const verbatim = up
      .slice(start, end)
      .replace(/export const freshWantNonce[^\n]*\n/, '')
      .replace(/export function offerInboxEntries\([\s\S]*?\n}\n/, '');
    for (const chunk of verbatim.split('\n\n').filter((c) => c.trim() !== '')) {
      expect(ours.includes(chunk), chunk.slice(0, 80)).toBe(true);
    }
    const sec6 = up.slice(up.indexOf('// 6. Signing an offer with an `evm` device'));
    const sec6Body = sec6.slice(sec6.indexOf('export interface OpenSwapAuthorisation'));
    expect(ours.includes(sec6Body.trimEnd())).toBe(true);
  });

  it('computes identical typed data, digests, challenges and signatures', async () => {
    const salt = evmDomainSaltFor('stagenet');
    const device = EvmDevice.fromPrivateKey(F.evmKey);
    const ctx = { contractAddress: F.account, authNonce: F.authNonce, evmDomainSalt: salt };
    const want = { nonce: F.wantNonce, color: F.wantColour, value: F.wantAmount };
    const call = {
      giveColor: F.colour,
      giveAmount: F.giveAmount,
      recipientKind: 1n,
      recipient: F.recipientCoinPk,
      want,
      wantEntry: F.coin.nonce.slice(),
      changeEntry: new Uint8Array(192),
      validUntil: F.validUntil,
    };
    call.wantEntry = new Uint8Array(192).fill(7);
    expect(hex(offer.OPEN_SWAP_TYPE_HASH)).toBe(hex(upOffer.OPEN_SWAP_TYPE_HASH));
    expect(offer.OPEN_SWAP_ENCODE_TYPE).toBe(upOffer.OPEN_SWAP_ENCODE_TYPE);
    expect(hex(offer.uint8Word(200n))).toBe(hex(upOffer.uint8Word(200n)));
    const ch = offer.openSwapChallenge(F.account, device.address, F.authNonce, call, F.coin);
    expect(hex(ch)).toBe(hex(upOffer.openSwapChallenge(F.account, device.address, F.authNonce, call, F.coin)));
    const m = offer.openSwapMessage(F.account, device.address, F.authNonce, call, ch);
    expect(m).toEqual(upOffer.openSwapMessage(F.account, device.address, F.authNonce, call, ch));
    expect(hex(offer.encodeOpenSwapStruct(m))).toBe(hex(upOffer.encodeOpenSwapStruct(m)));
    expect(offer.openSwapDigest(salt, m)).toEqual(upOffer.openSwapDigest(salt, m));
    expect(offer.buildOpenSwapTypedData(salt, m)).toEqual(upOffer.buildOpenSwapTypedData(salt, m));
    expect(offer.offerCircuitArgs(call)).toEqual(upOffer.offerCircuitArgs(call));
    expect(offer.predictChangeCoin(F.coin, 4n)).toEqual(upOffer.predictChangeCoin(F.coin, 4n));
    expect(offer.predictChangeCoin(F.coin, F.coin.value)).toBeNull();
    expect(() => offer.predictChangeCoin(F.coin, F.coin.value + 1n)).toThrow(RangeError);
    const coins = [{ ...F.coin, value: 5n }, F.coin];
    expect(offer.selectGiveCoin(coins, F.colour, 6n)).toBe(upOffer.selectGiveCoin(coins, F.colour, 6n));
    const a = await offer.signOpenSwapOffer(device, ctx, call, F.coin, F.useCounter);
    const b = await upOffer.signOpenSwapOffer(device, ctx, call, F.coin, F.useCounter);
    expect(a).toEqual(b);
    expect(offer.offerAuthArgs(a)).toEqual(upOffer.offerAuthArgs(b));
    expect([
      offer.RECIPIENT_OPEN,
      offer.RECIPIENT_NAMED_COIN_KEY,
      offer.RECIPIENT_CONTRACT_REFUSED,
      offer.TTL_CAP_SECONDS,
    ]).toEqual([
      upOffer.RECIPIENT_OPEN,
      upOffer.RECIPIENT_NAMED_COIN_KEY,
      upOffer.RECIPIENT_CONTRACT_REFUSED,
      upOffer.TTL_CAP_SECONDS,
    ]);
    expect(offer.freshWantNonce()).toHaveLength(32);
  });

  it("portable offer entries open with upstream's node:crypto codec, and back", async () => {
    const pk = x25519.getPublicKey(F.encSecretFixed);
    const want = { nonce: F.wantNonce, color: F.wantColour, value: F.wantAmount };
    const change = offer.predictChangeCoin(F.coin, F.giveAmount);
    const ours = await offer.offerInboxEntriesPortable(pk, want, change);
    expect(openInboxEntry(F.encSecretFixed, ours.wantEntry)).toMatchObject({ value: want.value });
    expect(openInboxEntry(F.encSecretFixed, ours.changeEntry)).toMatchObject({ value: change!.value });
    const theirs = upOffer.offerInboxEntries(pk, want, change);
    expect(await openEntryPortable(F.encSecretFixed, theirs.wantEntry)).toMatchObject({ value: want.value });
    const none = await offer.offerInboxEntriesPortable(pk, want, null);
    expect(hex(none.changeEntry)).toBe(hex(upOffer.offerInboxEntries(pk, want, null).changeEntry));
  });
});

describe('signet-derive.ts vs upstream erc20-vault/src/index.ts', () => {
  const root = derive.normaliseSecp256k1PublicKey(KNOWN.mpcRoot);

  it('derives identical paths and addresses', () => {
    for (const r of [derive.walletRecipient(unhex(KNOWN.walletCoinPk)), derive.contractRecipient(F.account)]) {
      expect(derive.depositPathBytes(r)).toEqual(upVault.depositPathBytes(r));
      expect(derive.deriveDepositEvmAddress(root, KNOWN.vault, r)).toBe(
        upVault.deriveDepositEvmAddress(root, KNOWN.vault, r),
      );
    }
    expect(derive.walletRecipient(F.account)).toEqual(upVault.walletRecipient(F.account));
    expect(derive.contractRecipient(F.account)).toEqual(upVault.contractRecipient(F.account));
    expect(derive.deriveVaultEvmAddress(root, KNOWN.vault)).toBe(upVault.deriveVaultEvmAddress(root, KNOWN.vault));
    expect(derive.vaultPathHex()).toBe(upVault.vaultPathHex());
    expect([
      derive.VAULT_DEPOSIT_REQUESTS_PATH,
      derive.VAULT_WITHDRAW_REQUESTS_PATH,
      derive.VAULT_NONCE_PATH,
      derive.VAULT_REQUESTS_PATH_DEPTH,
    ]).toEqual([
      upVault.VAULT_DEPOSIT_REQUESTS_PATH,
      upVault.VAULT_WITHDRAW_REQUESTS_PATH,
      upVault.VAULT_NONCE_PATH,
      upVault.VAULT_REQUESTS_PATH_DEPTH,
    ]);
  });

  it("the vendored block is textually upstream's", () => {
    const up = readFileSync(upstreamPath('contracts/erc20-vault/src/index.ts'), 'utf8');
    const ours = readFileSync(
      fileURLToPath(new URL('../src/passport/vendor/signet-derive.ts', import.meta.url)),
      'utf8',
    );
    const block = up.slice(up.indexOf('/** `Either<ZswapCoinPublicKey, ContractAddress>`'));
    expect(ours.includes(block.trimEnd())).toBe(true);
  });
});
