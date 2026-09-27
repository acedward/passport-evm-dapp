// Proving one account offer — a make or the account's side of a take — with the transcript
// partitioned FULLY GUARANTEED, so its value legs sit in segment 0 (plan G-TAKE, finding 15).
//
// Why: a Passport call's coins are matched where its transcript runs. midnight-js's default split
// puts a gated circuit's legs in the call's own random fallible segment, where no other party's
// legs can ever meet them (balancing is per token PER SEGMENT, and a Zswap proof binds its
// segment). G-TAKE proved at the ledger that the same call proven guaranteed settles against a
// wallet maker (b) and, when both sides are proven this way, against another account (c2). So
// EVERY account offer is proven guaranteed: makes (so accounts can take them) and takes.
//
// The steps, each checked: connect the account with the one coin the give is paid from (the call's
// private state), build the call with upstream `buildOpenSwapOffer` (proves, refuses a DUST action,
// asserts the legs are exactly +give / −want in ONE segment), bind it (the kernel's wire form, as
// midnight-2-offers' `aa-offer.ts` does; the imbalances must not change), and require that segment
// to be 0. The result is encoded as `swapoffer1…` and never balanced, signed or submitted here.

import { encodeOffer, offerIdOf } from '@mnbank/core';

import type { PassportProviders, PassportRuntime } from '../passport/runtime.js';
import { steeringParameters, withPartitionParameters } from './partition.js';
import { describeTx, imbalancesBySegment, type TxStructure } from './tx-structure.js';

const VENDOR = '../../../vendor/passport/contract';

export class AccountOfferError extends Error {
  override name = 'AccountOfferError';
  constructor(
    message: string,
    readonly code: 'placement' | 'binding' | 'not-guaranteed' | 'proof',
  ) {
    super(message);
  }
}

export interface AccountOfferCall {
  /** The eight leading circuit arguments (`OfferCallArgs` of upstream offer.ts). */
  call: {
    giveColor: Uint8Array;
    giveAmount: bigint;
    recipientKind: bigint;
    recipient: Uint8Array;
    want: { nonce: Uint8Array; color: Uint8Array; value: bigint };
    wantEntry: Uint8Array;
    changeEntry: Uint8Array;
    validUntil: bigint;
  };
  /** The coin the give is paid from, with its exact Merkle position. */
  coin: { nonce: Uint8Array; color: Uint8Array; value: bigint; mt_index: bigint };
  /** The trailing authorisation arguments: `pk`, `use_counter`, `sig`. */
  authArgs: readonly unknown[];
}

export interface ProvenAccountOffer {
  /** The BOUND ledger-v9 transaction. */
  tx: {
    serialize(): Uint8Array;
    imbalances(segment: number): Map<unknown, bigint>;
    merge(other: unknown): unknown;
  } & Record<string, unknown>;
  bytes: Uint8Array;
  blob: string;
  offerId: string;
  proveMs: number;
  structure: TxStructure;
  /** The parameters the partitioner was handed (picoseconds), for the evidence. */
  steering: { fromPs: string; toPs: string } | null;
  /** Unix ms: the intent's TTL (midnight-js builds calls with one hour). */
  expiresAt: number;
}

/**
 * A copy of `providers` whose public data provider hands the partitioner steering parameters
 * (partition.ts). The shared provider itself is not modified.
 */
export function guaranteedProviders(
  providers: PassportProviders,
  ledger: { LedgerParameters: { deserialize(b: Uint8Array): never } },
  onSteer?: (s: { fromPs: bigint; toPs: bigint }) => void,
): PassportProviders {
  return {
    ...providers,
    publicDataProvider: withPartitionParameters(providers.publicDataProvider as object, (params: unknown) => {
      const s = steeringParameters(params as never, (b) => ledger.LedgerParameters.deserialize(b));
      onSteer?.({ fromPs: s.fromPs, toPs: s.toPs });
      return s.params;
    }),
  };
}

/** Prove, bind and encode one account offer, legs in segment 0. */
export async function proveGuaranteedOffer(o: {
  rt: PassportRuntime;
  providers: PassportProviders;
  account: string;
  offer: AccountOfferCall;
}): Promise<ProvenAccountOffer> {
  const ledger = (await import('@midnightntwrk/ledger-v9')) as unknown as {
    LedgerParameters: { deserialize(b: Uint8Array): never };
  };
  const offerMod = (await import(`${VENDOR}/src/wallet/offer.js`)) as {
    buildOpenSwapOffer(spec: Record<string, unknown>): Promise<{
      proven: ProvenAccountOffer['tx'] & { bind?: () => ProvenAccountOffer['tx'] };
      proveMs: number;
    }>;
  };
  let steering: ProvenAccountOffer['steering'] = null;
  const providers = guaranteedProviders(o.providers, ledger, (s) => {
    steering = { fromPs: s.fromPs.toString(), toPs: s.toPs.toString() };
  });
  const { account: accountMod, witnesses } = o.rt.client as unknown as {
    account: {
      CustodyAccount: { connect(p: unknown, c: unknown, a: string, s: unknown): Promise<{ privateStateId: string }> };
    };
    witnesses: { withCoin(s: unknown, c: unknown): unknown; emptyCoinStore(): unknown };
  };
  const store = witnesses.withCoin(witnesses.emptyCoinStore(), {
    nonce: o.offer.coin.nonce,
    color: o.offer.coin.color,
    value: o.offer.coin.value,
    mtIndex: o.offer.coin.mt_index,
  });
  const custody = await accountMod.CustodyAccount.connect(providers, o.rt.compiledAccount(), o.account, store);
  const startedAt = Date.now();
  let built: Awaited<ReturnType<typeof offerMod.buildOpenSwapOffer>>;
  try {
    built = await offerMod.buildOpenSwapOffer({
      providers,
      compiledContract: o.rt.compiledAccount(),
      accountAddress: o.account,
      privateStateId: custody.privateStateId,
      circuitId: 'open_swap_shielded_with_evm',
      call: o.offer.call,
      authArgs: o.offer.authArgs,
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/segment|imbalance|artefact|DUST/i.test(m)) throw new AccountOfferError(m, 'placement');
    throw e;
  }
  const bound = typeof built.proven.bind === 'function' ? built.proven.bind() : built.proven;
  const before = JSON.stringify(imbalancesBySegment(built.proven as never));
  const after = JSON.stringify(imbalancesBySegment(bound as never));
  if (before !== after) throw new AccountOfferError(`binding changed the offer's imbalances`, 'binding');
  const structure = describeTx(bound as never);
  if (structure.legSegments.length !== 1 || structure.legSegments[0] !== 0) {
    throw new AccountOfferError(
      `the offer's legs are in segment(s) ${structure.legSegments.join(', ') || 'none'}, not 0: it could not be proven guaranteed`,
      'not-guaranteed',
    );
  }
  const bytes = bound.serialize();
  return {
    tx: bound,
    bytes,
    blob: encodeOffer(bytes),
    offerId: offerIdOf(bytes),
    proveMs: built.proveMs,
    structure,
    steering,
    expiresAt: intentTtl(bound) ?? startedAt + 60 * 60 * 1000,
  };
}

/**
 * The earliest intent TTL of a transaction (unix ms), or null when it cannot be read. midnight-js
 * gives a call's intent `ttlOneHour()` at build time; after it the ledger refuses the intent, and
 * the kernel expires the offer (its expiry follows the ledger).
 */
export function intentTtl(tx: unknown): number | null {
  try {
    const intents = (tx as { intents?: Map<number, { ttl?: unknown }> }).intents;
    let min: number | null = null;
    for (const intent of intents?.values() ?? []) {
      const t = intent.ttl instanceof Date ? intent.ttl.getTime() : null;
      if (t !== null && Number.isFinite(t)) min = min === null ? t : Math.min(min, t);
    }
    return min;
  } catch {
    return null;
  }
}
