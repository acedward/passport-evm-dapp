import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TokenRegistryError, registryFor, registryFromConfig, stagenetRegistry } from '../src/tokens/registry.js';

const deployments = (name: string) => fileURLToPath(new URL(`../src/tokens/deployments/${name}`, import.meta.url));
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('vendored deployment records', () => {
  it('are byte-identical to acedward/passport @ 2178b57 (PROVENANCE.md)', () => {
    expect(sha256(deployments('stagenet-vault.json'))).toBe(
      'a32253517be6dfd45a7c12fca2c12622514eed9834d60c49898b92c8ba653e3f',
    );
    expect(sha256(deployments('sepolia-stk.json'))).toBe(
      '0c9718001ad5e58ef7fb46de740ba1c9cd452d5257a465c6a4ada99918e7bee7',
    );
  });
});

describe('the stagenet registry', () => {
  const r = stagenetRegistry();

  it('maps USDC to the usdc role and stkA/B/C to stocks', () => {
    expect(r.usdc().symbol).toBe('USDC');
    expect(r.usdc().midnightName).toBe('wUSDC');
    expect(r.stocks().map((t) => t.midnightName)).toEqual(['wStkA', 'wStkB', 'wStkC']);
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
      expect(t.source?.commit).toBe('2178b57a5b9ad7d106aa188d80309b7101697824');
    }
  });

  it('keeps USDC provisional until the canonical list, and the stocks confirmed', () => {
    expect(r.usdc().provisional).toBe(true);
    expect(r.stocks().every((t) => !t.provisional)).toBe(true);
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
