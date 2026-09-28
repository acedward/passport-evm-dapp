// How much memory the relay needs to prove (plan 00039 P5.1b, question Q25).
//
// REAL mode (the default) builds ONE k=18 account call offline and proves it through the relay's
// own proof provider (PassportRuntime, the object every job uses) against a real proof server,
// while it samples its own container's memory. No chain, no wallet and no secret are involved: the
// account state is made in process by the pinned client's constructor and
// `activate_initial_device_with_evm`, with a throwaway EVM key that never leaves this process, and
// the call is `append_inbox_with_evm` (k=18, prover key 544 MB). Nothing is ever submitted.
//
// SYNTHETIC mode (--synthetic) needs no keys and no proof server: it generates a prover key of
// --key-mb MB with its compiler manifest and sends /prove bodies for it to an in-process server that
// reads each body to the end. It measures what the relay itself holds while it sends a body, and is
// cheap enough for CI (.github/workflows/ci.yml, job "Relay prover memory").
//
//   bun relay/src/tools/prover-memory.ts [--synthetic [--key-mb MB]] [--proofs N] [--budget-mb MB]
//                                        [--gc-each] [--stock] [--compare-payload] [--out FILE]
//
//   --stock            prove through midnight-js's stock HTTP proof provider instead (the relay's
//                      path before P5.1b), to compare the two in one build
//   --compare-payload  (real mode) prove once, and check that the relay's /prove body for the real
//                      key is byte-identical to the one the ledger builds (needs the stock memory)
//   --gc-each          run Bun.gc(true) after each proof and report the memory after it too
//
// Run it in a container with a memory limit and no swap (test/memory/run-prover-memory.sh does):
// it reads the container's cgroup (memory.stat `anon`, memory.current, memory.peak, memory.events)
// through a sampler PROCESS, so a peak inside a synchronous WASM call is still seen. It prints one
// JSON report and exits 1 when the peak anonymous memory exceeds --budget-mb or a body comparison
// fails, and 2 on an error. Past the container's limit the kernel kills it (exit 137).
//
// Environment (real mode): MIDNIGHT_MANAGED_PATH (the key volume, required) and
// MIDNIGHT_PROOF_SERVER_URL (default http://proof-server:6300).

import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomFillSync } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createLogger } from '../log.js';
import { PassportRuntime } from '../passport/runtime.js';
import type { RelayProofProvider } from '../prover/proving-provider.js';

const CGROUP = '/sys/fs/cgroup';
const CIRCUIT = 'append_inbox_with_evm';
const MB = 1024 * 1024;

type Json = Record<string, unknown>;

const say = (msg: string) => process.stderr.write(`prover-memory: ${msg}\n`);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readCgroup(file: string): string | null {
  try {
    return readFileSync(join(CGROUP, file), 'utf8');
  } catch {
    return null;
  }
}

function statField(stat: string | null, field: string): number | null {
  const m = stat?.match(new RegExp(`^${field} (\\d+)$`, 'm'));
  return m ? Number(m[1]) : null;
}

/** One reading of this process and its container. */
function snapshot(label: string): Json {
  const stat = readCgroup('memory.stat');
  const events = readCgroup('memory.events');
  const mu = process.memoryUsage();
  const num = (s: string | null) => (s === null ? null : Number(s.trim()));
  return {
    label,
    at: new Date().toISOString(),
    anonMb: mb(statField(stat, 'anon')),
    fileMb: mb(statField(stat, 'file')),
    currentMb: mb(num(readCgroup('memory.current'))),
    peakMb: mb(num(readCgroup('memory.peak'))),
    swapMb: mb(num(readCgroup('memory.swap.current'))),
    eventsMax: statField(events, 'max'),
    oomKill: statField(events, 'oom_kill'),
    rssMb: mb(mu.rss),
    heapUsedMb: mb(mu.heapUsed),
    externalMb: mb(mu.external),
    arrayBuffersMb: mb(mu.arrayBuffers),
  };
}

const mb = (bytes: number | null | undefined) =>
  bytes === null || bytes === undefined ? null : Math.round(bytes / MB);

/** A separate process that reads the cgroup every 100 ms: it keeps sampling while the relay's
 *  thread is inside a synchronous WASM call or a large copy. */
function startSampler(file: string): { stop: () => Promise<void> } {
  const script = `while :; do a=$(grep '^anon ' ${CGROUP}/memory.stat | cut -d' ' -f2); c=$(cat ${CGROUP}/memory.current); echo "$(date +%s%3N) $a $c"; sleep 0.1; done > ${file}`;
  const child = spawn('sh', ['-c', script], { stdio: 'ignore' });
  return {
    stop: () =>
      new Promise((done) => {
        child.once('exit', () => done());
        child.kill('SIGTERM');
      }),
  };
}

interface Sample {
  t: number;
  anon: number;
  current: number;
}

function readSamples(file: string): Sample[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim().split(' ').map(Number))
    .filter((p) => p.length === 3 && p.every((n) => Number.isFinite(n)))
    .map(([t, anon, current]) => ({ t: t!, anon: anon!, current: current! }));
}

function peakBetween(samples: Sample[], from: number, to: number): { anonMb: number | null; currentMb: number | null } {
  const inside = samples.filter((s) => s.t >= from && s.t <= to);
  if (inside.length === 0) return { anonMb: null, currentMb: null };
  return {
    anonMb: mb(Math.max(...inside.map((s) => s.anon))),
    currentMb: mb(Math.max(...inside.map((s) => s.current))),
  };
}

const gc = () => (globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc(true);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What one run proves. */
interface Scenario {
  /** For the report. */
  describe: Json;
  /** One proof; returns facts for the report. */
  prove(): Promise<Json>;
  /** The byte-identity check (the real scenario). */
  compare?: () => Promise<Json>;
  close?: () => Promise<void>;
}

async function main(): Promise<number> {
  const proofs = Number(arg('--proofs') ?? '4');
  const budgetMb = arg('--budget-mb') ? Number(arg('--budget-mb')) : null;
  const gcEach = process.argv.includes('--gc-each');
  const stock = process.argv.includes('--stock');
  const synthetic = process.argv.includes('--synthetic');
  const keyMb = Number(arg('--key-mb') ?? '544');
  const comparePayload = process.argv.includes('--compare-payload');
  const out = arg('--out');
  if (!Number.isInteger(proofs) || proofs < 1) throw new Error('--proofs must be a positive integer');
  if (!Number.isInteger(keyMb) || keyMb < 1) throw new Error('--key-mb must be a positive integer');

  const work = mkdtempSync(join(tmpdir(), 'prover-memory-'));
  const samplesFile = join(work, 'samples.txt');
  const sampler = startSampler(samplesFile);
  const snapshots: Json[] = [snapshot('start')];
  const proofRuns: Json[] = [];
  let compared: Json | null = null;
  let describe: Json;
  try {
    const scenario = synthetic
      ? await syntheticScenario(work, { stock, keyMb })
      : await realScenario({
          stock,
          managedPath: process.env.MIDNIGHT_MANAGED_PATH,
          proofServerUrl: process.env.MIDNIGHT_PROOF_SERVER_URL ?? 'http://proof-server:6300',
        });
    describe = scenario.describe;
    gc();
    await sleep(500);
    snapshots.push(snapshot('ready'));
    if (comparePayload) {
      if (!scenario.compare) throw new Error('--compare-payload needs the real scenario');
      compared = await scenario.compare();
      snapshots.push(snapshot('after the payload comparison'));
    }
    for (let i = 1; i <= proofs; i++) {
      const t0 = Date.now();
      const facts = await scenario.prove();
      const t1 = Date.now();
      const after = snapshot(`after proof ${i}`);
      let afterGc: Json | null = null;
      if (gcEach) {
        gc();
        await sleep(200);
        afterGc = snapshot(`after proof ${i} + Bun.gc(true)`);
      }
      proofRuns.push({ proof: i, ms: t1 - t0, ...facts, t0, t1, after, afterGc });
      say(`proof ${i}/${proofs}: ${t1 - t0} ms, anon after ${String(after.anonMb)} MB`);
    }
    await sleep(5_000);
    snapshots.push(snapshot('5 s after the last proof'));
    gc();
    await sleep(1_000);
    snapshots.push(snapshot('after a final Bun.gc(true)'));
    await scenario.close?.();
  } finally {
    await sampler.stop();
  }

  const samples = readSamples(samplesFile);
  rmSync(work, { recursive: true, force: true });
  for (const run of proofRuns) {
    const { t0, t1 } = run as { t0: number; t1: number };
    run.peakDuring = peakBetween(samples, t0, t1);
    delete run.t0;
    delete run.t1;
  }
  const all = peakBetween(samples, 0, Number.MAX_SAFE_INTEGER);
  const report: Json = {
    tool: 'relay/src/tools/prover-memory.ts',
    ...describe,
    bun: (globalThis as { Bun?: { version: string } }).Bun?.version ?? null,
    containerLimitMb: mb(Number((readCgroup('memory.max') ?? '').trim()) || null),
    swapLimit: (readCgroup('memory.swap.max') ?? '').trim() || null,
    proofs,
    gcEach,
    payloadComparison: compared,
    samples: samples.length,
    peakAnonMb: all.anonMb,
    peakCurrentMb: all.currentMb,
    snapshots,
    proofRuns,
    budgetMb,
  };
  const identical = compared === null || compared.identical === true;
  const pass = identical && (budgetMb === null || (all.anonMb !== null && all.anonMb <= budgetMb));
  report.result = budgetMb === null && identical ? 'MEASURED' : pass ? 'PASS' : 'FAIL';
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (out) writeFileSync(out, text);
  process.stdout.write(text);
  return pass ? 0 : 1;
}

/** The real k=18 call through PassportRuntime's proof provider (or the stock one). */
async function realScenario(o: {
  stock: boolean;
  managedPath: string | undefined;
  proofServerUrl: string;
}): Promise<Scenario> {
  if (!o.managedPath) throw new Error('MIDNIGHT_MANAGED_PATH (the key volume) is required');
  const managedPath = resolve(o.managedPath);
  const log = createLogger({ level: 'warn', sink: (l) => process.stderr.write(`${l}\n`) });
  const rt = await PassportRuntime.load({
    managedPath,
    networkId: 'undeployed',
    // Never contacted: the harness proves only; it reads no chain state.
    indexerUrl: 'http://127.0.0.1:9/api/v4/graphql',
    indexerWsUrl: 'ws://127.0.0.1:9/api/v4/graphql/ws',
    proofServerUrl: o.proofServerUrl,
    log,
  });
  const unprovenTx = await buildCall(rt, managedPath);
  const provider = (o.stock ? await stockProvider(managedPath, o.proofServerUrl) : rt.proofProvider) as {
    proveTx(tx: unknown): Promise<{ serialize(): Uint8Array }>;
  };
  return {
    describe: {
      mode: 'real',
      circuit: `account/${CIRCUIT}`,
      proverKeyMb: mb(statSync(join(managedPath, 'account', 'keys', `${CIRCUIT}.prover`)).size),
      provider: o.stock ? 'midnight-js httpClientProofProvider (stock)' : 'relay (PassportRuntime.proofProvider)',
    },
    prove: async () => ({ provenTxBytes: (await provider.proveTx(unprovenTx)).serialize().length }),
    compare: () => compareBodies(rt.proofProvider as RelayProofProvider, unprovenTx),
  };
}

/**
 * No keys and no proof server: a generated prover key of --key-mb MB in a bundle with its compiler
 * manifest, a preimage for it, and an in-process server that reads each /prove body to the end and
 * answers 16 bytes. It measures what the relay itself holds while it sends a body (the CI check).
 */
async function syntheticScenario(work: string, o: { stock: boolean; keyMb: number }): Promise<Scenario> {
  const ledger = await import('@midnightntwrk/ledger-v9');
  const { encodeContractKeyLocation, hashVerifierKey } = await import('@midnight-ntwrk/midnight-js-types');
  const circuit = 'synthetic_k18';
  const volume = join(work, 'volume');
  const dir = join(volume, 'Synthetic');
  for (const d of ['keys', 'zkir', 'compiler']) mkdirSync(join(dir, d), { recursive: true });
  const keyBytes = o.keyMb * MB;
  const keyHash = createHash('sha256');
  const fd = openSync(join(dir, 'keys', `${circuit}.prover`), 'w');
  const chunk = new Uint8Array(16 * MB);
  for (let done = 0; done < keyBytes;) {
    const piece = chunk.subarray(0, Math.min(chunk.length, keyBytes - done));
    randomFillSync(piece);
    writeSync(fd, piece);
    keyHash.update(piece);
    done += piece.length;
  }
  closeSync(fd);
  const vk = new Uint8Array(randomBytes(3_000));
  const ir = new Uint8Array(randomBytes(40_000));
  writeFileSync(join(dir, 'keys', `${circuit}.verifier`), vk);
  writeFileSync(join(dir, 'zkir', `${circuit}.bzkir`), ir);
  const entry = (size: number, hash: string) => ({ type: 'file', size, hash });
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  writeFileSync(
    join(dir, 'compiler', 'contract-manifest.json'),
    JSON.stringify({
      'manifest-version': '1',
      keys: {
        type: 'directory',
        [`${circuit}.prover`]: entry(keyBytes, keyHash.digest('hex')),
        [`${circuit}.verifier`]: entry(vk.length, sha(vk)),
      },
      zkir: { type: 'directory', [`${circuit}.bzkir`]: entry(ir.length, sha(ir)) },
    }),
  );

  const received: { bytes: number; contentLength: string | null }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 2 ** 32 - 1,
    async fetch(req) {
      let bytes = 0;
      const reader = req.body?.getReader();
      for (let r = await reader?.read(); r && !r.done; r = await reader!.read()) bytes += r.value.length;
      received.push({ bytes, contentLength: req.headers.get('content-length') });
      return new Response(new Uint8Array(16));
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  const keyLocation = encodeContractKeyLocation({
    contractAddress: 'ab'.repeat(32),
    circuitId: circuit,
    verifierKeyHash: hashVerifierKey(vk),
  });
  const aligned = { value: [], alignment: [] };
  const preimage = ledger.proofDataIntoSerializedPreimage(aligned as never, aligned as never, [], [], keyLocation);
  let prover: { prove(p: Uint8Array, k: string, b?: bigint): Promise<Uint8Array> };
  if (o.stock) {
    const { nodeZkConfigRegistry } = await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
    const { httpClientProvingProvider } = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');
    prover = httpClientProvingProvider(url, await nodeZkConfigRegistry(volume), { timeout: 900_000 }) as never;
  } else {
    const { relayProofProvider } = await import('../prover/proving-provider.js');
    prover = (await relayProofProvider(url, volume, { timeout: 900_000 })).provingProvider();
  }
  return {
    describe: {
      mode: 'synthetic',
      circuit: `Synthetic/${circuit}`,
      proverKeyMb: o.keyMb,
      provider: o.stock ? 'midnight-js httpClientProvingProvider (stock)' : 'relay (relayProofProvider)',
      proofServer: 'in-process: reads each /prove body to the end, answers 16 bytes',
    },
    prove: async () => {
      const before = received.length;
      await prover.prove(preimage, keyLocation, 12_345n);
      const got = received[before];
      if (!got || got.bytes <= keyBytes) throw new Error('the server did not receive a whole /prove body');
      if (got.contentLength !== null && Number(got.contentLength) !== got.bytes) {
        throw new Error(`Content-Length ${got.contentLength} but ${got.bytes} bytes received`);
      }
      return { bodyBytes: got.bytes, contentLength: got.contentLength };
    },
    close: async () => {
      await server.stop(true);
    },
  };
}

/** The relay's path before P5.1b: midnight-js's stock HTTP proof provider over the key volume. */
async function stockProvider(managedPath: string, proofServerUrl: string): Promise<unknown> {
  const { nodeZkConfigRegistry } = await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
  const { httpClientProofProvider } = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');
  return httpClientProofProvider(proofServerUrl, await nodeZkConfigRegistry(resolve(managedPath)), {
    timeout: 900_000,
  });
}

/** Prove once through the relay's provider, and for each contract proof compare the body it posts
 *  with the ledger's own `createProvingPayload` over the full key material (the stock body). */
async function compareBodies(relay: RelayProofProvider, unprovenTx: unknown): Promise<Json> {
  const { CostModel, createProvingPayload } = await import('@midnightntwrk/ledger-v9');
  const inner = relay.provingProvider();
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const bodies: Json[] = [];
  const wrapped = {
    check: inner.check,
    lookupKey: inner.lookupKey,
    prove: async (preimage: Uint8Array, keyLocation: string, binding?: bigint) => {
      const material = await relay.keyMaterial(keyLocation);
      if (material) {
        const ours = sha(await relay.proveBody(preimage, keyLocation, binding));
        const ledger = sha(createProvingPayload(preimage, binding, material));
        bodies.push({
          proverKeyMb: mb(material.proverKey.length),
          relaySha256: ours,
          ledgerSha256: ledger,
          identical: ours === ledger,
        });
      }
      return inner.prove(preimage, keyLocation, binding);
    },
  };
  const tx = unprovenTx as { prove(p: unknown, c: unknown): Promise<unknown> };
  await tx.prove(wrapped, CostModel.initialCostModel());
  const identical = bodies.length > 0 && bodies.every((b) => b.identical === true);
  say(`payload comparison: ${bodies.length} contract bodies, identical=${String(identical)}`);
  return { bodies, identical };
}

/** The unproven `append_inbox_with_evm` call on an account made in process: the constructor and
 *  the activation run in the compact runtime, then midnight-js assembles the call exactly as a job
 *  does, from these states instead of the indexer's. */
async function buildCall(rt: PassportRuntime, managedPath: string): Promise<unknown> {
  const { account, contract, signer, witnesses } = rt.client as unknown as {
    account: { accountConstructorArgs(o: Json): unknown[] };
    contract: { Contract: new (w: unknown) => ContractLike; ledger(s: unknown): { auth_nonce: bigint } };
    signer: {
      EvmDevice: { generate(): EvmDeviceLike };
      ensureEnrolled(d: EvmDeviceLike): Promise<void>;
      activationArgs(d: EvmDeviceLike, salt: Uint8Array): unknown[];
      authorise(d: EvmDeviceLike, ctx: Json, req: Json, counter: bigint): Promise<unknown>;
      authArgs(a: unknown): unknown[];
    };
    witnesses: { emptyCoinStore(sk?: Uint8Array): unknown; makeWitnesses(): unknown };
  };
  const VENDOR = '../../../vendor/passport/contract';
  const [inbox, runtime, contracts, ledgerV9] = await Promise.all([
    import(`${VENDOR}/src/wallet/inbox.js`) as Promise<{
      generateEncKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array };
      sealInboxEntry(pk: Uint8Array, coin: Json): Uint8Array;
    }>,
    import('@midnight-ntwrk/compact-runtime'),
    import('@midnight-ntwrk/midnight-js-contracts'),
    import('@midnightntwrk/ledger-v9'),
  ]);

  const coinSecrets = ledgerV9.ZswapSecretKeys.fromSeed(new Uint8Array(randomBytes(32)));
  const coinPublicKey = coinSecrets.coinPublicKey;
  const encKeys = inbox.generateEncKeyPair();
  const privateState0 = witnesses.emptyCoinStore(encKeys.secretKey);
  const device = signer.EvmDevice.generate();
  await signer.ensureEnrolled(device);
  const salt = new Uint8Array(randomBytes(32));
  const evmDomainSalt = new Uint8Array(32).fill(0xdd);
  const address = runtime.sampleContractAddress();
  const addressBytes = Uint8Array.from(Buffer.from(address, 'hex'));

  // The constructor, as a deployment runs it (vault = zero: this call never reaches the vault).
  const c = new contract.Contract(witnesses.makeWitnesses());
  const constructed = await c.initialState(
    runtime.createConstructorContext(privateState0, coinPublicKey),
    ...account.accountConstructorArgs({
      bootCommitment: device.bootCommitment(salt),
      encryptionPublicKey: encKeys.publicKey,
      evmDomainSalt,
    }),
  );
  // The permissionless activation, in the runtime.
  const activation = await c.impureCircuits.activate_initial_device_with_evm(
    runtime.createCircuitContext(
      'activate_initial_device_with_evm' as never,
      address,
      coinPublicKey,
      constructed.currentContractState.data as never,
      constructed.currentPrivateState,
    ),
    ...signer.activationArgs(device, salt),
  );
  const state = activation.context.queryContexts[address]!.state;
  const privateState = activation.context.callContext.currentPrivateState;

  // The account's contract state as the chain would hold it: the activated data, and the called
  // operation carrying the key volume's verifier key (its hash is the call's key location).
  const contractState = constructed.currentContractState;
  contractState.data = state;
  const op = new runtime.ContractOperation();
  op.verifierKey = new Uint8Array(readFileSync(join(managedPath, 'account', 'keys', `${CIRCUIT}.verifier`)));
  contractState.setOperation(CIRCUIT, op);
  // The compact runtime's ContractState (what the indexer provider hands a job), not ledger-v9's.
  const initialContractState = contractState;

  const ctx = { contractAddress: addressBytes, authNonce: contract.ledger(state).auth_nonce, evmDomainSalt };
  const entry = inbox.sealInboxEntry(encKeys.publicKey, {
    nonce: new Uint8Array(randomBytes(32)),
    color: new Uint8Array(32).fill(0x11),
    value: 7n,
  });
  const auth = await signer.authorise(device, ctx, { op: 'appendInbox', entry }, 0n);
  const built = (await (contracts.createUnprovenCallTxFromInitialStates as (...a: unknown[]) => Promise<unknown>)(
    rt.zkConfigProvider,
    {
      compiledContract: rt.compiledAccount(),
      circuitId: CIRCUIT,
      contractAddress: address,
      args: [entry, ...signer.authArgs(auth)],
      coinPublicKey,
      initialContractState,
      initialZswapChainState: new ledgerV9.ZswapChainState(),
      ledgerParameters: ledgerV9.LedgerParameters.initialParameters(),
      initialPrivateState: privateState,
    },
    coinSecrets.encryptionPublicKey,
  )) as { private: { unprovenTx: unknown } };
  say(`built ${CIRCUIT} on ${address.slice(0, 8)}… (device ${hex(device.address).slice(0, 8)}…)`);
  return built.private.unprovenTx;
}

interface ContractLike {
  initialState(
    ctx: unknown,
    ...args: unknown[]
  ): Promise<{ currentContractState: ContractStateLike; currentPrivateState: unknown }>;
  impureCircuits: Record<
    string,
    (
      ctx: unknown,
      ...args: unknown[]
    ) => Promise<{
      context: {
        queryContexts: Record<string, { state: unknown } | undefined>;
        callContext: { currentPrivateState: unknown };
      };
    }>
  >;
}

interface ContractStateLike {
  data: unknown;
  setOperation(name: string, op: unknown): void;
}

interface EvmDeviceLike {
  address: Uint8Array;
  bootCommitment(salt: Uint8Array): Uint8Array;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    say(`error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(2);
  },
);
