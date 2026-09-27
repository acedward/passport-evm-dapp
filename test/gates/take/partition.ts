// Steering midnight-js's transcript partitioner, so that a Passport call's WHOLE transcript runs in
// the guaranteed section and its coins land in segment 0, beside a wallet's offer.
//
// WHY. compact-js splits every call's public transcript with the ledger's `partitionTranscripts`
// (midnight-ledger `construct.rs`): it keeps as many checkpoint sections in the guaranteed part as
// fit a HEURISTIC budget derived from the ledger parameters' `min_time_to_dismiss`, and the rest
// is fallible. A gated Passport circuit does not fit the 15 ms default, so its legs land in the
// call's own random fallible segment (00034 Q39) and can never share a segment with a wallet's
// segment-0 offer. The heuristic is only the CLIENT's choice of split: the proof then binds the
// split, and the node enforces the real limit on the whole transaction (`OutsideTimeToDismiss`,
// a larger transaction is allowed more: 2 µs per byte, 15 ms minimum). So handing the partitioner
// a larger `min_time_to_dismiss` changes where the legs are proven, and nothing the node checks.
//
// HOW. `LedgerParameters` has no setter; its serialisation carries `min_time_to_dismiss` as a
// SCALE-compact u64 (midnight-ledger `serialize/src/util.rs`). The encoding is patched in place to
// a larger value of the SAME encoded length (so nothing else moves), deserialised, and checked by
// re-serialising. midnight-js reads the parameters from the public data provider's
// `queryZSwapAndContractState`, so the provider is wrapped for the one call that needs it.

/** The ledger's initial `min_time_to_dismiss`: 15 ms, in picoseconds. */
export const INITIAL_MIN_TIME_TO_DISMISS_PS = 15_000_000_000n;
/** The largest value with the same 6-byte SCALE encoding as 15 ms: 2^40 − 1 ps, about 1.1 s. */
export const STEERING_MIN_TIME_TO_DISMISS_PS = 0xff_ffff_ffffn;

export class PartitionSteeringError extends Error {
  override name = 'PartitionSteeringError';
}

/** SCALE-compact encoding of a u64, exactly as midnight-ledger's `ScaleBigInt` writes it. */
export function scaleEncodeU64(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new PartitionSteeringError('not a u64');
  const le = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    le[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  let occupied = 8;
  while (occupied > 0 && le[occupied - 1] === 0) occupied--;
  const canSqueeze = le[Math.max(occupied - 1, 0)]! < 64;
  let size: number;
  if (occupied === 0 || (occupied === 1 && canSqueeze)) size = 1;
  else if (occupied === 1 || (occupied === 2 && canSqueeze)) size = 2;
  else if (occupied === 2 || occupied === 3 || (occupied === 4 && canSqueeze)) size = 4;
  else size = occupied + 1;
  const bot6 = (b: number) => ((b & 0x3f) << 2) & 0xff;
  const top2 = (b: number) => (b & 0xc0) >> 6;
  if (size === 1) return Uint8Array.of(bot6(le[0]!) | 0b00);
  if (size === 2) return Uint8Array.of(bot6(le[0]!) | 0b01, top2(le[0]!) | bot6(le[1]!));
  if (size === 4) {
    return Uint8Array.of(
      bot6(le[0]!) | 0b10,
      top2(le[0]!) | bot6(le[1]!),
      top2(le[1]!) | bot6(le[2]!),
      top2(le[2]!) | bot6(le[3]!),
    );
  }
  const out = new Uint8Array(size);
  out[0] = (((size - 5) << 2) | 0b11) & 0xff;
  out.set(le.subarray(0, size - 1), 1);
  return out;
}

const indexesOf = (haystack: Uint8Array, needle: Uint8Array): number[] => {
  const hits: number[] = [];
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    hits.push(i);
  }
  return hits;
};

/** Replace the single occurrence of `from`'s encoding with `to`'s (same length only). */
export function patchU64Once(bytes: Uint8Array, from: bigint, to: bigint): Uint8Array {
  const a = scaleEncodeU64(from);
  const b = scaleEncodeU64(to);
  if (a.length !== b.length) throw new PartitionSteeringError('the replacement changes the encoded length');
  const hits = indexesOf(bytes, a);
  if (hits.length !== 1) {
    throw new PartitionSteeringError(
      `expected exactly one encoding of ${from} in the parameters, found ${hits.length}`,
    );
  }
  const out = Uint8Array.from(bytes);
  out.set(b, hits[0]!);
  return out;
}

const UNIT_PS: Record<string, bigint> = {
  ps: 1n,
  ns: 1_000n,
  µs: 1_000_000n,
  μs: 1_000_000n,
  us: 1_000_000n,
  ms: 1_000_000_000n,
  s: 1_000_000_000_000n,
};

/** `min_time_to_dismiss: 15.000ms` (the parameters' debug text) → picoseconds. */
export function minTimeToDismissFromText(text: string): bigint | null {
  const m = /min_time_to_dismiss:\s*([\d.]+)\s*(ps|ns|µs|μs|us|ms|s)\b/.exec(text);
  if (!m) return null;
  const [whole, frac = ''] = m[1]!.split('.');
  const unit = UNIT_PS[m[2]!]!;
  const scale = 10n ** BigInt(frac.length);
  return ((BigInt(whole || '0') * scale + BigInt(frac || '0')) * unit) / scale;
}

export interface LedgerParametersLike {
  serialize(): Uint8Array;
  toString(): string;
}

/** Parameters that steer the partitioner into a fully guaranteed transcript. */
export function steeringParameters<P extends LedgerParametersLike>(
  params: P,
  deserialize: (bytes: Uint8Array) => P,
): { params: P; fromPs: bigint; toPs: bigint } {
  const fromPs = minTimeToDismissFromText(params.toString());
  if (fromPs === null) throw new PartitionSteeringError('the parameters do not show min_time_to_dismiss');
  const patched = patchU64Once(params.serialize(), fromPs, STEERING_MIN_TIME_TO_DISMISS_PS);
  const steered = deserialize(patched);
  const again = steered.serialize();
  if (again.length !== patched.length || again.some((b, i) => b !== patched[i])) {
    throw new PartitionSteeringError('the patched parameters do not round-trip');
  }
  return { params: steered, fromPs, toPs: STEERING_MIN_TIME_TO_DISMISS_PS };
}

type StateQuery = (...args: unknown[]) => Promise<readonly unknown[] | null | undefined>;

/**
 * A view of a midnight-js public data provider whose `queryZSwapAndContractState` returns
 * `transform(parameters)` as its third element. Everything else passes through unchanged; the
 * wrapped provider itself is not modified (the relay shares one between jobs).
 */
export function withPartitionParameters<T extends object>(provider: T, transform: (params: unknown) => unknown): T {
  return new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop === 'queryZSwapAndContractState') {
        const original = Reflect.get(target, prop, receiver) as StateQuery;
        return async (...args: unknown[]) => {
          const r = await original.apply(target, args);
          if (!r) return r;
          const [zswap, contract, params, ...rest] = r;
          return [zswap, contract, transform(params), ...rest];
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
