// Settling a take: the maker's published offer and the account's complementary offer, merged into
// ONE token-balanced transaction, checked against the chain's LIVE ledger parameters, and handed to
// the kernel's batcher (`midnight-balancer`), which adds the DUST and submits (plan finding 12).
//
// Every refusal happens BEFORE anything is submitted:
//   - the maker's legs must be exactly what the customer signed to take (whole offers only), in
//     one segment, and that segment must be 0 (a default-proven account offer, with its legs in a
//     fallible segment, cannot be taken atomically: G-TAKE (c1));
//   - the merge must leave no value leg anywhere (`mergeTake`);
//   - the merged transaction must fit the node's time-to-dismiss (`cost(params, true)`), which a
//     fully guaranteed call must satisfy for the WHOLE transaction (risk R19).

import { submitToBatcher, type BatcherResult } from './batcher-client.js';
import { TakeMergeError, complementOf, mergeTake, type MergeableTx, type TakePlan } from './merge.js';
import { imbalancesBySegment, type TxStructure } from './tx-structure.js';

export class TakeRefusal extends Error {
  override name = 'TakeRefusal';
  constructor(
    message: string,
    readonly code: 'not-complementary' | 'maker-segment' | 'unbalanced' | 'intent-collision' | 'time-to-dismiss',
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface Leg {
  colour: string;
  amount: bigint;
}

const norm = (h: string) => h.replace(/^0x/, '').toLowerCase();

/**
 * Check that the maker's offer is exactly the one the customer signed to take: the customer GIVES
 * what the maker wants and WANTS what the maker gives, whole, and the maker's legs are in segment 0.
 */
export function checkMakerOffer(makerTx: MergeableTx, taker: { give: Leg; want: Leg }): { makerSegment: number } {
  let comp: ReturnType<typeof complementOf>;
  try {
    comp = complementOf(imbalancesBySegment(makerTx));
  } catch (e) {
    throw new TakeRefusal(e instanceof TakeMergeError ? e.message : 'the offer cannot be read', 'not-complementary');
  }
  const same = (a: Leg, b: Leg) => norm(a.colour) === norm(b.colour) && a.amount === b.amount;
  if (!same(comp.give, taker.give) || !same(comp.want, taker.want)) {
    throw new TakeRefusal('the offer on the exchange is not the one that was signed to take', 'not-complementary', {
      offerGives: { colour: comp.want.colour, amount: comp.want.amount.toString() },
      offerWants: { colour: comp.give.colour, amount: comp.give.amount.toString() },
    });
  }
  if (comp.makerSegment !== 0) {
    throw new TakeRefusal(
      `the offer's legs are in segment ${comp.makerSegment}, not 0: an account cannot take it in one transaction`,
      'maker-segment',
      { makerSegment: comp.makerSegment },
    );
  }
  return { makerSegment: comp.makerSegment };
}

export interface CostReading {
  /** `cost(params, true)`, or null when it threw (the node would refuse it). */
  enforced: { readTime: string; computeTime: string; blockUsage: string } | null;
  enforcedError: string | null;
  /** `cost(params, false)`: the same without the time-to-dismiss rule, for comparison. */
  unenforced: { readTime: string; computeTime: string; blockUsage: string } | null;
  /** `fees(params, true)` in specks, or null. */
  feesSpecks: string | null;
}

interface CostableTx {
  cost(params: unknown, enforceTimeToDismiss?: boolean): { readTime: bigint; computeTime: bigint; blockUsage: bigint };
  fees(params: unknown, enforceTimeToDismiss?: boolean): bigint;
}

const costText = (c: { readTime: bigint; computeTime: bigint; blockUsage: bigint }) => ({
  readTime: c.readTime.toString(),
  computeTime: c.computeTime.toString(),
  blockUsage: c.blockUsage.toString(),
});

/** Read the transaction's modelled cost against `params` (the chain's live parameters). */
export function readCost(tx: unknown, params: unknown): CostReading {
  const t = tx as CostableTx;
  let enforced: CostReading['enforced'] = null;
  let enforcedError: string | null = null;
  let unenforced: CostReading['unenforced'] = null;
  let feesSpecks: string | null = null;
  try {
    enforced = costText(t.cost(params, true));
  } catch (e) {
    enforcedError = e instanceof Error ? e.message : String(e);
  }
  try {
    unenforced = costText(t.cost(params, false));
  } catch {
    /* recorded as null */
  }
  try {
    feesSpecks = t.fees(params, true).toString();
  } catch {
    /* recorded as null */
  }
  return { enforced, enforcedError, unenforced, feesSpecks };
}

export interface MergedSettlement<T extends MergeableTx> {
  merged: T;
  plan: TakePlan;
  structure: TxStructure;
  cost: CostReading;
}

/** Merge (refusing an unbalanced result) and check the cost against the live parameters. */
export function mergeForSettlement<T extends MergeableTx>(
  makerTx: T,
  takerTx: T,
  params: unknown,
): MergedSettlement<T> {
  let m: ReturnType<typeof mergeTake<T>>;
  try {
    m = mergeTake(makerTx, takerTx);
  } catch (e) {
    if (e instanceof TakeMergeError) {
      throw new TakeRefusal(e.message, e.code === 'intent-collision' ? 'intent-collision' : 'unbalanced', e.detail);
    }
    throw e;
  }
  const cost = readCost(m.merged, params);
  if (cost.enforced === null) {
    throw new TakeRefusal(
      `the merged take does not fit the chain's time-to-dismiss: ${cost.enforcedError ?? 'refused'}`,
      'time-to-dismiss',
      { cost },
    );
  }
  return { merged: m.merged, plan: m.plan, structure: m.structure, cost };
}

/** Hand the proven, merged settlement to the batcher (`midnight-balancer`, `txStage: finalized`). */
export async function submitSettlement(o: {
  batcherUrl: string;
  merged: { serialize(): Uint8Array };
  /** The submitter's unshielded address (bech32m), as the exchange's own site sends it. */
  address: string;
  target?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<BatcherResult> {
  return submitToBatcher({
    batcherUrl: o.batcherUrl,
    txHex: Buffer.from(o.merged.serialize()).toString('hex'),
    address: o.address,
    ...(o.target ? { target: o.target } : {}),
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
  });
}
