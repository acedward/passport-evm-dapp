// Plan L-ACC.2/.4/.5: the browser's coin list. Exact positions come from the ledger's own leaves
// (never a guess), spends from its nullifiers, coins only the browser knows are kept, and a
// payment uses ONE coin (Q9).

import { describe, expect, it } from 'vitest';

import {
  CoinChoiceError,
  chooseCoin,
  contractCoinCommitment,
  contractCoinNullifier,
  holdingsByColour,
  localCoin,
  reconcileCoins,
  type OwnedInput,
  type OwnedOutput,
} from '../src/coins.js';

const ACCOUNT = 'ac'.repeat(32);
const USDC = 'a1'.repeat(32);
const STK = 'b2'.repeat(32);
const coin = (n: number, color: string, value: bigint) => ({
  nonce: n.toString(16).padStart(64, '0'),
  color,
  value: value.toString(),
});
const leaf = (c: ReturnType<typeof coin>, mtIndex: number, tx = `tx${mtIndex}`): OwnedOutput => ({
  commitment: contractCoinCommitment(c, ACCOUNT),
  mtIndex: String(mtIndex),
  txHash: tx,
  blockHeight: mtIndex,
});
const spend = (c: ReturnType<typeof coin>, tx = 'spend'): OwnedInput => ({
  nullifier: contractCoinNullifier(c, ACCOUNT),
  txHash: tx,
  blockHeight: 99,
});

describe('commitment and nullifier', () => {
  it('are 32-byte hex, distinct, and bound to the account', () => {
    const c = coin(1, USDC, 5n);
    const cm = contractCoinCommitment(c, ACCOUNT);
    const nf = contractCoinNullifier(c, ACCOUNT);
    expect(cm).toMatch(/^[0-9a-f]{64}$/);
    expect(nf).toMatch(/^[0-9a-f]{64}$/);
    expect(cm).not.toBe(nf);
    expect(contractCoinCommitment(c, 'ad'.repeat(32))).not.toBe(cm);
  });

  it('accepts 0x prefixes and upper case', () => {
    const c = coin(7, USDC, 9n);
    expect(contractCoinCommitment({ ...c, nonce: `0x${c.nonce.toUpperCase()}` }, `0x${ACCOUNT}`)).toBe(
      contractCoinCommitment(c, ACCOUNT),
    );
  });

  it('refuses a value beyond 128 bits', () => {
    expect(() => contractCoinCommitment(coin(1, USDC, 1n << 128n), ACCOUNT)).toThrow(RangeError);
  });
});

describe('reconcileCoins', () => {
  const a = coin(1, USDC, 60_000_000n);
  const b = coin(2, USDC, 40_000_000n);
  const s = coin(3, STK, 5_000_000n);

  it('gives each inbox coin its exact position from the matching leaf', () => {
    const coins = reconcileCoins({
      account: ACCOUNT,
      inbox: [
        { ...a, inboxIndex: '0' },
        { ...b, inboxIndex: '1' },
      ],
      outputs: [leaf(b, 17), leaf(coin(9, USDC, 1n), 16), leaf(a, 12)],
      inputs: [],
      previous: [],
    });
    expect(coins.map((c) => [c.value, c.mtIndex, c.inInbox, c.spent])).toEqual([
      ['60000000', '12', true, false],
      ['40000000', '17', true, false],
    ]);
    expect(coins[0]!.createdTx).toBe('tx12');
  });

  it('leaves the position unknown when no leaf matches (never a guess)', () => {
    const coins = reconcileCoins({
      account: ACCOUNT,
      inbox: [{ ...a, inboxIndex: '0' }],
      outputs: [],
      inputs: [],
      previous: [],
    });
    expect(coins[0]!.mtIndex).toBeNull();
  });

  it('marks coins spent from the ledger nullifiers', () => {
    const coins = reconcileCoins({
      account: ACCOUNT,
      inbox: [
        { ...a, inboxIndex: '0' },
        { ...b, inboxIndex: '1' },
      ],
      outputs: [leaf(a, 1), leaf(b, 2)],
      inputs: [spend(a, 'wd')],
      previous: [],
    });
    expect(coins.find((c) => c.value === a.value)).toMatchObject({ spent: true, spentTx: 'wd' });
    expect(coins.find((c) => c.value === b.value)).toMatchObject({ spent: false });
  });

  it('keeps a coin only this browser knows (a change with no inbox entry, Q13), and positions it', () => {
    const change = localCoin(coin(4, USDC, 10_000_000n), ACCOUNT, 'change', 'wd');
    expect(change).toMatchObject({ inInbox: false, mtIndex: null, origin: 'change' });
    const coins = reconcileCoins({
      account: ACCOUNT,
      inbox: [],
      outputs: [leaf(coin(4, USDC, 10_000_000n), 30)],
      inputs: [],
      previous: [change],
    });
    expect(coins).toEqual([expect.objectContaining({ mtIndex: '30', inInbox: false, origin: 'change' })]);
    // Once its entry is filed, the next walk marks it recoverable from the chain.
    const later = reconcileCoins({
      account: ACCOUNT,
      inbox: [{ ...coin(4, USDC, 10_000_000n), inboxIndex: '5' }],
      outputs: [leaf(coin(4, USDC, 10_000_000n), 30)],
      inputs: [],
      previous: coins,
    });
    expect(later).toEqual([
      expect.objectContaining({ mtIndex: '30', inInbox: true, origin: 'change', inboxIndex: '5' }),
    ]);
  });

  it('does not duplicate a coin found both locally and in the inbox', () => {
    const prev = reconcileCoins({
      account: ACCOUNT,
      inbox: [{ ...s, inboxIndex: '0' }],
      outputs: [leaf(s, 3)],
      inputs: [],
      previous: [],
    });
    const again = reconcileCoins({
      account: ACCOUNT,
      inbox: [{ ...s, inboxIndex: '0' }],
      outputs: [leaf(s, 3)],
      inputs: [],
      previous: prev,
    });
    expect(again).toHaveLength(1);
  });
});

describe('holdings and the coin a payment uses (Q9)', () => {
  const coins = reconcileCoins({
    account: ACCOUNT,
    inbox: [
      { ...coin(1, USDC, 60_000_000n), inboxIndex: '0' },
      { ...coin(2, USDC, 40_000_000n), inboxIndex: '1' },
      { ...coin(3, USDC, 90_000_000n), inboxIndex: '2' }, // spent
      { ...coin(5, USDC, 99_000_000n), inboxIndex: '3' }, // no leaf yet
    ],
    outputs: [
      leaf(coin(1, USDC, 60_000_000n), 1),
      leaf(coin(2, USDC, 40_000_000n), 2),
      leaf(coin(3, USDC, 90_000_000n), 3),
    ],
    inputs: [spend(coin(3, USDC, 90_000_000n))],
    previous: [],
  });

  it('adds the unspent coins and names the largest single payment', () => {
    // 100 wUSDC as 60 + 40 shows "largest single payment 60" (spec US2 scenario 1); the spent
    // coin is out, and the coin without a position counts in the total but cannot pay yet.
    expect(holdingsByColour(coins)).toEqual([
      { color: USDC, total: 199_000_000n, largest: 60_000_000n, coins: 3, unpositioned: 1, notInInbox: 0 },
    ]);
  });

  it('pays from the smallest single coin that covers the amount', () => {
    expect(chooseCoin(coins, USDC, 30_000_000n).value).toBe('40000000');
    expect(chooseCoin(coins, USDC, 41_000_000n).value).toBe('60000000');
    expect(chooseCoin(coins, `0x${USDC.toUpperCase()}`, 60_000_000n).mtIndex).toBe('1');
  });

  it('refuses an amount no single coin covers, naming the largest', () => {
    expect(() => chooseCoin(coins, USDC, 80_000_000n)).toThrow(CoinChoiceError);
    expect(() => chooseCoin(coins, USDC, 80_000_000n)).toThrow(/largest single payment is 60000000/);
    expect(() => chooseCoin(coins, STK, 1n)).toThrow(/no spendable coin/);
  });
});
