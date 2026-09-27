import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getAddress } from 'ethers';

import type { NetworkProfile } from '@mnbank/core';

import {
  type ChainParams,
  type WalletOption,
  WalletError,
  connectWallet,
  discoverWallets,
  sameChain,
  switchChain,
} from './eip1193.js';

export type WalletStatus = 'disconnected' | 'connecting' | 'connected';

export interface WalletState {
  status: WalletStatus;
  options: WalletOption[];
  address: string | null;
  chainId: string | null;
  walletName: string | null;
  /** True when connected to the chain the bank uses (Sepolia). */
  onRightChain: boolean;
  error: string | null;
  connect(option: WalletOption): Promise<void>;
  switchNetwork(): Promise<void>;
  disconnect(): void;
}

const WalletCtx = createContext<WalletState | null>(null);

export function WalletProvider({ network, children }: { network: NetworkProfile; children: ReactNode }) {
  const chain: ChainParams = useMemo(
    () => ({
      chainIdHex: network.evm.chainIdHex,
      chainName: network.evm.chainName,
      publicRpcUrl: network.evm.publicRpcUrl,
      explorerUrl: network.evm.explorerUrl,
    }),
    [network],
  );
  const [options, setOptions] = useState<WalletOption[]>([]);
  const [status, setStatus] = useState<WalletStatus>('disconnected');
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [selected, setSelected] = useState<WalletOption | null>(null);
  const [error, setError] = useState<string | null>(null);
  const detach = useRef<(() => void) | null>(null);

  useEffect(() => discoverWallets(setOptions), []);
  useEffect(() => () => detach.current?.(), []);

  const disconnect = useCallback(() => {
    detach.current?.();
    detach.current = null;
    setSelected(null);
    setAddress(null);
    setChainId(null);
    setStatus('disconnected');
  }, []);

  const connect = useCallback(
    async (option: WalletOption) => {
      setError(null);
      setStatus('connecting');
      try {
        const r = await connectWallet(option.provider, chain);
        detach.current?.();
        const onAccounts = (accounts: unknown) => {
          const first = Array.isArray(accounts) ? accounts[0] : undefined;
          if (typeof first === 'string') setAddress(getAddress(first));
          else disconnect();
        };
        const onChain = (id: unknown) => setChainId(typeof id === 'string' ? id.toLowerCase() : null);
        option.provider.on?.('accountsChanged', onAccounts);
        option.provider.on?.('chainChanged', onChain);
        detach.current = () => {
          option.provider.removeListener?.('accountsChanged', onAccounts);
          option.provider.removeListener?.('chainChanged', onChain);
        };
        setSelected(option);
        setAddress(r.address);
        setChainId(r.chainId);
        setStatus('connected');
      } catch (e) {
        setStatus('disconnected');
        setError(e instanceof WalletError ? e.message : 'The wallet did not connect.');
      }
    },
    [chain, disconnect],
  );

  const switchNetwork = useCallback(async () => {
    if (!selected) return;
    setError(null);
    try {
      await switchChain(selected.provider, chain);
      setChainId(String(await selected.provider.request({ method: 'eth_chainId' })).toLowerCase());
    } catch (e) {
      setError(e instanceof WalletError ? e.message : 'The wallet could not switch networks.');
    }
  }, [selected, chain]);

  const value: WalletState = {
    status,
    options,
    address,
    chainId,
    walletName: selected?.name ?? null,
    onRightChain: sameChain(chainId, chain.chainIdHex),
    error,
    connect,
    switchNetwork,
    disconnect,
  };
  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(WalletCtx);
  if (!v) throw new Error('useWallet outside WalletProvider');
  return v;
}
