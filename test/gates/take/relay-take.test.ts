import { describe, expect, it } from 'vitest';

import {
  RelayTakeError,
  checkTakeable,
  relayAssistedTake,
  type OfferStatus,
  type RelayTakeSteps,
  type TakeOfferRef,
} from './relay-take.js';

const STOCK = 'a1'.repeat(32);
const USDC = 'b2'.repeat(32);
const OFFER: TakeOfferRef = {
  offerId: 'o1',
  blob: 'swapoffer1xyz',
  give: { colour: STOCK, amount: 2_000_000n },
  want: { colour: USDC, amount: 3_000_000n },
};

/** A small world: the taker wallet's balances, the offer's status over time, and what happened. */
function world(o: {
  statuses?: OfferStatus[];
  take?: 'ok' | 'refused' | 'lost-receipt';
  withdrawArrives?: boolean;
  failDeposit?: string;
}) {
  const bal: Record<string, bigint> = { [STOCK]: 0n, [USDC]: 0n };
  const log: string[] = [];
  const statuses = [...(o.statuses ?? ['live', 'live'])];
  let n = 0;
  const steps: RelayTakeSteps = {
    async offerStatus() {
      return statuses[Math.min(n++, statuses.length - 1)]!;
    },
    async takerBalance(c) {
      return bal[c] ?? 0n;
    },
    async withdrawWholeCoin(coin) {
      log.push(`withdraw ${coin.value}`);
      if (o.withdrawArrives !== false) bal[coin.colour] = (bal[coin.colour] ?? 0n) + coin.value;
      return { txId: 'tx-withdraw' };
    },
    async takeAsWallet(offer) {
      log.push('take');
      if (o.take === 'refused') return { ok: false, error: 'nullifier already spent' };
      bal[offer.want.colour]! -= offer.want.amount;
      bal[offer.give.colour]! += offer.give.amount;
      return o.take === 'lost-receipt' ? { ok: false, error: 'timeout' } : { ok: true, txHash: 'tx-take' };
    },
    async depositToAccount(colour, value, purpose) {
      if (o.failDeposit === purpose) throw new Error('node down');
      log.push(`deposit ${purpose} ${value}`);
      bal[colour]! -= value;
      return { txId: `tx-${purpose}` };
    },
  };
  return { steps, bal, log };
}

describe('the relay-assisted take', () => {
  it('takes the offer and deposits the stock and the change', async () => {
    const w = world({});
    const r = await relayAssistedTake({ colour: USDC, value: 10_000_000n }, OFFER, w.steps);
    expect(r.outcome).toBe('taken');
    expect(w.log).toEqual(['withdraw 10000000', 'take', 'deposit stock 2000000', 'deposit change 7000000']);
    expect(r.transactions).toEqual(['tx-withdraw', 'tx-take', 'tx-stock', 'tx-change']);
    expect(r.deposits.map((d) => [d.purpose, d.colour, d.value])).toEqual([
      ['stock', STOCK, 2_000_000n],
      ['change', USDC, 7_000_000n],
    ]);
    expect(w.bal).toEqual({ [STOCK]: 0n, [USDC]: 0n }); // the bank keeps nothing
  });

  it('deposits no change when the coin is exactly the price', async () => {
    const w = world({});
    const r = await relayAssistedTake({ colour: USDC, value: 3_000_000n }, OFFER, w.steps);
    expect(r.outcome).toBe('taken');
    expect(r.transactions).toEqual(['tx-withdraw', 'tx-take', 'tx-stock']);
  });

  it('refuses before anything moves: wrong colour, too small, offer not live', async () => {
    expect(checkTakeable({ colour: STOCK, value: 9n }, OFFER)).toMatch(/colour/);
    expect(checkTakeable({ colour: USDC, value: 2_999_999n }, OFFER)).toMatch(/all or nothing/);
    const w = world({ statuses: ['consumed'] });
    const r = await relayAssistedTake({ colour: USDC, value: 10_000_000n }, OFFER, w.steps);
    expect(r).toMatchObject({ outcome: 'refused', transactions: [] });
    expect(w.log).toEqual([]);
  });

  it('refunds the whole coin when the offer is gone after the withdrawal', async () => {
    const w = world({ statuses: ['live', 'consumed'] });
    const r = await relayAssistedTake({ colour: `0x${USDC.toUpperCase()}`, value: 10_000_000n }, OFFER, w.steps);
    expect(r.outcome).toBe('refunded');
    expect(r.reason).toMatch(/consumed/);
    expect(w.log).toEqual(['withdraw 10000000', 'deposit refund 10000000']);
    expect(r.transactions).toEqual(['tx-withdraw', 'tx-refund']);
  });

  it('refunds when the take is refused', async () => {
    const w = world({ take: 'refused' });
    const r = await relayAssistedTake({ colour: USDC, value: 10_000_000n }, OFFER, w.steps);
    expect(r.outcome).toBe('refunded');
    expect(r.take).toMatchObject({ ok: false, error: 'nullifier already spent' });
    expect(w.log).toEqual(['withdraw 10000000', 'take', 'deposit refund 10000000']);
  });

  it('delivers, not refunds, when the take settled but its receipt was lost', async () => {
    const w = world({ take: 'lost-receipt' });
    const r = await relayAssistedTake({ colour: USDC, value: 10_000_000n }, OFFER, w.steps);
    expect(r.outcome).toBe('taken');
    expect(w.log).toEqual(['withdraw 10000000', 'take', 'deposit stock 2000000', 'deposit change 7000000']);
  });

  it('stops, with what is owed, when the coin never reaches the wallet or a deposit fails', async () => {
    await expect(
      relayAssistedTake({ colour: USDC, value: 10_000_000n }, OFFER, world({ withdrawArrives: false }).steps),
    ).rejects.toThrow(/did not reach/);
    const w = world({ failDeposit: 'change' });
    const err = await relayAssistedTake({ colour: USDC, value: 10_000_000n }, OFFER, w.steps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayTakeError);
    expect((err as RelayTakeError).owed).toEqual([{ colour: USDC, value: 7_000_000n, purpose: 'change' }]);
  });
});
