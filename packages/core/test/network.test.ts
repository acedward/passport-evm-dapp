import { describe, expect, it } from 'vitest';

import {
  NETWORK_DEFAULT_ASSETS,
  NetworkConfigError,
  PROFILES,
  SEPOLIA_CHAIN_ID,
  bridgeConfigured,
  resolveNetwork,
} from '../src/network.js';
import { stagenetRegistry } from '../src/tokens/registry.js';

describe('network profiles', () => {
  it('stagenet points at the live staging endpoints and the PR #4 vault', () => {
    const s = resolveNetwork('stagenet');
    expect(s.midnightNetworkId).toBe('stagenet');
    expect(s.midnight.nodeUrl).toBe('https://rpc.stagenet.shielded.tools');
    expect(s.midnight.indexerUrl).toBe('https://indexer.stagenet.shielded.tools/api/v4/graphql');
    expect(s.zswap.kernelUrl).toBe('https://stagenet.api-zswap.zkdojo.com');
    expect(s.zswap.batcherUrl).toBe('https://stagenet.batcher-zswap.zkdojo.com');
    expect(s.zswap.batcherTarget).toBe('midnight-balancer');
    expect(s.evm.chainId).toBe(SEPOLIA_CHAIN_ID);
    expect(s.bridge.vaultAddress).toBe('7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637');
    expect(s.bridge.vaultEvmAddress).toBe('0x648216975e722494bFF92E88FFc68C8F8d438FaA');
    expect(s.bridge.signetSingleton).toBe('1df4ce25fc9f9c03dc6f4d0eb12ddf3d0db094995d4c70aca1142eebb3b77a5d');
    expect(bridgeConfigured(s)).toBe(true);
  });

  it('undeployed uses the local stack DNS names and needs the bridge from configuration', () => {
    const u = resolveNetwork('undeployed');
    expect(u.midnight.nodeUrl).toBe('http://node:9944');
    expect(u.midnight.indexerUrl).toBe('http://indexer:8088/api/v4/graphql');
    expect(u.zswap.kernelUrl).toBe('http://kernel:9999');
    expect(u.zswap.batcherUrl).toBe('http://batcher:3334');
    expect(bridgeConfigured(u)).toBe(false);
  });

  it('every endpoint can be overridden, and the rest keep their defaults', () => {
    const s = resolveNetwork('stagenet', {
      midnight: { indexerUrl: 'https://indexer.example.test/api/v4/graphql' },
      zswap: { kernelUrl: 'https://kernel.example.test' },
    });
    expect(s.midnight.indexerUrl).toBe('https://indexer.example.test/api/v4/graphql');
    expect(s.midnight.nodeUrl).toBe(PROFILES.stagenet.midnight.nodeUrl);
    expect(s.zswap.kernelUrl).toBe('https://kernel.example.test');
    expect(s.zswap.batcherUrl).toBe(PROFILES.stagenet.zswap.batcherUrl);
    const u = resolveNetwork('undeployed', {
      bridge: {
        vaultAddress: 'bebd3370a7adab3ed23ed20014a5d4df5e1eebd03d554cec25b822c0b4b11024',
        vaultEvmAddress: '0x0000000000000000000000000000000000000001',
        mpcRootPublicKey: `0x04${'1'.repeat(128)}`,
      },
    });
    expect(bridgeConfigured(u)).toBe(true);
  });

  it('refuses unknown networks, unknown keys and invalid values', () => {
    expect(() => resolveNetwork('mainnet')).toThrow(NetworkConfigError);
    expect(() => resolveNetwork('stagenet', { nope: {} } as never)).toThrow(/unknown network setting "nope"/);
    expect(() => resolveNetwork('stagenet', { zswap: { kernel: 'x' } } as never)).toThrow(/zswap.kernel/);
    expect(() => resolveNetwork('stagenet', { zswap: { kernelUrl: 'not a url' } })).toThrow(/zswap.kernelUrl/);
    expect(() => resolveNetwork('undeployed', { bridge: { vaultAddress: 'XYZ' } })).toThrow(/bridge.vaultAddress/);
  });

  it('the default asset sets (plan 00046, data): stagenet shows the stk line, the local stack everything', () => {
    expect(NETWORK_DEFAULT_ASSETS.stagenet).toEqual(['USDC', 'stkA', 'stkB', 'stkC']);
    expect(NETWORK_DEFAULT_ASSETS.undeployed).toBeNull();
    // Every symbol of the stagenet default is one the vendored registry knows.
    const symbols = stagenetRegistry().tokens.map((t) => t.symbol);
    for (const s of NETWORK_DEFAULT_ASSETS.stagenet!) expect(symbols).toContain(s);
  });

  it('never carries a keyed RPC: the only EVM RPC is the public one offered to wallets', () => {
    const json = JSON.stringify(PROFILES);
    expect(json).not.toMatch(/infura|alchemy|apikey|api_key/i);
  });
});
