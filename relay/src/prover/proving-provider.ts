// The relay's proof provider: midnight-js's HTTP proof provider (5.0.0-beta.7), rebuilt so that a
// proof never holds its prover key in memory (plan 00039 P5.1b, question Q25).
//
// The stock provider held about eight copies of a k=18 account key (544 MB) per proof: the relay
// peaked at 4.6 GB for one proof and 5.1 GB for four in a row, and kept 1.7 GB for good
// (relay/src/tools/prover-memory.ts measures it):
//   - `check` resolved the FULL key material, reading and hashing the prover key, to send the ZKIR;
//   - `prove` read the key again, and the ledger's WASM `createProvingPayload` copied it into the
//     WASM heap and serialised the body there (a Vec that grows to 1 GiB) before copying it out, so
//     the WASM heap grew to about 1.7 GB, and a WASM heap never shrinks;
//   - the body was copied once more and posted through cross-fetch/node-fetch, and Bun's fetch
//     copies an in-memory body again while it sends it;
//   - the ledger's `Transaction.prove` also calls `lookupKey` for every contract call, only to read
//     the verifier key's version tag (ledger/src/prove.rs, `ContractCall::prove`), and the WASM glue
//     copies all three fields of the answer, the prover key included, into its heap.
// Here `check` reads only the ZKIR, `lookupKey` answers the verifier key and ZKIR with an EMPTY
// prover key (the relay never proves locally, and the ledger reads nothing else from it), and
// `prove` STREAMS the body (./prove-body.ts): the ledger's few-kilobyte frame, the prover key read
// from its file in 16 MB chunks, then the verifier key, ZKIR and binding input. The bytes are the
// ledger's own (the key material's layout is checked against the ledger on every proof; on a
// mismatch that proof falls back to the ledger building the body, as before), and the request
// carries a Content-Length, so the proof server sees the same request as before.
//
// Everything else is midnight-js's: a key location's embedded verifier-key hash picks the bundle
// (ZKConfigRegistry's rule); the verifier key and ZKIR come from its NodeZkConfigProvider,
// integrity-checked; the prover key is checked against the same compiler manifest, fail-closed
// (size before anything is sent, SHA-256 before the body's last bytes are sent, so a key that
// fails never reaches the proof server whole); requests, retries (3, on 500/503 and network
// errors, after 1, 2 and 4 s) and timeouts are the stock provider's.

import { createHash } from 'node:crypto';
import { open, readFile, readdir, stat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import * as ledgerV9 from '@midnightntwrk/ledger-v9';
import { CostModel } from '@midnightntwrk/ledger-v9';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {
  InvalidProtocolSchemeError,
  ZKArtifactNotFoundError,
  hashVerifierKey,
  parseContractKeyLocation,
} from '@midnight-ntwrk/midnight-js-types';
import {
  ZK_MANIFEST_DIR,
  ZK_MANIFEST_FILE_NAME,
  ZkArtifactIntegrityError,
  assertSafeName,
  parseZkArtifactManifest,
  warnIfInsecureRemoteUrl,
  type ZkArtifactManifest,
} from '@midnight-ntwrk/midnight-js-utils';

import type { Logger } from '../log.js';
import { assembleProveBody, equalBytes, proveBodyFrame, proveBodyParts, type ProveBodyParts } from './prove-body.js';

/** midnight-js's default per-request timeout (the relay passes its own, 900 s). */
export const DEFAULT_PROOF_TIMEOUT_MS = 300_000;
const RETRIES = 3;
const RETRY_ON = [500, 503];
const retryDelayMs = (attempt: number) => 2 ** attempt * 1_000;
/** How much of a prover key is in memory at once while it is sent. */
export const KEY_CHUNK_BYTES = 16 * 1024 * 1024;
/** The one-byte prover key of the per-proof layout check. */
const PROBE_KEY = Uint8Array.of(0x5a);

interface KeyMaterial {
  proverKey: Uint8Array;
  verifierKey: Uint8Array;
  ir: Uint8Array;
}

/** What the ledger's `Transaction.prove` calls (ledger-v9 `ProvingProvider`). */
export interface LedgerProvingProvider {
  check(serializedPreimage: Uint8Array, keyLocation: string): Promise<(bigint | undefined)[]>;
  prove(serializedPreimage: Uint8Array, keyLocation: string, overwriteBindingInput?: bigint): Promise<Uint8Array>;
  lookupKey(keyLocation: string): Promise<KeyMaterial | undefined>;
}

/** midnight-js's `ProofProvider`, plus the relay's inspection hooks. */
export interface RelayProofProvider {
  proveTx(unprovenTx: unknown, config?: { timeout?: number }): Promise<unknown>;
  /** The circuit-level provider (the harness and the tests drive it directly). */
  provingProvider(timeoutMs?: number): LedgerProvingProvider;
  /** The whole /prove body `prove` sends for these arguments, in memory (byte-identity checks). */
  proveBody(serializedPreimage: Uint8Array, keyLocation: string, overwriteBindingInput?: bigint): Promise<Uint8Array>;
  /** The FULL key material of a contract key location, prover key included (byte-identity checks). */
  keyMaterial(keyLocation: string): Promise<KeyMaterial | undefined>;
}

/** The ledger functions the provider uses (ledger-v9's; the tests substitute them). */
export interface ProvingLedger {
  createProvingPayload(
    serializedPreimage: Uint8Array,
    overwriteBindingInput?: bigint,
    keyMaterial?: KeyMaterial,
  ): Uint8Array;
  createCheckPayload(serializedPreimage: Uint8Array, ir?: Uint8Array): Uint8Array;
  parseCheckResult(result: Uint8Array): (bigint | undefined)[];
}

export interface RelayProofProviderOptions {
  /** Per-request timeout, ms (default 300 s, midnight-js's). */
  timeout?: number;
  headers?: Record<string, string>;
  log?: Logger;
  fetch?: typeof fetch;
  /** How much of a prover key is read at once (default KEY_CHUNK_BYTES). */
  keyChunkBytes?: number;
  ledger?: ProvingLedger;
}

/** A /prove body: in memory (a builtin, or the ledger-built fallback) or streamed from the key file. */
type ProveRequestBody = Uint8Array | StreamedBody;

interface StreamedBody {
  length: number;
  /** A fresh stream per attempt. */
  open(): ReadableStream<Uint8Array>;
  /** The integrity failure that stopped the last stream, if any. */
  failure(): ZkArtifactIntegrityError | null;
}

/** One compiled contract's artefacts: `<dir>/{keys,zkir,compiler}`, like midnight-js's bundles. */
class ArtefactBundle {
  readonly zk: NodeZkConfigProvider<string>;
  private manifestPromise: Promise<ZkArtifactManifest | undefined> | undefined;

  constructor(readonly dir: string) {
    this.zk = new NodeZkConfigProvider<string>(dir);
  }

  /** The bundle's compiler manifest (undefined when absent: the prover key then fails, fail-closed). */
  manifest(): Promise<ZkArtifactManifest | undefined> {
    if (!this.manifestPromise) {
      const p = readFile(join(this.dir, ZK_MANIFEST_DIR, ZK_MANIFEST_FILE_NAME)).then(
        (bytes) => parseZkArtifactManifest(bytes.toString('utf-8')),
        (e: unknown) => {
          if ((e as { code?: string }).code === 'ENOENT') return undefined;
          throw e;
        },
      );
      this.manifestPromise = p;
      p.catch(() => {
        if (this.manifestPromise === p) this.manifestPromise = undefined;
      });
    }
    return this.manifestPromise;
  }

  proverKeyPath(circuitId: string): string {
    assertSafeName(circuitId, 'circuitId');
    const base = resolve(this.dir, 'keys');
    const target = resolve(base, `${circuitId}.prover`);
    const rel = relative(base, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Invalid circuitId: ${JSON.stringify(circuitId)}`);
    }
    return target;
  }
}

/** The artefact bundles under `root`: every directory holding `keys/` and `zkir/` (midnight-js's
 *  `nodeZkConfigRegistry` rule), in a stable order. */
export async function findArtefactBundles(root: string): Promise<string[]> {
  const out: string[] = [];
  const isDir = async (p: string) => {
    try {
      return (await stat(p)).isDirectory();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      throw e;
    }
  };
  const visit = async (dir: string) => {
    if ((await isDir(join(dir, 'keys'))) && (await isDir(join(dir, 'zkir')))) {
      out.push(dir);
      return;
    }
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) await visit(join(dir, e.name));
    }
  };
  await visit(resolve(root));
  if (out.length === 0) {
    throw new Error(
      `No compiled contract artifact bundles (directories containing 'keys/' and 'zkir/' subdirectories) found under '${root}'`,
    );
  }
  return out;
}

/**
 * The body `prefix | key file | suffix` as a stream. The key's SHA-256 is computed as it is read
 * and compared with the manifest's before the suffix is sent: on a mismatch the stream fails, the
 * request never completes, and `failure()` returns the error.
 */
function streamedBody(
  path: string,
  parts: ProveBodyParts,
  keyLength: number,
  expectedSha256: string,
  label: string,
  chunkBytes: number,
): StreamedBody {
  let failure: ZkArtifactIntegrityError | null = null;
  return {
    length: parts.total,
    failure: () => failure,
    open() {
      failure = null;
      let file: FileHandle | undefined;
      let sent = -1; // -1: the prefix is next
      const hash = createHash('sha256');
      const closeFile = async () => {
        const f = file;
        file = undefined;
        await f?.close().catch(() => undefined);
      };
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (sent === -1) {
              file = await open(path, 'r');
              sent = 0;
              controller.enqueue(parts.prefix);
              return;
            }
            if (sent < keyLength) {
              const chunk = new Uint8Array(Math.min(chunkBytes, keyLength - sent));
              const { bytesRead } = await file!.read(chunk, 0, chunk.length, sent);
              if (bytesRead === 0) {
                throw new ZkArtifactIntegrityError(
                  `ZK artifact "${label}" failed integrity verification: expected ${keyLength} bytes, got ${sent}`,
                );
              }
              const piece = bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
              hash.update(piece);
              sent += bytesRead;
              controller.enqueue(piece);
              return;
            }
            await closeFile();
            const actual = hash.digest('hex');
            if (actual !== expectedSha256) {
              throw new ZkArtifactIntegrityError(
                `ZK artifact "${label}" failed integrity verification: expected sha-256 ${expectedSha256}, got ${actual}`,
              );
            }
            controller.enqueue(parts.suffix);
            controller.close();
          } catch (e) {
            await closeFile();
            if (e instanceof ZkArtifactIntegrityError) failure = e;
            controller.error(e);
          }
        },
        async cancel() {
          await closeFile();
        },
      });
    },
  };
}

/** The relay's proof provider over the key volume at `managedPath`. */
export async function relayProofProvider(
  proofServerUrl: string,
  managedPath: string,
  options: RelayProofProviderOptions = {},
): Promise<RelayProofProvider> {
  const bundles = (await findArtefactBundles(managedPath)).map((d) => new ArtefactBundle(d));
  const checkUrl = endpoint(proofServerUrl, '/check');
  const proveUrl = endpoint(proofServerUrl, '/prove');
  warnIfInsecureRemoteUrl(proofServerUrl, 'proof server URL');
  const fetchImpl = options.fetch ?? fetch;
  const headers = { 'Content-Type': 'application/octet-stream', ...(options.headers ?? {}) };
  const defaultTimeout = options.timeout ?? DEFAULT_PROOF_TIMEOUT_MS;
  const chunkBytes = options.keyChunkBytes ?? KEY_CHUNK_BYTES;
  const { createCheckPayload, createProvingPayload, parseCheckResult } = options.ledger ?? (ledgerV9 as ProvingLedger);
  let layoutWarned = false;

  // A key location → the bundle serving it, bound once (midnight-js's ZKConfigRegistry rule: the
  // bundle whose verifier key for the circuit hashes to the location's embedded hash).
  const bound = new Map<string, ArtefactBundle>();
  const vkHashes = new Map<ArtefactBundle, Map<string, string>>();
  const resolveLocation = async (
    keyLocation: string,
  ): Promise<{ bundle: ArtefactBundle; circuitId: string } | undefined> => {
    const parsed = parseContractKeyLocation(keyLocation);
    if (parsed === undefined) return undefined; // a protocol builtin: the proof server has its keys
    const known = bound.get(keyLocation);
    if (known) return { bundle: known, circuitId: parsed.circuitId };
    const suppressed: unknown[] = [];
    for (const bundle of bundles) {
      let hash = vkHashes.get(bundle)?.get(parsed.circuitId);
      if (hash === undefined) {
        try {
          hash = hashVerifierKey(await bundle.zk.getVerifierKey(parsed.circuitId));
        } catch (e) {
          suppressed.push(e);
          continue;
        }
        if (!vkHashes.has(bundle)) vkHashes.set(bundle, new Map());
        vkHashes.get(bundle)!.set(parsed.circuitId, hash);
      }
      if (hash !== parsed.verifierKeyHash) continue;
      bound.set(keyLocation, bundle);
      return { bundle, circuitId: parsed.circuitId };
    }
    throw new ZKArtifactNotFoundError(parsed, suppressed);
  };

  const post = async (url: URL, body: ProveRequestBody, timeoutMs: number): Promise<Uint8Array> => {
    const signal = AbortSignal.timeout(timeoutMs);
    const init = (): RequestInit & { duplex?: 'half' } =>
      body instanceof Uint8Array
        ? { method: 'POST', body: body as BodyInit, headers, signal }
        : {
            method: 'POST',
            body: body.open(),
            headers: { ...headers, 'Content-Length': String(body.length) },
            signal,
            duplex: 'half',
          };
    let response: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      let failure: unknown = null;
      response = undefined;
      try {
        response = await fetchImpl(url, init());
      } catch (e) {
        failure = e;
      }
      // A prover key that failed its integrity check is not a network error: never retried.
      const integrity = body instanceof Uint8Array ? null : body.failure();
      if (integrity) throw integrity;
      if (response && !RETRY_ON.includes(response.status)) break;
      if (attempt >= RETRIES) {
        if (failure !== null) throw failure;
        break;
      }
      await response?.body?.cancel().catch(() => undefined);
      await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
    }
    const res = response!;
    if (!res.ok) {
      throw new Error(
        `Failed Proof Server response: url="${res.url}", code="${res.status}", status="${res.statusText}"`,
      );
    }
    return new Uint8Array(await res.arrayBuffer());
  };

  /** The /prove request body for a proof: streamed from the key file, or in memory. */
  const proveRequest = async (
    serializedPreimage: Uint8Array,
    keyLocation: string,
    overwriteBindingInput?: bigint,
  ): Promise<ProveRequestBody> => {
    const target = await resolveLocation(keyLocation);
    // A protocol builtin: no key material, a body of a few kilobytes.
    if (!target) return createProvingPayload(serializedPreimage, overwriteBindingInput);
    const { bundle, circuitId } = target;
    const [verifierKey, ir] = await Promise.all([bundle.zk.getVerifierKey(circuitId), bundle.zk.getZKIR(circuitId)]);
    const frame = proveBodyFrame(
      createProvingPayload(serializedPreimage, overwriteBindingInput),
      createProvingPayload(serializedPreimage, undefined),
    );
    // The layout check: the ledger's own body for a one-byte key must equal ours.
    const ledgerProbe = createProvingPayload(serializedPreimage, overwriteBindingInput, {
      proverKey: PROBE_KEY,
      verifierKey,
      ir,
    });
    if (!equalBytes(ledgerProbe, assembleProveBody(frame, { proverKey: PROBE_KEY, verifierKey, ir }))) {
      if (!layoutWarned) {
        layoutWarned = true;
        options.log?.warn('the ledger /prove body layout changed; the ledger builds the body (more memory)', {
          circuit: circuitId,
        });
      }
      return createProvingPayload(serializedPreimage, overwriteBindingInput, {
        proverKey: await bundle.zk.getProverKey(circuitId),
        verifierKey,
        ir,
      });
    }
    // The prover key's integrity entry, checked as midnight-js checks it (fail-closed): its size
    // before anything is sent, its SHA-256 while it is sent.
    const label = `keys/${circuitId}.prover`;
    const path = bundle.proverKeyPath(circuitId);
    const manifest = await bundle.manifest();
    const entry = manifest?.files.get(label);
    if (entry === undefined) {
      const reason =
        manifest === undefined
          ? `no ZK artifact manifest (${ZK_MANIFEST_DIR}/${ZK_MANIFEST_FILE_NAME}) was found`
          : `ZK artifact manifest has no entry for "${label}"`;
      throw new ZkArtifactIntegrityError(
        `${reason}; integrity verification is required. Recompile with a manifest-emitting compactc, ` +
          `or construct the provider with { verify: 'warn' } or { verify: 'off' } to opt out.`,
      );
    }
    const size = (await stat(path)).size;
    if (size !== entry.size) {
      throw new ZkArtifactIntegrityError(
        `ZK artifact "${label}" failed integrity verification: expected ${entry.size} bytes, got ${size}`,
      );
    }
    return streamedBody(path, proveBodyParts(frame, size, verifierKey, ir), size, entry.hash, label, chunkBytes);
  };

  const collect = async (body: ProveRequestBody): Promise<Uint8Array> => {
    if (body instanceof Uint8Array) return body;
    const bytes = new Uint8Array(await new Response(body.open()).arrayBuffer());
    const failure = body.failure();
    if (failure) throw failure;
    return bytes;
  };

  const provingProvider = (timeoutMs: number = defaultTimeout): LedgerProvingProvider => ({
    async check(serializedPreimage, keyLocation) {
      const target = await resolveLocation(keyLocation);
      const ir = target ? await target.bundle.zk.getZKIR(target.circuitId) : undefined;
      return parseCheckResult(await post(checkUrl, createCheckPayload(serializedPreimage, ir), timeoutMs));
    },

    async prove(serializedPreimage, keyLocation, overwriteBindingInput) {
      return post(proveUrl, await proveRequest(serializedPreimage, keyLocation, overwriteBindingInput), timeoutMs);
    },

    // The ledger reads only the verifier key from this (its version tag), but copies every field
    // into its WASM heap: the prover key is left empty.
    async lookupKey(keyLocation) {
      const target = await resolveLocation(keyLocation);
      if (!target) return undefined;
      const { bundle, circuitId } = target;
      const [verifierKey, ir] = await Promise.all([bundle.zk.getVerifierKey(circuitId), bundle.zk.getZKIR(circuitId)]);
      return { proverKey: new Uint8Array(0), verifierKey, ir };
    },
  });

  const keyMaterial = async (keyLocation: string): Promise<KeyMaterial | undefined> => {
    const target = await resolveLocation(keyLocation);
    if (!target) return undefined;
    const { bundle, circuitId } = target;
    const [proverKey, verifierKey, ir] = await Promise.all([
      bundle.zk.getProverKey(circuitId),
      bundle.zk.getVerifierKey(circuitId),
      bundle.zk.getZKIR(circuitId),
    ]);
    return { proverKey, verifierKey, ir };
  };

  return {
    provingProvider,
    keyMaterial,
    proveBody: async (serializedPreimage, keyLocation, overwriteBindingInput) =>
      collect(await proveRequest(serializedPreimage, keyLocation, overwriteBindingInput)),
    async proveTx(unprovenTx, config) {
      const tx = unprovenTx as { prove(provider: LedgerProvingProvider, costModel: CostModel): Promise<unknown> };
      return tx.prove(provingProvider(config?.timeout ?? defaultTimeout), CostModel.initialCostModel());
    },
  };
}

function endpoint(base: string, path: string): URL {
  const url = new URL(base);
  url.pathname = url.pathname.replace(/\/$/, '') + path;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidProtocolSchemeError(url.protocol, ['http:', 'https:']);
  }
  return url;
}
