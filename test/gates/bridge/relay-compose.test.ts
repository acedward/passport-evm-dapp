import { describe, expect, it } from 'vitest';

import {
  ATTESTATION_BUDGET_MS,
  MPC_SIGNATURE_BUDGET_MS,
  RequestMatchError,
  fromResumableJson,
  isSignatureTimeout,
  matchNewRequest,
  normaliseHex,
  relayOptionsFor,
  remainingSignatureBudgetMs,
  toResumableJson,
  type VaultRelayConstants,
} from './relay-compose.js';

const OURS = 'aa'.repeat(32);
const OTHER = 'bb'.repeat(32);
const id = (n: number) => n.toString(16).padStart(64, '0');

describe('matchNewRequest', () => {
  const paths: Record<string, string> = { [id(1)]: OTHER, [id(2)]: OURS, [id(3)]: OTHER, [id(4)]: OURS };
  const pathOf = (requestId: string) => paths[requestId];

  it('picks the one new id whose stored path is ours', () => {
    const m = matchNewRequest({ before: [id(1)], after: [id(1), id(2)], pathOf, expectedPathHex: OURS });
    expect(m.requestId).toBe(id(2));
    expect(m.freshIds).toEqual([id(2)]);
  });

  it('ignores another user starting in the same window, whatever the order', () => {
    // "the newest open id" would pick id(3), which is somebody else's request.
    const m = matchNewRequest({ before: [id(1)], after: [id(1), id(2), id(3)], pathOf, expectedPathHex: OURS });
    expect(m.requestId).toBe(id(2));
    expect(m.freshIds).toEqual([id(2), id(3)]);
  });

  it('never returns an older open request with our path', () => {
    const m = matchNewRequest({ before: [id(2)], after: [id(2), id(4)], pathOf, expectedPathHex: OURS });
    expect(m.requestId).toBe(id(4));
  });

  it('normalises 0x prefixes and case on ids and paths', () => {
    const m = matchNewRequest({
      before: [`0x${id(1).toUpperCase()}`],
      after: [id(1), `0X${id(2)}`],
      pathOf,
      expectedPathHex: `0x${OURS.toUpperCase()}`,
    });
    expect(m.requestId).toBe(id(2));
  });

  it('refuses when the start created nothing', () => {
    expect(() => matchNewRequest({ before: [id(1)], after: [id(1)], pathOf, expectedPathHex: OURS })).toThrow(
      RequestMatchError,
    );
  });

  it('refuses when no new request carries our path', () => {
    expect(() => matchNewRequest({ before: [], after: [id(1), id(3)], pathOf, expectedPathHex: OURS })).toThrow(
      /none of the 2 new request/,
    );
  });

  it('refuses when a new id has no stored record', () => {
    expect(() => matchNewRequest({ before: [], after: [id(9)], pathOf, expectedPathHex: OURS })).toThrow(
      RequestMatchError,
    );
  });

  it('refuses two new requests on one path instead of guessing', () => {
    expect(() => matchNewRequest({ before: [], after: [id(2), id(4)], pathOf, expectedPathHex: OURS })).toThrow(
      /2 new requests carry the expected derivation path/,
    );
  });
});

describe('remainingSignatureBudgetMs', () => {
  it('counts from the start transaction, not from the relay loop', () => {
    expect(remainingSignatureBudgetMs(1_000, 1_000)).toBe(MPC_SIGNATURE_BUDGET_MS);
    expect(remainingSignatureBudgetMs(0, 5 * 60_000)).toBe(15 * 60_000);
    expect(remainingSignatureBudgetMs(0, 25 * 60_000)).toBe(0);
    expect(remainingSignatureBudgetMs(10_000, 0)).toBe(MPC_SIGNATURE_BUDGET_MS);
  });
});

describe('relayOptionsFor', () => {
  const vault: VaultRelayConstants = {
    vaultAddress: `0x${'77'.repeat(32)}`,
    signetAddress: '1D'.repeat(32),
    depositRequestsPath: [0],
    withdrawRequestsPath: [2],
    responseSchema: new Uint8Array([1, 2, 3]),
    mpcResponseKey: { x: 1n, y: 2n, identity: false },
  };
  const endpoints = {
    indexerUrl: 'https://indexer.example/api/v4/graphql',
    evmRpcUrl: 'https://rpc.example',
    outputCache: { networkId: 'stagenet', cacheUrl: 'https://cache.example/v1/stagenet' },
  };

  it('passes the indexer, the output cache and two separate deadlines', () => {
    const o = relayOptionsFor({
      kind: 'deposit',
      requestId: `0x${OURS}`,
      expectedSigner: '0xabc',
      vault,
      endpoints,
      publicDataProvider: {},
      signatureTimeoutMs: 123,
    });
    expect(o.indexerUrl).toBe(endpoints.indexerUrl);
    expect(o.outputCache).toEqual(endpoints.outputCache);
    expect(o.signatureTimeoutMs).toBe(123);
    expect(o.attestationTimeoutMs).toBe(ATTESTATION_BUDGET_MS);
    expect('timeoutMs' in o).toBe(false);
    expect(o.requestId).toBe(OURS);
    expect(o.requesterContractAddress).toBe('77'.repeat(32));
    expect(o.signetContractAddress).toBe('1d'.repeat(32));
    expect(o.requesterRequestsPath).toEqual([0]);
  });

  it("reads a withdrawal from the vault's withdraw map", () => {
    const o = relayOptionsFor({
      kind: 'withdraw',
      requestId: OURS,
      expectedSigner: '0xabc',
      vault,
      endpoints,
      publicDataProvider: {},
      signatureTimeoutMs: 1,
    });
    expect(o.requesterRequestsPath).toEqual([2]);
  });
});

describe('isSignatureTimeout', () => {
  it("recognises the relayer's signature deadline and nothing else", () => {
    expect(
      isSignatureTimeout(
        new Error(`timed out after 1200 s waiting for the MPC's signature on ${OURS} (expected signer 0x1)`),
      ),
    ).toBe(true);
    expect(isSignatureTimeout(new Error('timed out 2000 s after the broadcast waiting for the attestation'))).toBe(
      false,
    );
    expect(isSignatureTimeout('fetch failed')).toBe(false);
  });
});

describe('resumable JSON', () => {
  it('round-trips bigints and bytes nested in a circuit-input event', () => {
    const value = {
      kind: 'success',
      serializedOutput: new Uint8Array([0, 1, 255]),
      event: { signature: { bigR: { x: new Uint8Array(32).fill(7), y: new Uint8Array(32) }, s: 5n, recoveryId: 1n } },
      list: [1n, new Uint8Array([9])],
      buffer: Buffer.from([4, 5]),
    };
    const back = fromResumableJson(JSON.parse(JSON.stringify(toResumableJson(value)))) as typeof value;
    expect(back.serializedOutput).toEqual(new Uint8Array([0, 1, 255]));
    expect(back.event.signature.s).toBe(5n);
    expect(back.event.signature.bigR.x).toEqual(new Uint8Array(32).fill(7));
    expect(back.list).toEqual([1n, new Uint8Array([9])]);
    expect(back.buffer).toEqual(new Uint8Array([4, 5]));
  });

  it('normalises hex', () => {
    expect(normaliseHex('0xABcd')).toBe('abcd');
  });
});
