// Reading a ledger-9 transaction's STRUCTURE: which segments exist, which intent owns which
// segment, where the Zswap offers sit, and every per-segment, per-token imbalance.
//
// This is what decides whether two parties' offers can settle in one transaction (plan research
// findings 8 and 15):
//   * balancing is checked per token PER SEGMENT (the guaranteed segment 0, and one fallible
//     segment per intent), and a Zswap input or output proof binds the segment it was proven for;
//   * a contract call's coins sit in segment 0 when its transcript is GUARANTEED and in its own
//     intent's segment when the transcript is FALLIBLE (midnight-ledger `verify.rs`
//     `effects_check`: guaranteed transcripts match logical segment 0);
//   * two intents cannot share a segment id (`Transaction::merge` → IntentSegmentIdCollision),
//     while two Zswap offers in the same segment are merged.
//
// Everything here is duck-typed over the ledger-v9 `Transaction` surface (`intents`,
// `guaranteedOffer`, `fallibleOffer`, `imbalances(segment)`), so it runs in unit tests without
// the ledger's WASM. An unreadable imbalance is an error, never an empty reading: a guard that
// reads nothing must not pass (the kernel's solver-core rule).

export interface OfferLike {
  inputs?: readonly unknown[];
  outputs?: readonly unknown[];
  transients?: readonly unknown[];
  deltas?: Map<unknown, bigint>;
}

export interface ContractCallLike {
  address?: unknown;
  entryPoint?: unknown;
  guaranteedTranscript?: unknown;
  fallibleTranscript?: unknown;
}

export interface IntentLike {
  actions?: readonly unknown[];
  dustActions?: { spends?: readonly unknown[]; registrations?: readonly unknown[] } | undefined;
}

export interface TxLike {
  intents?: Map<number, IntentLike> | undefined;
  guaranteedOffer?: OfferLike | undefined;
  fallibleOffer?: Map<number, OfferLike> | undefined;
  imbalances(segment: number): Map<unknown, bigint>;
}

/** segment → token label → signed delta (decimal string). */
export type ImbalanceReading = Record<string, Record<string, string>>;

export class ImbalanceUnreadableError extends Error {
  override name = 'ImbalanceUnreadableError';
}

const MAX_SEGMENT = 0xffff;

/** `dust`, `shielded:<64 hex>` or `unshielded:<64 hex>`: the labels the Passport client uses. */
export function tokenLabel(token: unknown): string {
  const t = token as { tag?: unknown; raw?: unknown } | null;
  if (t?.tag === 'dust') return 'dust';
  return `${String(t?.tag ?? 'unknown')}:${String(t?.raw ?? '')
    .replace(/^0x/, '')
    .toLowerCase()}`;
}

export const shieldedLabel = (colourHex: string): string => `shielded:${colourHex.replace(/^0x/, '').toLowerCase()}`;

/** Every segment the transaction declares: 0, each intent's, each fallible offer's. */
export function declaredSegments(tx: TxLike): number[] {
  const out = new Set<number>([0]);
  for (const field of ['intents', 'fallibleOffer'] as const) {
    let collection: unknown;
    try {
      collection = tx[field];
    } catch {
      throw new ImbalanceUnreadableError(`transaction.${field} could not be read`);
    }
    if (collection === undefined || collection === null) continue;
    if (!(collection instanceof Map)) throw new ImbalanceUnreadableError(`transaction.${field} is not a map`);
    for (const key of collection.keys()) {
      if (typeof key !== 'number' || !Number.isInteger(key) || key < 0 || key > MAX_SEGMENT) {
        throw new ImbalanceUnreadableError(`transaction.${field} has an invalid segment id`);
      }
      out.add(key);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Every segment's imbalances, dust included. */
export function imbalancesBySegment(tx: TxLike): ImbalanceReading {
  const out: ImbalanceReading = {};
  for (const segment of declaredSegments(tx)) {
    let map: Map<unknown, bigint>;
    try {
      map = tx.imbalances(segment);
    } catch (e) {
      throw new ImbalanceUnreadableError(`imbalances(${segment}) could not be read: ${(e as Error).message}`);
    }
    const seg: Record<string, string> = {};
    for (const [token, delta] of map) {
      if (typeof delta !== 'bigint') throw new ImbalanceUnreadableError(`imbalances(${segment}) is not a bigint map`);
      const label = tokenLabel(token);
      seg[label] = (BigInt(seg[label] ?? '0') + delta).toString(10);
    }
    out[String(segment)] = seg;
  }
  return out;
}

/** The non-dust, non-zero entries only: the value legs. */
export function legsBySegment(reading: ImbalanceReading): ImbalanceReading {
  const out: ImbalanceReading = {};
  for (const [segment, tokens] of Object.entries(reading)) {
    for (const [token, delta] of Object.entries(tokens)) {
      if (token === 'dust' || BigInt(delta) === 0n) continue;
      (out[segment] ??= {})[token] = delta;
    }
  }
  return out;
}

/** The segments that carry a value leg, ascending. */
export function legSegments(reading: ImbalanceReading): number[] {
  return Object.keys(legsBySegment(reading))
    .map(Number)
    .sort((a, b) => a - b);
}

export interface OfferShape {
  inputs: number;
  outputs: number;
  transients: number;
  deltas: Record<string, string>;
}

export interface CallShape {
  address: string;
  entryPoint: string;
  /** Where the call's transcript runs: its coins sit in segment 0 if guaranteed, its own
   *  intent's segment if fallible. */
  transcript: 'guaranteed' | 'fallible' | 'both' | 'none';
}

export interface IntentShape {
  segment: number;
  calls: CallShape[];
  otherActions: number;
  dustSpends: number;
  dustRegistrations: number;
}

export interface TxStructure {
  segments: number[];
  intents: IntentShape[];
  guaranteedOffer: OfferShape | null;
  fallibleOffers: Record<string, OfferShape>;
  imbalances: ImbalanceReading;
  legs: ImbalanceReading;
  legSegments: number[];
}

const hexOf = (v: unknown): string => {
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  return String(v ?? '')
    .replace(/^0x/, '')
    .toLowerCase();
};

const entryPointOf = (v: unknown): string => (v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : String(v));

function offerShape(offer: OfferLike | undefined | null): OfferShape | null {
  if (!offer) return null;
  const deltas: Record<string, string> = {};
  for (const [token, delta] of offer.deltas ?? new Map()) deltas[hexOf(token)] = String(delta);
  return {
    inputs: offer.inputs?.length ?? 0,
    outputs: offer.outputs?.length ?? 0,
    transients: offer.transients?.length ?? 0,
    deltas,
  };
}

function isCall(action: unknown): action is ContractCallLike {
  const a = action as ContractCallLike | null;
  return !!a && ('guaranteedTranscript' in a || 'fallibleTranscript' in a) && 'entryPoint' in a;
}

/** The whole structure, as public values. */
export function describeTx(tx: TxLike): TxStructure {
  const imbalances = imbalancesBySegment(tx);
  const intents: IntentShape[] = [];
  for (const [segment, intent] of tx.intents ?? new Map<number, IntentLike>()) {
    const calls: CallShape[] = [];
    let otherActions = 0;
    for (const action of intent.actions ?? []) {
      if (!isCall(action)) {
        otherActions += 1;
        continue;
      }
      const g = action.guaranteedTranscript !== undefined && action.guaranteedTranscript !== null;
      const f = action.fallibleTranscript !== undefined && action.fallibleTranscript !== null;
      calls.push({
        address: hexOf(action.address),
        entryPoint: entryPointOf(action.entryPoint),
        transcript: g && f ? 'both' : g ? 'guaranteed' : f ? 'fallible' : 'none',
      });
    }
    intents.push({
      segment,
      calls,
      otherActions,
      dustSpends: intent.dustActions?.spends?.length ?? 0,
      dustRegistrations: intent.dustActions?.registrations?.length ?? 0,
    });
  }
  intents.sort((a, b) => a.segment - b.segment);
  const fallibleOffers: Record<string, OfferShape> = {};
  for (const [segment, offer] of tx.fallibleOffer ?? new Map<number, OfferLike>()) {
    const shape = offerShape(offer);
    if (shape) fallibleOffers[String(segment)] = shape;
  }
  const legs = legsBySegment(imbalances);
  return {
    segments: declaredSegments(tx),
    intents,
    guaranteedOffer: offerShape(tx.guaranteedOffer),
    fallibleOffers,
    imbalances,
    legs,
    legSegments: legSegments(imbalances),
  };
}
