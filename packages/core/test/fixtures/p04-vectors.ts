// Fixed inputs of plan 00039's P0.4 browser spike, so its recorded outputs can be reproduced
// here (evidence/00039-passport-evm-dapp/p0.4-browser-spike.md). Every "fixed" byte string is
// sha256 of a public label: nothing here is a secret, and the test EVM key has never held funds.

import { sha256 } from '@noble/hashes/sha2.js';

import { hexToBytes as unhex } from '../../src/hex.js';

export const LABEL = 'aa00039-p0.4-spike';
const utf8 = (s: string) => new TextEncoder().encode(s);
export const fixed = (name: string): Uint8Array => sha256(utf8(`${LABEL}:${name}`));

/** AA 00037's public known vector (its evidence folder). */
export const KNOWN = {
  vault: '7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637',
  mpcRoot:
    '0x047dd8ecafa5d9c921485b6ac33476870e98c3378e395f3c8fae92ce4943d8432847f591ab25ca454effb522ec2eaf04b7e1c83ba65ae731ea98dd52eb7d458dd4',
  walletCoinPk: 'c6a35196428ac58a956e93e0c3c7c7df254e428a827291e9111fde7037cd34a1',
  walletDepositPath: '4d1621ea7ac21848c188c490923f66197e3f296d415f4fe3cec05e27b3bbc064',
  walletDepositAddress: '0x5f89AB8632a7Cf386a32a1634D4F23312c0F3714',
  vaultEvmAddress: '0x648216975e722494bFF92E88FFc68C8F8d438FaA',
  stkA: '0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52',
  wStkAColour: '5eb2a3cebb2ebe7ba910c78f62c9e28e0d74acbd00c810730def3578860e6a02',
};

export const F = {
  account: fixed('account-address'),
  evmKey: fixed('evm-device-key'),
  authNonce: 5n,
  useCounter: 3n,
  colour: unhex(KNOWN.wStkAColour),
  coin: { nonce: fixed('held-coin-nonce'), color: unhex(KNOWN.wStkAColour), value: 10_000_000n, mt_index: 12345n },
  amount: 1_000_000n,
  recipientCoinPk: unhex(KNOWN.walletCoinPk),
  dest: unhex(KNOWN.stkA.slice(2)).slice(0, 20),
  erc20: unhex(KNOWN.stkA.slice(2)),
  evmTx: {
    nonce: 7n,
    gasLimit: 150_000n,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    keyVersion: 1n,
  },
  wantNonce: fixed('want-nonce'),
  wantColour: fixed('want-colour'),
  wantAmount: 10_500_000n,
  giveAmount: 10_000_000n - 2_500_000n,
  validUntil: 1_800_000_000n,
  encSecretFixed: fixed('enc-secret'),
  plainCoins: [0, 1, 2, 3].map((i) => ({
    nonce: fixed(`inbox-coin-nonce-${i}`),
    color: i % 2 === 0 ? unhex(KNOWN.wStkAColour) : fixed('other-colour'),
    value: [1n, 1_000_000n, 2n ** 64n + 7n, 2n ** 128n - 1n][i]!,
  })),
};

/** The spike's outputs (evidence p0.4; `out/node.json`), identical in Node, Bun and Chromium. */
export const EXPECTED = {
  fixedEncPublicKey: '489ee6fc8ffb2044bc1c63052bf746bf7936e5418c0e3c7c17fd8bb09c9c2f02',
  seededKeyPairPublicKey: '4bc6f7e4809961380972a7e1e1dacfaa74c6db2cb68bb571b00634b6e9cbf805',
  sealedEntriesSha256: '0409ce1590d2b2e7d8573008985e14ea2d6d0cc102b64fe51dccec6756efca5d',
  salt: 'f2358ecb621d3ac4f112375eedb0cda74bbcae8af2991dd5577d22f8acef44a3',
  deviceAddress: '74475a93d435e1e68c079d41584c26ac4f285c71',
  bootCommitment: 'ead4122d7394c6c31ab4e598c438018f15950ebd085cba4115132a9100436e01',
  deviceEntry: 'e527bedfdbf8a494fa5329dae8855fa895bdbe15f62fb94bb609c8d1b2457ae1',
  enrolmentDigest: '117baae7e4a6c47782ea10f9ceab8260c07f0cb59b554a744c5442edb3fbeb2e',
  withdrawShielded: {
    challenge: '9a0c74471a6b7240789c37d9819d2f734e130a076f35eb19bad5a6d1785a8d4b',
    digest: 'e4b7025a340ca4b75773cda59664f997c5b41075583a250778c5aa0e625d3854',
    r: '7fa98cbb6dbf1346b6098c5d96af439af79c54bc01d4721783f76352829691cd',
    s: '49a44997a0eadb6ce3ea1fa5c5564694c734cf020b18d0d0cdb5ab71345b47b1',
  },
  bridgeDepositStart: {
    challenge: '65d1d29cb8499bd66335538b57b9ae573354826cfbee2be92ddbe835edff6bb9',
    digest: '9d61730351d3e018b7e6e40b116780947cde6336acd771e741eb9dacbece2bf8',
  },
  bridgeWithdrawStart: {
    challenge: '08fc4dd66e8086e71522f69d5eda4c7282b6da210ac8f0b8ef251e27fce6f343',
    digest: '7325626e3178d3c492cd6f08612f15e83282d506039bcef68c53620be224a5a1',
  },
  openSwap: {
    changeNonce: '5c58fa8b82e798b9fc8e3b80b8df90c8afb77a320a289bb4b8ec92d454add700',
    challenge: '31ecc8c8d24fb11676bdfc1f1cfa2dac606bc9f3bdde2cc5d4768ba909f6eced',
    digest: '227ba96fe64a5f865597c7429c6b54e1578739d50846c4d34bc0b2935b196084',
    r: '2d4f8b9992cbbfe5fb23f3b6ddb9e4e7c21433f6b7b97a7563dd4350c7a9a064',
    s: '44d01e2be24a2f19f4d18fff1742fc344d236970b92d32d7e7a0ed5671f4fd2',
  },
  contractRecipient: {
    depositPath: '15bed6e26c337b671093f6ce4c3990a8b85479e324ac491b34cea96d1047e2db',
    depositAddress: '0x5ef53B2367721E05ED1E2E69b3c6475704562324',
  },
};

/** Replace crypto.getRandomValues with a seeded SHA-256 counter stream while `fn` runs, so
 *  sealing and key generation are byte-reproducible (the spike's technique). */
export async function withSeededRandom<T>(seed: string, fn: () => Promise<T> | T): Promise<T> {
  const c = globalThis.crypto as unknown as Record<string, unknown>;
  const seedBytes = utf8(`${LABEL}:drbg:${seed}`);
  let counter = 0;
  let pool = new Uint8Array(0);
  const next = (n: number): Uint8Array => {
    while (pool.length < n) {
      const block = new Uint8Array(seedBytes.length + 4);
      block.set(seedBytes, 0);
      new DataView(block.buffer).setUint32(seedBytes.length, counter++);
      const h = sha256(block);
      const merged = new Uint8Array(pool.length + h.length);
      merged.set(pool, 0);
      merged.set(h, pool.length);
      pool = merged;
    }
    const out = pool.slice(0, n);
    pool = pool.slice(n);
    return out;
  };
  const drbg = (arr: ArrayBufferView) => {
    new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).set(next(arr.byteLength));
    return arr;
  };
  const own = Object.prototype.hasOwnProperty.call(c, 'getRandomValues');
  const prev = c.getRandomValues;
  Object.defineProperty(c, 'getRandomValues', { value: drbg, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (own) Object.defineProperty(c, 'getRandomValues', { value: prev, configurable: true, writable: true });
    else delete c.getRandomValues;
  }
}
