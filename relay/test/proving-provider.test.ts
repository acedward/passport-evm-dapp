// The relay's proof provider (plan P5.1b, question Q25; relay/src/prover/proving-provider.ts): the
// /prove body it streams is the ledger's own byte for byte, it never reads a prover key into memory,
// and it keeps midnight-js's resolution, integrity checks, retries and errors. The real k=18 proof
// against a proof server is relay/src/tools/prover-memory.ts (test/memory/README.md).

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as ledger from '@midnightntwrk/ledger-v9';
import { encodeContractKeyLocation, hashVerifierKey, ZKArtifactNotFoundError } from '@midnight-ntwrk/midnight-js-types';
import { ZkArtifactIntegrityError } from '@midnight-ntwrk/midnight-js-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assembleProveBody,
  compactLength,
  concatBytes,
  proveBodyFrame,
  proveBodyParts,
  type ProveBodyFrame,
} from '../src/prover/prove-body.js';
import { findArtefactBundles, relayProofProvider, type ProvingLedger } from '../src/prover/proving-provider.js';

const CIRCUIT = 'big_circuit';
const ADDRESS = 'ab'.repeat(32);
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const aligned = { value: [], alignment: [] };

function preimageFor(keyLocation: string): Uint8Array {
  return ledger.proofDataIntoSerializedPreimage(aligned as never, aligned as never, [], [], keyLocation);
}

function frameFor(preimage: Uint8Array, binding?: bigint): ProveBodyFrame {
  return proveBodyFrame(
    ledger.createProvingPayload(preimage, binding),
    ledger.createProvingPayload(preimage, undefined),
  );
}

describe('the /prove body layout', () => {
  it('writes SCALE compact lengths as midnight-serialize does', () => {
    const hex = (n: number) => Buffer.from(compactLength(n)).toString('hex');
    expect(hex(0)).toBe('00');
    expect(hex(63)).toBe('fc');
    expect(hex(64)).toBe('0101');
    expect(hex(16_383)).toBe('fdff');
    expect(hex(16_384)).toBe('02000100');
    expect(hex(570_495_183)).toBe(Buffer.from(Uint32Array.of(570_495_183 * 4 + 2).buffer).toString('hex'));
    expect(hex(2 ** 30 - 1)).toBe('feffffff');
    expect(hex(2 ** 30)).toBe('0300000040');
    expect(() => compactLength(-1)).toThrow(RangeError);
  });

  it('is byte-identical to the ledger createProvingPayload for key sizes across every length width', () => {
    const vk = randomBytes(3_000);
    const loc = encodeContractKeyLocation({
      contractAddress: ADDRESS,
      circuitId: CIRCUIT,
      verifierKeyHash: sha256(vk),
    });
    const preimage = preimageFor(loc);
    const bindings = [undefined, 0n, 12_345n, ledger.maxField()];
    const sizes = [0, 1, 63, 64, 255, 16_383, 16_384, 70_000, (1 << 20) + 3];
    for (const binding of bindings) {
      const frame = frameFor(preimage, binding);
      for (const size of sizes) {
        for (const ir of [randomBytes(10), randomBytes(16_384)]) {
          const material = { proverKey: randomBytes(size), verifierKey: vk, ir };
          const ours = assembleProveBody(frame, material);
          const theirs = ledger.createProvingPayload(preimage, binding, material);
          expect(sha256(ours), `binding ${String(binding)}, key ${size}, ir ${ir.length}`).toBe(sha256(theirs));
          const parts = proveBodyParts(frame, size, vk, ir);
          expect(parts.total).toBe(theirs.length);
        }
      }
    }
  });

  it('refuses key-less bodies without the expected shape', () => {
    const loc = encodeContractKeyLocation({
      contractAddress: ADDRESS,
      circuitId: CIRCUIT,
      verifierKeyHash: 'cd'.repeat(32),
    });
    const withoutBinding = ledger.createProvingPayload(preimageFor(loc), undefined);
    expect(() => proveBodyFrame(withoutBinding, withoutBinding.slice(0, -1))).toThrow(/two None tags/);
    const other = ledger.createProvingPayload(preimageFor(loc.replace('big_circuit', 'other_one')), 7n);
    expect(() => proveBodyFrame(other, withoutBinding)).toThrow(/share the preimage prefix/);
  });
});

interface Captured {
  url: string;
  contentLength: string | null;
  body: Uint8Array;
}

/** A volume with one bundle (`<root>/Synthetic/{keys,zkir,compiler}`) and its compiler manifest. */
function makeVolume(
  root: string,
  proverKey: Uint8Array,
  verifierKey: Uint8Array,
  ir: Uint8Array,
  manifest: 'full' | 'without-prover' | 'none' = 'full',
) {
  const dir = join(root, 'Synthetic');
  for (const d of ['keys', 'zkir', 'compiler']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'keys', `${CIRCUIT}.prover`), proverKey);
  writeFileSync(join(dir, 'keys', `${CIRCUIT}.verifier`), verifierKey);
  writeFileSync(join(dir, 'zkir', `${CIRCUIT}.bzkir`), ir);
  const file = (b: Uint8Array) => ({ type: 'file', size: b.length, hash: sha256(b) });
  if (manifest !== 'none') {
    const keys: Record<string, unknown> = { type: 'directory', [`${CIRCUIT}.verifier`]: file(verifierKey) };
    if (manifest === 'full') keys[`${CIRCUIT}.prover`] = file(proverKey);
    writeFileSync(
      join(dir, 'compiler', 'contract-manifest.json'),
      JSON.stringify({
        'manifest-version': '1',
        'compiler-version': '0.34.0',
        keys,
        zkir: { type: 'directory', [`${CIRCUIT}.bzkir`]: file(ir) },
      }),
    );
  }
  return dir;
}

describe('relayProofProvider', () => {
  let root: string;
  let proverKey: Uint8Array;
  let verifierKey: Uint8Array;
  let ir: Uint8Array;
  let loc: string;
  let captured: Captured[];
  let answers: number[];

  // The proof server: reads every body to the end (as a real fetch sends it) and answers.
  const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
    captured.push({ url: String(input), contentLength: headers.get('content-length'), body });
    const status = answers.shift() ?? 200;
    return new Response(status === 200 ? Uint8Array.of(1, 2, 3) : 'busy', { status });
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relay-prover-'));
    proverKey = randomBytes(3 * 1024 * 1024 + 17);
    verifierKey = randomBytes(3_000);
    ir = randomBytes(40_000);
    makeVolume(root, proverKey, verifierKey, ir);
    loc = encodeContractKeyLocation({
      contractAddress: ADDRESS,
      circuitId: CIRCUIT,
      verifierKeyHash: hashVerifierKey(verifierKey),
    });
    captured = [];
    answers = [];
    fakeFetch.mockClear();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const provider = (extra: Parameters<typeof relayProofProvider>[2] = {}) =>
    relayProofProvider('http://proof-server:6300', root, {
      fetch: fakeFetch as unknown as typeof fetch,
      keyChunkBytes: 1024 * 1024,
      ...extra,
    });

  it('finds bundles as midnight-js does', async () => {
    mkdirSync(join(root, 'node_modules', 'x', 'keys'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'x', 'zkir'), { recursive: true });
    expect(await findArtefactBundles(root)).toEqual([join(root, 'Synthetic')]);
    await expect(findArtefactBundles(join(root, 'Synthetic', 'keys'))).rejects.toThrow(/No compiled contract/);
  });

  it('streams the ledger body, with a Content-Length, in chunks, and returns the answer', async () => {
    const p = await provider();
    for (const binding of [undefined, 99n]) {
      captured = [];
      const preimage = preimageFor(loc);
      const answer = await p.provingProvider().prove(preimage, loc, binding);
      expect([...answer]).toEqual([1, 2, 3]);
      expect(captured).toHaveLength(1);
      const expected = ledger.createProvingPayload(preimage, binding, { proverKey, verifierKey, ir });
      expect(captured[0]!.url).toBe('http://proof-server:6300/prove');
      expect(captured[0]!.contentLength).toBe(String(expected.length));
      expect(sha256(captured[0]!.body)).toBe(sha256(expected));
      expect(sha256(await p.proveBody(preimage, loc, binding))).toBe(sha256(expected));
    }
  });

  it('checks with the ZKIR only, and answers lookupKey without the prover key', async () => {
    const p = await provider();
    const preimage = preimageFor(loc);
    // Without the prover key file: neither call may read it.
    const keyFile = join(root, 'Synthetic', 'keys', `${CIRCUIT}.prover`);
    rmSync(keyFile);
    // Vec<Option<u64>> [none, 5]
    const result = Uint8Array.of(...Buffer.from('midnight:vec(option(u64)):'), 0x08, 0x00, 0x01, 0x14);
    fakeFetch.mockImplementationOnce(async (input, init) => {
      captured.push({ url: String(input), contentLength: null, body: new Uint8Array(init!.body as Uint8Array) });
      return new Response(result);
    });
    expect(await p.provingProvider().check(preimage, loc)).toEqual([undefined, 5n]);
    expect(captured[0]!.url).toBe('http://proof-server:6300/check');
    expect(sha256(captured[0]!.body)).toBe(sha256(ledger.createCheckPayload(preimage, ir)));
    const looked = await p.provingProvider().lookupKey(loc);
    expect(looked!.proverKey.length).toBe(0);
    expect(sha256(looked!.verifierKey)).toBe(sha256(verifierKey));
    expect(sha256(looked!.ir)).toBe(sha256(ir));
    await expect(p.keyMaterial(loc)).rejects.toThrow(/ENOENT/);
    writeFileSync(keyFile, proverKey);
    const full = await p.keyMaterial(loc);
    expect(sha256(full!.proverKey)).toBe(sha256(proverKey));
  });

  it('sends a builtin location without key material', async () => {
    const p = await provider();
    const preimage = preimageFor('midnight/zswap/spend');
    await p.provingProvider().prove(preimage, 'midnight/zswap/spend', 5n);
    expect(sha256(captured[0]!.body)).toBe(sha256(ledger.createProvingPayload(preimage, 5n)));
    expect(await p.provingProvider().lookupKey('midnight/zswap/spend')).toBeUndefined();
  });

  it('refuses a location whose verifier key no bundle has', async () => {
    const p = await provider();
    const other = encodeContractKeyLocation({
      contractAddress: ADDRESS,
      circuitId: CIRCUIT,
      verifierKeyHash: 'ef'.repeat(32),
    });
    await expect(p.provingProvider().prove(preimageFor(other), other)).rejects.toBeInstanceOf(ZKArtifactNotFoundError);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('refuses a tampered prover key: the body never completes and nothing is retried', async () => {
    const tampered = Uint8Array.from(proverKey);
    tampered[tampered.length - 5]! ^= 0xff;
    writeFileSync(join(root, 'Synthetic', 'keys', `${CIRCUIT}.prover`), tampered);
    // A real fetch fails when its body stream fails.
    const failing = async (_input: string | URL | Request, init?: RequestInit) => {
      await new Response(init?.body as BodyInit).arrayBuffer();
      return new Response(Uint8Array.of(1));
    };
    fakeFetch.mockImplementationOnce(failing).mockImplementationOnce(failing);
    const p = await provider();
    await expect(p.provingProvider().prove(preimageFor(loc), loc)).rejects.toThrow(ZkArtifactIntegrityError);
    await expect(p.provingProvider().prove(preimageFor(loc), loc)).rejects.toThrow(/expected sha-256/);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it('refuses a prover key of the wrong size before sending anything', async () => {
    truncateSync(join(root, 'Synthetic', 'keys', `${CIRCUIT}.prover`), 1000);
    const p = await provider();
    await expect(p.provingProvider().prove(preimageFor(loc), loc)).rejects.toThrow(/expected \d+ bytes, got 1000/);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('refuses a bundle without a manifest (fail-closed, as midnight-js)', async () => {
    rmSync(root, { recursive: true, force: true });
    makeVolume(root, proverKey, verifierKey, ir, 'none');
    const p = await provider();
    const error = await p
      .provingProvider()
      .prove(preimageFor(loc), loc)
      .catch((e: unknown) => e);
    // midnight-js already refuses the verifier key, so the location resolves to nothing.
    expect(error).toBeInstanceOf(ZKArtifactNotFoundError);
    expect((error as ZKArtifactNotFoundError).suppressedErrors[0]).toBeInstanceOf(ZkArtifactIntegrityError);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('refuses a prover key the manifest does not list, before sending anything', async () => {
    rmSync(root, { recursive: true, force: true });
    makeVolume(root, proverKey, verifierKey, ir, 'without-prover');
    const p = await provider();
    await expect(p.provingProvider().prove(preimageFor(loc), loc)).rejects.toThrow(
      /manifest has no entry for "keys\/big_circuit.prover"/,
    );
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('retries a 503 with a fresh body, as the stock provider (after 1 s)', async () => {
    answers = [503];
    const p = await provider();
    const preimage = preimageFor(loc);
    await p.provingProvider().prove(preimage, loc);
    expect(captured).toHaveLength(2);
    const expected = sha256(ledger.createProvingPayload(preimage, undefined, { proverKey, verifierKey, ir }));
    expect(captured.map((c) => sha256(c.body))).toEqual([expected, expected]);
  }, 10_000);

  it('reports a final failure with the stock error', async () => {
    answers = [400];
    const p = await provider();
    await expect(p.provingProvider().prove(preimageFor(loc), loc)).rejects.toThrow(
      /Failed Proof Server response: .*code="400"/,
    );
  });

  it('falls back to the ledger building the body when the layout does not match', async () => {
    const warn = vi.fn();
    const changed: ProvingLedger = {
      createCheckPayload: ledger.createCheckPayload,
      parseCheckResult: ledger.parseCheckResult,
      createProvingPayload: (pre, binding, km) => {
        const body = ledger.createProvingPayload(pre, binding, km);
        return km ? concatBytes([body, Uint8Array.of(0)]) : body;
      },
    };
    const p = await provider({ ledger: changed, log: { warn } as never });
    const preimage = preimageFor(loc);
    await p.provingProvider().prove(preimage, loc);
    await p.provingProvider().prove(preimage, loc);
    const expected = changed.createProvingPayload(preimage, undefined, { proverKey, verifierKey, ir });
    expect(captured.map((c) => sha256(c.body))).toEqual([sha256(expected), sha256(expected)]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('proves a transaction through the ledger with the stock cost model', async () => {
    const p = await provider();
    const prove = vi.fn(
      async (provider: { check: unknown; prove: unknown; lookupKey: unknown }, costModel: unknown) => {
        expect(typeof provider.check).toBe('function');
        expect(typeof provider.prove).toBe('function');
        expect(typeof provider.lookupKey).toBe('function');
        expect(costModel).toBeInstanceOf(ledger.CostModel);
        return 'proven';
      },
    );
    expect(await p.proveTx({ prove })).toBe('proven');
  });
});
