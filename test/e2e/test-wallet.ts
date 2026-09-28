// An EIP-1193 wallet for browser tests, announced through EIP-6963. The key is an ethers Wallet
// created fresh for each run (or, for the capped live runs, read from a mode-600 key file by the
// test process) and it stays in the Node test process: the page only sees a provider object whose
// requests are forwarded through `page.exposeFunction`.
//
// Two modes: FAKE (the default) answers Sepolia reads from `sepolia` and "sends" transactions by
// updating those balances; LIVE (`live: { rpcUrl }`) forwards every read to a public Sepolia RPC
// and signs and broadcasts `eth_sendTransaction` with the key, as a browser wallet would.

import type { Page } from '@playwright/test';
import { JsonRpcProvider, Wallet, getBytes, type TransactionRequest } from 'ethers';

export interface TestWallet {
  address: string;
  /** Every request the page made, in order. */
  calls: Array<{ method: string; params: unknown }>;
}

export interface FakeSepolia {
  /** Wei the connected address holds. */
  ethWei?: bigint;
  /** ERC20 balances by token address (lowercase), in base units. */
  erc20?: Record<string, bigint>;
  /** Balances of OTHER addresses (lowercase): wei, and ERC20s by `token:holder`. */
  others?: { eth?: Record<string, bigint>; erc20?: Record<string, bigint> };
}

export interface LiveSepolia {
  /** A public Sepolia RPC (never a keyed URL: it would reach the test logs). */
  rpcUrl: string;
}

const hexq = (v: bigint) => `0x${v.toString(16)}`;

export async function installTestWallet(
  page: Page,
  opts: { startChainId?: string; sepolia?: FakeSepolia; privateKey?: string; live?: LiveSepolia } = {},
): Promise<TestWallet> {
  const rpc = opts.live ? new JsonRpcProvider(opts.live.rpcUrl, 11155111, { staticNetwork: true }) : null;
  const wallet = opts.privateKey ? new Wallet(opts.privateKey, rpc ?? undefined) : Wallet.createRandom();
  let chainId = opts.startChainId ?? '0x1'; // mainnet: the dApp must ask to switch to Sepolia
  const calls: TestWallet['calls'] = [];
  let sent = 0;
  const me = wallet.address.toLowerCase();
  const fakeEth = (a: string) =>
    a.toLowerCase() === me ? (opts.sepolia?.ethWei ?? 0n) : (opts.sepolia?.others?.eth?.[a.toLowerCase()] ?? 0n);
  const fakeErc20 = (token: string, holder: string) =>
    holder.toLowerCase() === me
      ? (opts.sepolia?.erc20?.[token.toLowerCase()] ?? 0n)
      : (opts.sepolia?.others?.erc20?.[`${token.toLowerCase()}:${holder.toLowerCase()}`] ?? 0n);

  await page.exposeFunction('__mnbankTestWallet', async (method: string, params: unknown[]) => {
    calls.push({ method, params });
    if (
      rpc &&
      [
        'eth_getBalance',
        'eth_call',
        'eth_getTransactionReceipt',
        'eth_getTransactionCount',
        'eth_blockNumber',
        'eth_estimateGas',
        'eth_gasPrice',
      ].includes(method)
    ) {
      try {
        return await rpc.send(method, params);
      } catch (e) {
        return { __error: { code: -32603, message: e instanceof Error ? e.message : String(e) } };
      }
    }
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [wallet.address];
      case 'eth_chainId':
        return chainId;
      case 'wallet_switchEthereumChain':
        chainId = String((params[0] as { chainId: string }).chainId).toLowerCase();
        return null;
      case 'eth_getBalance':
        return hexq(fakeEth(String(params[0])));
      case 'eth_call': {
        const call = params[0] as { to?: string; data?: string };
        const holder = call.data && call.data.length >= 74 ? `0x${call.data.slice(34, 74)}` : me;
        return `0x${fakeErc20(String(call.to), holder).toString(16).padStart(64, '0')}`;
      }
      case 'eth_sendTransaction': {
        const tx = params[0] as { from?: string; to: string; data?: string; value?: string };
        if (rpc) {
          const req: TransactionRequest = { to: tx.to, data: tx.data ?? '0x', value: BigInt(tx.value ?? '0x0') };
          const res = await wallet.sendTransaction(req);
          return res.hash;
        }
        // FAKE: move the balances the page will read back.
        const s = (opts.sepolia ??= {});
        s.others ??= {};
        if (tx.data?.startsWith('0xa9059cbb')) {
          const to = `0x${tx.data.slice(34, 74)}`.toLowerCase();
          const amount = BigInt(`0x${tx.data.slice(74)}`);
          const key = `${tx.to.toLowerCase()}:${to}`;
          (s.others.erc20 ??= {})[key] = (s.others.erc20[key] ?? 0n) + amount;
          (s.erc20 ??= {})[tx.to.toLowerCase()] = (s.erc20[tx.to.toLowerCase()] ?? 0n) - amount;
        } else {
          const to = tx.to.toLowerCase();
          (s.others.eth ??= {})[to] = (s.others.eth[to] ?? 0n) + BigInt(tx.value ?? '0x0');
          s.ethWei = (s.ethWei ?? 0n) - BigInt(tx.value ?? '0x0');
        }
        sent++;
        return `0x${sent.toString(16).padStart(64, 'e')}`;
      }
      case 'eth_getTransactionReceipt':
        return { status: '0x1', transactionHash: params[0] };
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
