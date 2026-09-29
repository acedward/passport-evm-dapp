# MN Bank web app

A static Vite + React site. Every per-user record lives in the browser's local storage (see
`src/store/`); the relay keeps none. Build it with `bun run build:web` from the repository root.

## The MN Bank design system

`src/design/` holds the bank's look, taken from the owner-approved mockup: an ivory page, a deep
navy primary (`#152C55`), ONE antique-gold accent used sparingly (the masthead rule, the monogram,
the selected row, the current tracker stage, warnings), Libre Caslon Text headings, Source Sans 3
body text, tabular numerals for every amount, hairline-ruled statement tables with double-ruled
subtotals, restrained motion (none under `prefers-reduced-motion`), no gradients and no glass.

| File                        | What it holds                                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokens.css`                | Colour, type, spacing and rule tokens as CSS custom properties. Every text pair is checked for WCAG AA by `test/design-contrast.test.ts`: change a colour there and run the tests. |
| `base.css`                  | Reset, headings, links, focus ring, utilities (`num`, `tabular`, `mono`, `break`, `eyebrow`, `muted`, `small`, `sr-only`, `wrap`), reduced motion.                                |
| `components.css`            | The styles behind the components below.                                                                                                                                             |
| `fonts.ts`                  | The self-hosted fonts (see below).                                                                                                                                                  |
| `index.ts`                  | Every component, imported as `from '../design/index.js'`.                                                                                                                           |

### Fonts: self-hosted, not Google Fonts

The fonts come from the `@fontsource/libre-caslon-text` and `@fontsource/source-sans-3` packages
(SIL Open Font License 1.1; the licence texts ship in `public/licenses/`) and are served from the
site's own origin. Loading them from `fonts.googleapis.com` would hand every visitor's IP address
to Google before they did anything (a German court found that to breach the GDPR, LG München I,
3 O 17493/20, 2022), while the bank promises its servers keep nothing about the customer. It would
also break a strict CSP and the browser tests, which refuse any request that leaves the page's
origin. Only the Latin subset loads, with `font-display: swap`; anything else falls back to
Georgia / the system sans, and `test/e2e/visual.spec.ts` checks that fallback.

### Adopting the design system (every page uses it; follow this for anything new)

Replace plain markup with the components and keep every `data-testid` where it is: the components
pass `data-*`, `id`, `role`, `aria-*` and event props straight through to their element.

**Page frame.** A section is `<section data-testid="section-…">`, then a `PageHead`:

```tsx
<section data-testid="section-trade">
  <PageHead
    eyebrow="Buy and sell at USDC prices"
    title="Trade"
    lede="Every trade is a stock against USDC. Take an existing offer now, or place your own at your price."
  />
  <div className="trade-grid">…</div>
</section>
```

Headings: the masthead's "MN Bank" is the page's `h1`, a page title is an `h2` (`PageHead`), and
a panel title an `h3` (`Panel`).

**Panels.** `Panel` (white box; `title`, `meta` on the right, `tone="quiet"` for the ivory-grey
side box, `as="form"`/`"aside"`/`"div"`), `Card` (a panel with the gold top rule, for the one
card that invites an action). Two panels side by side: `<div className="form-grid">…</div>`.

**Forms.**

```tsx
<Panel as="form" title="New order" onSubmit={submit}>
  <Field label="Side">
    <Segmented label="Side" options={[{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }]}
               value={side} onChange={setSide} />
  </Field>
  <Field label="Quantity" htmlFor="tr-qty" hint="Largest single payment: 11.00 wUSDC">
    <UnitInput id="tr-qty" unit="wStkA" inputMode="decimal" value={qty} onChange={…} data-testid="order-quantity" />
  </Field>
  <Field label="Stock" htmlFor="tr-stock"><Select id="tr-stock" …>…</Select></Field>
  <div className="legs">                         {/* the exact legs, as in the mockup */}
    <div className="leg"><span className="k">You give</span><span className="v num">10.50 wUSDC</span></div>
    <div className="leg"><span className="k">You receive</span><span className="v num">10.00 wStkA</span></div>
    <div className="foot">Paid with your wUSDC coin of 11.00; the change stays in your account.</div>
  </div>
  <ButtonRow stretch>
    <Button type="submit" data-testid="place-order">Place order</Button>
    <Button variant="secondary" onClick={takeBest}>Take best ask</Button>
  </ButtonRow>
</Panel>
```

Also: `TextInput`, `CopyField` (a value to copy whole, e.g. a deposit address), `KeyValueList`
(label / value lines), `Steps` + `Step` (numbered steps the customer drives in order).

**Buttons.** `Button` with `variant` `primary` (default) / `secondary` / `danger` / `link` /
`inverse` (on the navy masthead) and `size="small"` (32 px on a desktop, 44 px on a phone or touch
screen). A link that looks like a button (the Markets book's Take): `ButtonLink href=… size="small"`.

**Money and prices.** `Money` formats exact BigInt base units with the token's decimals, grouped,
in tabular numerals, and keeps the raw value in `data-raw`:

```tsx
<Money raw={10_500_000n} decimals={6} unit="wUSDC" />   // 10.50 wUSDC
```

Prices from the book keep `bidText` / `askText` from `src/market/view.ts` (bids round down, asks
up), wrapped in `<span className="price-bid">` / `price-ask`.

**Tables.** A statement or history table stacks into label / value lines at 640 px and below;
give every non-first cell its column's `label`:

```tsx
<StatementTable caption="My offers" columns={[{ label: 'Placed' }, { label: 'Order' },
  { label: 'Quantity', align: 'right' }, { label: 'Price', sub: 'USDC', align: 'right' },
  { label: 'Status', align: 'right' }]}>
  {offers.map((o) => (
    <tr key={o.id} data-testid="my-offer" data-status={o.status}>
      <Cell block>{placedAt(o)}</Cell>
      <Cell label="Order">{o.side === 'sell' ? 'Sell' : 'Buy'} {o.stock}</Cell>
      <Cell label="Quantity" align="right" num>{o.quantity}</Cell>
      <Cell label="Price" align="right" num>{o.price}</Cell>
      <Cell label="Status" align="right"><StatusPill status="live">Live</StatusPill></Cell>
    </tr>
  ))}
</StatementTable>
```

A value with a second line under it goes in one `<span className="num-wrap">value<Sub>second
line</Sub></span>`, so the phone layout keeps the line under the value. An order book is
`<StatementTable variant="book" …>`: it stays a compact table on a phone, with the Take button in
`<td className="act">`. A line the account cannot pay: the disabled small `Button`, in place,
wrapped in a `Tooltip` that says why on hover, keyboard focus and tap (no extra row):
`<Tooltip id="nt-…" text="Not enough wStkA. You hold 100.00 wStkA."><Button … disabled
aria-describedby="nt-…">Sell</Button></Tooltip>`. The wrapper is the focusable part, and `id` names
the visually hidden copy of the text the button's `aria-describedby` points to; the sentence
comes from `fundWithOneCoin` (`notEnoughText`). The account's own offer: `<YoursBadge />` ("Your
offer"). A holdings row: `AssetCell symbol="wStkA" name="Stock A" origin=…`; a subtotal:
`SubtotalRow` in `foot`.

**Badges and states.** `Badge tone="green|navy|grey|gold|red"` (a market's Two-sided / Bids only /
No liquidity), `StatusPill status="live|filled|cancelled|progress|refunded|failed|done|idle"` (an
offer's or transfer's state, with a dot), `NoValue` for a deliberately absent value ("no
liquidity", "not valued", "no bids"), `NetworkBadge network="sepolia|midnight"`.

**Messages.** `Notice tone="info|warning|danger|success" title="…"`; give it `role="alert"` for an
error the customer caused and `role="status"` for a result. The one-live-offer rule (Q9):

```tsx
<Notice tone="warning" title="One live offer per account.">
  You already have one: Sell 10.00 wStkA at 1.05. Placing an order, taking an offer, starting a
  deposit or withdrawing is a new signed action, and it cancels that offer. We ask you before it happens.
</Notice>
```

A confirmation before a signed action that cancels the live offer: `Dialog` (native `<dialog>`,
Escape closes it) with `actions={<><Button variant="secondary">Keep my offer</Button><Button>…</Button></>}`,
instead of `window.confirm`. A destructive action with a typed phrase: `TypedConfirmDialog` (as
Local data's CLEAR ALL). Nothing to show: `EmptyState title="…"`.

**Progress.** `StageTracker` for a long job (done stages ticked in navy, the current one ringed in
gold), and `Hash` for a transaction hash or id (shortened, with Copy, and a link when `href` is
given). Pass a stage's test attributes through `data`:

```tsx
<StageTracker label="Your take" stages={[
  { key: 'proved', title: 'Proved', state: 'done', time: '14:06',
    detail: <>Midnight tx <Hash value={txHash} /></>, data: { testid: 'trade-stage', stage: 'proved' } },
  { key: 'batcher', title: 'Sent to the exchange', state: 'current' },
  { key: 'settled', title: 'Settled', state: 'pending' },
]} />
```

**Check it.** `test/e2e/visual.spec.ts` screenshots every page at 1280 px and 375 px and asserts
no horizontal page scroll, 44 px buttons on a phone, self-hosted fonts and no gradients; add the
new page there (its fixtures are in `test/e2e/visual-fixtures.ts`). The screenshots land in
`test-results/visual/` (or `$VISUAL_OUT_DIR`).

## When something is not working (error states)

Every way the bank, the exchange, the MPC, the wallet or the browser can stop an action has one
wording, kept in one place and unit-tested (`test/errors.test.ts`; the walkthroughs in the browser
are `test/e2e/errors.spec.ts`):

| File | What it words |
| --- | --- |
| `src/relay/messages.ts` | The relay's refusals (rate limits with their wait, the fee wallet low or starting up, a stale or replayed signature) and failed jobs (the exchange's settlement service at its limit or failing). `RelayError.message` is already the customer's sentence. |
| `src/relay/status.ts` | What `/health` pauses: the bank unreachable, its prover down, its fee wallet low or syncing (the shell); withdrawals when the vault's Sepolia account is low on gas, a slow MPC (Transfers); the settlement service down or refusing (Trade). `BankStatus.tsx` reads `/health` every minute and on tab focus; pages disable what is paused and say why BEFORE the wallet is asked to sign. |
| `src/store/messages.ts` | Local storage blocked, unavailable or full. |
| `src/bridge/messages.ts` | A transfer's stages and outcomes, including a stale request the bank closed (Q21 A) and a never-executed deposit closed with `abandonDeposit`. |

A wallet on another network gets a banner with a Switch button, and every signature and send first
checks the wallet's chain (`ensureChain` in `src/passport/operations.ts`).

