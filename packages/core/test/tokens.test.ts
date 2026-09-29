import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TokenRegistryError, registryFor, registryFromConfig, stagenetRegistry } from '../src/tokens/registry.js';

const deployments = (name: string) => fileURLToPath(new URL(`../src/tokens/deployments/${name}`, import.meta.url));
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('vendored deployment records', () => {
  it('are byte-identical to acedward/passport @ 6c7505a / 07d8ea4 (PROVENANCE.md)', () => {
    expect(sha256(deployments('stagenet-vault.json'))).toBe(
      '8897b1eeb72bff8a5dd7038aca9556cc9308246352ef7e0a277a2f5024453a67',
    );
    expect(sha256(deployments('sepolia-stk.json'))).toBe(
      '0c9718001ad5e58ef7fb46de740ba1c9cd452d5257a465c6a4ada99918e7bee7',
    );
  });
});

describe('the stagenet registry', () => {
  const r = stagenetRegistry();

  it('maps USDC to the usdc role and every other bridged token to a stock, in the file order', () => {
    expect(r.usdc().symbol).toBe('USDC');
    expect(r.usdc().midnightName).toBe('wUSDC');
    expect(r.tokens).toHaveLength(8);
    expect(r.stocks().map((t) => t.midnightName)).toEqual([
      'wStkA',
      'wStkB',
      'wStkC',
      'TBILL',
      'TB13W',
      'TB26W',
      'TB52W',
    ]);
    expect(r.tokens.map((t) => t.symbol)).toEqual(['stkA', 'stkB', 'stkC', 'USDC', 'TBILL', 'TB13W', 'TB26W', 'TB52W']);
  });

  it('carries the pinned addresses, colours and decimals (plan Pins table)', () => {
    const a = r.byMidnightName('wStkA');
    expect(a?.sepoliaAddress).toBe('0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52');
    expect(a?.midnightColour).toBe('5eb2a3cebb2ebe7ba910c78f62c9e28e0d74acbd00c810730def3578860e6a02');
    expect(r.byMidnightName('wStkB')?.midnightColour).toBe(
      'e7ca18cb056477a5aca5cce387306d56526c2f226b4a4e34f068e3a3e8179588',
    );
    expect(r.byMidnightName('wStkC')?.midnightColour).toBe(
      'db8ae472c587a0709094eeaf98b81a0d46752db1a807e77bd209814e808f19d9',
    );
    const usdc = r.usdc();
    expect(usdc.sepoliaAddress).toBe('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');
    expect(usdc.midnightColour).toBe('e5afe273bcb1252cfbc81ad6ca1caaafe22312c8c29f9b104a2fe3ead980bb2d');
    for (const t of r.tokens) {
      expect(t.decimals).toBe(6);
      expect(t.vault).toBe('7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637');
      expect(t.source?.commit).toBe('6c7505a4d2ec223fce5eb10266c331576805465a');
    }
  });

  // PR #4's "TBILL for MN Bank" and "Test T-Bill series for MN Bank" sections (@ 6c7505a).
  it.each([
    [
      'TBILL',
      '0x1531b11722CF9b600816ED0eAcBc49594DbB991f',
      '05b32284398b1a75dac4f92dcb8802a57ce2194dd3cae781f870430c18a8a8e9',
    ],
    [
      'TB13W',
      '0x5cF366decA552c30eBB2504d0b9Ee104A99f1c72',
      'b3d96e9933fb4548ce8a17a63f4c92bb3894b3571873c3edcc8a08aa7ce2512b',
    ],
    [
      'TB26W',
      '0x26dB7221903e62310409e454442adBb46E0B6E33',
      '7b044b55c0493a67eeb16f25d3757eea07f9abaf55e374739953afd449bc3b62',
    ],
    [
      'TB52W',
      '0x02A0D1BaF66351715A84aC4763b82f1155BdD5b0',
      '8f4798a5ee48747f37562da76ed8711ad4b4ea1ad7ac16d80eb74b92792b9ec2',
    ],
  ])('carries %s as PR #4 lists it: no "w", a stock, its address and colour', (symbol, address, colour) => {
    const t = r.byMidnightName(symbol);
    expect(t?.symbol).toBe(symbol);
    expect(t?.role).toBe('stock');
    expect(t?.sepoliaAddress).toBe(address);
    expect(t?.midnightColour).toBe(colour);
    expect(r.bySepoliaAddress(address)).toBe(t);
    expect(r.byColour(colour)).toBe(t);
    expect(r.isTradablePair(r.usdc().midnightColour, colour)).toBe(true);
  });

  it('marks every entry confirmed: PR #4 lists them as canonical, USDC included', () => {
    expect(r.usdc().provisional).toBe(false);
    expect(r.tokens.every((t) => !t.provisional)).toBe(true);
  });

  it('looks tokens up by colour and address in any case', () => {
    expect(r.byColour('0x5EB2A3CEBB2EBE7BA910C78F62C9E28E0D74ACBD00C810730DEF3578860E6A02')?.midnightName).toBe(
      'wStkA',
    );
    expect(r.byColour('not hex')).toBeUndefined();
    expect(r.bySepoliaAddress('0x2ab7be0769e3bbd5c7d047b422cb383fcc06fb52')?.symbol).toBe('stkA');
  });

  it('only USDC against one stock is a tradable pair (FR-008)', () => {
    const usdc = r.usdc().midnightColour;
    const [a, b] = r.stocks();
    expect(r.isTradablePair(usdc, a!.midnightColour)).toBe(true);
    expect(r.isTradablePair(a!.midnightColour, usdc)).toBe(true);
    expect(r.isTradablePair(a!.midnightColour, b!.midnightColour)).toBe(false);
    expect(r.isTradablePair(usdc, usdc)).toBe(false);
    expect(r.isTradablePair(usdc, '11'.repeat(32))).toBe(false);
  });
});

describe('registries from configuration (the local stack)', () => {
  const local = {
    tokens: [
      { symbol: 'tUSDC', midnightName: 'shielded-a', role: 'usdc', decimals: 6, midnightColour: 'aa'.repeat(32) },
      {
        symbol: 'tSTK',
        midnightName: 'shielded-b',
        role: 'stock',
        decimals: 6,
        midnightColour: `0x${'BB'.repeat(32)}`,
      },
    ],
  };

  it('maps local colours to the roles', () => {
    const r = registryFromConfig('undeployed', local);
    expect(r.usdc().midnightName).toBe('shielded-a');
    expect(r.stocks()[0]?.midnightColour).toBe('bb'.repeat(32));
    expect(r.usdc().sepoliaAddress).toBe('');
    expect(r.usdc().source).toBeNull();
  });

  it('the local network has no built-in list', () => {
    expect(() => registryFor('undeployed')).toThrow(TokenRegistryError);
    expect(registryFor('undeployed', local).network).toBe('undeployed');
    expect(registryFor('stagenet').usdc().symbol).toBe('USDC');
  });

  it('refuses a registry without exactly one usdc, duplicates, or bad values', () => {
    const [u, s] = local.tokens as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(() =>
      registryFromConfig('undeployed', { tokens: [s, { ...s, midnightName: 'x', midnightColour: 'cc'.repeat(32) }] }),
    ).toThrow(/exactly one usdc/);
    expect(() =>
      registryFromConfig('undeployed', {
        tokens: [u, { ...u, role: 'usdc', midnightName: 'y', midnightColour: 'dd'.repeat(32) }, s],
      }),
    ).toThrow(/exactly one usdc/);
    expect(() => registryFromConfig('undeployed', { tokens: [u, { ...s, midnightColour: 'aa'.repeat(32) }] })).toThrow(
      /duplicate colour/,
    );
    expect(() => registryFromConfig('undeployed', { tokens: [u, { ...s, decimals: 19 }] })).toThrow(TokenRegistryError);
    expect(() => registryFromConfig('undeployed', { tokens: [u, { ...s, midnightColour: 'zz' }] })).toThrow(
      TokenRegistryError,
    );
  });
});
