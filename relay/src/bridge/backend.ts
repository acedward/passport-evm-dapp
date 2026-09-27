// What the bridge service needs from the outside world, as one interface (plan L-BRG.4): Sepolia
// reads, the vault's public state, the two device-gated starts and the three settles (proofs paid
// by the sponsor), and the relayer loop between them (the MPC's signature, the broadcast, Sepolia
// finality, the attestation).
//
// The service (./service.ts) holds every rule: the lanes, the preflights, the nonce the customer
// signs, the request-id match, the stages, resume and refund. It talks only to this interface, so
// its tests run with a fake MPC and a fake chain (relay/test/bridge-*.test.ts); the live
// implementation is ./live-backend.ts.

import type {
  AttestedKind,
  BridgeCoinJson,
  BridgeDepositPayload,
  BridgeKind,
  BridgeWithdrawPayload,
} from '@mnbank/core';

/** Sepolia, read-only. */
export interface EvmReader {
  ethBalance(address: string): Promise<bigint>;
  erc20Balance(token: string, holder: string): Promise<bigint>;
  /** The transaction count, as of the latest block or including the mempool. */
  nonce(address: string, tag: 'latest' | 'pending'): Promise<bigint>;
}

/** The request ids open in one direction of the vault, and each one's stored derivation path. */
export interface OpenRequests {
  ids: string[];
  pathOf(requestId: string): string | undefined;
}

/** What a vault settle view says about a request: who the mint (or refund) goes to, and what. */
export interface SettleView {
  /** The recipient account (64 hex), or null when the recipient is a wallet key. */
  account: string | null;
  erc20: string;
  amount: bigint;
}

/** One stage of the relayer loop, as upstream's `relayRequest` reports it. */
export type RelayProgress =
  | { stage: 'signed'; signedTxHash: string; from: string; nonce: number; afterMs: number }
  | {
      stage: 'broadcast';
      evmTxHash: string;
      evmBlock: number;
      evmStatus: number | undefined;
      alreadyMined: boolean;
      afterMs: number;
    }
  | { stage: 'not-broadcast'; reason: string; afterMs: number }
  | { stage: 'finalized'; evmBlock: number; finalizedBlock: number; afterMs: number }
  | { stage: 'attested'; kind: AttestedKind; outputOrigin: string; afterMs: number };

/** The relayer loop's result: the settle circuits' two arguments plus public facts. Opaque to the
 *  service except for the named fields. */
export interface RelayOutcome {
  kind: AttestedKind;
  evmTxHash?: string;
  evmStatus?: number;
  signedTxHash: string;
  signatureAfterMs: number;
  attestationAfterMs: number;
  /** The attested event (circuit-input form) and output bytes, passed to the settle unchanged. */
  event: unknown;
  serializedOutput: Uint8Array;
}

/** A gated start's verified authorisation (the circuit's trailing `pk, use_counter, sig`). */
export interface StartAuth {
  arm: 'evm';
  pk: { x: bigint; y: bigint; identity: false };
  use_counter: bigint;
  sig: { r: bigint; s: bigint };
}

export interface StartOutcome {
  txId: string;
  /** A withdrawal's change coin (the circuit's result); null for a deposit or a whole-coin spend. */
  change: BridgeCoinJson | null;
}

export interface SettleOutcome {
  txId: string;
  coin: BridgeCoinJson | null;
  entryMatchesCoin: boolean;
}

export type SettleCircuit = 'bridge_deposit_complete' | 'bridge_withdraw_complete' | 'bridge_withdraw_refund';

export interface TxFacts {
  hash: string | null;
  blockHeight: number | null;
  /** The block's timestamp, ms. */
  blockMs: number | null;
}

export interface BridgeBackend {
  readonly evm: EvmReader;
  /** The vault's own EVM account (deposits land there; withdrawals are paid from it). */
  readonly vaultEvmAddress: string;
  /** The Sepolia address that pays `account`'s deposits: derived from `depositPath(right(account))`. */
  depositAddress(account: string): string;
  /** `depositPath(right(account))` as the vault stores it (64 hex). */
  depositPathHex(account: string): string;
  /** The vault's own path, `pad(32, "vault")` (64 hex): every withdrawal carries it. */
  vaultPathHex(): string;
  /** The shielded colour the vault mints for `erc20` (64 hex). */
  colourOf(erc20: string): string;
  openRequests(kind: BridgeKind): Promise<OpenRequests>;
  settleView(kind: BridgeKind, requestId: string): Promise<SettleView | null>;
  /** Prove and submit `bridge_deposit_start_with_evm` (the sponsor pays). The caller holds the prover lane. */
  startDeposit(input: { account: string; payload: BridgeDepositPayload; auth: StartAuth }): Promise<StartOutcome>;
  /** Prove and submit `bridge_withdraw_start_with_evm` with the payload's coin as the call's private state. */
  startWithdraw(input: { account: string; payload: BridgeWithdrawPayload; auth: StartAuth }): Promise<StartOutcome>;
  /** The relayer loop for one request; resumable (re-running it with the same id is safe). */
  relay(input: {
    kind: BridgeKind;
    requestId: string;
    expectedSigner: string;
    signatureTimeoutMs: number;
    onProgress: (p: RelayProgress) => void;
  }): Promise<RelayOutcome>;
  /** Prove and submit a settle (permissionless), sealing the minted coin's inbox entry to the account. */
  settle(input: {
    kind: BridgeKind;
    circuit: SettleCircuit;
    account: string;
    requestId: string;
    relay: RelayOutcome;
  }): Promise<SettleOutcome>;
  /** Public facts of a Midnight transaction, by its midnight-js id; nulls when not indexed yet. */
  txFacts(txId: string): Promise<TxFacts>;
}

// ── A JSON-RPC Sepolia reader ────────────────────────────────────────────────

const quantity = (v: unknown): bigint => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v)) throw new Error('not a hex quantity');
  return v === '0x' ? 0n : BigInt(v);
};

/**
 * Sepolia through JSON-RPC. The URL may carry an API key: it is never logged, and errors say only
 * which method failed (the logger also redacts the URL).
 */
export function jsonRpcEvmReader(
  url: string,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
): EvmReader {
  let id = 0;
  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error(`Sepolia ${method}: unreachable`);
    }
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: { message?: string } } | null;
    if (!res.ok || !body || body.error) throw new Error(`Sepolia ${method}: ${body?.error?.message ?? res.status}`);
    return body.result;
  };
  return {
    ethBalance: async (address) => quantity(await call('eth_getBalance', [address, 'latest'])),
    erc20Balance: async (token, holder) =>
      quantity(
        await call('eth_call', [
          { to: token, data: `0x70a08231${holder.toLowerCase().replace(/^0x/, '').padStart(64, '0')}` },
          'latest',
        ]),
      ),
    nonce: async (address, tag) => quantity(await call('eth_getTransactionCount', [address, tag])),
  };
}
