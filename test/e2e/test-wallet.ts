// An EIP-1193 wallet for browser tests, announced through EIP-6963. The key is an ethers Wallet
// created fresh for each run and it stays in the Node test process: the page only sees a
// provider object whose requests are forwarded through `page.exposeFunction`.

import type { Page } from '@playwright/test';
import { Wallet, getBytes } from 'ethers';

export interface TestWallet {
  address: string;
  /** Every request the page made, in order. */
  calls: Array<{ method: string; params: unknown }>;
}

export async function installTestWallet(page: Page, opts: { startChainId?: string } = {}): Promise<TestWallet> {
  const wallet = Wallet.createRandom();
  let chainId = opts.startChainId ?? '0x1'; // mainnet: the dApp must ask to switch to Sepolia
  const calls: TestWallet['calls'] = [];

  await page.exposeFunction('__mnbankTestWallet', async (method: string, params: unknown[]) => {
    calls.push({ method, params });
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [wallet.address];
      case 'eth_chainId':
        return chainId;
      case 'wallet_switchEthereumChain':
        chainId = String((params[0] as { chainId: string }).chainId).toLowerCase();
        return null;
      case 'personal_sign':
        return wallet.signMessage(getBytes(String(params[0])));
      case 'eth_signTypedData_v4': {
        const td = JSON.parse(String(params[1])) as {
          domain: Record<string, unknown>;
          types: Record<string, unknown>;
          message: Record<string, unknown>;
        };
        const { EIP712Domain: _d, ...types } = td.types;
        return wallet.signTypedData(td.domain, types as never, td.message);
      }
      default:
        return { __error: { code: 4200, message: `unsupported method ${method}` } };
    }
  });

  await page.addInitScript(() => {
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    const bridge = (window as unknown as { __mnbankTestWallet: (m: string, p: unknown[]) => Promise<unknown> })
      .__mnbankTestWallet;
    const provider = {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        const result = await bridge(method, params ?? []);
        const err = (result as { __error?: { code: number; message: string } } | null)?.__error;
        if (err) throw Object.assign(new Error(err.message), { code: err.code });
        if (method === 'wallet_switchEthereumChain') {
          const id = (params?.[0] as { chainId: string }).chainId;
          for (const h of listeners.chainChanged ?? []) h(id);
        }
        return result;
      },
      on(event: string, h: (...a: unknown[]) => void) {
        (listeners[event] ??= []).push(h);
      },
      removeListener(event: string, h: (...a: unknown[]) => void) {
        listeners[event] = (listeners[event] ?? []).filter((x) => x !== h);
      },
    };
    const info = {
      uuid: '0f5c2a4e-6b1d-4c38-9a57-00000000e2e0',
      name: 'MN Test Wallet',
      icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E',
      rdns: 'test.mnbank',
    };
    const announce = () =>
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  });

  return { address: wallet.address, calls };
}
