// The offer-files kernel's wire formats, as the staging kernel serves them (API shape pinned at
// effectstream/zswap-offerfiles-kernel `ledger-v9` @ 5d46e8d; captured read-only from
// https://stagenet.api-zswap.zkdojo.com on 2026-09-27, see test/fixtures/kernel/).
//
// Parsing is strict about what the bank relies on and tolerant of everything else: unknown
// fields are dropped, and a single unreadable offer row is skipped (and counted) rather than
// taking the whole market down.

import { z } from 'zod';

/** A 64-hex value (colour, offer id), lowercased; the kernel serves it without 0x. */
const Hex64 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'expected 64 hex characters')
  .transform((s) => s.toLowerCase());

/** A base-unit amount. The kernel serves amounts as decimal strings to keep full precision;
 *  a JSON number is accepted only while it is a safe integer. */
const Amount = z
  .union([
    z.string().regex(/^\d+$/, 'expected a non-negative integer string'),
    z
      .number()
      .int()
      .nonnegative()
      .refine((n) => Number.isSafeInteger(n), 'unsafe integer amount'),
  ])
  .transform((v) => BigInt(v));

/** A count that the kernel serves as a number (or, defensively, a digit string). */
const Count = z
  .union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)])
  .transform((v) => Number(v))
  .refine((n) => Number.isSafeInteger(n), 'count out of range');

/** A price or statistic: a JSON number (chart stats) or a Postgres numeric string (pairs). Kept
 *  as the decimal TEXT the kernel sent, so it can be read exactly (`parseDecimalRatio`). */
const Decimal = z.union([
  z
    .number()
    .refine((n) => Number.isFinite(n), 'not a finite number')
    .transform((n) => String(n)),
  z.string().regex(/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/, 'not a decimal'),
]);

const Text = z.union([z.string(), z.number()]).transform((v) => String(v));

/** One leg of an offer: a token colour, an amount in base units, and its value layer. The
 *  colour is kept as served (lowercased when it is hex); the price derivation decides what an
 *  unknown colour or a non-SHIELDED leg means. */
export const OfferLegSchema = z.object({
  token: z.string().transform((s) => s.toLowerCase()),
  amount: Amount,
  type: z.string(),
});
export type OfferLeg = z.output<typeof OfferLegSchema>;

const Computed = z.object({
  gives: z.array(OfferLegSchema),
  wants: z.array(OfferLegSchema),
  expiresAt: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  firstSeenAt: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  status: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
});

/** A row of `GET /v1/offers` (a MIP-0006 OffchainOfferPayload without the offer string). */
export const OfferRowSchema = z.object({
  offerId: Hex64,
  blockHeight: Text.nullish().transform((v) => v ?? null),
  blobChars: z
    .number()
    .int()
    .nonnegative()
    .nullish()
    .transform((v) => v ?? null),
  computed: Computed,
});
export type OfferRow = z.output<typeof OfferRowSchema>;

/** The envelope of `GET /v1/offers`; rows are parsed one by one (see `parseOffersPage`). */
export const OffersPageSchema = z.object({
  offers: z.array(z.unknown()),
  nextCursor: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .transform((s) => s.toLowerCase())
    .nullable(),
});

/** `GET /v1/offers/:offerId`: one offer, with its `swapoffer1…` string. */
export const OfferDetailSchema = z.object({
  offerId: Hex64,
  offerBech32: z.string().min(1),
  blockHeight: Text.nullish().transform((v) => v ?? null),
  ttlSeconds: Text.nullish().transform((v) => v ?? null),
  computed: Computed,
});
export type OfferDetail = z.output<typeof OfferDetailSchema>;

/** A row of `GET /v1/pairs`. The pair is oriented by colour hex: LEAST is the base, GREATEST
 *  the quote, and `last_price` is the newest fill's raw base-unit ratio quote ÷ base. */
export const PairSchema = z.object({
  pair_key: z.string(),
  base_color: Hex64,
  quote_color: Hex64,
  trade_count: Count,
  last_price: Decimal.nullish().transform((v) => v ?? null),
  last_traded_at: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  open_count: Count,
});
export type Pair = z.output<typeof PairSchema>;
export const PairsSchema = z.array(PairSchema);

/** `GET /v1/chart/stats?base=&quote=`: re-oriented to the caller's base; `last` is a raw
 *  base-unit ratio quote ÷ base. When the pair has never filled, the kernel reports the MID of
 *  the open book as `last` (or 0), which the bank never shows as a trade (FR-007). */
export const ChartStatsSchema = z.object({
  base: Hex64,
  quote: Hex64,
  last: Decimal,
  change24: Decimal.optional(),
  high: Decimal.optional(),
  low: Decimal.optional(),
  volume_base: Decimal,
  volume_quote: Decimal.optional(),
});
export type ChartStats = z.output<typeof ChartStatsSchema>;

/** A row of `GET /v1/known-tokens`. */
export const KnownTokenSchema = z.object({
  token_color: Hex64,
  name: z.string(),
  kind: z.string(),
  decimals: z
    .number()
    .int()
    .nonnegative()
    .nullish()
    .transform((v) => v ?? null),
  asset_id: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
});
export type KnownToken = z.output<typeof KnownTokenSchema>;
export const KnownTokensSchema = z.array(KnownTokenSchema);

/** An event on `GET /v1/offers/stream` (server-sent events, one JSON object per `data:`). */
export const StreamEventSchema = z
  .object({
    type: z.string(),
    offerHash: z.string().optional(),
    timestamp: z.number().optional(),
  })
  .loose();
export type StreamEvent = z.output<typeof StreamEventSchema>;

/** The stream events that change the book or the last trade. */
export const BOOK_EVENTS: ReadonlySet<string> = new Set(['offer_indexed', 'offer_consumed', 'offer_expired']);
