// The L-BRG live runs' test EOA (plan 00039 L-BRG testing): a throwaway Sepolia key generated in
// this process and written, before anything uses it, to KEY_FILE with mode 600 (exclusive create).
// Prints only the address. Run it again to print the address of the key already there.
//
//   KEY_FILE=/state/l-brg-test-eoa.key bun test/stack/new-test-eoa.ts

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import { Wallet } from 'ethers';

const file = process.env.KEY_FILE;
if (!file) throw new Error('set KEY_FILE');
if (!existsSync(file)) {
  const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
  let key: Buffer;
  do key = randomBytes(32);
  while (BigInt(`0x${key.toString('hex')}`) === 0n || BigInt(`0x${key.toString('hex')}`) >= N);
  writeFileSync(file, `0x${key.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600);
  key.fill(0);
}
if ((statSync(file).mode & 0o777) !== 0o600) throw new Error('the key file is not mode 600');
const m = /^(0x[0-9a-fA-F]{64})\s*$/.exec(readFileSync(file, 'utf8'));
if (!m) throw new Error('the key file does not hold a 32-byte hex key');
console.log(JSON.stringify({ address: new Wallet(m[1]!).address }));
