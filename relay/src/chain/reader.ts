// Public chain reads the relay serves to the browser: an account's ledger state, its inbox
// ciphertexts (the browser decrypts; the relay never sees the secret) and its Zswap activity
// (the exact positions of its coins' leaves, and its spends). A localnet indexer sends no CORS
// headers, and the relay keeps the parsing of ledger state and ledger events off the browser
// (plan P0.4: the browser bundle carries no ledger-v9).

import type { AccountStateView, InboxPage, ZswapActivity } from '@mnbank/core';

import { type IndexerClient, ledgerEventDecoder, zswapActivityOf, type EventDecoder } from './indexer.js';

export type { AccountStateView, InboxPage, ZswapActivity };

export interface ChainReader {
  accountState(account: string): Promise<AccountStateView | null>;
  inbox(account: string, from: number, limit: number): Promise<InboxPage | null>;
  zswap(account: string): Promise<ZswapActivity | null>;
}

export class ChainReadNotImplementedError extends Error {
  override name = 'ChainReadNotImplementedError';
}

/** The relay without a key volume cannot parse account state: reads say so (501). */
export const notImplementedChainReader: ChainReader = {
  async accountState() {
    throw new ChainReadNotImplementedError('account reads need the relay key volume (the compiled account)');
  },
  async inbox() {
    throw new ChainReadNotImplementedError('account reads need the relay key volume (the compiled account)');
  },
  async zswap() {
    throw new ChainReadNotImplementedError('account reads need the relay key volume (the compiled account)');
  },
};

/** The fields of an account's ledger this reader uses (the compiled contract's `ledger()`). */
export interface LedgerView {
  readonly booted: boolean;
  readonly device_count: bigint;
  readonly device_epoch: bigint;
  readonly auth_nonce: bigint;
  readonly inbox_count: bigint;
  readonly enc_key: Uint8Array;
  readonly evm_domain_salt: Uint8Array;
  readonly vault_address: { bytes: Uint8Array };
  devices: { [Symbol.iterator](): Iterator<Uint8Array> };
  inbox: { member(k: bigint): boolean; lookup(k: bigint): Uint8Array };
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

export function accountStateView(account: string, l: LedgerView): AccountStateView {
  return {
    account,
    booted: l.booted,
    deviceCount: Number(l.device_count),
    deviceEpoch: l.device_epoch.toString(10),
    devices: [...l.devices].map(hex).sort(),
    authNonce: l.auth_nonce.toString(10),
    inboxCount: l.inbox_count.toString(10),
    encKey: hex(l.enc_key),
    vault: hex(l.vault_address.bytes),
    evmDomainSalt: hex(l.evm_domain_salt),
  };
}

export function inboxPageOf(account: string, l: LedgerView, from: number, limit: number): InboxPage {
  const total = Number(l.inbox_count);
  const entries: Array<string | null> = [];
  for (let i = from; i < Math.min(total, from + limit); i++) {
    const k = BigInt(i);
    entries.push(l.inbox.member(k) ? hex(l.inbox.lookup(k)) : null);
  }
  return { account, from, entries, total };
}

/** Reads over the indexer, parsing state with the compiled account's `ledger()`. */
export class IndexerChainReader implements ChainReader {
  private decoder: Promise<EventDecoder> | null = null;

  constructor(
    private readonly ledgerOf: (account: string) => Promise<LedgerView | null>,
    private readonly indexer: IndexerClient,
    decoder?: EventDecoder,
  ) {
    if (decoder) this.decoder = Promise.resolve(decoder);
  }

  async accountState(account: string): Promise<AccountStateView | null> {
    const l = await this.ledgerOf(account);
    return l ? accountStateView(account, l) : null;
  }

  async inbox(account: string, from: number, limit: number): Promise<InboxPage | null> {
    const l = await this.ledgerOf(account);
    return l ? inboxPageOf(account, l, from, limit) : null;
  }

  async zswap(account: string): Promise<ZswapActivity | null> {
    const found = await this.indexer.accountTransactions(account);
    if (!found) return null;
    this.decoder ??= ledgerEventDecoder();
    return zswapActivityOf(account, found.txs, await this.decoder, found.tip);
  }
}
