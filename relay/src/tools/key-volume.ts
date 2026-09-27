// The key volume's checks, run by the one-shot key job (deploy/key-volume/build.sh) inside the
// key-volume image. It never proves and never holds a secret: everything it reads and prints is
// public (hashes, addresses, circuit names).
//
//   bun relay/src/tools/key-volume.ts prune <root>            delete the prover keys not kept, re-stamp
//   bun relay/src/tools/key-volume.ts marker-inputs <root>    print the installed set's input stamp
//   bun relay/src/tools/key-volume.ts verify <root> [--inputs <stamp>] [--write-marker] [--recheck]
//
// `verify` runs the four checks of relay/src/prover/key-volume.ts and prints a JSON report. It
// exits 0 when the set is VERIFIED and 1 otherwise. With --write-marker it writes the report as
// `<root>/.mnbank-keys.json`; with --recheck it keeps the marker's build facts and, when
// KEYS_VERIFY_ONCHAIN_EVERY_START=false, trusts the marker's earlier on-chain check.
//
// Environment (the relay's own names, so one .env drives both):
//   RELAY_NETWORK                       stagenet (default) or undeployed
//   MIDNIGHT_INDEXER_URL                override the profile's indexer
//   BRIDGE_VAULT_ADDRESS, BRIDGE_SIGNET_SINGLETON   override the profile's contracts
//   RELAY_KEYS_FINGERPRINT              the pinned verifier-key fingerprint (64 hex)
//   KEYS_KEEP_PROVERS                   the kept prover keys (<bundle>/<circuit>, comma-separated)
//   KEYS_VERIFY_ONCHAIN_EVERY_START     true (default) or false
//   KV_*                                build facts build.sh passes in (toolchain and sources)

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveNetwork, type NetworkOverrides } from '@mnbank/core';

import stagenetRecord from '../../../packages/core/src/tokens/deployments/stagenet-vault.json' with { type: 'json' };
import {
  KEYED_BUNDLES,
  checkExpectedVk,
  compareDeployed,
  deployedVerifierDigests,
  missingProvers,
  parseKeptProvers,
  proversToPrune,
  restampManifest,
  verifierDigests,
} from '../prover/key-volume.js';
import { scanKeyTree } from '../prover/keys.js';

const MARKER = '.mnbank-keys.json';
const FORMAT = 'mnbank-key-volume/1';

type Json = Record<string, unknown>;

const say = (msg: string) => process.stderr.write(`key-volume: ${msg}\n`);
const nowUtc = () => new Date().toISOString();
const env = (name: string) => {
  const v = process.env[name]?.trim();
  return v === undefined || v === '' ? undefined : v;
};

function readMarker(root: string): Json | null {
  const p = join(root, MARKER);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Json;
  } catch {
    return null;
  }
}

function network() {
  const name = env('RELAY_NETWORK') ?? 'stagenet';
  const overrides: NetworkOverrides = {};
  const indexerUrl = env('MIDNIGHT_INDEXER_URL');
  if (indexerUrl) overrides.midnight = { indexerUrl };
  const vaultAddress = env('BRIDGE_VAULT_ADDRESS')?.replace(/^0x/, '').toLowerCase();
  const signetSingleton = env('BRIDGE_SIGNET_SINGLETON')?.replace(/^0x/, '').toLowerCase();
  if (vaultAddress || signetSingleton) {
    overrides.bridge = {
      ...(vaultAddress ? { vaultAddress } : {}),
      ...(signetSingleton ? { signetSingleton } : {}),
    };
  }
  return resolveNetwork(name, overrides);
}

/** The verifier keys deployed at `address`, from the indexer's current contract state. */
async function deployedKeys(indexerUrl: string, address: string): Promise<Record<string, string>> {
  const ledger = (await import('@midnightntwrk/ledger-v9')) as unknown as {
    ContractState: { deserialize(b: Uint8Array): Parameters<typeof deployedVerifierDigests>[0] };
  };
  let lastError = 'no attempt';
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(indexerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: `{ contractAction(address: "${address}") { state } }` }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json()) as { data?: { contractAction?: { state?: string } | null }; errors?: unknown[] };
      if (body.errors && body.errors.length > 0) throw new Error(`the indexer answered ${JSON.stringify(body.errors)}`);
      const hex = body.data?.contractAction?.state;
      if (!hex) throw new Error(`no contract at ${address}`);
      return deployedVerifierDigests(ledger.ContractState.deserialize(Uint8Array.from(Buffer.from(hex, 'hex'))));
    } catch (e) {
      lastError = (e as Error).message;
      say(`reading ${address} failed (attempt ${attempt}/5): ${lastError}`);
      if (attempt < 5) await new Promise((r) => setTimeout(r, attempt * 10_000));
    }
  }
  throw new Error(`the deployed verifier keys of ${address} could not be read: ${lastError}`);
}

async function expectedVkOf(root: string, bundle: string): Promise<Record<string, string> | undefined> {
  const mod = (await import(pathToFileURL(join(root, bundle, 'contract', 'index.js')).href)) as {
    expectedVk?: Record<string, string>;
  };
  return mod.expectedVk;
}

async function verify(root: string, opts: { inputs?: string; writeMarker: boolean; recheck: boolean }) {
  const problems: string[] = [];
  const warnings: string[] = [];
  const previous = opts.recheck ? readMarker(root) : null;
  const kept = parseKeptProvers(env('KEYS_KEEP_PROVERS'));
  const net = network();

  // 1. Each bundle against its compiled expectedVk table.
  const ours: Record<string, Record<string, string>> = {};
  const expectedVk: Json = {};
  for (const bundle of KEYED_BUNDLES) {
    ours[bundle] = verifierDigests(join(root, bundle));
    const check = checkExpectedVk(bundle, ours[bundle]!, await expectedVkOf(root, bundle));
    expectedVk[bundle] = { circuits: check.circuits, ok: check.problems.length === 0 };
    problems.push(...check.problems);
  }

  // 2. The vault and the singleton against the verifier keys deployed on the network.
  let onChain: Json;
  const everyStart = (env('KEYS_VERIFY_ONCHAIN_EVERY_START') ?? 'true').toLowerCase() !== 'false';
  const earlier = previous?.checks as Json | undefined;
  const earlierOnChain = earlier?.onChain as Json | undefined;
  if (opts.recheck && !everyStart && earlierOnChain?.ok === true) {
    onChain = { ...earlierOnChain, skipped: 'KEYS_VERIFY_ONCHAIN_EVERY_START=false; trusting the check at build time' };
  } else if (!net.bridge.vaultAddress || !net.bridge.signetSingleton) {
    onChain = { ok: false, reason: 'the network profile names no vault or singleton' };
    problems.push(
      'on-chain: no vault or singleton address is configured (BRIDGE_VAULT_ADDRESS, BRIDGE_SIGNET_SINGLETON)',
    );
  } else {
    const contracts: Json = {};
    let ok = true;
    for (const [name, address, bundle] of [
      ['vault', net.bridge.vaultAddress, 'Erc20Vault'],
      ['singleton', net.bridge.signetSingleton, 'SignetSigner'],
    ] as const) {
      const deployed = await deployedKeys(net.midnight.indexerUrl, address);
      const cmp = compareDeployed(bundle, ours[bundle]!, deployed);
      contracts[name] = { address, circuits: Object.keys(ours[bundle]!).length, ...cmp };
      problems.push(...cmp.problems);
      if (cmp.problems.length > 0) ok = false;
      if (cmp.extraOnChain.length > 0)
        warnings.push(`${name}: deployed operations this compile lacks: ${cmp.extraOnChain.join(', ')}`);
    }
    onChain = { ok, indexer: net.midnight.indexerUrl, checkedUtc: nowUtc(), contracts };
  }

  // 2b. On stagenet, also PR #4's deployment record (vendored in @mnbank/core).
  let record: Json = { applies: false };
  if (net.name === 'stagenet' && net.bridge.vaultAddress === stagenetRecord.vaultContractAddress) {
    const vault = compareDeployed('Erc20Vault', ours.Erc20Vault!, stagenetRecord.artefacts.vault.verifierKeys);
    const signet = compareDeployed(
      'SignetSigner',
      ours.SignetSigner!,
      stagenetRecord.artefacts.signetSigner.verifierKeys,
    );
    record = { applies: true, vault: vault.equal, signetSigner: signet.equal };
    problems.push(
      ...vault.problems.map((p) => `PR #4 record: ${p}`),
      ...signet.problems.map((p) => `PR #4 record: ${p}`),
    );
  }

  // 3. The prover keys the relay proves with.
  const missing = missingProvers(root, kept);
  problems.push(...missing.map((m) => `${m}: prover key or zkir missing`));

  // 4. The fingerprint (the relay's own algorithm) against the pin.
  const fingerprint = scanKeyTree(root).fingerprint;
  const pin = env('RELAY_KEYS_FINGERPRINT')?.toLowerCase() ?? null;
  if (pin === null) warnings.push('RELAY_KEYS_FINGERPRINT is not set: the relay will accept any key set');
  else if (pin !== fingerprint) problems.push(`fingerprint ${fingerprint} differs from RELAY_KEYS_FINGERPRINT ${pin}`);

  const verdict = problems.length === 0 ? 'VERIFIED' : 'MISMATCH';
  const report: Json = {
    format: FORMAT,
    verdict,
    network: net.name,
    fingerprint,
    fingerprintPinned: pin,
    inputs: opts.inputs ?? (previous?.inputs as string | undefined) ?? null,
    builtUtc: (previous?.builtUtc as string | undefined) ?? nowUtc(),
    verifiedUtc: nowUtc(),
    build: previous?.build ?? {
      source: env('KV_SOURCE') ?? null,
      compactc: env('KV_COMPACTC_VERSION') ?? null,
      compactcArchiveSha256: env('KV_COMPACTC_ARCHIVE_SHA256') ?? null,
      sigNetMidnight: env('KV_SIGNET_VERSION') ?? null,
      passportCommit: env('KV_PASSPORT_COMMIT') ?? null,
      accountSourceSha256: env('KV_ACCOUNT_SHA256') ?? null,
      compileSeconds: env('KV_COMPILE_SECONDS') ? Number(env('KV_COMPILE_SECONDS')) : null,
    },
    keptProvers: kept,
    checks: { expectedVk, onChain, pr4Record: record, provers: { kept: kept.length, missing }, fingerprint },
    problems,
    warnings,
  };
  if (opts.writeMarker && verdict === 'VERIFIED')
    writeFileSync(join(root, MARKER), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  for (const w of warnings) say(`warning: ${w}`);
  for (const p of problems) say(`PROBLEM: ${p}`);
  say(`verdict ${verdict} (fingerprint ${fingerprint})`);
  return verdict === 'VERIFIED';
}

async function main(): Promise<number> {
  const [cmd, root, ...rest] = process.argv.slice(2);
  if (!cmd || !root) {
    say('usage: key-volume.ts prune|marker-inputs|verify <root> [options]');
    return 64;
  }
  if (cmd === 'prune') {
    const kept = parseKeptProvers(env('KEYS_KEEP_PROVERS'));
    const doomed = proversToPrune(root, kept);
    for (const f of doomed) rmSync(f);
    let restamped = 0;
    for (const bundle of KEYED_BUNDLES) restamped += restampManifest(join(root, bundle));
    say(`pruned ${doomed.length} prover keys (kept ${kept.length}); ${restamped} manifest entries removed`);
    return 0;
  }
  if (cmd === 'marker-inputs') {
    const m = readMarker(root);
    if (m && m.verdict === 'VERIFIED' && typeof m.inputs === 'string') process.stdout.write(`${m.inputs}\n`);
    return 0;
  }
  if (cmd === 'verify') {
    const flag = (name: string) => rest.includes(name);
    const i = rest.indexOf('--inputs');
    const inputs = i >= 0 ? rest[i + 1] : undefined;
    const ok = await verify(root, {
      ...(inputs ? { inputs } : {}),
      writeMarker: flag('--write-marker'),
      recheck: flag('--recheck'),
    });
    return ok ? 0 : 1;
  }
  say(`unknown command ${cmd}`);
  return 64;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    say(`error: ${(e as Error).message}`);
    process.exit(2);
  },
);
