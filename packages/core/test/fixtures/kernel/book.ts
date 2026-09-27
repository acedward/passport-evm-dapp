// A known offer book for the markets tests, in the exact wire shapes of the offer-files kernel
// (`ledger-v9` @ 5d46e8d: `GET /v1/offers` rows, `/v1/pairs` rows, `/v1/chart/stats`), with the
// stagenet registry's real colours. The staging book was empty when the shapes were captured
// (./staging-2026-09-27/), so these rows follow the kernel's source field by field: amounts and
// block heights as strings, `last_price` as a Postgres numeric string, stats as JSON numbers.
//
// The expected prices are written out by hand beside each scenario (never computed by the code
// under test).

export const COLOUR = {
  wStkA: '5eb2a3cebb2ebe7ba910c78f62c9e28e0d74acbd00c810730def3578860e6a02',
  wStkB: 'e7ca18cb056477a5aca5cce387306d56526c2f226b4a4e34f068e3a3e8179588',
  wStkC: 'db8ae472c587a0709094eeaf98b81a0d46752db1a807e77bd209814e808f19d9',
  wUSDC: 'e5afe273bcb1252cfbc81ad6ca1caaafe22312c8c29f9b104a2fe3ead980bb2d',
  // Registered on the staging kernel, unknown to the bank (./staging-2026-09-27/known-tokens.json).
  TWUSDC: 'e934b965a454ed6857080e9956ea83fb5542e0a860e96ce91daf35f5d7b02c9f',
  NIGHT: '0000000000000000000000000000000000000000000000000000000000000000',
} as const;

export type WireLeg = { token: string; amount: string; type: 'SHIELDED' | 'UNSHIELDED' };
export type WireOffer = {
  version: 1;
  offerId: string;
  blobChars: number;
  blockHeight: string;
  computed: {
    gives: WireLeg[];
    wants: WireLeg[];
    expiresAt: string;
    inputNullifiers: string[];
    firstSeenAt: string;
    status: 'live';
  };
};

const hex64 = (n: number, tag: string) =>
  (tag + n.toString(16))
    .padStart(64, '0')
    .slice(-64)
    .replace(/[^0-9a-f]/g, '0');

export const leg = (token: string, amount: bigint | number, type: WireLeg['type'] = 'SHIELDED'): WireLeg => ({
  token,
  amount: String(amount),
  type,
});

/** One live row as `GET /v1/offers` serves it. `n` makes the id, height and nullifier unique. */
export function offerRow(n: number, gives: WireLeg[], wants: WireLeg[]): WireOffer {
  return {
    version: 1,
    offerId: hex64(n, 'a0'),
    blobChars: 24_000 + n,
    blockHeight: String(900_000 + n),
    computed: {
      gives,
      wants,
      expiresAt: '2026-10-11T12:00:00.000Z',
      inputNullifiers: [hex64(n, 'bb')],
      firstSeenAt: `2026-09-27T12:${String(n % 60).padStart(2, '0')}:00.000Z`,
      status: 'live',
    },
  };
}

/** The scenario book. Highest `n` first, as the kernel orders newest first. */
export const BOOK: WireOffer[] = [
  // wStkA, both sides (spec US3's independent test: ask 1.05, bid 0.95).
  offerRow(1, [leg(COLOUR.wStkA, 10_000_000)], [leg(COLOUR.wUSDC, 10_500_000)]), // ask 10 @ 1.05
  offerRow(2, [leg(COLOUR.wUSDC, 9_500_000)], [leg(COLOUR.wStkA, 10_000_000)]), // bid 10 @ 0.95
  offerRow(3, [leg(COLOUR.wStkA, 20_000_000)], [leg(COLOUR.wUSDC, 22_000_000)]), // ask 20 @ 1.10
  offerRow(4, [leg(COLOUR.wUSDC, 4_500_000)], [leg(COLOUR.wStkA, 5_000_000)]), // bid 5 @ 0.90
  // wStkC, asks only, at cent prices (Offer Files 00057's ladders: about 100 stocks per USDC).
  offerRow(5, [leg(COLOUR.wStkC, 100_000_000)], [leg(COLOUR.wUSDC, 1_040_000)]), // ask 100 @ 0.0104
  offerRow(6, [leg(COLOUR.wStkC, 100_000_000)], [leg(COLOUR.wUSDC, 1_200_000)]), // ask 100 @ 0.012
  // Ignored: every one of these involves wStkB, which therefore has no liquidity.
  offerRow(7, [leg(COLOUR.wStkA, 5_000_000)], [leg(COLOUR.wStkB, 5_000_000)]), // stock-to-stock
  offerRow(8, [leg(COLOUR.wStkB, 1_000_000), leg(COLOUR.wStkC, 1_000_000)], [leg(COLOUR.wUSDC, 2_000_000)]), // basket
  offerRow(9, [leg(COLOUR.wStkB, 1_000_000)], [leg(COLOUR.wUSDC, 1_000_000, 'UNSHIELDED')]), // unshielded leg
  offerRow(10, [leg(COLOUR.wStkB, 1_000_000)], [leg(COLOUR.TWUSDC, 1_000_000)]), // unknown colour
  offerRow(11, [leg(COLOUR.NIGHT, 1_000_000, 'UNSHIELDED')], [leg(COLOUR.wUSDC, 1_000_000)]), // NIGHT, unshielded
].reverse();

/** What a person computes by hand from BOOK (spec SC-002): whole USDC per whole stock. */
export const EXPECTED = {
  wStkA: { bestBid: '0.95', bestAsk: '1.05', bids: 2, asks: 2, last: '1.02' },
  wStkB: { bestBid: null, bestAsk: null, bids: 0, asks: 0, last: '0.0098' }, // no liquidity, one old fill
  wStkC: { bestBid: null, bestAsk: '0.0104', bids: 0, asks: 2, last: null },
} as const;

/** `GET /v1/pairs` for BOOK plus some fills, oriented by colour hex (LEAST = base):
 *  - wStkA (5eb2…) < wUSDC (e5af…): base wStkA, last_price = USDC ÷ wStkA raw = 1.02;
 *  - wUSDC (e5af…) < wStkB (e7ca…): base wUSDC, last_price = wStkB ÷ USDC raw: a fill of
 *    100 wStkB for 0.98 USDC is 100000000 ÷ 980000, which Postgres cuts at 20 decimals;
 *  - wStkC (db8a…) < wUSDC: base wStkC, never filled (only open offers). */
export const PAIRS = [
  {
    pair_key: `${COLOUR.wStkA}|${COLOUR.wUSDC}`,
    base_color: COLOUR.wStkA,
    quote_color: COLOUR.wUSDC,
    trade_count: 3,
    last_price: '1.02000000000000000000',
    last_traded_at: '2026-09-27T11:00:00.000Z',
    open_count: 4,
  },
  {
    pair_key: `${COLOUR.wStkC}|${COLOUR.wUSDC}`,
    base_color: COLOUR.wStkC,
    quote_color: COLOUR.wUSDC,
    trade_count: 0,
    last_price: null,
    last_traded_at: null,
    open_count: 2,
  },
  {
    pair_key: `${COLOUR.wUSDC}|${COLOUR.wStkB}`,
    base_color: COLOUR.wUSDC,
    quote_color: COLOUR.wStkB,
    trade_count: 1,
    last_price: '102.04081632653061224490',
    last_traded_at: '2026-09-27T10:00:00.000Z',
    open_count: 0,
  },
];

/** `GET /v1/chart/stats?base=<stock>&quote=<wUSDC>` per stock (JSON numbers, as trade-data.ts
 *  returns them). wStkC never filled, so the kernel reports the open-book MID (here the best ask
 *  0.0104, the only side) as `last` with zero volume: that is NOT a trade. */
export const STATS: Record<'wStkA' | 'wStkB' | 'wStkC', object> = {
  wStkA: {
    base: COLOUR.wStkA,
    quote: COLOUR.wUSDC,
    last: 1.02,
    change24: 2,
    high: 1.02,
    low: 1,
    volume_base: 30000000,
    volume_quote: 30300000,
  },
  wStkB: {
    base: COLOUR.wStkB,
    quote: COLOUR.wUSDC,
    last: 0.0098,
    change24: 0,
    high: 0.0098,
    low: 0.0098,
    volume_base: 0,
    volume_quote: 0,
  },
  wStkC: {
    base: COLOUR.wStkC,
    quote: COLOUR.wUSDC,
    last: 0.0104,
    change24: 0,
    high: 0.0104,
    low: 0.0104,
    volume_base: 0,
    volume_quote: 0,
  },
};

/** The kernel's filter semantics for `GET /v1/offers?token=&direction=` (getOpenOffersPage):
 *  an offer matches when it has a leg of `token` on the given side (either side for ANY). */
export function matchesFilter(o: WireOffer, token?: string, direction?: string): boolean {
  if (!token) return true;
  const inGives = o.computed.gives.some((l) => l.token === token);
  const inWants = o.computed.wants.some((l) => l.token === token);
  if (direction === 'GIVING') return inGives;
  if (direction === 'WANTING') return inWants;
  return inGives || inWants;
}
