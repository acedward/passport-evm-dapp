// A stand-in for a ledger-9 transaction in unit tests: the fields the structure readers and the
// merge helper touch, with the ledger's merge rules (intent segments must be disjoint, Zswap offers
// and imbalances add up per segment). The live gate checks the same code against the real ledger.

import type { MergeableTx } from './merge.js';
import type { IntentLike, OfferLike } from './tx-structure.js';

export type Token = { tag: 'dust' } | { tag: 'shielded' | 'unshielded'; raw: string };
export const shielded = (raw: string): Token => ({ tag: 'shielded', raw });
export const DUST: Token = { tag: 'dust' };

type Deltas = Array<[Token, bigint]>;

export class FakeTx implements MergeableTx {
  constructor(
    readonly intentMap: Map<number, IntentLike> = new Map(),
    readonly segmentDeltas: Map<number, Deltas> = new Map(),
    readonly guaranteed: OfferLike | undefined = undefined,
    readonly fallible: Map<number, OfferLike> = new Map(),
  ) {}

  get intents(): Map<number, IntentLike> {
    return this.intentMap;
  }
  get guaranteedOffer(): OfferLike | undefined {
    return this.guaranteed;
  }
  get fallibleOffer(): Map<number, OfferLike> {
    return this.fallible;
  }

  imbalances(segment: number): Map<unknown, bigint> {
    const out = new Map<unknown, bigint>();
    const byKey = new Map<string, Token>();
    const sums = new Map<string, bigint>();
    for (const [t, d] of this.segmentDeltas.get(segment) ?? []) {
      const k = JSON.stringify(t);
      byKey.set(k, t);
      sums.set(k, (sums.get(k) ?? 0n) + d);
    }
    for (const [k, v] of sums) out.set(byKey.get(k), v);
    return out;
  }

  merge(other: MergeableTx): MergeableTx {
    const o = other as FakeTx;
    const intents = new Map(this.intentMap);
    for (const [k, v] of o.intentMap) {
      if (intents.has(k)) throw new Error(`IntentSegmentIdCollision(${k})`);
      intents.set(k, v);
    }
    const deltas = new Map<number, Deltas>();
    for (const src of [this.segmentDeltas, o.segmentDeltas]) {
      for (const [seg, ds] of src) deltas.set(seg, [...(deltas.get(seg) ?? []), ...ds]);
    }
    const fallible = new Map(this.fallible);
    for (const [k, v] of o.fallible) fallible.set(k, v);
    return new FakeTx(intents, deltas, this.guaranteed ?? o.guaranteed, fallible);
  }
}

/** A wallet's `initSwap` offer: legs in segment 0, no intent. */
export function walletOffer(give: string, giveAmount: bigint, want: string, wantAmount: bigint): FakeTx {
  return new FakeTx(
    new Map(),
    new Map([
      [
        0,
        [
          [shielded(give), giveAmount],
          [shielded(want), -wantAmount],
        ],
      ],
    ]),
    { inputs: [{}], outputs: [{}, {}], transients: [], deltas: new Map([[give, giveAmount]]) },
  );
}

/** A Passport `open_swap` call at intent segment `intent`, its legs proven into `legs`
 *  (0 when the transcript is guaranteed, `intent` when it is fallible). */
export function accountOffer(
  intent: number,
  legs: number,
  give: string,
  giveAmount: bigint,
  want: string,
  wantAmount: bigint,
): FakeTx {
  const guaranteed = legs === 0;
  const call = {
    address: 'aa'.repeat(32),
    entryPoint: 'open_swap_shielded_with_evm',
    guaranteedTranscript: guaranteed ? {} : undefined,
    fallibleTranscript: guaranteed ? undefined : {},
  };
  const offer: OfferLike = { inputs: [{}], outputs: [{}, {}], transients: [], deltas: new Map() };
  return new FakeTx(
    new Map([[intent, { actions: [call], dustActions: undefined }]]),
    new Map([
      [
        legs,
        [
          [shielded(give), giveAmount],
          [shielded(want), -wantAmount],
        ],
      ],
    ]),
    guaranteed ? offer : undefined,
    guaranteed ? new Map() : new Map([[intent, offer]]),
  );
}
