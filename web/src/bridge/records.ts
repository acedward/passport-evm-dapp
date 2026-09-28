// A bridge transfer as this browser keeps it (plan L-BRG.1–.3; Q5: the relay keeps nothing): one
// `bridge` record per transfer, in the account's scope, from the first funding transaction to the
// settle. It holds every hash, the relay job(s) that drove it (a new one per resume), and the vault
// request id that lets a restarted relay pick it up again.

import type { BridgeKind, BridgeResult, CoinInfo, JobStage } from '@mnbank/core';

import { recordKey, type WalletScope } from '../store/schema.js';
import type { LocalStore } from '../store/store.js';

export type TransferState =
  /** Funding in progress (a deposit's Sepolia transactions), nothing signed for Midnight yet. */
  | 'funding'
  /** At the relay: queued or running. */
  | 'running'
  /** The relay no longer drives it (it restarted, or the MPC was slow): the page can resume it. */
  | 'needs-resume'
  | 'succeeded'
  | 'failed';

export interface TransferRecord {
  id: string;
  kind: BridgeKind;
  account: string;
  symbol: string;
  midnightName: string;
  erc20: string;
  colour: string;
  decimals: number;
  /** Base units. */
  amount: string;
  /** Deposits: where the tokens and the sweep's gas go (derived in this page). */
  depositAddress?: string;
  /** Withdrawals: the Sepolia destination. */
  dest?: string;
  /** Withdrawals: the coin the start spends (its commitment), marked spent on success. */
  spentCommitment?: string;
  createdAt: number;
  updatedAt: number;
  state: TransferState;
  /** Deposits: the customer's own Sepolia transactions to the deposit address. */
  funding?: { tokenTx?: string; gasTx?: string };
  /** The relay jobs, oldest first (the start, then one per resume). */
  jobIds: string[];
  /** The vault request id, once the start landed. */
  requestId?: string;
  startedAtMs?: number;
  /** Every stage every job reported, in order (public details only: hashes, ids, heights). */
  stages: JobStage[];
  error?: { code: string; message: string };
  result?: BridgeResult;
  /** The finished transfer's coins are in the coin list. */
  applied?: boolean;
  /** A withdrawal's change (192 zero bytes in its inbox entry, Q13): re-filed with one more signature. */
  change?: {
    coin: CoinInfo;
    secured: boolean;
    secureTx?: string;
    deferredReason?: string;
    /** The bank's single-use entitlement to file the change's entry (security review F-B3). */
    entitlement?: string;
  };
  /** When this page last asked whether the bank closed the request (a transfer to resume, P4-A). */
  closedCheckAt?: number;
}

export const transferKey = (scope: WalletScope, account: string, id: string) =>
  recordKey(scope, 'bridge', { account, id });

export function readTransfer(store: LocalStore, scope: WalletScope, account: string, id: string) {
  return store.get<TransferRecord>(transferKey(scope, account, id))?.data ?? null;
}

export function writeTransfer(store: LocalStore, scope: WalletScope, rec: TransferRecord): TransferRecord {
  const next = { ...rec, updatedAt: Date.now() };
  store.put(scope, 'bridge', next, { account: rec.account, id: rec.id });
  return next;
}

/** Update a transfer from its CURRENT stored copy (another tab may have written it meanwhile). */
export function patchTransfer(
  store: LocalStore,
  scope: WalletScope,
  account: string,
  id: string,
  patch: (rec: TransferRecord) => TransferRecord,
): TransferRecord | null {
  const cur = readTransfer(store, scope, account, id);
  return cur ? writeTransfer(store, scope, patch(cur)) : null;
}

/** Every transfer of one account in this browser, newest first. */
export function listTransfers(store: LocalStore, scope: WalletScope, account: string): TransferRecord[] {
  const out: TransferRecord[] = [];
  for (const r of store.list(scope)) {
    if (r.parsed.kind !== 'bridge' || r.parsed.scope.global || r.parsed.scope.account !== account || !r.record)
      continue;
    out.push(r.record.data as TransferRecord);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export const inFlight = (t: TransferRecord) =>
  t.state === 'funding' || t.state === 'running' || t.state === 'needs-resume';

/** Merge a job's stages into the transfer's history (a job reports its whole list every poll). */
export function mergeStages(prev: readonly JobStage[], next: readonly JobStage[]): JobStage[] {
  const seen = new Set(prev.map((s) => `${s.stage}@${s.at}@${JSON.stringify(s.detail ?? {})}`));
  const out = [...prev];
  for (const s of next) {
    const k = `${s.stage}@${s.at}@${JSON.stringify(s.detail ?? {})}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

/** The newest detail of a stage (e.g. the `started` stage's request id). */
export const stageDetail = (t: Pick<TransferRecord, 'stages'>, stage: string) =>
  [...t.stages].reverse().find((s) => s.stage === stage)?.detail;

/** Whether the transfer's Sepolia transaction has been broadcast (its nonce is spent). */
export const broadcast = (t: Pick<TransferRecord, 'stages'>) =>
  t.stages.some((s) => s.stage === 'evm-broadcast' || s.stage === 'evm-not-broadcast' || s.stage === 'attested');
