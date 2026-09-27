// The relay composition for one account-path bridge request (plan 00039, G-BRIDGE; research
// finding 7). Pure: no network, no Passport import, nothing environment-specific. The caller
// injects the vault's constants and its public-data provider. Written and proven live by the
// G-BRIDGE gate (test/gates/bridge/), moved here unchanged by plan L-BRG.4; the gate re-exports it.
//
// WHY IT EXISTS. Passport's `AccountBridge` (acedward/passport `contract/src/wallet/bridge.ts`,
// `latestRequestId`) takes "the newest open id in the shared vault" as the id of the request a
// start just created. The vault is shared by every account and wallet that bridges, so with a
// second user that is a race: another start landing in the same window, or an older request
// still open, is returned instead. The vault's own driver (erc20-vault `deploy/stagenet.ts`,
// `cmdDepositStart`) does it correctly, and this is that rule as a function:
//
//   1. read the open ids of the direction BEFORE the start and AFTER it;
//   2. keep the ids that are new;
//   3. keep the new ids whose stored record carries the expected MPC derivation path: this
//      account's deposit path (`depositPath(right(account))`) for a deposit, the vault's own
//      path (`vaultPath()`, `pad(32, "vault")`) for a withdrawal;
//   4. exactly one must remain.
//
// A withdrawal's path is the same for every user (the vault's own EVM account pays out), so
// step 3 does not separate two withdrawals: the relay's global withdrawal lane (one at a time,
// plan P1.3) is what keeps the diff to one new id.
//
// The rest of the file builds the options of the vault's `relayRequest` (erc20-vault
// `src/relayer.ts`, SDK 0.23.0) with every field the 0.23 relayer needs spelled out, and a JSON
// codec for its result so a relay can resume from stored state after a restart.

export type BridgeKind = 'deposit' | 'withdraw';

/** Lower-case hex without a `0x` prefix: the one spelling ids and paths are compared in. */
export function normaliseHex(value: string): string {
  return value.replace(/^0x/i, '').toLowerCase();
}

export class RequestMatchError extends Error {
  constructor(
    message: string,
    readonly freshIds: readonly string[],
  ) {
    super(message);
    this.name = 'RequestMatchError';
  }
}

export interface RequestMatch {
  /** The id the MPC answers under. */
  readonly requestId: string;
  /** Every id that appeared between the two reads, ours included. */
  readonly freshIds: readonly string[];
}

/**
 * The request a start created: new between `before` and `after`, and carrying `expectedPathHex`.
 * Throws {@link RequestMatchError} unless exactly one id qualifies.
 */
export function matchNewRequest(input: {
  readonly before: Iterable<string>;
  readonly after: Iterable<string>;
  /** The stored record's derivation path as hex, or undefined when the id has no record. */
  readonly pathOf: (requestId: string) => string | undefined;
  readonly expectedPathHex: string;
}): RequestMatch {
  const before = new Set([...input.before].map(normaliseHex));
  const freshIds = [...new Set([...input.after].map(normaliseHex))].filter((id) => !before.has(id));
  if (freshIds.length === 0) {
    throw new RequestMatchError('the start created no new request in the vault', freshIds);
  }
  const expected = normaliseHex(input.expectedPathHex);
  const ours = freshIds.filter((id) => {
    const stored = input.pathOf(id);
    return stored !== undefined && normaliseHex(stored) === expected;
  });
  if (ours.length === 0) {
    throw new RequestMatchError(
      `none of the ${freshIds.length} new request(s) carries the expected derivation path ${expected}`,
      freshIds,
    );
  }
  if (ours.length > 1) {
    throw new RequestMatchError(
      `${ours.length} new requests carry the expected derivation path; serialise starts on one path`,
      freshIds,
    );
  }
  return { requestId: ours[0]!, freshIds };
}

/** The MPC signature budget: the plan's stop rule and upstream's `POLL_TIMEOUT_MS`. */
export const MPC_SIGNATURE_BUDGET_MS = 20 * 60_000;

/** Sepolia finality (two epochs, about 13 minutes) plus one full poll, counted from the broadcast. */
export const ATTESTATION_BUDGET_MS = 13 * 60_000 + 20 * 60_000;

/**
 * What is left of the signature budget when the budget counts from the START (the Midnight
 * transaction that created the request), not from whenever the relay loop happens to begin.
 */
export function remainingSignatureBudgetMs(
  startedAtMs: number,
  nowMs: number,
  budgetMs: number = MPC_SIGNATURE_BUDGET_MS,
): number {
  return Math.max(0, budgetMs - Math.max(0, nowMs - startedAtMs));
}

/** The vault's public constants a relay needs: addresses, ledger paths, keys. */
export interface VaultRelayConstants {
  readonly vaultAddress: string;
  readonly signetAddress: string;
  readonly depositRequestsPath: readonly number[];
  readonly withdrawRequestsPath: readonly number[];
  readonly responseSchema: Uint8Array;
  readonly mpcResponseKey: { readonly x: bigint; readonly y: bigint; readonly identity: boolean };
}

/** Where the relay reads and writes: every one is configuration (FR-014). */
export interface RelayEndpoints {
  /** The Midnight indexer's GraphQL URL; SDK 0.23.0 reads the singleton's events from it. */
  readonly indexerUrl: string;
  /** The EVM JSON-RPC the signed transaction is broadcast to. */
  readonly evmRpcUrl: string;
  /** The MPC's output cache: the exact attested bytes, untrusted until an attestation verifies. */
  readonly outputCache: { readonly networkId: string; readonly cacheUrl: string };
}

/**
 * The options object for the vault's `relayRequest`. Never sets the legacy `timeoutMs`, which
 * would bound BOTH polls with one number; the signature and attestation deadlines are separate.
 */
export function relayOptionsFor(input: {
  readonly kind: BridgeKind;
  readonly requestId: string;
  /** The derived EVM account the MPC signs from: the deposit address, or the vault's own account. */
  readonly expectedSigner: string;
  readonly vault: VaultRelayConstants;
  readonly endpoints: RelayEndpoints;
  readonly publicDataProvider: unknown;
  readonly signatureTimeoutMs: number;
  readonly attestationTimeoutMs?: number;
  readonly intervalMs?: number;
  readonly onProgress?: (progress: unknown) => void;
  readonly log?: (line: string) => void;
}) {
  return {
    publicDataProvider: input.publicDataProvider,
    indexerUrl: input.endpoints.indexerUrl,
    requesterContractAddress: normaliseHex(input.vault.vaultAddress),
    requesterRequestsPath:
      input.kind === 'deposit' ? input.vault.depositRequestsPath : input.vault.withdrawRequestsPath,
    signetContractAddress: normaliseHex(input.vault.signetAddress),
    requestId: normaliseHex(input.requestId),
    expectedSigner: input.expectedSigner,
    mpcResponseKey: input.vault.mpcResponseKey,
    responseSchema: input.vault.responseSchema,
    evmRpcUrl: input.endpoints.evmRpcUrl,
    outputCache: { networkId: input.endpoints.outputCache.networkId, cacheUrl: input.endpoints.outputCache.cacheUrl },
    signatureTimeoutMs: input.signatureTimeoutMs,
    attestationTimeoutMs: input.attestationTimeoutMs ?? ATTESTATION_BUDGET_MS,
    intervalMs: input.intervalMs ?? 15_000,
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    ...(input.log === undefined ? {} : { log: input.log }),
  };
}

/** True when a `relayRequest` error is the signature deadline (the stop rule), not a transport fault. */
export function isSignatureTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out after \d+ s waiting for the MPC's signature/.test(message);
}

/**
 * A relay result (or any value with bigints and bytes inside, such as the attested event in
 * circuit-input form) as plain JSON, so a job can be stored and resumed by request id.
 */
export function toResumableJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === 'bigint') return { __bigint: v.toString() };
      if (v instanceof Uint8Array) return { __bytes: Buffer.from(v).toString('hex') };
      // A Buffer reaches the replacer already through its own toJSON: { type: 'Buffer', data }.
      if (isBufferJson(v)) return { __bytes: Buffer.from(v.data).toString('hex') };
      return v;
    }),
  );
}

function isBufferJson(v: unknown): v is { type: 'Buffer'; data: number[] } {
  return (
    v !== null &&
    typeof v === 'object' &&
    (v as { type?: unknown }).type === 'Buffer' &&
    Array.isArray((v as { data?: unknown }).data)
  );
}

/** The inverse of {@link toResumableJson}. */
export function fromResumableJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(fromResumableJson);
  const record = value as Record<string, unknown>;
  if (typeof record.__bigint === 'string') return BigInt(record.__bigint);
  if (typeof record.__bytes === 'string') return Uint8Array.from(Buffer.from(record.__bytes, 'hex'));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(record)) out[key] = fromResumableJson(v);
  return out;
}
