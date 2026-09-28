import { describe, expect, it } from 'vitest';

import { HexError, bytesToHex, hexToBytes, isHex, normaliseHex32 } from '../src/hex.js';

describe('hex helpers', () => {
  it('round-trips bytes', () => {
    const b = Uint8Array.from([0, 1, 0xab, 0xff]);
    expect(bytesToHex(b)).toBe('0001abff');
    expect(bytesToHex(b, true)).toBe('0x0001abff');
    expect(hexToBytes('0x0001ABff')).toEqual(b);
  });

  it('checks lengths and characters', () => {
    expect(isHex('abcd', 2)).toBe(true);
    expect(isHex('abcd', 3)).toBe(false);
    expect(isHex('abc')).toBe(false);
    expect(isHex('zz')).toBe(false);
    expect(() => hexToBytes('zz')).toThrow(HexError);
    expect(() => hexToBytes('00', 32)).toThrow(/32 bytes/);
  });

  it('normalises 32-byte values to lowercase without 0x', () => {
    expect(normaliseHex32(`0x${'AB'.repeat(32)}`)).toBe('ab'.repeat(32));
  });
});
