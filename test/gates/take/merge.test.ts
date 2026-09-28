import { describe, expect, it } from 'vitest';

import { DUST, FakeTx, accountOffer, shielded, walletOffer } from './fake-tx.js';
import { TakeMergeError, complementOf, mergeTake, planTake, singleLegSegment, sumReadings } from './merge.js';
import { describeTx, imbalancesBySegment, legSegments, tokenLabel } from './tx-structure.js';

const STOCK = 'a1'.repeat(32);
const USDC = 'b2'.repeat(32);
const G = 2_000_000n; // the maker gives 2 stock
const W = 3_000_000n; // and wants 3 USDC

describe('reading a transaction', () => {
  it('labels tokens as the Passport client does', () => {
    expect(tokenLabel(DUST)).toBe('dust');
    expect(tokenLabel(shielded(`0x${USDC.toUpperCase()}`))).toBe(`shielded:${USDC}`);
  });

  it('describes a wallet offer: legs in segment 0, no intent', () => {
    const s = describeTx(walletOffer(STOCK, G, USDC, W));
    expect(s.segments).toEqual([0]);
    expect(s.intents).toEqual([]);
    expect(s.legs).toEqual({ '0': { [`shielded:${STOCK}`]: '2000000', [`shielded:${USDC}`]: '-3000000' } });
    expect(s.guaranteedOffer).toMatchObject({ inputs: 1, outputs: 2 });
  });

  it('describes an account call: where its transcript runs decides where its legs are', () => {
    const fallible = describeTx(accountOffer(4711, 4711, USDC, W, STOCK, G));
    expect(fallible.segments).toEqual([0, 4711]);
    expect(fallible.intents[0]).toMatchObject({ segment: 4711, calls: [{ transcript: 'fallible' }] });
    expect(fallible.legSegments).toEqual([4711]);
    expect(Object.keys(fallible.fallibleOffers)).toEqual(['4711']);

    const guaranteed = describeTx(accountOffer(4711, 0, USDC, W, STOCK, G));
    expect(guaranteed.intents[0]).toMatchObject({ segment: 4711, calls: [{ transcript: 'guaranteed' }] });
    expect(guaranteed.legSegments).toEqual([0]);
    expect(guaranteed.guaranteedOffer).not.toBeNull();
  });

  it('never reads an unreadable imbalance as empty', () => {
    const broken = new FakeTx();
    broken.imbalances = () => {
      throw new Error('boom');
    };
    expect(() => imbalancesBySegment(broken)).toThrow(/could not be read/);
  });

  it('ignores dust when finding the legs', () => {
    const tx = new FakeTx(
      new Map(),
      new Map([
        [
          0,
          [
            [DUST, -5n],
            [shielded(STOCK), 1n],
          ],
        ],
      ]),
    );
    expect(legSegments(imbalancesBySegment(tx))).toEqual([0]);
  });
});

describe('the complement of an offer', () => {
  it('gives what the maker wants and wants what the maker gives', () => {
    const c = complementOf(imbalancesBySegment(walletOffer(STOCK, G, USDC, W)));
    expect(c).toEqual({ makerSegment: 0, give: { colour: USDC, amount: W }, want: { colour: STOCK, amount: G } });
  });

  it('refuses split legs and baskets', () => {
    const split = new FakeTx(
      new Map(),
      new Map([
        [0, [[shielded(STOCK), G]]],
        [9, [[shielded(USDC), -W]]],
      ]),
    );
    expect(() => complementOf(imbalancesBySegment(split))).toThrow(TakeMergeError);
    const basket = new FakeTx(
      new Map(),
      new Map([
        [
          0,
          [
            [shielded(STOCK), G],
            [shielded('c3'.repeat(32)), 1n],
            [shielded(USDC), -W],
          ],
        ],
      ]),
    );
    expect(() => complementOf(imbalancesBySegment(basket))).toThrow(/one-token-for-one-token/);
    expect(() => singleLegSegment({ '0': { dust: '-1' } }, 'x')).toThrow(/no value leg/);
  });
});

describe('planning and merging a take', () => {
  it('(a) a default (fallible) account call cannot fill a wallet offer: the legs are in different segments', () => {
    const maker = walletOffer(STOCK, G, USDC, W);
    const taker = accountOffer(4711, 4711, USDC, W, STOCK, G);
    const plan = planTake(maker, taker);
    expect(plan).toMatchObject({ makerLegSegment: 0, takerLegSegment: 4711, settleable: false });
    expect(plan.residualLegs).toEqual({
      '0': { [`shielded:${STOCK}`]: '2000000', [`shielded:${USDC}`]: '-3000000' },
      '4711': { [`shielded:${USDC}`]: '3000000', [`shielded:${STOCK}`]: '-2000000' },
    });
    expect(() => mergeTake(maker, taker)).toThrow(TakeMergeError);
    const measured = mergeTake(maker, taker, { requireBalanced: false });
    expect(measured.balanced).toBe(false);
    expect(measured.structure.legSegments).toEqual([0, 4711]);
  });

  it('(b) a guaranteed account call fills a wallet offer in segment 0', () => {
    const maker = walletOffer(STOCK, G, USDC, W);
    const taker = accountOffer(4711, 0, USDC, W, STOCK, G);
    const plan = planTake(maker, taker);
    expect(plan).toMatchObject({ makerLegSegment: 0, takerLegSegment: 0, settleable: true, intentCollisions: [] });
    const m = mergeTake(maker, taker);
    expect(m.balanced).toBe(true);
    expect(m.structure.segments).toEqual([0, 4711]);
  });

  it('(c) two default account calls sit in their own segments; two guaranteed ones meet in segment 0', () => {
    const makerDefault = accountOffer(100, 100, STOCK, G, USDC, W);
    const takerDefault = accountOffer(200, 200, USDC, W, STOCK, G);
    expect(planTake(makerDefault, takerDefault).settleable).toBe(false);
    const takerGuaranteed = accountOffer(200, 0, USDC, W, STOCK, G);
    expect(planTake(makerDefault, takerGuaranteed)).toMatchObject({ makerLegSegment: 100, takerLegSegment: 0 });
    const makerGuaranteed = accountOffer(100, 0, STOCK, G, USDC, W);
    expect(planTake(makerGuaranteed, takerGuaranteed).settleable).toBe(true);
  });

  it('refuses before merging when both artefacts own the same intent segment', () => {
    const maker = accountOffer(7, 0, STOCK, G, USDC, W);
    const taker = accountOffer(7, 0, USDC, W, STOCK, G);
    const plan = planTake(maker, taker);
    expect(plan.intentCollisions).toEqual([7]);
    expect(plan.settleable).toBe(false);
    expect(() => mergeTake(maker, taker, { requireBalanced: false })).toThrow(/segment 7/);
  });

  it('refuses amounts that do not cancel', () => {
    const maker = walletOffer(STOCK, G, USDC, W);
    const taker = accountOffer(9, 0, USDC, W - 1n, STOCK, G);
    const plan = planTake(maker, taker);
    expect(plan.settleable).toBe(false);
    expect(plan.reason).toMatch(/do not cancel/);
    expect(plan.residualLegs).toEqual({ '0': { [`shielded:${USDC}`]: '-1' } });
  });

  it('adds readings per segment and token', () => {
    expect(sumReadings({ '0': { a: '1', b: '-2' } }, { '0': { a: '-1' }, '5': { c: '3' } })).toEqual({
      '0': { a: '0', b: '-2' },
      '5': { c: '3' },
    });
  });
});
