// VENDORED VERBATIM from acedward/passport @ 51c1fb4ad164af034c8ed60fbb047e43cdd509f5 (identical at
// the canonical PR #4 head 07d8ea4f4e83ad264b3d2eef536be02047308827):
//   contract/contracts/erc20-vault/src/relayer.ts
// Everything below the marker line is the upstream file byte for byte (relay/test/bridge-vendor.test.ts
// compares it with the submodule on every run). Its one import, "./signet-sdk.js", resolves to this
// directory's shim, which reaches @sig-net/midnight 0.23.0 through THIS repository's root install
// instead of the vault package's own node_modules (the reason for the shim: Q12 option C, Q18).
// DROP this copy when the vault package can be imported from a hoisted install.
// ---- upstream relayer.ts below this line ----
// The relayer loop for one Signet request of this vault: MPC signature -> EVM broadcast ->
// MPC attestation. MOVED from e2e/relay.ts by project 00034 PR-G (G3) and RE-BASED by
// project 00037 on @sig-net/midnight 0.23.0 and sig-net's erc20-vault v0.3.0 client.
//
// The MPC only SIGNS and ATTESTS. Between those two acts somebody has to put the signed
// transaction on the EVM chain, and that somebody is an ordinary untrusted relayer — which
// is the whole point of the design: it can censor, but it cannot forge, because the settle
// circuits verify the attestation in-circuit against the response key the vault pinned.
//
//   1. poll the Signet singleton's response events until a signature that RECOVERS TO THE
//      EXPECTED DERIVED SENDER appears, and assemble the signed EIP-1559 transaction;
//   2. broadcast it (or find it already mined: the loop is resumable by request id) and
//      wait for the receipt;
//   3. poll until an attestation verifies over the attested output bytes.
//
// What 00037 changed, and why (sig-net erc20-vault v0.3.0 / SDK 0.23.0):
//
//   * EVENTS come from `signetEventSourceFromIndexer({ queryUrl })`. 0.23.0 removed
//     `signetEventSourceFromPublicDataProvider`; the new source reads the indexer's
//     `contractEvents` directly (the client half of Sig Network's "fallible sections" fix).
//     The public-data provider is still what the reader reads the REQUEST RECORD with.
//   * POLLS wait up to 20 minutes each (upstream `POLL_TIMEOUT_MS`): a live MPC attests
//     only once the EVM transaction is FINAL, and Sepolia finality takes two epochs, about
//     13 minutes. The attestation deadline therefore runs from the broadcast and covers
//     finality plus the poll (`DEFAULT_ATTESTATION_TIMEOUT_MS`).
//   * THE ATTESTED OUTPUT is read from the MPC's output cache when one is configured
//     (`MpcOutputCacheReader`: the exact bytes the MPC signed, written before it posts).
//     The cache is UNTRUSTED — the bytes only count once the attestation verifies over
//     them. When there is no cache, or it has no object yet, the loop falls back to this
//     fork's original trick: the schema is a single `bool`, so the attested output can only
//     be `true`, `false` or the protocol's fixed 5-byte never-executed marker, and the
//     right one is found by trying all three against the signature. No trace endpoint.
//   * PROGRESS is reported through `onProgress` at every stage (signed, broadcast,
//     finalized, attested) so a caller can persist it; re-running with the same request
//     id resumes, because the signed transaction is re-assembled from the chain and an
//     already-mined hash is never re-broadcast.

import { ethers } from "ethers";

import {
  MPC_FAILURE_OUTPUT,
  MpcOutputCacheReader,
  requestIdBytes,
  respondBidirectionalEventToCircuitInput,
  serializeRespondOutput,
  signetEventSourceFromIndexer,
  SignetRequestResponseReader,
  verifyRespondBidirectionalSignature,
} from "./signet-sdk.js";

export type AttestedKind = "success" | "returned-false" | "never-executed";

/** Where the attested output bytes came from. */
export type OutputOrigin = "mpc-cache" | "bool-candidates";

/** Upstream's give-up horizon for every MPC poll (erc20-vault v0.3.0 `POLL_TIMEOUT_MS`). */
export const POLL_TIMEOUT_MS = 20 * 60_000;

/** Sepolia finality: two epochs, about 13 minutes. */
export const SEPOLIA_FINALITY_MS = 13 * 60_000;

/** Attestation deadline, counted from the broadcast: finality plus one full poll. */
export const DEFAULT_ATTESTATION_TIMEOUT_MS = SEPOLIA_FINALITY_MS + POLL_TIMEOUT_MS;

export interface RelayResult {
  readonly evmTxHash?: string;
  readonly evmStatus?: number;
  readonly evmBlock?: number;
  readonly kind: AttestedKind;
  /** The exact unpadded bytes the attestation commits to — a settle-circuit argument. */
  readonly serializedOutput: Uint8Array;
  readonly outputOrigin: OutputOrigin;
  /**
   * The attested event in the CIRCUIT-INPUT shape. The wire form the singleton stores
   * carries R as a full point in big-endian bytes; the circuit takes a different spelling,
   * and passing the wire form straight through fails the in-circuit verify with
   * "Invalid attestation signature" even though it verified off-chain.
   */
  readonly event: unknown;
  readonly signedTxSender: string;
  readonly signedTxHash: string;
  readonly signedTxNonce: number;
  readonly waitedMs: number;
  /** ms from the start of the loop until the signature was seen. */
  readonly signatureAfterMs: number;
  /** ms from the start of the loop until the attestation verified. */
  readonly attestationAfterMs: number;
  /** Highest `finalized` block observed while waiting, if the RPC serves the tag. */
  readonly finalizedBlockSeen?: number;
}

/** One stage of the loop, reported as it happens so a caller can persist it. */
export type RelayProgress =
  | {
      readonly stage: "signed";
      readonly requestId: string;
      readonly signedTxHash: string;
      readonly from: string;
      readonly nonce: number;
      readonly to: string | null;
      readonly afterMs: number;
    }
  | {
      readonly stage: "broadcast";
      readonly requestId: string;
      readonly evmTxHash: string;
      readonly evmBlock: number;
      readonly evmStatus: number | undefined;
      readonly alreadyMined: boolean;
      readonly afterMs: number;
    }
  | {
      readonly stage: "not-broadcast";
      readonly requestId: string;
      readonly reason: string;
      readonly afterMs: number;
    }
  | {
      readonly stage: "finalized";
      readonly requestId: string;
      readonly evmBlock: number;
      readonly finalizedBlock: number;
      readonly afterMs: number;
    }
  | {
      readonly stage: "attested";
      readonly requestId: string;
      readonly kind: AttestedKind;
      readonly outputOrigin: OutputOrigin;
      readonly afterMs: number;
    };

/** The MPC output cache to read attested outputs from (SDK 0.23.0 `MpcOutputCacheReader`). */
export interface OutputCacheOptions {
  /** The Midnight network id the MPC serves, e.g. `stagenet`. */
  readonly networkId: string;
  /** Defaults to the cache the SDK publishes for `networkId`. */
  readonly cacheUrl?: string;
}

export interface RelayOptions {
  /** Reads the requester's ledger (the request record). */
  readonly publicDataProvider: unknown;
  /**
   * The indexer GraphQL endpoint the singleton's EVENTS are read from. Defaults to
   * `INDEXER_URL` / `MIDNIGHT_INDEXER_URL` from the environment.
   */
  readonly indexerUrl?: string;
  readonly requesterContractAddress: string;
  readonly requesterRequestsPath: readonly number[];
  readonly signetContractAddress: string;
  readonly requestId: string;
  /** The derived EVM account the MPC signs this request from. */
  readonly expectedSigner: string;
  readonly mpcResponseKey: { x: bigint; y: bigint; identity: boolean };
  readonly responseSchema: Uint8Array;
  readonly evmRpcUrl: string;
  /** Read the attested output from the MPC's output cache first. Off when undefined. */
  readonly outputCache?: OutputCacheOptions;
  /** Skip the broadcast entirely, to provoke a never-executed attestation. */
  readonly doNotBroadcast?: boolean;
  readonly intervalMs?: number;
  /** Legacy single deadline: when set, bounds BOTH polls (the local stack passes 5 min). */
  readonly timeoutMs?: number;
  /** Signature deadline, from the start of the loop. Default {@link POLL_TIMEOUT_MS}. */
  readonly signatureTimeoutMs?: number;
  /** Attestation deadline, from the broadcast. Default {@link DEFAULT_ATTESTATION_TIMEOUT_MS}. */
  readonly attestationTimeoutMs?: number;
  readonly onProgress?: (progress: RelayProgress) => void;
  readonly log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveIndexerUrl(explicit: string | undefined): string {
  const url = explicit ?? process.env.INDEXER_URL ?? process.env.MIDNIGHT_INDEXER_URL;
  if (url === undefined || url === "") {
    throw new Error(
      "relayer: no indexer URL — pass `indexerUrl` or set INDEXER_URL (SDK 0.23.0 reads the " +
        "Signet singleton's events straight from the indexer)",
    );
  }
  return url;
}

export function makeReader(options: {
  publicDataProvider: unknown;
  indexerUrl?: string;
  requesterContractAddress: string;
  requesterRequestsPath: readonly number[];
  signetContractAddress: string;
}): SignetRequestResponseReader {
  return new SignetRequestResponseReader({
    requesterContractAddress: options.requesterContractAddress,
    requesterRequestsPath: options.requesterRequestsPath,
    signetContractAddress: options.signetContractAddress,
    publicDataProvider: options.publicDataProvider as never,
    eventSource: signetEventSourceFromIndexer({ queryUrl: resolveIndexerUrl(options.indexerUrl) }),
  });
}

/** The three outputs a `bool`-schema request can be attested with. */
export function boolOutputCandidates(
  responseSchema: Uint8Array,
): readonly { kind: AttestedKind; bytes: Uint8Array }[] {
  return [
    { kind: "success", bytes: serializeRespondOutput(responseSchema, { success: true }) },
    { kind: "returned-false", bytes: serializeRespondOutput(responseSchema, { success: false }) },
    { kind: "never-executed", bytes: MPC_FAILURE_OUTPUT },
  ];
}

/** Which of the three candidates `bytes` is, or undefined for anything else. */
export function classifyOutput(
  responseSchema: Uint8Array,
  bytes: Uint8Array,
): AttestedKind | undefined {
  const same = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((value, index) => value === b[index]);
  return boolOutputCandidates(responseSchema).find((c) => same(c.bytes, bytes))?.kind;
}

/**
 * One attestation check over a request's posted attestations: the cached bytes first
 * (when given), then the three `bool` candidates. Pure given its inputs, so it is unit
 * tested without a network.
 */
export function findAttestation(
  requestId: string,
  posts: readonly unknown[],
  mpcResponseKey: RelayOptions["mpcResponseKey"],
  responseSchema: Uint8Array,
  cachedBytes: Uint8Array | undefined,
):
  | { kind: AttestedKind; bytes: Uint8Array; post: unknown; origin: OutputOrigin }
  | undefined {
  const id = requestIdBytes(requestId as never);
  const verifies = (bytes: Uint8Array) =>
    posts.find((post) =>
      verifyRespondBidirectionalSignature(id, bytes, post as never, mpcResponseKey as never),
    );
  if (cachedBytes !== undefined) {
    const post = verifies(cachedBytes);
    if (post !== undefined) {
      const kind = classifyOutput(responseSchema, cachedBytes);
      if (kind === undefined) {
        throw new Error(
          `request ${requestId}: the MPC attested an output that is none of true / false / ` +
            `never-executed (${Buffer.from(cachedBytes).toString("hex")})`,
        );
      }
      return { kind, bytes: cachedBytes, post, origin: "mpc-cache" };
    }
  }
  for (const candidate of boolOutputCandidates(responseSchema)) {
    const post = verifies(candidate.bytes);
    if (post !== undefined) {
      return { kind: candidate.kind, bytes: candidate.bytes, post, origin: "bool-candidates" };
    }
  }
  return undefined;
}

/** Run the whole relayer round trip for one request. Resumable: safe to re-run. */
export async function relayRequest(options: RelayOptions): Promise<RelayResult> {
  const log = options.log ?? ((line: string) => { console.log(line); });
  const progress = options.onProgress ?? (() => undefined);
  const intervalMs = options.intervalMs ?? 3_000;
  const signatureTimeoutMs = options.timeoutMs ?? options.signatureTimeoutMs ?? POLL_TIMEOUT_MS;
  const attestationTimeoutMs =
    options.timeoutMs ?? options.attestationTimeoutMs ?? DEFAULT_ATTESTATION_TIMEOUT_MS;
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const reader = makeReader(options);
  const cache =
    options.outputCache === undefined
      ? undefined
      : new MpcOutputCacheReader({
          networkId: options.outputCache.networkId,
          cacheUrl: options.outputCache.cacheUrl,
          signetContractAddress: options.signetContractAddress,
        });
  if (cache !== undefined) log(`      output cache ${cache.objectUrl(options.requestId as never)}`);

  // ---- 1. the MPC's signature over the EVM transaction ------------------------------
  let signed: ethers.Transaction | undefined;
  let lastNote = 0;
  while (signed === undefined) {
    if (elapsed() > signatureTimeoutMs) {
      throw new Error(
        `timed out after ${Math.round(elapsed() / 1000)} s waiting for the MPC's signature on ` +
          `${options.requestId} (expected signer ${options.expectedSigner})`,
      );
    }
    try {
      signed = await reader.getSignedEvmTransaction(
        options.requestId as never,
        options.expectedSigner,
      );
    } catch (error) {
      log(`      signature poll failed (retrying): ${String((error as Error)?.message ?? error)}`);
    }
    if (signed === undefined) {
      if (elapsed() - lastNote >= 60_000) {
        log(`      no signature yet (${Math.round(elapsed() / 1000)} s)`);
        lastNote = elapsed();
      }
      await sleep(intervalMs);
    }
  }
  const signatureAfterMs = elapsed();
  log(`      signed by ${String(signed.from)} nonce ${String(signed.nonce)} -> ${String(signed.to)} after ${Math.round(signatureAfterMs / 1000)} s`);
  if (signed.from?.toLowerCase() !== options.expectedSigner.toLowerCase()) {
    throw new Error(
      `the MPC signed as ${String(signed.from)}, expected the derived account ${options.expectedSigner}`,
    );
  }
  const signedTxHash = String(signed.hash);
  progress({
    stage: "signed",
    requestId: options.requestId,
    signedTxHash,
    from: String(signed.from),
    nonce: Number(signed.nonce),
    to: signed.to,
    afterMs: signatureAfterMs,
  });

  // ---- 2. broadcast (or find it already mined) --------------------------------------
  const provider = new ethers.JsonRpcProvider(options.evmRpcUrl, undefined, { staticNetwork: true });
  let evmTxHash: string | undefined;
  let evmStatus: number | undefined;
  let evmBlock: number | undefined;
  let broadcastAt = Date.now();
  let finalizedBlockSeen: number | undefined;
  try {
    if (options.doNotBroadcast === true) {
      log("      NOT broadcasting (provoking a never-executed attestation)");
      progress({ stage: "not-broadcast", requestId: options.requestId, reason: "doNotBroadcast", afterMs: elapsed() });
    } else {
      const existing = await provider.getTransactionReceipt(signedTxHash);
      let receipt = existing;
      if (receipt === null) {
        // A nonce another transaction already consumed can never be mined: say so and go
        // straight to the attestation, which will be the never-executed marker.
        const accountNonce = await provider.getTransactionCount(String(signed.from), "latest");
        if (accountNonce > Number(signed.nonce)) {
          const reason = `nonce ${String(signed.nonce)} already consumed (account nonce ${accountNonce}); not broadcasting`;
          log(`      ${reason}`);
          progress({ stage: "not-broadcast", requestId: options.requestId, reason, afterMs: elapsed() });
        } else {
          const sent = await provider.broadcastTransaction(signed.serialized);
          log(`      broadcast ${sent.hash}`);
          receipt = await sent.wait(1);
        }
      }
      if (receipt !== null) {
        evmTxHash = receipt.hash;
        evmStatus = receipt.status ?? undefined;
        evmBlock = receipt.blockNumber;
        broadcastAt = Date.now();
        log(`      evm tx ${receipt.hash} block ${String(receipt.blockNumber)} status ${String(receipt.status)}${existing ? " (already mined)" : ""}`);
        progress({
          stage: "broadcast",
          requestId: options.requestId,
          evmTxHash: receipt.hash,
          evmBlock: receipt.blockNumber,
          evmStatus,
          alreadyMined: existing !== null,
          afterMs: elapsed(),
        });
      }
    }

    // ---- 3. the attestation (finality is observed on the way, not required) ---------
    lastNote = 0;
    let finalityReported = false;
    for (;;) {
      if (evmBlock !== undefined && !finalityReported) {
        try {
          const finalized = await provider.getBlock("finalized");
          if (finalized !== null) {
            finalizedBlockSeen = finalized.number;
            if (finalized.number >= evmBlock) {
              finalityReported = true;
              log(`      evm block ${evmBlock} is final (finalized head ${finalized.number}) after ${Math.round((Date.now() - broadcastAt) / 1000)} s`);
              progress({
                stage: "finalized",
                requestId: options.requestId,
                evmBlock,
                finalizedBlock: finalized.number,
                afterMs: elapsed(),
              });
            }
          }
        } catch {
          // An RPC without the `finalized` tag just never reports finality.
        }
      }

      let cachedBytes: Uint8Array | undefined;
      if (cache !== undefined) {
        try {
          cachedBytes = await cache.fetchSerializedOutput(options.requestId as never);
        } catch (error) {
          log(`      output cache read failed (retrying): ${String((error as Error)?.message ?? error)}`);
        }
      }
      let posts: readonly unknown[] = [];
      try {
        posts = await reader.getRespondBidirectionalEvents(options.requestId as never);
      } catch (error) {
        log(`      attestation poll failed (retrying): ${String((error as Error)?.message ?? error)}`);
      }
      const found = findAttestation(
        options.requestId,
        posts,
        options.mpcResponseKey,
        options.responseSchema,
        cachedBytes,
      );
      if (found !== undefined) {
        const attestationAfterMs = elapsed();
        log(`      attested: ${found.kind} (output from ${found.origin}) after ${Math.round(attestationAfterMs / 1000)} s`);
        progress({
          stage: "attested",
          requestId: options.requestId,
          kind: found.kind,
          outputOrigin: found.origin,
          afterMs: attestationAfterMs,
        });
        return {
          evmTxHash,
          evmStatus,
          evmBlock,
          kind: found.kind,
          serializedOutput: found.bytes,
          outputOrigin: found.origin,
          event: respondBidirectionalEventToCircuitInput(found.post as never),
          signedTxSender: String(signed.from),
          signedTxHash,
          signedTxNonce: Number(signed.nonce),
          waitedMs: attestationAfterMs,
          signatureAfterMs,
          attestationAfterMs,
          finalizedBlockSeen,
        };
      }
      if (Date.now() - broadcastAt > attestationTimeoutMs) {
        throw new Error(
          `timed out ${Math.round((Date.now() - broadcastAt) / 1000)} s after the broadcast waiting ` +
            `for the MPC's attestation on ${options.requestId}` +
            `${cachedBytes === undefined ? "" : " (the cache held bytes that no post verified over)"}`,
        );
      }
      if (elapsed() - lastNote >= 60_000) {
        log(`      no verifying attestation yet (${Math.round(elapsed() / 1000)} s; ${posts.length} post(s); finalized head ${finalizedBlockSeen ?? "?"})`);
        lastNote = elapsed();
      }
      await sleep(intervalMs);
    }
  } finally {
    provider.destroy();
  }
}
