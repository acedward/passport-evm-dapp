import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { afterEach, describe, expect, it } from 'vitest';

import { parseSponsorSeed } from '../src/config.js';
import { unshieldedAddress, units, writeNewMnemonic } from '../src/tools/sponsor-wallet.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('sponsor-wallet tool', () => {
  it('formats base units as whole units', () => {
    expect(units(0n, 6)).toBe('0');
    expect(units(1_500_000n, 6)).toBe('1.5');
    expect(units(59_910_000_000_000_000n, 15)).toBe('59.91');
    expect(units(10n ** 15n, 15)).toBe('1');
  });

  it('writes a new 24-word mnemonic with mode 600, which the relay accepts, and never overwrites', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sponsor-'));
    dirs.push(dir);
    const file = join(dir, 'sponsor.seed');
    const words = writeNewMnemonic(file);
    expect(words.split(' ')).toHaveLength(24);
    expect(validateMnemonic(words, wordlist)).toBe(true);
    expect(readFileSync(file, 'utf8').trim()).toBe(words);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(parseSponsorSeed(readFileSync(file, 'utf8'))).toMatch(/^[0-9a-f]{128}$/);
    expect(() => writeNewMnemonic(file)).toThrow(/already exists/);
    expect(readFileSync(file, 'utf8').trim()).toBe(words);
  });

  it('derives the same public NIGHT address from the same seed, per network', async () => {
    const seed = 'ab'.repeat(32);
    const a = await unshieldedAddress(seed, 'stagenet');
    expect(a).toMatch(/^mn_addr_stagenet1[0-9a-z]+$/);
    expect(await unshieldedAddress(seed, 'stagenet')).toBe(a);
    expect(await unshieldedAddress('cd'.repeat(32), 'stagenet')).not.toBe(a);
    expect(await unshieldedAddress(seed, 'undeployed')).toMatch(/^mn_addr_undeployed1/);
  });
});
