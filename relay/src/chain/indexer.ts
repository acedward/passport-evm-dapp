// The indexer reads behind the account routes: which Zswap leaves the ledger inserted for the
// account's coins (with their exact Merkle positions), and which of its coins were spent.
//
// Source: the indexer's `contract(address) { actions { transaction { zswapLedgerEvents } } }`
// (indexer API v4, present on the local 4.4.0-rc.3 stack and on stagenet). Every coin an account
// owns is created by a transaction that calls the account (a contract-owned output must be
// claimed by its contract in the same transaction), so the account's actions cover all of them.
// Each event is the ledger's own serialised `Event`, decoded here with ledger-v9:
//   zswapOutput { commitment, contract, mtIndex }   a new leaf, at its exact position
//   zswapInput  { nullifier, contract }              a spend
// Only events whose `contract` is the account are kept.

import type { OwnedInput, OwnedOutput, ZswapActivity } from '@mnbank/core';

export class IndexerError extends Error {
  override name = 'IndexerError';
}

/** The account has at least one full indexer page of actions, and the relay does not page yet
 *  (a known limit, plan question Q27): its history cannot be read in full. */
export class AccountHistoryTooLongError extends IndexerError {
  override name = 'AccountHistoryTooLongError';
  constructor(readonly limit: number) {
    super(`the account has ${limit} or more actions; paging is not implemented`);
  }
}

const ACTIONS_QUERY = `query AccountActions($address: HexEncoded!, $limit: Int) {
  contract(address: $address) {
    actions(limit: $limit) {
      transaction { hash block { height } zswapLedgerEvents { id raw } }
    }
  }
  block { height }
}`;

export interface RawActionTx {
  hash: string;
  blockHeight: number;
  events: Array<{ id: number; raw: string }>;
}

export interface IndexerClientOptions {
  indexerUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** The most actions read per account (the indexer caps a page at 500). */
  maxActions?: number;
}

export class IndexerClient {
  private readonly f: typeof fetch;
  constructor(private readonly options: IndexerClientOptions) {
    this.f = options.fetchImpl ?? fetch;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.f(this.options.indexerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
    });
    if (!res.ok) throw new IndexerError(`the indexer answered ${res.status}`);
    const body = (await res.json()) as { data?: T; errors?: Array<{ message?: string }> };
    if (body.errors?.length) throw new IndexerError(`indexer: ${body.errors.map((e) => e.message).join('; ')}`);
    if (!body.data) throw new IndexerError('the indexer returned no data');
    return body.data;
  }

  /** The account's transactions (deduplicated, oldest first) and the chain tip. */
  async accountTransactions(account: string): Promise<{ txs: RawActionTx[]; tip: number } | null> {
    const limit = Math.min(this.options.maxActions ?? 500, 500);
    const data = await this.graphql<{
      contract: {
        actions: Array<{
          transaction: {
            hash: string;
            block: { height: number };
            zswapLedgerEvents: Array<{ id: number; raw: string }>;
          };
        }>;
      } | null;
      block: { height: number } | null;
    }>(ACTIONS_QUERY, { address: account, limit });
    if (!data.contract) return null;
    if (data.contract.actions.length >= limit) throw new AccountHistoryTooLongError(limit);
    const byHash = new Map<string, RawActionTx>();
    for (const a of data.contract.actions) {
      const t = a.transaction;
      if (!byHash.has(t.hash))
        byHash.set(t.hash, { hash: t.hash, blockHeight: t.block.height, events: t.zswapLedgerEvents ?? [] });
    }
    const txs = [...byHash.values()].sort((a, b) => a.blockHeight - b.blockHeight || (a.hash < b.hash ? -1 : 1));
    return { txs, tip: data.block?.height ?? 0 };
  }
}

/** A decoded Zswap event, as ledger-v9's `Event.content` describes it. */
export type DecodedEvent =
  | { tag: 'zswapOutput'; commitment: string; contract: string | undefined; mtIndex: bigint }
  | { tag: 'zswapInput'; nullifier: string; contract: string | undefined }
  | { tag: string };

export type EventDecoder = (rawHex: string) => DecodedEvent;

/** ledger-v9's decoder (loaded on first use: the WASM is large). */
export async function ledgerEventDecoder(): Promise<EventDecoder> {
  const { Event } = await import('@midnightntwrk/ledger-v9');
  return (rawHex) => {
    const bytes = Uint8Array.from(Buffer.from(rawHex.replace(/^0x/, ''), 'hex'));
    return Event.deserialize(bytes).content as DecodedEvent;
  };
}

const norm = (h: string | undefined) => (h ?? '').replace(/^0x/, '').toLowerCase();

/** Keep the account's own leaves and spends from its transactions' events. */
export function zswapActivityOf(
  account: string,
  txs: readonly RawActionTx[],
  decode: EventDecoder,
  tip: number,
): ZswapActivity {
  const me = norm(account);
  const outputs: OwnedOutput[] = [];
  const inputs: OwnedInput[] = [];
  const seenEvents = new Set<number>();
  for (const tx of txs) {
    for (const ev of [...tx.events].sort((a, b) => a.id - b.id)) {
      if (seenEvents.has(ev.id)) continue;
      seenEvents.add(ev.id);
      const d = decode(ev.raw);
      if (d.tag === 'zswapOutput' && 'commitment' in d && norm(d.contract) === me) {
        outputs.push({
          commitment: norm(d.commitment),
          mtIndex: d.mtIndex.toString(10),
          txHash: tx.hash,
          blockHeight: tx.blockHeight,
        });
      } else if (d.tag === 'zswapInput' && 'nullifier' in d && norm(d.contract) === me) {
        inputs.push({ nullifier: norm(d.nullifier), txHash: tx.hash, blockHeight: tx.blockHeight });
      }
    }
  }
  return { account: me, outputs, inputs, transactions: txs.length, blockHeight: tip };
}
