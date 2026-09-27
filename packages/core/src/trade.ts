// Trading at USDC prices (plan L-TRD, spec US7/US8, FR-008/FR-011/FR-012/FR-019, Q3, Q9).
//
// Every trade is USDC against ONE stock. A customer either MAKES an offer ("sell N at P", "buy N
// at P") or TAKES a whole live offer from the book. Both are one `open_swap_shielded_with_evm`
// call by the account, proven with a fully guaranteed transcript by the relay (G-TAKE), so its
// legs sit in segment 0, where any taker's or maker's legs can meet them.
//
// This module is the pure part both the browser and the relay use: the exact legs of an order in
// bigint base units, the complement of a book entry, whether one coin can fund it (Q9: one coin
// per payment, whole offers only), the one-live-offer rule and the warnings before a signed action
// would cancel a live offer (L-TRD.3), and the wire shapes of the two relay actions.

import { z } from 'zod';

import { QualifiedCoinSchema } from './accounts.js';
import { AmountError, type Ratio, formatUnits, parseUnits, priceRatio } from './amount.js';
import type { StoredCoin } from './coins.js';
import { normaliseHex32 } from './hex.js';
import type { BookEntry } from './market/prices.js';
import type { TokenEntry } from './tokens/registry.js';

export class TradeError extends Error {
  override name = 'TradeError';
}

export type TradeSide = 'buy' | 'sell';

/** One leg: a colour (64 hex, lowercase) and an amount in its base units. */
export interface TradeLeg {
  colour: string;
  amount: bigint;
}

export interface OrderLegs {
  side: TradeSide;
  /** What the account gives up. */
  give: TradeLeg;
  /** What the account wants in return. */
  want: TradeLeg;
  /** The stock leg, stock base units. */
  stockRaw: bigint;
  /** The USDC leg, USDC base units. */
  usdcRaw: bigint;
  /** Whole USDC per whole stock that the legs actually carry. */
  effectivePrice: Ratio;
  /** True when N × P was not a whole number of USDC base units and had to be rounded. */
  rounded: boolean;
}

/**
 * A price in whole USDC per whole stock ("1.05"), exact, with at most the USDC token's decimals.
 * Zero and more digits than USDC carries are refused (a price the legs cannot express).
 */
export function parsePrice(text: string, usdc: Pick<TokenEntry, 'decimals'>): Ratio {
  let raw: bigint;
  try {
    raw = parseUnits(text, usdc.decimals);
  } catch (e) {
    throw new TradeError(e instanceof AmountError ? e.message.replace(/^amount/, 'the price') : 'not a price');
  }
  return { num: raw, den: 10n ** BigInt(usdc.decimals) };
}

/**
 * The legs of a limit order, in exact bigint maths (spec FR-011):
 *   sell N at P → give N stock, want N × P USDC;
 *   buy N at P  → give N × P USDC, want N stock.
 * When N × P is not a whole number of USDC base units it is rounded IN THE CUSTOMER'S FAVOUR, as a
 * limit price must be: a sell asks for at least P (rounded up), a buy pays at most P (rounded
 * down). A USDC leg that rounds to zero is refused.
 */
export function orderLegs(
  side: TradeSide,
  stock: Pick<TokenEntry, 'midnightColour' | 'decimals'>,
  usdc: Pick<TokenEntry, 'midnightColour' | 'decimals'>,
  quantityRaw: bigint,
  price: Ratio,
): OrderLegs {
  if (quantityRaw <= 0n) throw new TradeError('the quantity must be greater than zero');
  if (price.num <= 0n || price.den <= 0n) throw new TradeError('the price must be greater than zero');
  // USDC base units = quantityRaw / 10^sd × price × 10^ud.
  const num = quantityRaw * price.num * 10n ** BigInt(usdc.decimals);
  const den = price.den * 10n ** BigInt(stock.decimals);
  const floor = num / den;
  const exact = num % den === 0n;
  const usdcRaw = exact ? floor : side === 'sell' ? floor + 1n : floor;
  if (usdcRaw <= 0n) throw new TradeError('the order is too small: its USDC amount rounds to zero');
  const stockLeg: TradeLeg = { colour: normaliseHex32(stock.midnightColour), amount: quantityRaw };
  const usdcLeg: TradeLeg = { colour: normaliseHex32(usdc.midnightColour), amount: usdcRaw };
  return {
    side,
    give: side === 'sell' ? stockLeg : usdcLeg,
    want: side === 'sell' ? usdcLeg : stockLeg,
    stockRaw: quantityRaw,
    usdcRaw,
    effectivePrice: priceRatio(usdcRaw, usdc.decimals, quantityRaw, stock.decimals),
    rounded: !exact,
  };
}

/**
 * What the account must give and want to take a whole book entry (FR-012): taking an ASK (a
 * maker selling the stock) is a BUY: give the ask's USDC, want its stock. Taking a BID is a SELL:
 * give the bid's stock, want its USDC.
 */
export function takeLegs(
  entry: Pick<BookEntry, 'side' | 'stockRaw' | 'usdcRaw'>,
  stock: Pick<TokenEntry, 'midnightColour' | 'decimals'>,
  usdc: Pick<TokenEntry, 'midnightColour' | 'decimals'>,
): OrderLegs {
  const stockLeg: TradeLeg = { colour: normaliseHex32(stock.midnightColour), amount: entry.stockRaw };
  const usdcLeg: TradeLeg = { colour: normaliseHex32(usdc.midnightColour), amount: entry.usdcRaw };
  const side: TradeSide = entry.side === 'ask' ? 'buy' : 'sell';
  return {
    side,
    give: side === 'buy' ? usdcLeg : stockLeg,
    want: side === 'buy' ? stockLeg : usdcLeg,
    stockRaw: entry.stockRaw,
    usdcRaw: entry.usdcRaw,
    effectivePrice: priceRatio(entry.usdcRaw, usdc.decimals, entry.stockRaw, stock.decimals),
    rounded: false,
  };
}

export type Fundability =
  { ok: true; coin: StoredCoin & { mtIndex: string } } | { ok: false; reason: string; largest: bigint; needed: bigint };

/**
 * Can ONE coin pay `give` (Q9: no coin merge, offers are all or nothing)? The coin used is the
 * smallest unspent, positioned coin that covers it (L-ACC.5). When none does, the reason names the
 * largest single payment, as the book shows it (spec US8 acceptance 1).
 */
export function fundWithOneCoin(
  coins: readonly StoredCoin[],
  give: TradeLeg,
  token: Pick<TokenEntry, 'midnightName' | 'decimals'>,
): Fundability {
  const colour = normaliseHex32(give.colour);
  const usable = coins.filter((c) => !c.spent && c.color === colour && c.mtIndex !== null);
  const covering = usable
    .filter((c) => BigInt(c.value) >= give.amount)
    .sort((a, b) => (BigInt(a.value) < BigInt(b.value) ? -1 : BigInt(a.value) > BigInt(b.value) ? 1 : 0));
  if (covering[0]) return { ok: true, coin: covering[0] as StoredCoin & { mtIndex: string } };
  const largest = usable.reduce((m, c) => (BigInt(c.value) > m ? BigInt(c.value) : m), 0n);
  const fmt = (v: bigint) => formatUnits(v, token.decimals, { minFractionDigits: 2, grouping: true });
  const reason =
    largest === 0n
      ? `You hold no spendable ${token.midnightName}.`
      : `Needs ${fmt(give.amount)} ${token.midnightName} from one coin; your largest single payment is ${fmt(largest)}.`;
  return { ok: false, reason, largest, needed: give.amount };
}

// ── Offers the account made, and the one-live-offer rule (Q9, L-TRD.1, L-TRD.3) ──────────

/** The kernel's lifecycle words, plus what only the browser can know. */
export type OfferState =
  /** On the book, and this account has not signed anything since. */
  | 'live'
  /** Settled by a taker: the account's coin was spent by the offer. */
  | 'filled'
  /** The intent's TTL passed (at most 1 hour after proving). */
  | 'expired'
  /** Another signed action of the account moved its nonce, so the offer can never settle. */
  | 'cancelled'
  /** Proven but the exchange refused it, or never answered. */
  | 'refused';

/** The part of a stored offer the rules read. */
export interface OfferRuleInput {
  status: OfferState;
  /** The auth nonce the offer's signature binds. */
  authNonce: string;
  /** Unix ms after which the ledger refuses the offer's intent. */
  expiresAt: number;
}

/**
 * Is this offer still able to settle? Live on the book, not past its TTL, and signed at the
 * account's CURRENT auth nonce (any other executed call advances it, which kills the offer).
 */
export function offerStillLive(o: OfferRuleInput, now: number, currentAuthNonce?: string | bigint): boolean {
  if (o.status !== 'live') return false;
  if (now >= o.expiresAt) return false;
  if (currentAuthNonce !== undefined && BigInt(currentAuthNonce) !== BigInt(o.authNonce)) return false;
  return true;
}

/** The signed actions an account can take (bridge ones included: L-BRG). */
export type SignedAction = 'withdraw' | 'append-inbox' | 'bridge-deposit' | 'bridge-withdraw' | 'open-swap' | 'take';

const ACTION_TEXT: Record<SignedAction, string> = {
  withdraw: 'This withdrawal',
  'append-inbox': 'Recording this change',
  'bridge-deposit': 'This deposit from Sepolia',
  'bridge-withdraw': 'This withdrawal to Sepolia',
  'open-swap': 'A second offer',
  take: 'Taking this offer',
};

export type ActionGuard =
  | { kind: 'ok' }
  /** The action is allowed after the customer confirms. */
  | { kind: 'warn'; message: string }
  /** The action is refused. */
  | { kind: 'refuse'; message: string };

/**
 * What the page must do before `action` while `live` is the account's live offer (Q9: one live
 * offer per account; any other signed call, once executed, makes it unsettleable):
 *   - making a second offer is REFUSED: the two would share one auth nonce, so at most one could
 *     ever settle, and they may spend the same coin (L-TRD.1);
 *   - every other signed action WARNS that it cancels the offer, and needs a confirmation
 *     (L-TRD.3; spec US7 acceptance 1, US8 acceptance 2).
 */
export function guardSignedAction(
  action: SignedAction,
  live: (OfferRuleInput & { summary: string }) | null,
  now: number,
  currentAuthNonce?: string | bigint,
): ActionGuard {
  if (!live || !offerStillLive(live, now, currentAuthNonce)) return { kind: 'ok' };
  const until = new Date(live.expiresAt).toISOString().slice(11, 16);
  if (action === 'open-swap') {
    return {
      kind: 'refuse',
      message:
        `You already have a live offer (${live.summary}). An account can have one live offer at a time: ` +
        `it stays on the exchange until someone takes it or it expires at ${until} UTC.`,
    };
  }
  return {
    kind: 'warn',
    message:
      `${ACTION_TEXT[action]} cancels your live offer (${live.summary}): once it goes through, that offer can ` +
      'never be taken. Continue?',
  };
}

// ── The relay actions (wire) ───────────────────────────────────────────────────────────

const hex = (bytes: number) => z.string().regex(new RegExp(`^(0x)?[0-9a-fA-F]{${bytes * 2}}$`));
const hex32 = hex(32);
const decimal = z.string().regex(/^[0-9]{1,40}$/);

/**
 * `open-swap` (make, FR-011): the account's `open_swap_shielded_with_evm` in the OPEN shape
 * (anyone may take it). Every field is what the circuit and its EIP-712 challenge bind: the give
 * leg, the wanted coin (its nonce is the browser's fresh randomness), the two inbox entries the
 * browser sealed to the account's own key (the wanted coin, and the predicted change or 192 zero
 * bytes), the deadline (0: none but the intent's TTL), and the coin the give is paid from.
 */
export const OpenSwapPayloadSchema = z
  .object({
    giveColor: hex32,
    giveAmount: decimal,
    wantColor: hex32,
    wantAmount: decimal,
    wantNonce: hex32,
    wantEntry: hex(192),
    changeEntry: hex(192),
    validUntil: decimal,
    coin: QualifiedCoinSchema,
    authNonce: decimal,
  })
  .strict();
export type OpenSwapPayload = z.infer<typeof OpenSwapPayloadSchema>;

/**
 * `take` (FR-012): the same call, complementary to one whole live offer on the book (its give is
 * the maker's want, its want the maker's give), merged by the relay with the maker's offer and
 * settled in ONE transaction through the batcher.
 */
export const TakePayloadSchema = OpenSwapPayloadSchema.extend({
  offerId: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type TakePayload = z.infer<typeof TakePayloadSchema>;

export interface OpenSwapResult {
  /** The kernel's id of the offer (SHA-256 of its bytes). */
  offerId: string;
  /** Whether the exchange accepted it, and what it said. */
  kernel: { accepted: boolean; status: string; code: string | null; reason: string | null };
  /** The segment its legs are in (0 when proven guaranteed, which is what makes it takeable). */
  legSegment: number;
  proveSeconds: number;
  /** Unix ms: the intent's TTL (the ledger refuses the offer after it). */
  expiresAt: number;
  bytes: number;
}

export interface TakeResult {
  offerId: string;
  /** The settling transaction, as the batcher reported it. */
  txHash: string;
  proveSeconds: number;
  /** The merged transaction's modelled cost against the chain's live parameters. */
  cost: { blockUsage: string; computeTimePs: string; readTimePs: string; feesSpecks: string | null };
  path: 'batcher';
}
