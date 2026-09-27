// The key volume's build-time checks (plan 00039 P4-B): what the one-shot key job
// (deploy/key-volume/build.sh, relay/src/tools/key-volume.ts) runs before the relay may use a
// freshly compiled key set, and again on every start.
//
// The method is G-BRIDGE's (test/gates/bridge/gate.ts `keys-verify`):
//   1. every bundle's verifier keys equal its compiled `expectedVk` table (SHA-256 of each
//      `.verifier` file). compact-runtime compares a callee module's table with the verifier keys
//      deployed at the callee's address on every cross-contract call, so this is the table the
//      account's bridge circuits are checked against;
//   2. the vault's and the Signet singleton's verifier keys equal the ones DEPLOYED on the network
//      (the indexer's contract state), circuit by circuit;
//   3. every prover key the relay proves with is present;
//   4. the whole verifier-key set has the pinned fingerprint (the relay's `scanKeyTree`), which
//      ties the account's keys to the ones every live account so far was deployed with.
//
// This module holds the pure comparisons and the file walks; the CLI does the network read.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The bundles a relay key volume holds, in compile order (callees first). */
export const KEY_VOLUME_BUNDLES = ['SignetSigner', 'SignetCircuits', 'Erc20Vault', 'account'] as const;

/** The bundles that carry keys (SignetCircuits is JavaScript only). */
export const KEYED_BUNDLES = ['SignetSigner', 'Erc20Vault', 'account'] as const;

/**
 * The prover keys the key job keeps, as `<bundle>/<circuit>`. Everything else is pruned after
 * the compile (the account's bundle is about 7.2 GB with every key and 3.0 GB with these).
 *
 * The relay's own required list (relay/src/main.ts) plus two it may prove:
 * `Erc20Vault/abandonDeposit` (closing a never-executed deposit, plan question Q21) and
 * `account/deposit_shielded` (the relay-assisted take's return leg, Q15, and the funding tools).
 */
export const DEFAULT_KEPT_PROVERS: readonly string[] = [
  'account/activate_initial_device_with_evm',
  'account/withdraw_shielded_with_evm',
  'account/append_inbox_with_evm',
  'account/open_swap_shielded_with_evm',
  'account/deposit_shielded',
  'account/bridge_deposit_start_with_evm',
  'account/bridge_deposit_complete',
  'account/bridge_withdraw_start_with_evm',
  'account/bridge_withdraw_complete',
  'account/bridge_withdraw_refund',
  'Erc20Vault/startDeposit',
  'Erc20Vault/completeDeposit',
  'Erc20Vault/abandonDeposit',
  'Erc20Vault/startWithdraw',
  'Erc20Vault/completeWithdraw',
  'Erc20Vault/refundWithdraw',
  'SignetSigner/signBidirectional',
];

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

/** Parse a `KEYS_KEEP_PROVERS` value (comma- or space-separated `<bundle>/<circuit>`). */
export function parseKeptProvers(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [...DEFAULT_KEPT_PROVERS];
  const entries = value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const e of entries) {
    if (!/^[A-Za-z0-9_]+\/[A-Za-z0-9_]+$/.test(e))
      throw new Error(`KEYS_KEEP_PROVERS: "${e}" is not <bundle>/<circuit>`);
  }
  return [...new Set(entries)].sort();
}

/** SHA-256 of every `<bundle>/keys/*.verifier`, by circuit name. */
export function verifierDigests(bundleDir: string): Record<string, string> {
  const keysDir = join(bundleDir, 'keys');
  if (!existsSync(keysDir)) return {};
  const out: Record<string, string> = {};
  for (const f of readdirSync(keysDir).sort()) {
    if (f.endsWith('.verifier')) out[f.slice(0, -'.verifier'.length)] = sha256(readFileSync(join(keysDir, f)));
  }
  return out;
}

export interface ExpectedVkCheck {
  circuits: number;
  problems: string[];
}

/** Check 1: the verifier files equal the compiled module's `expectedVk`, both ways. */
export function checkExpectedVk(
  bundle: string,
  files: Record<string, string>,
  expectedVk: Record<string, string> | undefined,
): ExpectedVkCheck {
  const problems: string[] = [];
  const table = expectedVk ?? {};
  if (Object.keys(table).length === 0) {
    problems.push(`${bundle}: the compiled module has no expectedVk table (a --skip-zk compile?)`);
  }
  for (const [circuit, digest] of Object.entries(files)) {
    if (table[circuit] === undefined) problems.push(`${bundle}/${circuit}: not in the compiled expectedVk table`);
    else if (table[circuit] !== digest) problems.push(`${bundle}/${circuit}: verifier key differs from expectedVk`);
  }
  for (const circuit of Object.keys(table)) {
    if (files[circuit] === undefined) problems.push(`${bundle}/${circuit}: no verifier key file`);
  }
  return { circuits: Object.keys(files).length, problems };
}

export interface DeployedCheck {
  equal: boolean;
  /** Circuits whose key differs from the deployed one, or that the contract does not have. */
  problems: string[];
  /** Operations deployed on chain that this compile does not have (a later maintenance update). */
  extraOnChain: string[];
}

/**
 * Check 2: every circuit of ours equals the verifier key deployed for the same operation.
 * An operation deployed on chain that we lack is reported, not fatal: a maintenance update can
 * add one (for example MIP-0018 metadata), and the relay never calls it.
 */
export function compareDeployed(
  name: string,
  ours: Record<string, string>,
  deployed: Record<string, string>,
): DeployedCheck {
  const problems: string[] = [];
  for (const [circuit, digest] of Object.entries(ours)) {
    if (deployed[circuit] === undefined) problems.push(`${name}/${circuit}: not deployed on chain`);
    else if (deployed[circuit] !== digest) problems.push(`${name}/${circuit}: differs from the deployed verifier key`);
  }
  const extraOnChain = Object.keys(deployed)
    .filter((c) => ours[c] === undefined)
    .sort();
  return { equal: problems.length === 0 && extraOnChain.length === 0, problems, extraOnChain };
}

/** Check 3: kept prover keys (`<bundle>/<circuit>`) that are missing, empty, or lack their zkir. */
export function missingProvers(root: string, kept: readonly string[]): string[] {
  const missing: string[] = [];
  for (const entry of kept) {
    const [bundle, circuit] = entry.split('/') as [string, string];
    const prover = join(root, bundle, 'keys', `${circuit}.prover`);
    const zkir = ['bzkir', 'zkir'].some((ext) => existsSync(join(root, bundle, 'zkir', `${circuit}.${ext}`)));
    if (!existsSync(prover) || statSync(prover).size === 0 || !zkir) missing.push(entry);
  }
  return missing;
}

/** The prover files to delete: every `.prover` of a keyed bundle not in the kept list. */
export function proversToPrune(root: string, kept: readonly string[]): string[] {
  const keep = new Set(kept);
  const out: string[] = [];
  for (const bundle of KEYED_BUNDLES) {
    const keysDir = join(root, bundle, 'keys');
    if (!existsSync(keysDir)) continue;
    for (const f of readdirSync(keysDir).sort()) {
      if (f.endsWith('.prover') && !keep.has(`${bundle}/${f.slice(0, -'.prover'.length)}`)) out.push(join(keysDir, f));
    }
  }
  return out;
}

/**
 * Drop the pruned keys from a bundle's `compiler/contract-manifest.json`. midnight-js's
 * NodeZkConfigProvider checks files against this manifest, so an entry for a deleted `.prover`
 * would fail the first call that reads it (the aa-contracts image does the same re-stamp).
 * Returns the number of entries removed.
 */
export function restampManifest(bundleDir: string): number {
  const path = join(bundleDir, 'compiler', 'contract-manifest.json');
  if (!existsSync(path)) return 0;
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { keys?: Record<string, unknown> };
  const keysDir = join(bundleDir, 'keys');
  const present = new Set(existsSync(keysDir) ? readdirSync(keysDir) : []);
  let dropped = 0;
  for (const name of Object.keys(manifest.keys ?? {})) {
    if (name === 'type' || present.has(name)) continue;
    delete manifest.keys![name];
    dropped += 1;
  }
  if (dropped > 0) writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return dropped;
}

/** An operation name from ContractState.operations(): a string, or bytes shown as hex. */
export function operationName(op: unknown): string {
  if (typeof op === 'string') return op;
  if (op instanceof Uint8Array) return Buffer.from(op).toString('hex');
  return String(op);
}

/** SHA-256 of each deployed operation's verifier key, from a deserialised ContractState. */
export function deployedVerifierDigests(state: {
  operations(): unknown[];
  operation(op: never): { verifierKey?: Uint8Array } | undefined;
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const op of state.operations()) {
    const vk = state.operation(op as never)?.verifierKey;
    if (vk) out[operationName(op)] = sha256(vk);
  }
  return out;
}
