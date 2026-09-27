// Plan L-BRG: the bridge starts' wire bodies build the same challenge and digest the pinned client
// does (the P0.4 golden vectors), the typed data is what ethers hashes, and the preflights refuse
// exactly what the vault v0.3.0 preflight refuses (plus the queue).

import { TypedDataEncoder, Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EVM_GAS,
  depositPreflight,
  evmTxParamsJson,
  matchesGasPolicy,
  maxGasCostWei,
  queuedDepositPreflight,
  withdrawPreflight,
  type BridgeDepositPayload,
  type BridgeWithdrawPayload,
} from '../src/bridge.js';
import { bytesToHex as hex } from '../src/hex.js';
import {
  EvmDevice,
  bridgeDepositStartRequest,
  bridgeWithdrawStartRequest,
  evmDomainSaltFor,
  gatedCall,
} from '../src/passport/index.js';
import { EXPECTED, F } from './fixtures/p04-vectors.js';

const evm = {
  nonce: F.evmTx.nonce.toString(),
  gasLimit: F.evmTx.gasLimit.toString(),
  maxFeePerGas: F.evmTx.maxFeePerGas.toString(),
  maxPriorityFeePerGas: F.evmTx.maxPriorityFeePerGas.toString(),
  keyVersion: F.evmTx.keyVersion.toString(),
};

describe('the bridge starts as the page builds them', () => {
  const salt = evmDomainSaltFor('stagenet');
  const device = EvmDevice.fromPrivateKey(F.evmKey);
  const ctx = { account: hex(F.account), authNonce: F.authNonce, evmDomainSalt: hex(salt) };
  const owner = `0x${hex(device.address)}`;

  it('BridgeDepositStart reproduces the P0.4 challenge and digest, and ethers hashes it the same', () => {
    const payload: BridgeDepositPayload = {
      erc20: `0x${hex(F.erc20)}`,
      amount: F.amount.toString(),
      evm,
      authNonce: F.authNonce.toString(),
    };
    const call = gatedCall(ctx, owner, bridgeDepositStartRequest(payload));
    expect({ challenge: hex(call.challenge), digest: hex(call.digest) }).toEqual(EXPECTED.bridgeDepositStart);
    const { EIP712Domain: _d, ...types } = call.typedData.types as Record<string, never>;
    expect(TypedDataEncoder.hash(call.typedData.domain as never, types, call.typedData.message as never)).toBe(
      call.digestHex,
    );
    expect(call.typedData.primaryType).toBe('BridgeDepositStart');
  });

  it('BridgeWithdrawStart reproduces the P0.4 challenge and digest (the coin and its mt_index are bound)', () => {
    const payload: BridgeWithdrawPayload = {
      dest: `0x${hex(F.dest)}`,
      color: hex(F.colour),
      erc20: `0x${hex(F.erc20)}`,
      amount: F.amount.toString(),
      coin: {
        nonce: hex(F.coin.nonce),
        color: hex(F.coin.color),
        value: F.coin.value.toString(),
        mtIndex: F.coin.mt_index.toString(),
      },
      evm,
      authNonce: F.authNonce.toString(),
    };
    const call = gatedCall(ctx, owner, bridgeWithdrawStartRequest(payload));
    expect({ challenge: hex(call.challenge), digest: hex(call.digest) }).toEqual(EXPECTED.bridgeWithdrawStart);
    const moved = gatedCall(
      ctx,
      owner,
      bridgeWithdrawStartRequest({ ...payload, coin: { ...payload.coin, mtIndex: '12346' } }),
    );
    expect(moved.digestHex).not.toBe(call.digestHex);
  });

  it('a wallet signature over the typed data recovers to the signer', async () => {
    const w = Wallet.createRandom();
    const payload: BridgeDepositPayload = { erc20: `0x${hex(F.erc20)}`, amount: '1', evm, authNonce: '0' };
    const call = gatedCall({ ...ctx, authNonce: 0n }, w.address, bridgeDepositStartRequest(payload));
    const { EIP712Domain: _d, ...types } = call.typedData.types as Record<string, never>;
    const sig = await w.signTypedData(call.typedData.domain as never, types, call.typedData.message as never);
    const { verifyTypedData } = await import('ethers');
    expect(verifyTypedData(call.typedData.domain as never, types, call.typedData.message as never, sig)).toBe(
      w.address,
    );
  });
});

describe('the gas policy', () => {
  it('is AA 00037 / G-BRIDGE: 100,000 gas at 10 gwei, 1 gwei tip, key version 1 (0.001 ETH per sweep)', () => {
    expect(maxGasCostWei(DEFAULT_EVM_GAS)).toBe(1_000_000_000_000_000n);
    const signed = evmTxParamsJson(DEFAULT_EVM_GAS, 5n);
    expect(signed).toEqual({
      nonce: '5',
      gasLimit: '100000',
      maxFeePerGas: '10000000000',
      maxPriorityFeePerGas: '1000000000',
      keyVersion: '1',
    });
    expect(matchesGasPolicy(signed, DEFAULT_EVM_GAS)).toBe(true);
    expect(matchesGasPolicy({ ...signed, maxFeePerGas: '10000000001' }, DEFAULT_EVM_GAS)).toBe(false);
  });
});

describe('the preflights', () => {
  const gas = DEFAULT_EVM_GAS;
  const cost = maxGasCostWei(gas);

  it('with nothing queued, the deposit preflight IS the vault v0.3.0 one', () => {
    for (const [erc20Balance, ethBalance] of [
      [1_000_000n, cost],
      [999_999n, cost],
      [1_000_000n, cost - 1n],
      [0n, 0n],
    ] as const) {
      const ours = queuedDepositPreflight({ erc20Balance, ethBalance, amount: 1_000_000n, gas, decimals: 6 });
      const upstream = depositPreflight({
        erc20Balance,
        amount: 1_000_000n,
        ethBalance,
        gasLimit: gas.gasLimit,
        maxFeePerGas: gas.maxFeePerGas,
        decimals: 6,
      });
      expect(ours).toEqual(upstream);
    }
    expect(queuedDepositPreflight({ erc20Balance: 0n, ethBalance: 0n, amount: 1n, gas, decimals: 6 }).problems).toEqual(
      [
        'the deposit address holds 0 of the ERC20 but the sweep moves 0.000001: fund it on the EVM chain first',
        'the deposit address holds 0 wei but the sweep may cost up to 1000000000000000 wei (gasLimit 100000 x maxFeePerGas 10000000000): send it gas ETH first',
      ],
    );
  });

  it('reserves the tokens and gas of requests queued ahead on the same address', () => {
    const base = { amount: 1_000_000n, gas, decimals: 6 };
    expect(queuedDepositPreflight({ ...base, erc20Balance: 2_000_000n, ethBalance: 2n * cost }).ok).toBe(true);
    expect(
      queuedDepositPreflight({
        ...base,
        erc20Balance: 2_000_000n,
        ethBalance: 2n * cost,
        aheadSameToken: 1_000_000n,
        aheadSweeps: 1,
      }).ok,
    ).toBe(true);
    const short = queuedDepositPreflight({
      ...base,
      erc20Balance: 1_500_000n,
      ethBalance: 2n * cost - 1n,
      aheadSameToken: 1_000_000n,
      aheadSweeps: 1,
    });
    expect(short.ok).toBe(false);
    expect(short.problems).toHaveLength(2);
  });

  it('the withdrawal preflight names a vault gas or token shortfall', () => {
    expect(withdrawPreflight({ vaultEthWei: cost, vaultErc20: 1n, amount: 1n, gas }).ok).toBe(true);
    const r = withdrawPreflight({ vaultEthWei: cost - 1n, vaultErc20: 0n, amount: 1n, gas });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/vault account holds 999999999999999 wei of gas/);
    expect(r.problems[1]).toMatch(/holds 0 of this token, less than the 1 to pay out/);
  });
});
