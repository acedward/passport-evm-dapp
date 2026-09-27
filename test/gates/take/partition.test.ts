import { describe, expect, it } from 'vitest';

import {
  INITIAL_MIN_TIME_TO_DISMISS_PS,
  PartitionSteeringError,
  STEERING_MIN_TIME_TO_DISMISS_PS,
  minTimeToDismissFromText,
  patchU64Once,
  scaleEncodeU64,
  steeringParameters,
  withPartitionParameters,
} from './partition.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('SCALE-compact u64 (midnight-ledger ScaleBigInt)', () => {
  it.each([
    [0n, '00'],
    [1n, '04'],
    [63n, 'fc'],
    [64n, '0101'],
    [16_383n, 'fdff'],
    [16_384n, '02000100'],
    [1_073_741_823n, 'feffffff'],
    [1_073_741_824n, '0300000040'],
    // The ledger's initial min_time_to_dismiss, as it appears in LedgerParameters.serialize()
    // (measured: offset 552 of the 774-byte initial parameters, exactly once).
    [15_000_000_000n, '0700d6117e03'],
    [STEERING_MIN_TIME_TO_DISMISS_PS, '07ffffffffff'],
    [0xffff_ffff_ffff_ffffn, '13ffffffffffffffff'],
  ])('%s → %s', (v, want) => {
    expect(hex(scaleEncodeU64(v))).toBe(want);
  });

  it('refuses values outside u64', () => {
    expect(() => scaleEncodeU64(-1n)).toThrow(PartitionSteeringError);
    expect(() => scaleEncodeU64(1n << 64n)).toThrow(PartitionSteeringError);
  });
});

describe('patching the parameters', () => {
  const params = Uint8Array.from([9, 9, ...scaleEncodeU64(INITIAL_MIN_TIME_TO_DISMISS_PS), 7, 7]);

  it('replaces the one encoding with a same-length one', () => {
    const out = patchU64Once(params, INITIAL_MIN_TIME_TO_DISMISS_PS, STEERING_MIN_TIME_TO_DISMISS_PS);
    expect(hex(out)).toBe('090907ffffffffff0707');
    expect(hex(params)).toBe('09090700d6117e030707'); // the input is not modified
  });

  it('refuses a length change, no match and two matches', () => {
    expect(() => patchU64Once(params, INITIAL_MIN_TIME_TO_DISMISS_PS, 1n << 41n)).toThrow(/length/);
    expect(() => patchU64Once(params, 14_000_000_000n, STEERING_MIN_TIME_TO_DISMISS_PS)).toThrow(/found 0/);
    const twice = Uint8Array.from([...params, ...params]);
    expect(() => patchU64Once(twice, INITIAL_MIN_TIME_TO_DISMISS_PS, STEERING_MIN_TIME_TO_DISMISS_PS)).toThrow(
      /found 2/,
    );
  });

  it('reads min_time_to_dismiss from the parameters text', () => {
    expect(minTimeToDismissFromText('limits: TransactionLimits { min_time_to_dismiss: 15.000ms, x }')).toBe(
      15_000_000_000n,
    );
    expect(minTimeToDismissFromText('min_time_to_dismiss: 2.000μs,')).toBe(2_000_000n);
    expect(minTimeToDismissFromText('min_time_to_dismiss: 1.5s')).toBe(1_500_000_000_000n);
    expect(minTimeToDismissFromText('nothing here')).toBeNull();
  });

  it('builds steering parameters and checks the round trip', () => {
    class P {
      constructor(readonly bytes: Uint8Array) {}
      serialize() {
        return this.bytes;
      }
      toString() {
        const v = this.bytes[3] === 0xff ? '1.099s' : '15.000ms';
        return `TransactionLimits { min_time_to_dismiss: ${v} }`;
      }
    }
    const s = steeringParameters(new P(params), (b) => new P(b));
    expect(s.fromPs).toBe(INITIAL_MIN_TIME_TO_DISMISS_PS);
    expect(s.toPs).toBe(STEERING_MIN_TIME_TO_DISMISS_PS);
    expect(hex(s.params.serialize())).toBe('090907ffffffffff0707');
    // A deserialiser that does not reproduce the bytes is refused.
    expect(() => steeringParameters(new P(params), () => new P(Uint8Array.from([1])))).toThrow(/round-trip/);
  });
});

describe('the public data provider view', () => {
  it('replaces only the parameters, and leaves the shared provider untouched', async () => {
    const provider = {
      calls: 0,
      async queryZSwapAndContractState(address: string) {
        this.calls += 1;
        return ['zswap', `contract:${address}`, 'params'] as const;
      },
      async queryContractState(address: string) {
        return `state:${address}`;
      },
    };
    const view = withPartitionParameters(provider, (p) => `steered(${String(p)})`);
    expect(await view.queryZSwapAndContractState('ab')).toEqual(['zswap', 'contract:ab', 'steered(params)']);
    expect(await view.queryContractState('ab')).toBe('state:ab');
    expect(await provider.queryZSwapAndContractState('ab')).toEqual(['zswap', 'contract:ab', 'params']);
    expect(provider.calls).toBe(2);
  });

  it('passes a missing state through', async () => {
    const view = withPartitionParameters({ queryZSwapAndContractState: async () => null }, () => 'x');
    expect(await view.queryZSwapAndContractState()).toBeNull();
  });
});
