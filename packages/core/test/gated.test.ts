// Plan L-ACC.4: one gated call = one wallet signature. The typed data the wallet signs and the
// digest the relay rebuilds must be the same thing, bound to the exact coin (mt_index included).

import { TypedDataEncoder, Wallet, recoverAddress } from 'ethers';
import { describe, expect, it } from 'vitest';

import type { WithdrawPayload } from '../src/accounts.js';
import {
  appendInboxRequest,
  evmDeviceEntry,
  findEvmUseCounter,
  gatedCall,
  withdrawRequest,
} from '../src/passport/index.js';

const ACCOUNT = '5e'.repeat(32);
const SALT = '9a'.repeat(32);
const payload: WithdrawPayload = {
  recipient: '11'.repeat(32),
  color: '22'.repeat(32),
  amount: '1500000',
  coin: { nonce: '33'.repeat(32), color: '22'.repeat(32), value: '5000000', mtIndex: '42' },
  authNonce: '3',
};

const ethersDigest = (td: {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  message: Record<string, unknown>;
}) => {
  const { EIP712Domain: _d, ...types } = td.types as Record<string, never>;
  return TypedDataEncoder.hash(td.domain, types, td.message);
};

describe('gatedCall', () => {
  it('builds typed data whose EIP-712 hash is the digest the relay rebuilds', async () => {
    const w = Wallet.createRandom();
    const call = gatedCall(
      { account: ACCOUNT, authNonce: 3n, evmDomainSalt: SALT },
      w.address,
      withdrawRequest(payload),
    );
    expect(call.typedData.primaryType).toBe('WithdrawShielded');
    expect(ethersDigest(call.typedData as never)).toBe(call.digestHex);
    // A wallet's eth_signTypedData_v4 over the typed data recovers to the device.
    const { EIP712Domain: _d, ...types } = call.typedData.types as Record<string, never>;
    const sig = await w.signTypedData(call.typedData.domain, types, call.typedData.message);
    expect(recoverAddress(call.digestHex, sig)).toBe(w.address);
  });

  it('binds the coin: another mt_index, value or nonce is another digest', () => {
    const ctx = { account: ACCOUNT, authNonce: 3n, evmDomainSalt: SALT };
    const owner = `0x${'77'.repeat(20)}`;
    const base = gatedCall(ctx, owner, withdrawRequest(payload)).digestHex;
    for (const coinPatch of [{ mtIndex: '43' }, { value: '5000001' }, { nonce: '34'.repeat(32) }]) {
      const other = gatedCall(ctx, owner, withdrawRequest({ ...payload, coin: { ...payload.coin, ...coinPatch } }));
      expect(other.digestHex).not.toBe(base);
    }
    expect(gatedCall({ ...ctx, authNonce: 4n }, owner, withdrawRequest(payload)).digestHex).not.toBe(base);
    expect(gatedCall(ctx, `0x${'78'.repeat(20)}`, withdrawRequest(payload)).digestHex).not.toBe(base);
  });

  it('builds the AppendInbox call over the entry', () => {
    const entry = 'ab'.repeat(192);
    const call = gatedCall(
      { account: ACCOUNT, authNonce: 0n, evmDomainSalt: SALT },
      `0x${'77'.repeat(20)}`,
      appendInboxRequest({ entry, authNonce: '0' }),
    );
    expect(call.typedData.primaryType).toBe('AppendInbox');
    expect(ethersDigest(call.typedData as never)).toBe(call.digestHex);
    expect(() => appendInboxRequest({ entry: 'ab'.repeat(191), authNonce: '0' })).toThrow();
  });
});

describe('the device use counter (MIP-0013 S11)', () => {
  const owner = `0x${'77'.repeat(20)}`;
  it('finds the counter whose entry is live, from a hint or by scanning', () => {
    const live = [evmDeviceEntry(ACCOUNT, owner, 0n, 5n), 'ff'.repeat(32)];
    expect(findEvmUseCounter(live, ACCOUNT, owner, 0n)).toBe(5n);
    expect(findEvmUseCounter(live, ACCOUNT, owner, 0n, 5n)).toBe(5n);
    expect(findEvmUseCounter(live, ACCOUNT, owner, 0n, 9n)).toBe(5n); // a stale-high hint still resolves
    expect(findEvmUseCounter(live, ACCOUNT, `0x${'78'.repeat(20)}`, 0n)).toBeNull();
    expect(findEvmUseCounter(live, ACCOUNT, owner, 1n)).toBeNull(); // another epoch
  });
});
