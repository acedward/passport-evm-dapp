// Hex helpers shared by the browser and the relay. Lowercase, no 0x unless asked.

export class HexError extends Error {
  override name = 'HexError';
}

export function isHex(value: string, bytes?: number): boolean {
  const s = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) return false;
  return bytes === undefined || s.length === bytes * 2;
}

export function hexToBytes(value: string, bytes?: number): Uint8Array {
  if (!isHex(value, bytes)) {
    throw new HexError(bytes === undefined ? 'not a hex string' : `expected ${bytes} bytes of hex`);
  }
  const s = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array, prefix = false): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return prefix ? `0x${s}` : s;
}

/** Normalise a 32-byte hex value (colour, contract address) to 64 lowercase hex chars. */
export function normaliseHex32(value: string): string {
  return bytesToHex(hexToBytes(value, 32));
}

export const ZERO32_HEX = '0'.repeat(64);
