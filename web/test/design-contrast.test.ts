// @vitest-environment node
// Plan P1.5: every text colour the MN Bank design puts on a background meets WCAG 2.2 AA
// (4.5:1 for text; 3:1 for large text and for the parts of a control, 1.4.11). The pairs are
// read from web/src/design/tokens.css, so a colour change that breaks contrast fails here.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../src/design/tokens.css', import.meta.url)), 'utf8');
const tokens = new Map<string, string>();
for (const m of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)) tokens.set(m[1]!, m[2]!.toLowerCase());

const hex = (name: string): string => {
  const v = tokens.get(name);
  if (!v) throw new Error(`no colour token --${name}`);
  return v;
};

/** WCAG 2.x relative luminance of an sRGB colour. */
function luminance(h: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}

export function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a! + 0.05) / (b! + 0.05);
}

// [foreground, background, minimum ratio, where it is used]
const TEXT = 4.5;
const LARGE_OR_UI = 3;
export const PAIRS: ReadonlyArray<readonly [string, string, number, string]> = [
  ['ink', 'paper', TEXT, 'body text on the page'],
  ['ink', 'surface', TEXT, 'body text in panels and tables'],
  ['ink', 'surface-alt', TEXT, 'text in the pending box and copy fields'],
  ['slate', 'paper', TEXT, 'ledes'],
  ['slate', 'surface', TEXT, 'secondary text, "no liquidity"'],
  ['slate', 'surface-alt', TEXT, 'unit suffixes, grey badges'],
  ['muted', 'paper', TEXT, 'eyebrows and captions on the page'],
  ['muted', 'surface', TEXT, 'table heads, notes, hints'],
  ['muted', 'surface-alt', TEXT, 'notes in the pending box'],
  ['muted', 'gold-soft', TEXT, 'a sub line in the selected market row'],
  ['navy', 'paper', TEXT, 'page titles, links'],
  ['navy', 'surface', TEXT, 'panel titles, secondary buttons, links'],
  ['navy', 'surface-alt', TEXT, 'links in the pending box'],
  ['navy', 'navy-soft', TEXT, 'navy badges, secondary-button hover'],
  ['on-accent', 'navy', TEXT, 'primary buttons'],
  ['on-accent', 'navy-hover', TEXT, 'primary buttons, hovered'],
  ['on-accent', 'danger', TEXT, 'the CLEAR ALL button'],
  ['on-accent', 'danger-hover', TEXT, 'the CLEAR ALL button, hovered'],
  ['navy', 'on-navy', TEXT, 'the masthead Connect button'],
  ['on-navy', 'navy', TEXT, 'the masthead'],
  ['on-navy', 'navy', TEXT, 'a tooltip: why a button is greyed out (AA 00044)'],
  ['on-navy-muted', 'navy', TEXT, 'masthead labels, the tagline'],
  ['on-navy-gold', 'navy', TEXT, 'the "Midnight stagenet" badge'],
  ['on-navy', 'sepolia-bg', TEXT, 'the "Sepolia" badge'],
  ['gold-ink', 'gold-soft', TEXT, '"Your offer", gold badges'],
  ['gold-ink', 'surface', TEXT, '"refunded"'],
  ['warn-ink', 'warn-soft', TEXT, 'warning notices'],
  ['warn-ink', 'surface', TEXT, 'the current stage'],
  ['positive', 'positive-soft', TEXT, 'green badges, success notices'],
  ['positive', 'surface', TEXT, 'bids, "live"'],
  ['positive', 'gold-soft', TEXT, 'a bid in the selected market row'],
  ['danger', 'danger-soft', TEXT, 'danger notices'],
  ['danger', 'surface', TEXT, 'asks, field errors'],
  ['danger', 'gold-soft', TEXT, 'an ask in the selected market row'],
  ['ink', 'danger-soft', TEXT, 'body text in a danger notice'],
  ['ink', 'warn-soft', TEXT, 'body text in a warning notice'],
  ['ink', 'positive-soft', TEXT, 'body text in a success notice'],
  ['disabled-ink', 'disabled-bg', TEXT, 'a disabled button (exempt in WCAG; kept legible anyway)'],
  // Non-text contrast (WCAG 1.4.11): control borders and focus indicators.
  ['field-border', 'surface', LARGE_OR_UI, 'input borders'],
  ['navy', 'paper', LARGE_OR_UI, 'the focus ring'],
  ['on-navy', 'navy', LARGE_OR_UI, 'the focus ring on the masthead'],
  ['navy', 'surface', LARGE_OR_UI, 'the current tab underline, secondary-button borders'],
];

describe('the MN Bank colour tokens (WCAG 2.2 AA)', () => {
  it('parses every token the pairs use', () => {
    for (const [fg, bg] of PAIRS) expect([hex(fg), hex(bg)]).toHaveLength(2);
  });

  it('computes contrast the WCAG way', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  it.each(PAIRS.map(([fg, bg, min, use]) => ({ fg, bg, min, use })))(
    '--$fg on --$bg ≥ $min:1 ($use)',
    ({ fg, bg, min }) => {
      expect(contrast(hex(fg), hex(bg))).toBeGreaterThanOrEqual(min);
    },
  );

  it('uses the gold accent only as a rule or marker, never as small text on a light surface', () => {
    // --gold on white is below 4.5:1 by design; text in gold uses --gold-ink instead.
    expect(contrast(hex('gold'), hex('surface'))).toBeLessThan(TEXT);
    expect(contrast(hex('gold-ink'), hex('surface'))).toBeGreaterThanOrEqual(TEXT);
  });
});
