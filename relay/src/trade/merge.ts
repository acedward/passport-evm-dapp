// The take merge helper: put a maker's proven offer and a taker's proven complementary offer into
// ONE transaction, and say — before anything is submitted — whether it can settle.
//
// A take settles only if, after the merge, every non-dust imbalance in every segment is zero; the
// batcher's balancer then adds DUST and nothing else (plan finding 12). Two facts decide it:
//
//   1. Where each party's legs are. A wallet's `initSwap` offer carries its legs in the
//      guaranteed segment 0. A Passport call carries them where its transcript runs: segment 0
//      if the call was partitioned GUARANTEED, its own random intent segment if FALLIBLE
//      (the midnight-js default for every gated circuit, 00034 Q39). The Zswap proofs bind the
//      segment, so a proven offer cannot be moved: the legs must be proven into the same segment.
//   2. Intent segments. Two intents at the same segment id do not merge (ledger
//      `IntentSegmentIdCollision`); a Zswap offer without an intent does.
//
// `planTake` answers both from the two artefacts alone; `mergeTake` merges and reads the result.
// Nothing here signs, balances or submits.

import {
  describeTx,
  imbalancesBySegment,
  legsBySegment,
  type ImbalanceReading,
  type TxLike,
  type TxStructure,
} from './tx-structure.js';

export interface MergeableTx extends TxLike {
  merge(other: MergeableTx): MergeableTx;
}

export class TakeMergeError extends Error {
  override name = 'TakeMergeError';
  constructor(
    message: string,
    readonly code: 'intent-collision' | 'no-legs' | 'split-legs' | 'unbalanced' | 'not-complementary',
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface Leg {
  /** 64 hex, lowercase. */
  colour: string;
  amount: bigint;
}

/** The one segment a party's legs are in; throws if there are none or they are split. */
export function singleLegSegment(reading: ImbalanceReading, who: string): number {
  const segments = Object.keys(legsBySegment(reading)).map(Number);
  if (segments.length === 0) throw new TakeMergeError(`${who} carries no value leg`, 'no-legs');
  if (segments.length > 1) {
    throw new TakeMergeError(`${who}'s legs are split across segments ${segments.join(', ')}`, 'split-legs', {
      segments,
    });
  }
  return segments[0]!;
}

/**
 * What a taker must offer to fill a maker's single-segment, shielded offer exactly: the maker's
 * surplus (+) is what the taker WANTS, the maker's deficit (−) is what the taker GIVES.
 * Only the one-for-one shielded shape the bank trades is accepted.
 */
export function complementOf(maker: ImbalanceReading): { give: Leg; want: Leg; makerSegment: number } {
  const makerSegment = singleLegSegment(maker, 'the maker');
  const legs = legsBySegment(maker)[String(makerSegment)]!;
  const entries = Object.entries(legs);
  const plus = entries.filter(([, d]) => BigInt(d) > 0n);
  const minus = entries.filter(([, d]) => BigInt(d) < 0n);
  if (plus.length !== 1 || minus.length !== 1) {
    throw new TakeMergeError('only a one-token-for-one-token offer can be taken', 'not-complementary', { legs });
  }
  const [giveLabel, giveDelta] = plus[0]!;
  const [wantLabel, wantDelta] = minus[0]!;
  for (const label of [giveLabel, wantLabel]) {
    if (!label.startsWith('shielded:')) {
      throw new TakeMergeError(`only shielded legs can be taken by an account (${label})`, 'not-complementary');
    }
  }
  return {
    makerSegment,
    // The taker wants what the maker gives up, and gives what the maker wants.
    want: { colour: giveLabel.slice('shielded:'.length), amount: BigInt(giveDelta) },
    give: { colour: wantLabel.slice('shielded:'.length), amount: -BigInt(wantDelta) },
  };
}

/** Add two readings, segment by segment, token by token (what a merge does to imbalances). */
export function sumReadings(a: ImbalanceReading, b: ImbalanceReading): ImbalanceReading {
  const out: ImbalanceReading = {};
  for (const reading of [a, b]) {
    for (const [segment, tokens] of Object.entries(reading)) {
      const seg = (out[segment] ??= {});
      for (const [token, delta] of Object.entries(tokens)) {
        seg[token] = (BigInt(seg[token] ?? '0') + BigInt(delta)).toString(10);
      }
    }
  }
  return out;
}

export interface TakePlan {
  makerLegSegment: number;
  takerLegSegment: number;
  makerIntentSegments: number[];
  takerIntentSegments: number[];
  /** Intent segment ids both artefacts use: the merge itself would fail. */
  intentCollisions: number[];
  /** The value legs left after the merge, per segment (empty = token-balanced). */
  residualLegs: ImbalanceReading;
  /** True when the merge succeeds AND leaves no value leg anywhere. */
  settleable: boolean;
  reason: string;
}

const intentSegments = (tx: TxLike): number[] => [...(tx.intents?.keys() ?? [])].sort((a, b) => a - b);

/** Decide from the two artefacts alone whether their merge can settle, and why not. */
export function planTake(maker: TxLike, taker: TxLike): TakePlan {
  const makerReading = imbalancesBySegment(maker);
  const takerReading = imbalancesBySegment(taker);
  const makerLegSegment = singleLegSegment(makerReading, 'the maker');
  const takerLegSegment = singleLegSegment(takerReading, 'the taker');
  const makerIntentSegments = intentSegments(maker);
  const takerIntentSegments = intentSegments(taker);
  const intentCollisions = makerIntentSegments.filter((s) => takerIntentSegments.includes(s));
  const residualLegs = legsBySegment(sumReadings(makerReading, takerReading));
  const settleable = intentCollisions.length === 0 && Object.keys(residualLegs).length === 0;
  let reason: string;
  if (intentCollisions.length) {
    reason = `both artefacts have an intent at segment ${intentCollisions.join(', ')}; the ledger refuses the merge`;
  } else if (makerLegSegment !== takerLegSegment) {
    reason =
      `the maker's legs are in segment ${makerLegSegment} and the taker's in segment ${takerLegSegment}; ` +
      'balancing is per segment and the proofs bind their segment, so neither side can fund the other';
  } else if (Object.keys(residualLegs).length) {
    reason = `both parties' legs are in segment ${makerLegSegment} but the amounts do not cancel`;
  } else {
    reason = `both parties' legs are in segment ${makerLegSegment} and cancel exactly`;
  }
  return {
    makerLegSegment,
    takerLegSegment,
    makerIntentSegments,
    takerIntentSegments,
    intentCollisions,
    residualLegs,
    settleable,
    reason,
  };
}

export interface MergedTake<T extends MergeableTx> {
  merged: T;
  plan: TakePlan;
  structure: TxStructure;
  residualLegs: ImbalanceReading;
  balanced: boolean;
}

/**
 * Merge a maker's and a taker's proven artefacts. With `requireBalanced` (the production default)
 * a merge that leaves any value leg is refused, so an unsettleable take is never submitted;
 * without it the merged transaction is returned anyway, for measuring what the batcher and the
 * node say about it.
 */
export function mergeTake<T extends MergeableTx>(
  maker: T,
  taker: T,
  opts: { requireBalanced?: boolean } = {},
): MergedTake<T> {
  const plan = planTake(maker, taker);
  if (plan.intentCollisions.length) {
    throw new TakeMergeError(plan.reason, 'intent-collision', { segments: plan.intentCollisions });
  }
  const merged = maker.merge(taker) as T;
  const structure = describeTx(merged);
  const residualLegs = structure.legs;
  const balanced = Object.keys(residualLegs).length === 0;
  if (!balanced && (opts.requireBalanced ?? true)) {
    throw new TakeMergeError(`the merged take is not token-balanced: ${plan.reason}`, 'unbalanced', {
      residualLegs,
    });
  }
  return { merged, plan, structure, residualLegs, balanced };
}
