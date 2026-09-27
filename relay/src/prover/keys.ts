// The key volume: the compiled contracts with their prover and verifier keys, built once by a
// pinned one-shot and mounted read-only at MIDNIGHT_MANAGED_PATH (plan P0.5 decision). The relay
// image carries no keys.
//
// Its identity is a FINGERPRINT over every verifier key: sha256 of the sorted lines
// "<contract>/<circuit> <sha256 of the .verifier file>". The relay refuses to start when a pinned
// fingerprint is configured and the volume's differs, so it can never prove against keys that
// do not match the contracts the accounts were deployed with.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface KeyTreeCircuit {
  contract: string;
  circuit: string;
  verifierSha256: string;
  hasProverKey: boolean;
  hasZkir: boolean;
}

export interface KeyTree {
  root: string;
  fingerprint: string;
  circuits: KeyTreeCircuit[];
}

export class KeyVolumeError extends Error {
  override name = 'KeyVolumeError';
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Scan `<root>/<contract>/keys/*.verifier` (the compactc layout). */
export function scanKeyTree(root: string): KeyTree {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new KeyVolumeError('the key volume is not mounted');
  const circuits: KeyTreeCircuit[] = [];
  for (const contract of readdirSync(root).sort()) {
    const keysDir = join(root, contract, 'keys');
    if (!existsSync(keysDir) || !statSync(keysDir).isDirectory()) continue;
    for (const file of readdirSync(keysDir).sort()) {
      if (!file.endsWith('.verifier')) continue;
      const circuit = file.slice(0, -'.verifier'.length);
      circuits.push({
        contract,
        circuit,
        verifierSha256: sha256(readFileSync(join(keysDir, file))),
        hasProverKey: existsSync(join(keysDir, `${circuit}.prover`)),
        hasZkir:
          existsSync(join(root, contract, 'zkir', `${circuit}.bzkir`)) ||
          existsSync(join(root, contract, 'zkir', `${circuit}.zkir`)),
      });
    }
  }
  if (circuits.length === 0) throw new KeyVolumeError('the key volume holds no verifier keys');
  const lines = circuits.map((c) => `${c.contract}/${c.circuit} ${c.verifierSha256}`).sort();
  return { root, fingerprint: sha256(`${lines.join('\n')}\n`), circuits };
}

export interface KeyCheck {
  present: boolean;
  fingerprint: string | null;
  pinned: boolean;
  matchesPin: boolean | null;
  /** Circuits the relay needs whose prover key is missing ("<contract>/<circuit>"). */
  missingProverKeys: string[];
}

/** Check the volume against the pin and the circuits the enabled actions prove. */
export function checkKeyVolume(root: string | null, pin: string | null, required: readonly string[] = []): KeyCheck {
  if (!root)
    return {
      present: false,
      fingerprint: null,
      pinned: pin !== null,
      matchesPin: pin === null ? null : false,
      missingProverKeys: [...required],
    };
  let tree: KeyTree;
  try {
    tree = scanKeyTree(root);
  } catch {
    return {
      present: false,
      fingerprint: null,
      pinned: pin !== null,
      matchesPin: pin === null ? null : false,
      missingProverKeys: [...required],
    };
  }
  const have = new Set(tree.circuits.filter((c) => c.hasProverKey).map((c) => `${c.contract}/${c.circuit}`));
  return {
    present: true,
    fingerprint: tree.fingerprint,
    pinned: pin !== null,
    matchesPin: pin === null ? null : tree.fingerprint === pin,
    missingProverKeys: required.filter((r) => !have.has(r)),
  };
}
