// The records the account features keep in this browser (spec FR-003, Q5), and small typed
// accessors over the store. Every per-user fact lives here and nowhere else: the relay keeps none.
//
//   account  (account scope)   the account's address, device, vault and registration receipts
//   secret   (account scope)   the account's X25519 encryption key pair (the viewing secret)
//   secret   (no account yet)  the key pair of a registration in flight, until it is confirmed
//   coins    (account scope)   every coin the browser knows (StoredCoin[]), spent ones included
//   roster   (account scope)   the device's use counter, a hint for the next signature
//   job      (either scope)    a request in flight at the relay (resumable by its id)

import type { StoredCoin } from '@mnbank/core';

import type { LocalStore } from '../store/store.js';
import { recordKey, type WalletScope } from '../store/schema.js';

export interface AccountRecord {
  address: string;
  /** The device: the EOA, lowercase 0x hex. */
  device: string;
  network: string;
  vault: string;
  createdAt: number;
  txs?: { waveOne: string; waveTwo: string; activation: string };
}

export interface SecretRecord {
  encSecretKey: string;
  encPublicKey: string;
  /** True while the registration that will use it has not finished. */
  pending?: boolean;
}

export interface RosterRecord {
  useCounter: string;
}

export type JobAction = 'register' | 'withdraw' | 'append-inbox' | 'open-swap' | 'take';

export interface JobRecord {
  requestId: string;
  action: JobAction;
  startedAt: number;
  /** The last state and stage seen. */
  state: string;
  stage: string;
  /** Action context the browser needs when the job finishes. */
  context?: Record<string, unknown>;
}

export const readAccount = (store: LocalStore, scope: WalletScope, account: string) =>
  store.get<AccountRecord>(recordKey(scope, 'account', { account }))?.data ?? null;

/** The account this wallet has in this browser on this network, if any (one per wallet). */
export function findAccount(store: LocalStore, scope: WalletScope): AccountRecord | null {
  for (const r of store.list(scope)) {
    if (r.parsed.kind === 'account' && !r.parsed.scope.global && r.parsed.scope.account && r.record) {
      return r.record.data as AccountRecord;
    }
  }
  return null;
}

export const readSecret = (store: LocalStore, scope: WalletScope, account: string | null) =>
  store.get<SecretRecord>(recordKey(scope, 'secret', { account }))?.data ?? null;

export const readCoins = (store: LocalStore, scope: WalletScope, account: string): StoredCoin[] =>
  store.get<StoredCoin[]>(recordKey(scope, 'coins', { account }))?.data ?? [];

export const readRoster = (store: LocalStore, scope: WalletScope, account: string) =>
  store.get<RosterRecord>(recordKey(scope, 'roster', { account }))?.data ?? null;

/** Every job record of this wallet (registration jobs have no account yet). */
export function listJobs(
  store: LocalStore,
  scope: WalletScope,
): Array<{ key: string; account: string | null; job: JobRecord }> {
  const out: Array<{ key: string; account: string | null; job: JobRecord }> = [];
  for (const r of store.list(scope)) {
    if (r.parsed.kind !== 'job' || r.parsed.scope.global || !r.record) continue;
    out.push({ key: r.key, account: r.parsed.scope.account, job: r.record.data as JobRecord });
  }
  return out.sort((a, b) => a.job.startedAt - b.job.startedAt);
}
