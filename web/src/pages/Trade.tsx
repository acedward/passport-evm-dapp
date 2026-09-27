// The Trade section (spec US7, US8; plan L-TRD): buy or sell a stock at USDC prices, either by
// making an offer ("Sell N at P" / "Buy N at P", pre-filled from the best ask or bid) or by taking
// one whole offer from the book. Every trade is ONE wallet signature; the exact legs are shown
// before it. The account's offers (My offers) are reconciled from the chain and the exchange.
//
// The seam limits are enforced and explained here (Q9, FR-019): one live offer at a time, each
// payment from one coin (an offer bigger than the largest coin is not takeable, with the reason),
// and a warning before a take cancels a live offer (L-TRD.3). Neutral styling until the MN Bank
// design is approved (Q16).

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import {
  type BookEntry,
  type JobView,
  KernelClient,
  type Market,
  type NetworkProfile,
  type OrderLegs,
  type TokenEntry,
  type TradeSide,
  formatPrice,
  formatUnits,
  fundWithOneCoin,
  orderLegs,
  parsePrice,
  parseUnits,
  takeLegs,
} from '@mnbank/core';

import { useMarkets } from '../market/MarketContext.js';
import { askText, bidText } from '../market/view.js';
import { syncAccount, type OperationEnv } from '../passport/operations.js';
import { findAccount, readCoins, readSecret } from '../passport/records.js';
import { RelayClient } from '../relay/client.js';
import { useStore } from '../store/StoreContext.js';
import { guardFor, makeOffer, reconcileOffers, takeOffer } from '../trade/operations.js';
import { liveOffer, readTrades, type TradeRecord } from '../trade/records.js';
import { useWallet } from '../wallet/WalletContext.js';

const short = (s: string, head = 8, tail = 6) =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
const amt = (raw: bigint, t: TokenEntry) => formatUnits(raw, t.decimals, { minFractionDigits: 2, grouping: true });
const clock = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

const STAGE_TEXT: Record<string, string> = {
  queued: 'Waiting in line',
  running: 'Started',
  proving: 'Preparing the offer’s proof (about a minute)',
  proven: 'Offer proven',
  posted: 'Sent to the exchange',
  listed: 'Listed on the exchange',
  'offer-checked': 'The offer is still there and is exactly the one you chose',
  merged: 'Your side and the offer combined into one transaction',
  settled: 'Settled',
  succeeded: 'Done',
  failed: 'Failed',
};

const STATE_TEXT: Record<TradeRecord['state'], string> = {
  live: 'Live',
  filled: 'Filled',
  expired: 'Expired',
  cancelled: 'Cancelled',
  refused: 'Refused',
};

/** `#trade?stock=wStkA&offer=<id>`: the Markets page's Take buttons link here. */
function hashParams(): URLSearchParams {
  const q = window.location.hash.split('?')[1] ?? '';
  return new URLSearchParams(q);
}

function Tracker({ job }: { job: JobView }) {
  return (
    <div className="tracker" data-testid="trade-tracker" data-state={job.state} data-stage={job.stage}>
      <p>
        <strong>{STAGE_TEXT[job.stage] ?? job.stage}</strong>
        {job.state === 'queued' && job.position !== undefined && <span> — position {job.position} in the queue</span>}
      </p>
      <ol>
        {job.stages.map((s, i) => (
          <li key={`${s.stage}-${i}`} data-testid="trade-stage" data-stage={s.stage}>
            {STAGE_TEXT[s.stage] ?? s.stage}
            {s.detail?.tx && (
              <span className="mono" title={s.detail.tx}>
                {' '}
                tx {short(s.detail.tx)}
              </span>
            )}
            {s.detail?.offerId && (
              <span className="mono" title={s.detail.offerId}>
                {' '}
                offer {short(s.detail.offerId)}
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function LegsPreview({ legs, stock, usdc }: { legs: OrderLegs; stock: TokenEntry; usdc: TokenEntry }) {
  const giveT = legs.side === 'sell' ? stock : usdc;
  const wantT = legs.side === 'sell' ? usdc : stock;
  return (
    <dl className="legs" data-testid="legs">
      <dt>You give</dt>
      <dd data-testid="legs-give" data-raw={legs.give.amount.toString()}>
        {amt(legs.give.amount, giveT)} {giveT.midnightName}
      </dd>
      <dt>You receive</dt>
      <dd data-testid="legs-want" data-raw={legs.want.amount.toString()}>
        {amt(legs.want.amount, wantT)} {wantT.midnightName}
      </dd>
      <dt>Price</dt>
      <dd data-testid="legs-price">
        {formatPrice(legs.effectivePrice, { round: legs.side === 'sell' ? 'up' : 'down' }).text} {usdc.midnightName} per{' '}
        {stock.midnightName}
        {legs.rounded && (
          <small data-testid="legs-rounded"> (rounded to a whole unit of {usdc.midnightName}, in your favour)</small>
        )}
      </dd>
    </dl>
  );
}

export function Trade({ network, relayUrl }: { network: NetworkProfile; relayUrl: string }) {
  const { state, registry } = useMarkets();
  const { store, revision } = useStore();
  const wallet = useWallet();
  const relay = useMemo(() => new RelayClient(relayUrl), [relayUrl]);
  const kernel = useMemo(() => new KernelClient({ baseUrl: network.zswap.kernelUrl }), [network]);
  const params = hashParams();
  const stocks = registry?.stocks() ?? [];
  const usdc = registry?.usdc() ?? null;
  const [stockName, setStockName] = useState<string>(params.get('stock') ?? stocks[0]?.midnightName ?? '');
  const [picked, setPicked] = useState<string | null>(params.get('offer'));
  const [side, setSide] = useState<TradeSide>('sell');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [job, setJob] = useState<JobView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [confirmTake, setConfirmTake] = useState<BookEntry | null>(null);

  const stock = stocks.find((s) => s.midnightName === stockName) ?? stocks[0] ?? null;
  const market: Market | null =
    state.status === 'ready' && stock
      ? (state.snapshot.markets.find((m) => m.stock.midnightColour === stock.midnightColour) ?? null)
      : null;

  const evmAddress = wallet.status === 'connected' ? wallet.address : null;
  const scope = useMemo(() => (evmAddress ? { network: network.name, evmAddress } : null), [evmAddress, network.name]);
  const account = useMemo(
    () => (store && scope ? findAccount(store, scope) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, scope, revision],
  );
  const hasSecret = !!(store && scope && account && readSecret(store, scope, account.address));
  const coins = useMemo(
    () => (store && scope && account ? readCoins(store, scope, account.address) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, scope, account, revision],
  );
  const trades = useMemo(
    () => (store && scope && account ? readTrades(store, scope, account.address) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, scope, account, revision],
  );
  // The clock the page reasons with (an offer's expiry), ticking so a live offer lapses on screen.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const live = liveOffer(trades, now);

  const env = useCallback((): OperationEnv | null => {
    if (!store || !scope || !wallet.provider || !wallet.address) return null;
    return {
      relay,
      store,
      scope,
      provider: wallet.provider,
      owner: wallet.address,
      chainId: network.evm.chainId,
      onJob: setJob,
    };
  }, [store, scope, wallet.provider, wallet.address, relay, network]);

  // Reconcile My offers and the coins when the page opens, and every 30 s while an offer is live.
  const accountAddress = account?.address;
  const reconcile = useCallback(async () => {
    const e = env();
    if (!e || !accountAddress || !hasSecret) return;
    try {
      const changed = await reconcileOffers(e, accountAddress, kernel);
      if (changed.length === 0) await syncAccount(e, accountAddress);
      const filled = changed.find((c) => c.state === 'filled');
      if (filled) setMessage({ kind: 'ok', text: `Your offer (${filled.summary}) was filled.` });
    } catch {
      /* the next refresh tries again; the page keeps the last known state */
    }
  }, [env, accountAddress, hasSecret, kernel]);
  useEffect(() => {
    if (!accountAddress) return;
    const t = setTimeout(() => void reconcile(), 0);
    const every = live ? setInterval(() => void reconcile(), 30_000) : null;
    return () => {
      clearTimeout(t);
      if (every) clearInterval(every);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountAddress, evmAddress, !!live]);

  if (!registry || !stock || !usdc) {
    return (
      <section data-testid="section-trade">
        <h2>Trade</h2>
        <p className="notice error">Trading is not configured for this network.</p>
      </section>
    );
  }
  if (wallet.status !== 'connected' || !scope) {
    return (
      <section data-testid="section-trade">
        <h2>Trade</h2>
        <p>Connect your wallet to trade.</p>
      </section>
    );
  }
  if (!account || !hasSecret) {
    return (
      <section data-testid="section-trade">
        <h2>Trade</h2>
        <p data-testid="trade-no-account">
          Open an account on <a href="#accounts">Accounts</a> (or import your export on <a href="#local">Local data</a>)
          to trade.
        </p>
      </section>
    );
  }

  // Pre-fill the price from the book: a sell joins the best ask (else the best bid), a buy the best bid.
  const prefill = (s: TradeSide) => {
    if (!market) return;
    const bestAsk = market.asks.best?.price;
    const bestBid = market.bids.best?.price;
    const r = s === 'sell' ? (bestAsk ?? bestBid) : (bestBid ?? bestAsk);
    if (r) setPrice(s === 'sell' ? askText(r) : bidText(r));
  };

  // ── Make ──
  let legs: OrderLegs | null = null;
  let legsError: string | null = null;
  if (quantity.trim() !== '' && price.trim() !== '') {
    try {
      legs = orderLegs(side, stock, usdc, parseUnits(quantity, stock.decimals), parsePrice(price, usdc));
    } catch (e) {
      legsError = e instanceof Error ? e.message : 'Enter a quantity and a price.';
    }
  }
  const makeFunding = legs ? fundWithOneCoin(coins, legs.give, legs.side === 'sell' ? stock : usdc) : null;
  const makeGuard = guardFor({ store: store!, scope }, account.address, 'open-swap', now);

  const run = async (label: string, fn: (e: OperationEnv) => Promise<void>) => {
    const e = env();
    if (!e) return;
    setBusy(label);
    setMessage(null);
    setJob(null);
    try {
      await fn(e);
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Something went wrong.' });
    } finally {
      setBusy(null);
    }
  };

  const submitMake = (ev: FormEvent) => {
    ev.preventDefault();
    if (!legs || !makeFunding?.ok || makeGuard.kind === 'refuse') return;
    const l = legs;
    void run('make', async (e) => {
      const rec = await makeOffer(e, account.address, l, { stock, usdc });
      setMessage({ kind: 'ok', text: `Your offer is on the exchange: ${rec.summary} (offer ${short(rec.offerId)}).` });
      setQuantity('');
    });
  };

  // ── Take ──
  const asks = market?.asks.entries ?? [];
  const bids = market?.bids.entries ?? [];
  const takeability = (e: BookEntry) => {
    const l = takeLegs(e, stock, usdc);
    return { legs: l, funding: fundWithOneCoin(coins, l.give, l.side === 'sell' ? stock : usdc) };
  };
  const startTake = (e: BookEntry) => {
    setMessage(null);
    setConfirmTake(e);
  };
  const doTake = (e: BookEntry) =>
    void run('take', async (env2) => {
      setConfirmTake(null);
      const rec = await takeOffer(env2, account.address, e, { stock, usdc });
      setMessage({
        kind: 'ok',
        text: `Done: ${rec.summary}, settled in one transaction (tx ${short(rec.settledTx ?? '')}).`,
      });
      setPicked(null);
    });
  const takeGuard = guardFor({ store: store!, scope }, account.address, 'take', now);

  const pickedEntry = [...asks, ...bids].find((e) => e.offerId === picked) ?? null;
  const pickedGone = picked !== null && state.status === 'ready' && !pickedEntry;

  const bookTable = (entries: BookEntry[], kind: 'asks' | 'bids') => (
    <div className="table-wrap">
      <table data-testid={`trade-book-${kind}`}>
        <caption>
          {kind === 'asks' ? 'Asks — you buy' : 'Bids — you sell'} · {entries.length}{' '}
          {entries.length === 1 ? 'offer' : 'offers'}
        </caption>
        <thead>
          <tr>
            <th className="num">Price</th>
            <th className="num">Quantity ({stock.midnightName})</th>
            <th className="num">
              {kind === 'asks' ? 'You pay' : 'You get'} ({usdc.midnightName})
            </th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 ? (
            <tr>
              <td colSpan={4} className="hint">
                no {kind}
              </td>
            </tr>
          ) : (
            entries.map((e) => {
              const t = takeability(e);
              const own = trades.some((x) => x.role === 'make' && x.offerId === e.offerId);
              return (
                <tr
                  key={e.offerId}
                  data-testid="trade-line"
                  data-offer={e.offerId}
                  aria-selected={picked === e.offerId}
                  className={picked === e.offerId ? 'selected' : undefined}
                >
                  <td className="num">{kind === 'asks' ? askText(e.price) : bidText(e.price)}</td>
                  <td className="num">{amt(e.stockRaw, stock)}</td>
                  <td className="num">{amt(e.usdcRaw, usdc)}</td>
                  <td>
                    {own ? (
                      <span className="hint" data-testid="own-offer">
                        your offer
                      </span>
                    ) : t.funding.ok ? (
                      <button type="button" data-testid="take-line" disabled={!!busy} onClick={() => startTake(e)}>
                        {kind === 'asks' ? 'Buy' : 'Sell'}
                      </button>
                    ) : (
                      <span className="hint" data-testid="not-takeable" title={t.funding.reason}>
                        Not takeable: {t.funding.reason}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );

  const bestAsk = market?.asks.best ?? null;
  const bestBid = market?.bids.best ?? null;

  return (
    <section data-testid="section-trade">
      <h2>Trade</h2>
      <p className="hint">
        Every trade is {usdc.midnightName} against one stock, at a price in {usdc.midnightName}. You sign once per
        trade; the bank pays the network fees.
      </p>
      {message && (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={`notice ${message.kind}`}
          data-testid="trade-message"
        >
          {message.text}
        </p>
      )}
      <label>
        Stock{' '}
        <select
          value={stock.midnightName}
          onChange={(e) => {
            setStockName(e.target.value);
            setPicked(null);
          }}
          data-testid="trade-stock"
        >
          {stocks.map((s) => (
            <option key={s.midnightColour} value={s.midnightName}>
              {s.midnightName} / {usdc.midnightName}
            </option>
          ))}
        </select>
      </label>
      {state.status === 'unavailable' && (
        <p role="alert" className="notice error" data-testid="trade-exchange-unavailable">
          Exchange unavailable: {state.reason}. You cannot trade until it answers again.
        </p>
      )}

      {live && (
        <p className="notice" data-testid="live-offer-banner">
          You have a live offer: {live.summary}, until {clock(live.expiresAt)}. An account can have one live offer at a
          time, and any other signed action (a take, a withdrawal, a bridge move) cancels it.
        </p>
      )}

      <section aria-labelledby="take-title" data-testid="take-section">
        <h3 id="take-title">Take an offer from the book</h3>
        <p className="hint">Offers are all or nothing: you pay and receive exactly the amounts shown, from one coin.</p>
        <p>
          <button
            type="button"
            data-testid="buy-best-ask"
            disabled={!bestAsk || !!busy || !takeability(bestAsk).funding.ok}
            onClick={() => bestAsk && startTake(bestAsk)}
          >
            Buy at best ask{bestAsk ? ` (${askText(bestAsk.price)})` : ''}
          </button>{' '}
          <button
            type="button"
            data-testid="sell-best-bid"
            disabled={!bestBid || !!busy || !takeability(bestBid).funding.ok}
            onClick={() => bestBid && startTake(bestBid)}
          >
            Sell at best bid{bestBid ? ` (${bidText(bestBid.price)})` : ''}
          </button>
        </p>
        {market?.status === 'no-liquidity' && (
          <p className="notice" data-testid="trade-no-liquidity">
            No liquidity: nobody is offering to buy or sell {stock.midnightName} right now. You can make an offer below.
          </p>
        )}
        {pickedGone && (
          <p className="notice" data-testid="picked-gone">
            The offer you picked is no longer on the exchange.
          </p>
        )}
        {pickedEntry && !confirmTake && (
          <p>
            <button type="button" data-testid="take-picked" disabled={!!busy} onClick={() => startTake(pickedEntry)}>
              Review the offer you picked
            </button>
          </p>
        )}
        {confirmTake &&
          (() => {
            const t = takeability(confirmTake);
            return (
              <div className="confirm" data-testid="take-confirm" data-offer={confirmTake.offerId}>
                <h4>{t.legs.side === 'buy' ? 'Buy' : 'Sell'} — the whole offer</h4>
                <LegsPreview legs={t.legs} stock={stock} usdc={usdc} />
                {!t.funding.ok && (
                  <p role="alert" className="notice error" data-testid="take-not-fundable">
                    {t.funding.reason}
                  </p>
                )}
                {takeGuard.kind === 'warn' && (
                  <p role="alert" className="notice" data-testid="take-cancels-offer">
                    {takeGuard.message}
                  </p>
                )}
                <button
                  type="button"
                  data-testid="take-sign"
                  disabled={!!busy || !t.funding.ok}
                  onClick={() => doTake(confirmTake)}
                >
                  {takeGuard.kind === 'warn' ? 'Cancel my offer and sign' : 'Sign and take'}
                </button>{' '}
                <button type="button" className="link" onClick={() => setConfirmTake(null)}>
                  Back
                </button>
              </div>
            );
          })()}
        <div className="book-sides">
          {bookTable(asks, 'asks')}
          {bookTable(bids, 'bids')}
        </div>
      </section>

      <section aria-labelledby="make-title" data-testid="make-section">
        <h3 id="make-title">Make an offer</h3>
        <form onSubmit={submitMake}>
          <fieldset>
            <legend>Side</legend>
            <label>
              <input
                type="radio"
                name="side"
                checked={side === 'sell'}
                onChange={() => {
                  setSide('sell');
                  prefill('sell');
                }}
                data-testid="side-sell"
              />{' '}
              Sell {stock.midnightName}
            </label>{' '}
            <label>
              <input
                type="radio"
                name="side"
                checked={side === 'buy'}
                onChange={() => {
                  setSide('buy');
                  prefill('buy');
                }}
                data-testid="side-buy"
              />{' '}
              Buy {stock.midnightName}
            </label>
          </fieldset>
          <label>
            Quantity ({stock.midnightName}){' '}
            <input
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              inputMode="decimal"
              data-testid="make-quantity"
            />
          </label>{' '}
          <label>
            Price ({usdc.midnightName} per {stock.midnightName}){' '}
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              inputMode="decimal"
              data-testid="make-price"
            />
          </label>{' '}
          <button type="button" className="link" onClick={() => prefill(side)} data-testid="make-prefill">
            Use the best {side === 'sell' ? 'ask' : 'bid'}
          </button>
          {legsError && (
            <p role="alert" className="notice error" data-testid="make-error">
              {legsError}
            </p>
          )}
          {legs && <LegsPreview legs={legs} stock={stock} usdc={usdc} />}
          {legs && makeFunding && !makeFunding.ok && (
            <p role="alert" className="notice error" data-testid="make-not-fundable">
              {makeFunding.reason}
            </p>
          )}
          {makeGuard.kind === 'refuse' && (
            <p role="alert" className="notice" data-testid="make-refused">
              {makeGuard.message}
            </p>
          )}
          <p className="hint">
            Your offer stays on the exchange until someone takes it (all of it) or it expires, about an hour after you
            sign. Signing anything else from this account before then cancels it.
          </p>
          <button
            type="submit"
            data-testid="make-sign"
            disabled={!!busy || !legs || !makeFunding?.ok || makeGuard.kind === 'refuse'}
          >
            Sign and publish offer
          </button>
        </form>
      </section>

      {job && <Tracker job={job} />}

      <section aria-labelledby="my-offers-title" data-testid="my-offers">
        <h3 id="my-offers-title">My offers and trades</h3>
        <button type="button" data-testid="reconcile" disabled={!!busy} onClick={() => void reconcile()}>
          Refresh
        </button>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Trade</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Offer</th>
                <th>Settled by</th>
              </tr>
            </thead>
            <tbody>
              {trades.length === 0 ? (
                <tr>
                  <td colSpan={6} className="hint">
                    No trades yet.
                  </td>
                </tr>
              ) : (
                trades.map((t) => (
                  <tr key={`${t.role}-${t.offerId}`} data-testid="my-trade" data-role={t.role} data-state={t.state}>
                    <td>{new Date(t.createdAt).toISOString().slice(0, 16).replace('T', ' ')}</td>
                    <td>{t.summary}</td>
                    <td>{t.role === 'make' ? 'Your offer' : 'Taken'}</td>
                    <td data-testid="my-trade-state">
                      {STATE_TEXT[t.state]}
                      {t.role === 'make' && t.state === 'live' && <small> until {clock(t.expiresAt)}</small>}
                    </td>
                    <td className="mono" title={t.offerId}>
                      {short(t.offerId)}
                    </td>
                    <td className="mono" title={t.settledTx ?? ''} data-testid="my-trade-tx">
                      {t.settledTx ? short(t.settledTx) : '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
