// The Markets section (spec US3, FR-007/FR-008): each stock against USDC, priced only from the
// live offers on the exchange, and a per-stock order book. Each book line's Take opens the Trade
// section on that offer (plan L-TRD), which shows the exact legs and whether one coin can pay.
// Neutral styling until the MN Bank design is approved (Q16); the wording follows the mockup.

import { useState } from 'react';

import type { FeedState, Market } from '@mnbank/core';

import { useMarkets } from '../market/MarketContext.js';
import {
  STATUS_TEXT,
  bookLines,
  depthText,
  ignoredText,
  lastTradeText,
  marketRows,
  spreadText,
} from '../market/view.js';

const short = (s: string, head = 6, tail = 4) => `${s.slice(0, head)}…${s.slice(-tail)}`;
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19);

function FeedStatus({ state }: { state: FeedState }) {
  const stream =
    state.stream === 'live'
      ? 'Live'
      : state.stream === 'polling'
        ? 'Updating every 15 s'
        : state.stream === 'connecting'
          ? 'Connecting…'
          : '';
  const updated =
    state.status === 'ready'
      ? `updated ${clock(state.updatedAt)} UTC`
      : state.status === 'unavailable' && state.lastUpdatedAt !== null
        ? `last read ${clock(state.lastUpdatedAt)} UTC`
        : '';
  return (
    <p className="hint" data-testid="market-feed-status" data-stream={state.stream} data-status={state.status}>
      {[stream, updated].filter(Boolean).join(' · ')}
    </p>
  );
}

function Book({ market, onClose }: { market: Market; onClose(): void }) {
  const stock = market.stock.midnightName;
  const usdc = market.usdc.midnightName;
  const spread = spreadText(market);
  const asks = bookLines(market, 'asks');
  const bids = bookLines(market, 'bids');
  const takeHref = (offerId: string) =>
    `#trade?${new URLSearchParams({ stock: market.stock.midnightName, offer: offerId }).toString()}`;
  return (
    <section className="book" data-testid="book" data-stock={stock} aria-labelledby="book-title">
      <div className="book-head">
        <h3 id="book-title">{stock} / USDC</h3>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="hint" data-testid="book-summary">
        {[
          spread !== null ? `Spread ${spread}` : null,
          `last trade ${lastTradeText(market.lastTrade)}`,
          'prices in USDC per stock',
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {market.status === 'no-liquidity' && (
        <p className="notice" data-testid="book-empty">
          No liquidity: nobody is offering to buy or sell {stock} for USDC right now.
        </p>
      )}
      <div className="book-sides">
        <div className="table-wrap">
          <table data-testid="book-asks">
            <caption>
              Asks — sellers; you buy · {asks.length} {asks.length === 1 ? 'offer' : 'offers'}
              {asks.length > 0 && <span className="hint"> · {depthText(market, 'asks')}</span>}
            </caption>
            <thead>
              <tr>
                <th className="num">Price</th>
                <th className="num">Quantity ({stock})</th>
                <th className="num">You pay ({usdc})</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {asks.length === 0 ? (
                <tr>
                  <td colSpan={4} className="hint">
                    no asks
                  </td>
                </tr>
              ) : (
                asks.map((l) => (
                  <tr key={l.offerId} data-testid="book-line" data-offer={l.offerId}>
                    <td className="num" data-testid="line-price">
                      {l.price}
                    </td>
                    <td className="num" data-testid="line-quantity">
                      {l.quantity}
                    </td>
                    <td className="num" data-testid="line-total">
                      {l.total}
                    </td>
                    <td>
                      <a href={takeHref(l.offerId)} className="button" data-testid="take">
                        Take
                      </a>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="table-wrap">
          <table data-testid="book-bids">
            <caption>
              Bids — buyers; you sell · {bids.length} {bids.length === 1 ? 'offer' : 'offers'}
              {bids.length > 0 && <span className="hint"> · {depthText(market, 'bids')}</span>}
            </caption>
            <thead>
              <tr>
                <th className="num">Price</th>
                <th className="num">Quantity ({stock})</th>
                <th className="num">You get ({usdc})</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {bids.length === 0 ? (
                <tr>
                  <td colSpan={4} className="hint">
                    no bids
                  </td>
                </tr>
              ) : (
                bids.map((l) => (
                  <tr key={l.offerId} data-testid="book-line" data-offer={l.offerId}>
                    <td className="num" data-testid="line-price">
                      {l.price}
                    </td>
                    <td className="num" data-testid="line-quantity">
                      {l.quantity}
                    </td>
                    <td className="num" data-testid="line-total">
                      {l.total}
                    </td>
                    <td>
                      <a href={takeHref(l.offerId)} className="button" data-testid="take">
                        Take
                      </a>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      <p className="hint">Offers are all or nothing: you pay and receive the whole amount shown.</p>
    </section>
  );
}

export function Markets() {
  const { state, registry, error } = useMarkets();
  const [selected, setSelected] = useState<string | null>(null);

  if (!registry) {
    return (
      <section data-testid="section-markets">
        <h2>Markets</h2>
        <p role="alert" className="notice error" data-testid="markets-config-error">
          Markets are not configured for this network: {error ?? 'no token list'}.
        </p>
      </section>
    );
  }

  const rows = marketRows(state, registry);
  const market =
    state.status === 'ready' ? (state.snapshot.markets.find((m) => m.stock.midnightName === selected) ?? null) : null;
  const ignored = ignoredText(state);

  return (
    <section data-testid="section-markets">
      <h2>Markets</h2>
      <p className="hint">
        Stocks priced in USDC. Prices come only from live offers on the exchange. A stock without offers shows “no
        liquidity”; prices are never estimated.
      </p>
      <FeedStatus state={state} />
      {state.status === 'unavailable' && (
        <p role="alert" className="notice error" data-testid="exchange-unavailable">
          Exchange unavailable: {state.reason}. Prices are not shown until it answers again; your holdings are not
          affected.
        </p>
      )}
      {state.status === 'ready' && !state.complete && (
        <p className="notice" data-testid="book-incomplete">
          The exchange has more offers than this page reads; the best prices may be missing some of them.
        </p>
      )}
      <div className="table-wrap">
        <table data-testid="markets-table">
          <thead>
            <tr>
              <th>Stock</th>
              <th className="num">Best bid (USDC)</th>
              <th className="num">Best ask (USDC)</th>
              <th className="num">Last trade (USDC)</th>
              <th className="num">Offers (bids / asks)</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.colour}
                data-testid="market-row"
                data-stock={r.stock}
                aria-selected={selected === r.stock}
                className={selected === r.stock ? 'selected' : undefined}
              >
                <td>
                  <button
                    type="button"
                    className="link"
                    data-testid="open-book"
                    disabled={state.status !== 'ready'}
                    onClick={() => setSelected(selected === r.stock ? null : r.stock)}
                  >
                    {r.stock}
                  </button>
                  <br />
                  <span className="hint" title={r.colour}>
                    {r.symbol} · {short(r.colour)}
                  </span>
                </td>
                <td className="num" data-testid="best-bid">
                  {r.bestBid}
                </td>
                <td className="num" data-testid="best-ask">
                  {r.bestAsk}
                </td>
                <td className="num" data-testid="last-trade">
                  {r.lastTrade}
                  {r.lastTradeAt && (
                    <>
                      <br />
                      <span className="hint">{r.lastTradeAt}</span>
                    </>
                  )}
                </td>
                <td className="num" data-testid="offer-counts">
                  {r.bids} / {r.asks}
                </td>
                <td data-testid="market-status" data-status={r.status}>
                  {STATUS_TEXT[r.status]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">Holdings are valued at the best bid; a stock with no bid is not valued.</p>
      {ignored && (
        <p className="hint" data-testid="ignored-offers">
          {ignored}
        </p>
      )}
      {market && <Book market={market} onClose={() => setSelected(null)} />}
    </section>
  );
}
