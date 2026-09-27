import { getAddress } from 'ethers';
import { describe, expect, it } from 'vitest';

import {
  WalletError,
  connectWallet,
  discoverWallets,
  type Eip1193Provider,
  type WalletOption,
} from '../src/wallet/eip1193.js';

const SEPOLIA = {
  chainIdHex: '0xaa36a7',
  chainName: 'Sepolia',
  publicRpcUrl: 'https://rpc.sepolia.org',
  explorerUrl: 'https://sepolia.etherscan.io',
};
const ADDR = '0x74475a93d435e1e68c079d41584c26ac4f285c71';

function fakeProvider(opts: { chainId?: string; knowsSepolia?: boolean; reject?: string } = {}) {
  let chainId = opts.chainId ?? '0x1';
  const calls: string[] = [];
  const provider: Eip1193Provider = {
    async request({ method, params }) {
      calls.push(method);
      if (method === opts.reject) throw Object.assign(new Error('User rejected'), { code: 4001 });
      if (method === 'eth_requestAccounts') return [ADDR];
      if (method === 'eth_chainId') return chainId;
      if (method === 'wallet_switchEthereumChain') {
        if (opts.knowsSepolia === false && !calls.includes('wallet_addEthereumChain'))
          throw Object.assign(new Error('Unrecognized chain'), { code: 4902 });
        chainId = (params as Array<{ chainId: string }>)[0]!.chainId;
        return null;
      }
      if (method === 'wallet_addEthereumChain') return null;
      throw new Error(`unexpected ${method}`);
    },
  };
  return { provider, calls };
}

describe('connectWallet', () => {
  it('asks to switch to Sepolia when the wallet is elsewhere, and returns a checksummed address', async () => {
    const { provider, calls } = fakeProvider();
    expect(await connectWallet(provider, SEPOLIA)).toEqual({
      address: getAddress(ADDR),
      chainId: '0xaa36a7',
    });
    expect(calls).toEqual(['eth_requestAccounts', 'eth_chainId', 'wallet_switchEthereumChain', 'eth_chainId']);
  });

  it('does not ask to switch when already on Sepolia', async () => {
    const { provider, calls } = fakeProvider({ chainId: '0xAA36A7' });
    await connectWallet(provider, SEPOLIA);
    expect(calls).not.toContain('wallet_switchEthereumChain');
  });

  it('adds Sepolia to a wallet that does not know it (4902), then switches', async () => {
    const { provider, calls } = fakeProvider({ knowsSepolia: false });
    expect((await connectWallet(provider, SEPOLIA)).chainId).toBe('0xaa36a7');
    expect(calls).toEqual([
      'eth_requestAccounts',
      'eth_chainId',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'wallet_switchEthereumChain',
      'eth_chainId',
    ]);
  });

  it('turns a rejection into a plain message', async () => {
    await expect(connectWallet(fakeProvider({ reject: 'eth_requestAccounts' }).provider, SEPOLIA)).rejects.toThrow(
      new WalletError('You declined the request in your wallet.'),
    );
    await expect(
      connectWallet(fakeProvider({ reject: 'wallet_switchEthereumChain' }).provider, SEPOLIA),
    ).rejects.toThrow(/declined/);
  });
});

describe('discoverWallets', () => {
  it('collects EIP-6963 announcements', () => {
    const seen: WalletOption[][] = [];
    const { provider } = fakeProvider();
    const onRequest = () =>
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: { info: { uuid: 'u1', name: 'W1', icon: 'data:image/png;base64,AA', rdns: 'x.w1' }, provider },
        }),
      );
    window.addEventListener('eip6963:requestProvider', onRequest);
    const stop = discoverWallets((o) => seen.push(o));
    // a malformed announcement is ignored
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { name: 'bad' }, provider } }));
    stop();
    window.removeEventListener('eip6963:requestProvider', onRequest);
    expect(seen.at(-1)?.map((o) => [o.id, o.name, o.rdns])).toEqual([['u1', 'W1', 'x.w1']]);
  });

  it('falls back to window.ethereum when nothing announces itself', async () => {
    const { provider } = fakeProvider();
    (window as unknown as { ethereum?: unknown }).ethereum = provider;
    const seen: WalletOption[][] = [];
    const stop = discoverWallets((o) => seen.push(o));
    await new Promise((r) => setTimeout(r, 450));
    stop();
    delete (window as unknown as { ethereum?: unknown }).ethereum;
    expect(seen.at(-1)?.map((o) => o.name)).toEqual(['Browser wallet']);
  });
});
