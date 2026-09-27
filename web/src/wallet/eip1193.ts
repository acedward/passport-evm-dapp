// Wallet connection: EIP-6963 discovery with an EIP-1193 (`window.ethereum`) fallback, and the
// switch to Sepolia before any EVM action (spec FR-001). The page never asks for, accepts or
// stores a private key or seed: every signature happens in the wallet.

import { getAddress } from 'ethers';

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

export interface WalletOption {
  id: string;
  name: string;
  icon?: string;
  rdns?: string;
  provider: Eip1193Provider;
}

export interface ChainParams {
  chainIdHex: string;
  chainName: string;
  publicRpcUrl: string;
  explorerUrl: string;
}

export class WalletError extends Error {
  override name = 'WalletError';
}

const isProvider = (p: unknown): p is Eip1193Provider => !!p && typeof (p as Eip1193Provider).request === 'function';

/** Find the wallets in this browser. Calls `onChange` whenever the list grows. */
export function discoverWallets(onChange: (options: WalletOption[]) => void, win: Window = window): () => void {
  const found = new Map<string, WalletOption>();
  const publish = () => onChange([...found.values()]);
  const onAnnounce = (e: Event) => {
    const detail = (
      e as CustomEvent<{
        info?: { uuid?: unknown; name?: unknown; icon?: unknown; rdns?: unknown };
        provider?: unknown;
      }>
    ).detail;
    const info = detail?.info;
    if (!info || typeof info.uuid !== 'string' || typeof info.name !== 'string' || !isProvider(detail.provider)) return;
    found.set(info.uuid, {
      id: info.uuid,
      name: info.name,
      ...(typeof info.icon === 'string' && info.icon.startsWith('data:image/') ? { icon: info.icon } : {}),
      ...(typeof info.rdns === 'string' ? { rdns: info.rdns } : {}),
      provider: detail.provider,
    });
    publish();
  };
  win.addEventListener('eip6963:announceProvider', onAnnounce);
  win.dispatchEvent(new Event('eip6963:requestProvider'));
  // EIP-1193 fallback for wallets that do not announce themselves.
  const fallback = setTimeout(() => {
    const injected = (win as unknown as { ethereum?: unknown }).ethereum;
    if (found.size === 0 && isProvider(injected)) {
      found.set('injected', { id: 'injected', name: 'Browser wallet', provider: injected });
      publish();
    }
  }, 400);
  return () => {
    clearTimeout(fallback);
    win.removeEventListener('eip6963:announceProvider', onAnnounce);
  };
}

const errorCode = (e: unknown): number | undefined => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'number' ? c : undefined;
};

function friendly(e: unknown, fallback: string): WalletError {
  if (errorCode(e) === 4001) return new WalletError('You declined the request in your wallet.');
  if (e instanceof WalletError) return e;
  return new WalletError(fallback);
}

/** Ask the wallet to switch to Sepolia, adding the network first if the wallet lacks it. */
export async function switchChain(provider: Eip1193Provider, chain: ChainParams): Promise<void> {
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.chainIdHex }] });
  } catch (e) {
    if (errorCode(e) !== 4902) throw friendly(e, `Your wallet could not switch to ${chain.chainName}.`);
    try {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: chain.chainIdHex,
            chainName: chain.chainName,
            nativeCurrency: { name: 'Sepolia ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: [chain.publicRpcUrl],
            blockExplorerUrls: [chain.explorerUrl],
          },
        ],
      });
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.chainIdHex }] });
    } catch (e2) {
      throw friendly(e2, `Your wallet could not add ${chain.chainName}.`);
    }
  }
}

export const sameChain = (a: string | null, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

/** Connect: request the account, then make sure the wallet is on Sepolia. */
export async function connectWallet(
  provider: Eip1193Provider,
  chain: ChainParams,
): Promise<{ address: string; chainId: string }> {
  let accounts: unknown;
  try {
    accounts = await provider.request({ method: 'eth_requestAccounts' });
  } catch (e) {
    throw friendly(e, 'The wallet did not connect.');
  }
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof first !== 'string') throw new WalletError('The wallet shared no account.');
  let chainId = String(await provider.request({ method: 'eth_chainId' }));
  if (!sameChain(chainId, chain.chainIdHex)) {
    await switchChain(provider, chain);
    chainId = String(await provider.request({ method: 'eth_chainId' }));
  }
  return { address: getAddress(first), chainId: chainId.toLowerCase() };
}
