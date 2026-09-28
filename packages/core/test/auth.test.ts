import { type BaseWallet, SigningKey, TypedDataEncoder, Wallet, hexlify, randomBytes } from 'ethers';
import { describe, expect, it } from 'vitest';

import {
  CanonicalJsonError,
  NO_ACCOUNT,
  RELAY_ACTION_TYPES,
  RELAY_DOMAIN_NAME,
  buildRelayActionMessage,
  canonicalJson,
  payloadHash,
  recoverRelayActionPoint,
  relayActionDigest,
  relayActionTypedData,
  relayDomain,
  verifyRelayAction,
  type RelayActionMessage,
  type VerifyRelayActionOptions,
} from '../src/auth.js';

const NOW = 1_800_000_000;
const newNonce = () => hexlify(randomBytes(32));

/** A nonce book like the relay's: issued nonces, each usable once. */
function nonceBook() {
  const issued = new Set<string>();
  const used = new Set<string>();
  return {
    issue(): string {
      const n = newNonce();
      issued.add(n);
      return n;
    },
    consume: (n: string): 'ok' | 'unknown' | 'used' => {
      if (used.has(n)) return 'used';
      if (!issued.has(n)) return 'unknown';
      issued.delete(n);
      used.add(n);
      return 'ok';
    },
  };
}

async function sign(wallet: BaseWallet, message: RelayActionMessage): Promise<string> {
  return wallet.signTypedData(relayDomain(), RELAY_ACTION_TYPES, message);
}

describe('canonical JSON and the payload hash', () => {
  it('sorts keys, drops undefined, renders bigints as strings', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: undefined, d: 10n })).toBe(
      '{"a":[true,null,"x"],"b":1,"d":"10"}',
    );
    expect(payloadHash({ x: 1, y: 2 })).toBe(payloadHash({ y: 2, x: 1 }));
    expect(payloadHash({ x: 1 })).not.toBe(payloadHash({ x: 2 }));
  });

  it('refuses values that do not have one JSON form', () => {
    expect(() => canonicalJson({ b: new Uint8Array(2) })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(CanonicalJsonError);
  });
});

describe('RelayAction typed data', () => {
  it("names MN Bank's relay and Sepolia, and matches ethers' own encoding", async () => {
    const wallet = Wallet.createRandom();
    const msg = buildRelayActionMessage({
      action: 'register',
      network: 'stagenet',
      owner: wallet.address,
      payload: { encPublicKey: 'ab' },
      nonce: newNonce(),
      expiry: NOW + 60,
    });
    const td = relayActionTypedData(msg);
    expect(td.domain).toEqual({ name: RELAY_DOMAIN_NAME, version: '1', chainId: 11155111 });
    expect(td.primaryType).toBe('RelayAction');
    expect(td.types.EIP712Domain.map((f) => f.name)).toEqual(['name', 'version', 'chainId']);
    expect(msg.account).toBe(NO_ACCOUNT);
    const { EIP712Domain: _d, ...types } = td.types;
    expect(relayActionDigest(msg)).toBe(TypedDataEncoder.hash(td.domain, types, td.message));
  });

  it('registration: the device point is recovered from the one signature', async () => {
    const wallet = Wallet.createRandom();
    const msg = buildRelayActionMessage({
      action: 'register',
      network: 'stagenet',
      owner: wallet.address,
      payload: {},
      nonce: newNonce(),
      expiry: NOW + 60,
    });
    const sig = await sign(wallet, msg);
    expect(recoverRelayActionPoint(msg, sig)).toBe(new SigningKey(wallet.privateKey).publicKey);
  });
});

describe('verifyRelayAction', () => {
  const setup = async (over: Partial<Parameters<typeof buildRelayActionMessage>[0]> = {}) => {
    const wallet = Wallet.createRandom();
    const book = nonceBook();
    const payload = { encPublicKey: 'aa'.repeat(32), amount: '1000000' };
    const message = buildRelayActionMessage({
      action: 'register',
      network: 'stagenet',
      owner: wallet.address,
      payload,
      nonce: book.issue(),
      expiry: NOW + 120,
      ...over,
    });
    const signature = await sign(wallet, message);
    const options: VerifyRelayActionOptions = {
      expectedAction: 'register',
      network: 'stagenet',
      payload,
      now: NOW,
      maxTtlSeconds: 600,
      consumeNonce: book.consume,
    };
    return { wallet, book, payload, message, signature, options };
  };

  it('accepts a valid authorisation once', async () => {
    const { wallet, message, signature, options } = await setup();
    const r = verifyRelayAction({ message, signature }, options);
    expect(r).toMatchObject({ ok: true, signer: wallet.address });
  });

  it('refuses a replay of the same authorisation', async () => {
    const { message, signature, options } = await setup();
    expect(verifyRelayAction({ message, signature }, options).ok).toBe(true);
    expect(verifyRelayAction({ message, signature }, options)).toMatchObject({ ok: false, code: 'replayed' });
  });

  it('refuses a nonce the relay never issued (or forgot on restart)', async () => {
    const { wallet, payload, options } = await setup();
    const message = buildRelayActionMessage({
      action: 'register',
      network: 'stagenet',
      owner: wallet.address,
      payload,
      nonce: newNonce(),
      expiry: NOW + 60,
    });
    expect(verifyRelayAction({ message, signature: await sign(wallet, message) }, options)).toMatchObject({
      ok: false,
      code: 'unknown-nonce',
    });
  });

  it('refuses the wrong signer', async () => {
    const { message, options } = await setup();
    const other = Wallet.createRandom();
    expect(verifyRelayAction({ message, signature: await sign(other, message) }, options)).toMatchObject({
      ok: false,
      code: 'wrong-signer',
    });
  });

  it('refuses an expired authorisation, and one that expires too far ahead', async () => {
    const expired = await setup({ expiry: NOW - 1 });
    expect(
      verifyRelayAction({ message: expired.message, signature: expired.signature }, expired.options),
    ).toMatchObject({ ok: false, code: 'expired' });
    const now = await setup({ expiry: NOW });
    expect(verifyRelayAction({ message: now.message, signature: now.signature }, now.options)).toMatchObject({
      ok: false,
      code: 'expired',
    });
    const far = await setup({ expiry: NOW + 601 });
    expect(verifyRelayAction({ message: far.message, signature: far.signature }, far.options)).toMatchObject({
      ok: false,
      code: 'expiry-too-far',
    });
  });

  it('refuses a body the signature does not cover', async () => {
    const { message, signature, options } = await setup();
    expect(
      verifyRelayAction(
        { message, signature },
        { ...options, payload: { ...(options.payload as object), amount: '999' } },
      ),
    ).toMatchObject({ ok: false, code: 'payload-mismatch' });
  });

  it('refuses another action, network or account', async () => {
    const { message, signature, options } = await setup();
    expect(verifyRelayAction({ message, signature }, { ...options, expectedAction: 'withdraw' })).toMatchObject({
      code: 'wrong-action',
    });
    expect(verifyRelayAction({ message, signature }, { ...options, network: 'undeployed' })).toMatchObject({
      code: 'wrong-network',
    });
    expect(verifyRelayAction({ message, signature }, { ...options, expectedAccount: '11'.repeat(32) })).toMatchObject({
      code: 'wrong-account',
    });
  });

  it('refuses a tampered message (the owner is not who signed)', async () => {
    const { message, signature, options } = await setup();
    const forged = { ...message, owner: Wallet.createRandom().address };
    expect(verifyRelayAction({ message: forged, signature }, options)).toMatchObject({
      ok: false,
      code: 'wrong-signer',
    });
    const later = { ...message, expiry: String(NOW + 300) };
    expect(verifyRelayAction({ message: later, signature }, options)).toMatchObject({
      ok: false,
      code: 'wrong-signer',
    });
  });

  it('refuses a missing, malformed or garbage signature without consuming the nonce', async () => {
    const { message, options, book } = await setup();
    let consumed = 0;
    const counting = { ...options, consumeNonce: (n: string) => (consumed++, book.consume(n)) };
    expect(verifyRelayAction(undefined, counting)).toMatchObject({ code: 'malformed' });
    expect(verifyRelayAction({ message }, counting)).toMatchObject({ code: 'malformed' });
    expect(verifyRelayAction({ message, signature: `0x${'00'.repeat(65)}` }, counting)).toMatchObject({
      code: 'bad-signature',
    });
    expect(consumed).toBe(0);
  });
});
