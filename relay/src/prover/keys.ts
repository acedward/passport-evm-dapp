// The key volume: the compiled contracts with their prover and verifier keys, built once by a
// pinned one-shot and mounted read-only at MIDNIGHT_MANAGED_PATH (plan P0.5 decision). The relay
// image carries no keys.
//
// Its identity is a FINGERPRINT over every verifier key: sha256 of the sorted lines
// "<contract>/<circuit> <sha256 of the .verifier file>". When a key volume is configured, the relay
// refuses to start (plan P4-A) unless:
//   - a pinned fingerprint, when configured, equals the volume's;
//   - every circuit the relay proves (./required.ts) has its prover key, verifier key and ZKIR;
//   - the vault's and the Signet singleton's verifier keys are the DEPLOYED ones (./deployed.ts);
// so it can never prove against keys that do not match the contracts the accounts use. The
// account's own keys are checked against the loaded code by passport/runtime.ts `bindingCheck`.

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
  /** Circuits the relay needs whose verifier key is missing. */
  missingVerifierKeys: string[];
  /** Circuits the relay needs whose ZKIR (`.bzkir` / `.zkir`) is missing. */
  missingZkir: string[];
  /** Circuits whose verifier key is not the deployed contract's ("<contract>/<circuit>"). */
  mismatchedVerifierKeys: string[];
}

export interface KeyVolumeRequirements {
  /** The pinned fingerprint (RELAY_KEYS_FINGERPRINT), or null. */
  pin: string | null;
  /** Every "<contract>/<circuit>" the relay proves (./required.ts). */
  required?: readonly string[];
  /** "<contract>/<circuit>" → the SHA-256 of the DEPLOYED contract's verifier key (the vault's and
   *  the Signet singleton's, from PR #4's deployment record). Checked for every circuit listed. */
  deployed?: Readonly<Record<string, string>>;
}

const absent = (pin: string | null, required: readonly string[]): KeyCheck => ({
  present: false,
  fingerprint: null,
  pinned: pin !== null,
  matchesPin: pin === null ? null : false,
  missingProverKeys: [...required],
  missingVerifierKeys: [...required],
  missingZkir: [...required],
  mismatchedVerifierKeys: [],
});

/** Check the volume against the pin, the circuits the relay proves, and the deployed verifier keys. */
export function checkKeyVolume(
  root: string | null,
  pin: string | null,
  required: readonly string[] = [],
  deployed: Readonly<Record<string, string>> = {},
): KeyCheck {
  if (!root) return absent(pin, required);
  let tree: KeyTree;
  try {
    tree = scanKeyTree(root);
  } catch {
    return absent(pin, required);
  }
  const byId = new Map(tree.circuits.map((c) => [`${c.contract}/${c.circuit}`, c]));
  return {
    present: true,
    fingerprint: tree.fingerprint,
    pinned: pin !== null,
    matchesPin: pin === null ? null : tree.fingerprint === pin,
    missingProverKeys: required.filter((r) => !byId.get(r)?.hasProverKey),
    missingVerifierKeys: required.filter((r) => !byId.has(r)),
    missingZkir: required.filter((r) => !byId.get(r)?.hasZkir),
    mismatchedVerifierKeys: Object.entries(deployed)
      .filter(([id, sha]) => byId.has(id) && byId.get(id)!.verifierSha256 !== sha.toLowerCase())
      .map(([id]) => id)
      .sort(),
  };
}

/** True when the volume holds everything the relay proves, as deployed, and matches its pin. */
export const keyVolumeComplete = (k: KeyCheck): boolean =>
  k.present &&
  k.matchesPin !== false &&
  k.missingProverKeys.length === 0 &&
  k.missingVerifierKeys.length === 0 &&
  k.missingZkir.length === 0 &&
  k.mismatchedVerifierKeys.length === 0;

/**
 * The start-up refusal (plan P4-A): every problem with a configured key volume, one line each, in
 * words an operator can act on. Empty when the volume is complete. Public names and hashes only.
 */
export function keyVolumeProblems(k: KeyCheck, req: KeyVolumeRequirements & { root: string }): string[] {
  if (!k.present) return [`no compiled contracts with keys were found at MIDNIGHT_MANAGED_PATH (${req.root})`];
  const out: string[] = [];
  if (k.matchesPin === false) {
    out.push(`the key volume's fingerprint ${k.fingerprint} is not RELAY_KEYS_FINGERPRINT ${req.pin}`);
  }
  const list = (what: string, ids: string[]) => {
    if (ids.length > 0) out.push(`missing ${what} (${ids.length}): ${ids.join(', ')}`);
  };
  list('verifier keys', k.missingVerifierKeys);
  list(
    'prover keys',
    k.missingProverKeys.filter((id) => !k.missingVerifierKeys.includes(id)),
  );
  list(
    'ZKIR',
    k.missingZkir.filter((id) => !k.missingVerifierKeys.includes(id)),
  );
  for (const id of k.mismatchedVerifierKeys) {
    out.push(
      `${id}: the verifier key does not match the deployed contract's (sha256 ${req.deployed?.[id] ?? '?'}); the keys were built from other sources`,
    );
  }
  return out;
}
