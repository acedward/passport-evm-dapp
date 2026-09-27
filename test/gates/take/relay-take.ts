// The relay-assisted take (questions file Q15, option A): the fallback when a Passport account
// cannot take an offer in one atomic transaction. One signature, several transactions, NOT atomic:
//
//   1. the account withdraws its WHOLE coin to the relay's taker wallet (`withdraw_shielded_with_evm`,
//      the customer's one signature). The whole coin, so no change stays behind without an inbox
//      entry (Q13);
//   2. that wallet takes the maker's offer through the batcher as an ordinary wallet taker;
//   3. it deposits what it received (the stock) and the change back into the account with
//      `deposit_shielded`, each coin with an inbox entry sealed to the account's key.
//
// If the offer is gone by step 2 — or the take does not settle — the wallet deposits the coin back
// unchanged: the REFUND. While the take is in flight the bank holds the customer's coin (custodial,
// for minutes), which is the cost of this option.
//
// This module is the orchestration only; every chain operation is an injected step, so the order,
// the amounts and every refund branch are unit-tested (relay-take.test.ts) and the gate supplies
// the real steps (gate.ts).

export type OfferStatus = 'live' | 'consumed' | 'cancelled' | 'expired' | 'unknown';

export interface LegRef {
  /** 64 hex, lowercase. */
  colour: string;
  amount: bigint;
}

export interface TakeOfferRef {
  offerId: string;
  /** `swapoffer1…` */
  blob: string;
  /** What the maker gives: the taker (and so the account) receives it. */
  give: LegRef;
  /** What the maker wants: the account pays it. */
  want: LegRef;
}

export interface AccountCoinRef {
  colour: string;
  value: bigint;
}

export interface DepositedCoin {
  purpose: 'stock' | 'change' | 'refund';
  colour: string;
  value: bigint;
  txId: string;
}

export interface RelayTakeSteps {
  offerStatus(offerId: string): Promise<OfferStatus>;
  /** The taker wallet's spendable balance of a colour (base units). */
  takerBalance(colour: string): Promise<bigint>;
  /** Step 1: resolves once the taker wallet holds the withdrawn value. */
  withdrawWholeCoin(coin: AccountCoinRef): Promise<{ txId: string }>;
  /** Step 2: the wallet taker through the batcher. Never throws for a refused take. */
  takeAsWallet(offer: TakeOfferRef): Promise<{ ok: boolean; txHash?: string; error?: string }>;
  /** Step 3: `deposit_shielded` of `value` of `colour` into the account, with its inbox entry;
   *  resolves once the deposit is final. */
  depositToAccount(colour: string, value: bigint, purpose: DepositedCoin['purpose']): Promise<{ txId: string }>;
  log?(event: string, detail?: Record<string, unknown>): void;
}

export interface RelayTakeResult {
  outcome: 'taken' | 'refunded' | 'refused';
  reason: string;
  withdrawal?: { txId: string };
  take?: { ok: boolean; txHash?: string; error?: string };
  deposits: DepositedCoin[];
  /** Transactions the customer's value moved through, in order. */
  transactions: string[];
}

export class RelayTakeError extends Error {
  override name = 'RelayTakeError';
  constructor(
    message: string,
    /** Coins the taker wallet still holds for the account and must deposit (resume data). */
    readonly owed: Array<{ colour: string; value: bigint; purpose: DepositedCoin['purpose'] }>,
  ) {
    super(message);
  }
}

const norm = (h: string) => h.replace(/^0x/, '').toLowerCase();

/** Refuse before anything moves: the coin must be of the wanted colour and cover the price. */
export function checkTakeable(coin: AccountCoinRef, offer: TakeOfferRef): string | null {
  if (norm(coin.colour) !== norm(offer.want.colour)) return 'the coin is not of the colour the offer wants';
  if (offer.want.amount <= 0n || offer.give.amount <= 0n) return 'the offer has an empty leg';
  if (coin.value < offer.want.amount) return 'the coin is smaller than the price (offers are all or nothing)';
  return null;
}

export async function relayAssistedTake(
  coin: AccountCoinRef,
  offer: TakeOfferRef,
  steps: RelayTakeSteps,
): Promise<RelayTakeResult> {
  const log = steps.log ?? (() => {});
  const refused = checkTakeable(coin, offer);
  if (refused) return { outcome: 'refused', reason: refused, deposits: [], transactions: [] };

  const status = await steps.offerStatus(offer.offerId);
  if (status !== 'live') {
    return { outcome: 'refused', reason: `the offer is ${status}; nothing was moved`, deposits: [], transactions: [] };
  }

  const wantColour = norm(offer.want.colour);
  const giveColour = norm(offer.give.colour);
  const wantBefore = await steps.takerBalance(wantColour);
  const giveBefore = await steps.takerBalance(giveColour);

  // 1. the customer's one signature: the whole coin to the taker wallet.
  const withdrawal = await steps.withdrawWholeCoin({ colour: wantColour, value: coin.value });
  log('withdrawn', { txId: withdrawal.txId, value: coin.value.toString() });
  const transactions = [withdrawal.txId];
  const held = await steps.takerBalance(wantColour);
  if (held < wantBefore + coin.value) {
    throw new RelayTakeError('the withdrawn coin did not reach the taker wallet', []);
  }

  const deposits: DepositedCoin[] = [];
  const pay = async (owed: Array<{ colour: string; value: bigint; purpose: DepositedCoin['purpose'] }>) => {
    for (let i = 0; i < owed.length; i++) {
      const o = owed[i]!;
      try {
        const r = await steps.depositToAccount(o.colour, o.value, o.purpose);
        deposits.push({ ...o, txId: r.txId });
        transactions.push(r.txId);
        log('deposited', { purpose: o.purpose, value: o.value.toString(), txId: r.txId });
      } catch (e) {
        throw new RelayTakeError(`the ${o.purpose} deposit failed: ${(e as Error).message}`, owed.slice(i));
      }
    }
  };
  const refund = async (reason: string, take?: RelayTakeResult['take']): Promise<RelayTakeResult> => {
    log('refunding', { reason });
    await pay([{ colour: wantColour, value: coin.value, purpose: 'refund' }]);
    return { outcome: 'refunded', reason, withdrawal, ...(take ? { take } : {}), deposits, transactions };
  };

  // 2. is the offer still there?
  const again = await steps.offerStatus(offer.offerId);
  if (again !== 'live') return refund(`the offer became ${again} before the take`);

  const take = await steps.takeAsWallet(offer);
  log('take', {
    ok: take.ok,
    ...(take.txHash ? { txHash: take.txHash } : {}),
    ...(take.error ? { error: take.error } : {}),
  });
  let settled = take.ok;
  if (!settled) {
    // A refused or timed-out submission: the wallet's balance says whether it settled after all.
    const giveNow = await steps.takerBalance(giveColour);
    settled = giveNow >= giveBefore + offer.give.amount;
    if (!settled) return refund(`the take did not settle: ${take.error ?? 'refused'}`, take);
  }
  if (take.txHash) transactions.push(take.txHash);

  // 3. what the account bought, and its change.
  const change = coin.value - offer.want.amount;
  await pay([
    { colour: giveColour, value: offer.give.amount, purpose: 'stock' },
    ...(change > 0n ? [{ colour: wantColour, value: change, purpose: 'change' as const }] : []),
  ]);
  return { outcome: 'taken', reason: 'the offer was taken for the account', withdrawal, take, deposits, transactions };
}
