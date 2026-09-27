import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_KEPT_PROVERS,
  checkExpectedVk,
  compareDeployed,
  deployedVerifierDigests,
  missingProvers,
  operationName,
  parseKeptProvers,
  proversToPrune,
  restampManifest,
  verifierDigests,
} from '../src/prover/key-volume.js';
import { scanKeyTree } from '../src/prover/keys.js';

const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A key tree: `<root>/<bundle>/{keys,zkir,compiler}` with the given circuits. */
function tree(bundles: Record<string, { circuits: string[]; provers: string[] }>): string {
  const root = mkdtempSync(join(tmpdir(), 'kv-'));
  dirs.push(root);
  for (const [bundle, { circuits, provers }] of Object.entries(bundles)) {
    mkdirSync(join(root, bundle, 'keys'), { recursive: true });
    mkdirSync(join(root, bundle, 'zkir'), { recursive: true });
    mkdirSync(join(root, bundle, 'compiler'), { recursive: true });
    const manifest: { keys: Record<string, unknown> } = { keys: { type: 'directory' } };
    for (const c of circuits) {
      writeFileSync(join(root, bundle, 'keys', `${c}.verifier`), `vk:${bundle}/${c}`);
      writeFileSync(join(root, bundle, 'zkir', `${c}.bzkir`), `ir:${c}`);
      manifest.keys[`${c}.verifier`] = { type: 'file' };
    }
    for (const c of provers) {
      writeFileSync(join(root, bundle, 'keys', `${c}.prover`), `pk:${bundle}/${c}`);
      manifest.keys[`${c}.prover`] = { type: 'file' };
    }
    writeFileSync(join(root, bundle, 'compiler', 'contract-manifest.json'), JSON.stringify(manifest));
  }
  return root;
}

describe('the kept prover list', () => {
  it('defaults to the relay set plus abandonDeposit and deposit_shielded', () => {
    const kept = parseKeptProvers(undefined);
    expect(kept).toEqual([...DEFAULT_KEPT_PROVERS]);
    expect(kept).toContain('Erc20Vault/abandonDeposit');
    expect(kept).toContain('account/deposit_shielded');
    expect(parseKeptProvers('  ')).toEqual([...DEFAULT_KEPT_PROVERS]);
  });

  it('parses a custom list and refuses malformed entries', () => {
    expect(parseKeptProvers('account/a, Erc20Vault/b account/a')).toEqual(['Erc20Vault/b', 'account/a']);
    expect(() => parseKeptProvers('account')).toThrow(/bundle/);
    expect(() => parseKeptProvers('account/../x')).toThrow(/bundle/);
  });

  it('covers every prover key the relay requires (relay/src/main.ts requiredProverKeys)', () => {
    const src = join(__dirname, '..', 'src');
    const files = readdirSync(src, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(join(src, f), 'utf8'))
      .filter((text) => /requiredProverKeys\s*=\s*\[/.test(text));
    expect(files.length).toBeGreaterThan(0);
    const required = new Set<string>();
    for (const text of files) {
      const block = /requiredProverKeys\s*=\s*\[([\s\S]*?)\]/.exec(text)?.[1] ?? '';
      for (const m of block.matchAll(/'((?:account|Erc20Vault|SignetSigner)\/[A-Za-z0-9_]+)'/g)) required.add(m[1]!);
    }
    expect(required.size).toBeGreaterThan(10);
    for (const r of required) expect(DEFAULT_KEPT_PROVERS).toContain(r);
  });
});

describe('check 1: verifier keys against the compiled expectedVk', () => {
  it('passes when both sides agree', () => {
    const files = { a: sha('a'), b: sha('b') };
    expect(checkExpectedVk('account', files, { a: sha('a'), b: sha('b') })).toEqual({ circuits: 2, problems: [] });
  });

  it('names a differing key, a missing file, an extra file and a light compile', () => {
    const r = checkExpectedVk('account', { a: sha('x'), c: sha('c') }, { a: sha('a'), b: sha('b') });
    expect(r.problems).toEqual([
      'account/a: verifier key differs from expectedVk',
      'account/c: not in the compiled expectedVk table',
      'account/b: no verifier key file',
    ]);
    expect(checkExpectedVk('account', {}, {}).problems[0]).toMatch(/no expectedVk table/);
    expect(checkExpectedVk('account', {}, undefined).problems[0]).toMatch(/no expectedVk table/);
  });
});

describe('check 2: against the deployed verifier keys', () => {
  it('is equal when every circuit matches', () => {
    const r = compareDeployed('Erc20Vault', { a: '1', b: '2' }, { a: '1', b: '2' });
    expect(r).toEqual({ equal: true, problems: [], extraOnChain: [] });
  });

  it('fails on a differing or undeployed circuit', () => {
    const r = compareDeployed('Erc20Vault', { a: '1', b: '2' }, { a: '9' });
    expect(r.problems).toEqual([
      'Erc20Vault/a: differs from the deployed verifier key',
      'Erc20Vault/b: not deployed on chain',
    ]);
    expect(r.equal).toBe(false);
  });

  it('reports an operation added on chain later without failing', () => {
    const r = compareDeployed('Erc20Vault', { a: '1' }, { a: '1', metadata: '7' });
    expect(r.problems).toEqual([]);
    expect(r.extraOnChain).toEqual(['metadata']);
    expect(r.equal).toBe(false);
  });

  it('hashes a deployed contract state the way the files are hashed', () => {
    const vk = new TextEncoder().encode('vk-bytes');
    const state = {
      operations: () => ['startDeposit', new Uint8Array([0xab, 0xcd])],
      operation: (op: string | Uint8Array) => (op === 'startDeposit' ? { verifierKey: vk } : { verifierKey: vk }),
    };
    expect(deployedVerifierDigests(state as never)).toEqual({ startDeposit: sha(vk), abcd: sha(vk) });
    expect(operationName('x')).toBe('x');
    expect(operationName(new Uint8Array([1, 2]))).toBe('0102');
  });
});

describe('prune, re-stamp and completeness', () => {
  it('prunes every prover key not kept, re-stamps the manifest, and keeps the fingerprint', () => {
    const root = tree({
      account: { circuits: ['activate', 'withdraw', 'rotate'], provers: ['activate', 'withdraw', 'rotate'] },
      Erc20Vault: { circuits: ['startDeposit', 'initialise'], provers: ['startDeposit', 'initialise'] },
      SignetSigner: { circuits: ['signBidirectional'], provers: ['signBidirectional'] },
    });
    const before = scanKeyTree(root).fingerprint;
    const kept = ['account/activate', 'account/withdraw', 'Erc20Vault/startDeposit', 'SignetSigner/signBidirectional'];
    const doomed = proversToPrune(root, kept);
    expect(doomed.map((f) => f.slice(root.length + 1)).sort()).toEqual([
      'Erc20Vault/keys/initialise.prover',
      'account/keys/rotate.prover',
    ]);
    for (const f of doomed) rmSync(f);
    expect(restampManifest(join(root, 'account'))).toBe(1);
    expect(restampManifest(join(root, 'Erc20Vault'))).toBe(1);
    expect(restampManifest(join(root, 'SignetSigner'))).toBe(0);
    const manifest = JSON.parse(readFileSync(join(root, 'account', 'compiler', 'contract-manifest.json'), 'utf8'));
    expect(Object.keys(manifest.keys).sort()).toEqual([
      'activate.prover',
      'activate.verifier',
      'rotate.verifier',
      'type',
      'withdraw.prover',
      'withdraw.verifier',
    ]);
    // Pruning never touches a verifier key, so the relay's pin still matches.
    expect(scanKeyTree(root).fingerprint).toBe(before);
    expect(missingProvers(root, kept)).toEqual([]);
    expect(missingProvers(root, [...kept, 'account/rotate', 'Erc20Vault/nope'])).toEqual([
      'account/rotate',
      'Erc20Vault/nope',
    ]);
  });

  it('counts an empty prover key as missing', () => {
    const root = tree({ account: { circuits: ['activate'], provers: [] } });
    writeFileSync(join(root, 'account', 'keys', 'activate.prover'), '');
    expect(statSync(join(root, 'account', 'keys', 'activate.prover')).size).toBe(0);
    expect(missingProvers(root, ['account/activate'])).toEqual(['account/activate']);
  });

  it('digests every verifier file of a bundle', () => {
    const root = tree({ account: { circuits: ['a', 'b'], provers: [] } });
    expect(verifierDigests(join(root, 'account'))).toEqual({ a: sha('vk:account/a'), b: sha('vk:account/b') });
    expect(verifierDigests(join(root, 'missing'))).toEqual({});
  });
});
