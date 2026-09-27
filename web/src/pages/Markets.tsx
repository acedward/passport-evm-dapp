// The Markets section (spec US3, FR-007/FR-008): each stock against USDC, priced only from the
// live offers on the exchange, and a per-stock order book. Each book line's Take opens the Trade
// section on that offer (plan L-TRD), which shows the exact legs and whether one coin can pay.
// Styled with the MN Bank design system (plan P1.5); every word on the page comes from
// ../market/view.ts.

import { useState } from 'react';

import type { FeedState, Market, TokenRegistry } from '@mnbank/core';

import {
  AssetCell,
  Badge,
  Button,
  ButtonLink,
  Cell,
  NoValue,
  Notice,
  PageHead,
  Panel,
  StatementTable,
  StatusPill,
  Sub,
  shortHex,
  tokenDisplayName,
  type BadgeTone,
  type Column,
} from '../design/index.js';
import { useMarkets } from '../market/MarketContext.js';
import {
  STATUS_TEXT,
  bookLines,
  depthText,
  ignoredText,
  lastTradeText,
  marketRows,
  spreadText,
  type MarketStatus,
} from '../market/view.js';

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19);

const STATUS_TONE: Record<MarketStatus, BadgeTone> = {
  'two-sided': 'green',
  'bids-only': 'navy',
  'asks-only': 'navy',
  'no-liquidity': 'grey',
  unavailable: 'red',
  loading: 'grey',
};

/** A price, or the words for its absence ("no bids", "—") in the quiet italic style. */
const isPrice = (text: string) => /^-?[0-9]/.test(text);

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
    <p className="feed" data-testid="market-feed-status" data-stream={state.stream} data-status={state.status}>
      {stream ? (
        <StatusPill status={state.stream === 'live' ? 'live' : state.stream === 'polling' ? 'progress' : 'idle'}>
          {stream}
        </StatusPill>
      ) : null}
      {updated ? <span>{updated}</span> : null}
    </p>
  );
}

const BOOK_COLUMNS = (stock: string, usdc: string, side: 'asks' | 'bids'): Column[] => [
  { label: 'Price', sub: 'USDC' },
  { label: 'Quantity', sub: stock, align: 'right' },
  { label: side === 'asks' ? 'You pay' : 'You get', sub: usdc, align: 'right' },
  { label: 'Action', srOnly: true, align: 'right' },
];

function BookSide({ market, side }: { market: Market; side: 'asks' | 'bids' }) {
  const stock = market.stock.midnightName;
  const usdc = market.usdc.midnightName;
  const lines = bookLines(market, side);
  const takeHref = (offerId: string) =>
    `#trade?${new URLSearchParams({ stock: market.stock.midnightName, offer: offerId }).toString()}`;
  const headId = `book-${side}-title`;
  return (
    <div>
      <div className="book-side-head">
        <h4 id={headId}>
          {side === 'asks' ? 'Asks' : 'Bids'}{' '}
          <span className="small muted">{side === 'asks' ? '— sellers; you buy' : '— buyers; you sell'}</span>
        </h4>
        <span className="small muted">
          {lines.length} {lines.length === 1 ? 'offer' : 'offers'}
        </span>
        {lines.length > 0 && <span className="depth">{depthText(market, side)}</span>}
      </div>
      <StatementTable
        variant="book"
        columns={BOOK_COLUMNS(stock, usdc, side)}
        aria-labelledby={headId}
        data-testid={side === 'asks' ? 'book-asks' : 'book-bids'}
      >
        {lines.length === 0 ? (
          <tr className="row-empty">
            <td colSpan={4}>
              <NoValue>{side === 'asks' ? 'no asks' : 'no bids'}</NoValue>
            </td>
          </tr>
        ) : (
          lines.map((l) => (
            <tr key={l.offerId} data-testid="book-line" data-offer={l.offerId}>
              <td className="num">
                <span className={side === 'asks' ? 'price-ask' : 'price-bid'} data-testid="line-price">
                  {l.price}
                </span>
              </td>
              <td className="num" data-testid="line-quantity">
                {l.quantity}
              </td>
              <td className="num" data-testid="line-total">
                {l.total}
              </td>
              <td className="act">
                <ButtonLink size="small" href={takeHref(l.offerId)} data-testid="take">
                  Take
                </ButtonLink>
              </td>
            </tr>
          ))
        )}
      </StatementTable>
    </div>
  );
}

function Book({ market, onClose }: { market: Market; onClose(): void }) {
  const stock = market.stock.midnightName;
  const spread = spreadText(market);
  return (
    <Panel
      className="section-gap"
      data-testid="book"
      data-stock={stock}
      title={`${stock} / USDC`}
      meta={
        <>
          <span data-testid="book-summary">
            {[
              spread !== null ? `Spread ${spread}` : null,
              `last trade ${lastTradeText(market.lastTrade)}`,
              'prices in USDC per stock',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <Button variant="link" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {market.status === 'no-liquidity' && (
        <Notice className="panel-intro" data-testid="book-empty">
          No liquidity: nobody is offering to buy or sell {stock} for USDC right now.
        </Notice>
      )}
      <div className="book-grid">
        <BookSide market={market} side="asks" />
        <BookSide market={market} side="bids" />
      </div>
      <Notice className="section-gap">
        <strong>Offers are all or nothing:</strong> you pay and receive the whole amount shown. Taking an offer from the
        book arrives with the Trade section.
      </Notice>
    </Panel>
  );
}

function origin(registry: TokenRegistry, colour: string, symbol: string) {
  const t = registry.byColour(colour);
  return t?.sepoliaAddress ? (
    <>
      bridged from Sepolia{' '}
      <span className="mono" title={`${t.sepoliaAddress} → colour ${colour}`}>
        {shortHex(t.sepoliaAddress)}
      </span>
    </>
  ) : (
    <>
      {symbol} ·{' '}
      <span className="mono" title={colour}>
        {shortHex(colour)}
      </span>
    </>
  );
}

export function Markets() {
  const { state, registry, error } = useMarkets();
  const [selected, setSelected] = useState<string | null>(null);

  const head = (
    <PageHead
      eyebrow="Stocks priced in USDC"
      title="Markets"
      lede="Prices come only from live offers on the exchange. A stock without offers shows “no liquidity”; prices are never estimated."
      actions={<FeedStatus state={state} />}
    />
  );

  if (!registry) {
    return (
      <section data-testid="section-markets">
        {head}
        <Notice tone="danger" role="alert" data-testid="markets-config-error">
          Markets are not configured for this network: {error ?? 'no token list'}.
        </Notice>
      </section>
    );
  }

  const rows = marketRows(state, registry);
  const market =
    state.status === 'ready' ? (state.snapshot.markets.find((m) => m.stock.midnightName === selected) ?? null) : null;
  const ignored = ignoredText(state);

  return (
    <section data-testid="section-markets">
      {head}
      {state.status === 'unavailable' && (
        <Notice tone="danger" role="alert" className="panel-intro" data-testid="exchange-unavailable">
          Exchange unavailable: {state.reason}. Prices are not shown until it answers again; your holdings are not
          affected.
        </Notice>
      )}
      {state.status === 'ready' && !state.complete && (
        <Notice tone="warning" className="panel-intro" data-testid="book-incomplete">
          The exchange has more offers than this page reads; the best prices may be missing some of them.
        </Notice>
      )}
      <Panel>
        <StatementTable
          data-testid="markets-table"
          caption="Stocks against USDC"
          columns={[
            { label: 'Stock' },
            { label: 'Best bid', sub: 'USDC', align: 'right' },
            { label: 'Best ask', sub: 'USDC', align: 'right' },
            { label: 'Last trade', sub: 'USDC', align: 'right' },
            { label: 'Offers', sub: 'bids / asks', align: 'right' },
            { label: 'Status', align: 'right' },
          ]}
        >
          {rows.map((r) => {
            const token = registry.byColour(r.colour);
            return (
              <tr
                key={r.colour}
                data-testid="market-row"
                data-stock={r.stock}
                aria-selected={selected === r.stock}
                className={selected === r.stock ? 'row-selected' : undefined}
              >
                <AssetCell
                  symbol={
                    <Button
                      variant="link"
                      className="sym"
                      data-testid="open-book"
                      aria-expanded={selected === r.stock}
                      disabled={state.status !== 'ready'}
                      onClick={() => setSelected(selected === r.stock ? null : r.stock)}
                    >
                      {r.stock}
                    </Button>
                  }
                  name={token ? tokenDisplayName(token) : undefined}
                  origin={origin(registry, r.colour, r.symbol)}
                />
                <Cell label="Best bid" align="right" num>
                  {isPrice(r.bestBid) ? (
                    <span className="price-bid" data-testid="best-bid">
                      {r.bestBid}
                    </span>
                  ) : (
                    <NoValue data-testid="best-bid">{r.bestBid}</NoValue>
                  )}
                </Cell>
                <Cell label="Best ask" align="right" num>
                  {isPrice(r.bestAsk) ? (
                    <span className="price-ask" data-testid="best-ask">
                      {r.bestAsk}
                    </span>
                  ) : (
                    <NoValue data-testid="best-ask">{r.bestAsk}</NoValue>
                  )}
                </Cell>
                <Cell label="Last trade" align="right" num data-testid="last-trade">
                  <span className="num-wrap">
                    {isPrice(r.lastTrade) ? r.lastTrade : <NoValue>{r.lastTrade}</NoValue>}
                    {r.lastTradeAt && <Sub>{r.lastTradeAt}</Sub>}
                  </span>
                </Cell>
                <Cell label="Offers" align="right" num data-testid="offer-counts">
                  {r.bids} / {r.asks}
                </Cell>
                <Cell label="Status" align="right" data-testid="market-status" data-status={r.status}>
                  <Badge tone={STATUS_TONE[r.status]}>{STATUS_TEXT[r.status]}</Badge>
                </Cell>
              </tr>
            );
          })}
        </StatementTable>
        <p className="table-note">Holdings are valued at the best bid; a stock with no bid is not valued.</p>
        {ignored && (
          <p className="table-note" data-testid="ignored-offers">
            {ignored}
          </p>
        )}
      </Panel>
      {market && <Book market={market} onClose={() => setSelected(null)} />}
    </section>
  );
}
