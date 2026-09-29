// Plan P1.5: the MN Bank components render the markup their styles and the pages' tests rely on.

import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  AssetCell,
  Badge,
  Button,
  ButtonLink,
  Cell,
  Money,
  NetworkBadge,
  Notice,
  StageTracker,
  StatementTable,
  StatusPill,
  SubtotalRow,
  Tooltip,
  UnitInput,
  formatMoney,
  shortHex,
  tokenDisplayName,
} from '../src/design/index.js';

const html = (el: ReactElement) => renderToStaticMarkup(el);

describe('Money', () => {
  it('formats exact base units with the token decimals, tabular, with the raw value kept', () => {
    expect(formatMoney(1_979_586_200_000n, 6)).toBe('1,979,586.20');
    expect(formatMoney(412_310_000_000_000_000n, 18, { minFractionDigits: 0, maxFractionDigits: 6 })).toBe('0.41231');
    expect(formatMoney(5n, 6)).toBe('0.000005');
    expect(formatMoney(1_000_000n, 6, { grouping: false })).toBe('1.00');
    const out = html(<Money raw={10_500_000n} decimals={6} unit="wUSDC" data-testid="m" />);
    expect(out).toContain('class="num"');
    expect(out).toContain('data-raw="10500000"');
    expect(out).toContain('10.50<span class="money-unit">wUSDC</span>');
  });
});

describe('statement tables', () => {
  it('stack by default, carry each cell label for phone width, and double-rule the subtotal', () => {
    const out = html(
      <StatementTable
        columns={[{ label: 'Asset' }, { label: 'Value', sub: 'USDC', align: 'right' }]}
        foot={
          <SubtotalRow span={1} label="Subtotal" valueLabel="USDC" valueTestId="total">
            1.00
          </SubtotalRow>
        }
      >
        <tr>
          <AssetCell symbol="wStkA" name="Stock A" origin="bridged from Sepolia" />
          <Cell label="Value" align="right" num>
            1.00
          </Cell>
        </tr>
      </StatementTable>,
    );
    expect(out).toMatch(/^<table class="ledger stack">/);
    expect(out).toContain('<th scope="col" class="r">Value<span class="th-sub">USDC</span></th>');
    expect(out).toContain('<td data-label="Value" class="r num">1.00</td>');
    expect(out).toContain('<td class="cell-asset"><span class="sym">wStkA</span><span class="name">Stock A</span>');
    expect(out).toMatch(/<tfoot><tr><td class="cell-block" colspan="1">Subtotal<\/td>/i);
    expect(out).toContain('data-label="USDC" data-testid="total"');
  });

  it('keeps an order book a table at phone width', () => {
    const out = html(<StatementTable variant="book" columns={[{ label: 'Price' }]} />);
    expect(out).toMatch(/^<table class="book">/);
  });
});

describe('badges, buttons, notices', () => {
  it('map tones and variants to the design classes', () => {
    expect(html(<Badge tone="green">Two-sided</Badge>)).toBe('<span class="tag tag-green">Two-sided</span>');
    expect(html(<NetworkBadge network="sepolia" />)).toBe('<span class="net net-sepolia">Sepolia</span>');
    expect(html(<StatusPill status="live">Live</StatusPill>)).toContain('class="status st-live"');
    expect(html(<Button>Open account</Button>)).toBe('<button type="button" class="btn">Open account</button>');
    expect(html(<Button variant="danger">CLEAR ALL</Button>)).toContain('class="btn btn-danger"');
    expect(html(<Button variant="secondary" size="small" type="submit" />)).toContain(
      'type="submit" class="btn btn-secondary btn-small"',
    );
    expect(html(<ButtonLink href="#trade">Take</ButtonLink>)).toBe(
      '<a class="btn btn-secondary" href="#trade">Take</a>',
    );
    expect(
      html(
        <Notice tone="warning" title="One live offer per account.">
          …
        </Notice>,
      ),
    ).toContain(
      'class="notice notice-warn" data-tone="warning"><strong class="notice-title">One live offer per account.</strong>',
    );
  });

  it('announces a unit suffix with its input', () => {
    const out = html(<UnitInput id="amount" unit="stkB" />);
    const id = /<span class="unit" id="([^"]+)">stkB<\/span>/.exec(out)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`aria-describedby="${id}"`);
  });
});

describe('the tooltip on a greyed-out control (AA 00044)', () => {
  const text = 'Not enough wStkA. You hold 100.00 wStkA.';
  const el = (
    <Tooltip id="nt-1" text={text} data-testid="not-enough">
      <Button size="small" variant="secondary" disabled aria-describedby="nt-1">
        Sell
      </Button>
    </Tooltip>
  );

  it('wraps the disabled control in a focusable wrapper, describes it by a visually hidden copy, bubble closed', () => {
    const out = html(el);
    expect(out).toMatch(/^<span data-testid="not-enough" class="tip" tabindex="0">/);
    expect(out).toContain(
      '<button type="button" class="btn btn-secondary btn-small" disabled="" aria-describedby="nt-1">Sell</button>',
    );
    expect(out).toContain(`<span class="sr-only" id="nt-1">${text}</span>`);
    expect(out).toContain(`<span class="tip-bubble" aria-hidden="true" data-testid="tooltip">${text}</span>`);
    expect(out).not.toContain('tip-open');
  });

  it('opens on hover, on focus and on tap; Escape closes it; leaving resets it', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(el));
    const wrap = host.querySelector<HTMLElement>('.tip')!;
    const open = () => wrap.classList.contains('tip-open');
    const fire = (ev: Event, target: EventTarget = wrap) => act(async () => void target.dispatchEvent(ev));
    expect(open()).toBe(false);

    await fire(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    expect(open()).toBe(true);
    await fire(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }), document);
    expect(open()).toBe(false);
    await fire(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    expect(open()).toBe(false);

    await act(async () => wrap.focus());
    expect(document.activeElement).toBe(wrap);
    expect(open()).toBe(true);
    await act(async () => wrap.blur());
    expect(open()).toBe(false);

    await fire(new MouseEvent('click', { bubbles: true }));
    expect(open()).toBe(true);
    await act(async () => root.unmount());
    host.remove();
  });
});

describe('the stage tracker', () => {
  it('marks done, current and pending stages and passes data attributes through', () => {
    const out = html(
      <StageTracker
        label="Deposit"
        stages={[
          { key: 'a', title: 'Tokens sent', state: 'done', data: { testid: 'job-stage', stage: 'sent' } },
          { key: 'b', title: 'Sepolia finality', state: 'current', detail: 'about 12 min' },
          { key: 'c', title: 'Completed', state: 'pending' },
        ]}
      />,
    );
    expect(out).toContain('<ol class="stage-tracker" aria-label="Deposit">');
    expect(out).toContain('<li class="stage done" data-testid="job-stage" data-stage="sent">');
    expect(out).toContain('<li class="stage current" aria-current="step">');
    expect(out).toContain('<span class="sr-only"> (not started)</span>');
  });
});

describe('names', () => {
  it('shortens hex and names tokens in plain words', () => {
    expect(shortHex('0x484738A67858305Edfc139B194Ed430Fe4D8e56b')).toBe('0x4847…e56b');
    expect(shortHex('abc')).toBe('abc');
    expect(tokenDisplayName({ role: 'stock', symbol: 'stkA' })).toBe('Stock A');
    expect(tokenDisplayName({ role: 'usdc', symbol: 'USDC' })).toBe('USD Coin (test)');
    expect(tokenDisplayName({ role: 'stock', symbol: 'TSLA' })).toBe('');
  });
});
