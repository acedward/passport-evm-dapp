// Plan P1.5: the MN Bank components render the markup their styles and the pages' tests rely on.

import type { ReactElement } from 'react';
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
