// Sepolia holdings of the connected EOA (spec FR-006): ETH and every configured ERC20, read
// through the wallet's own provider (the wallet is on Sepolia, FR-001), or through a public
// Sepolia RPC when the wallet cannot answer reads. Never a keyed RPC: the page holds no secret.

import type { TokenEntry } from '@mnbank/core';

import type { Eip1193Provider } from '../wallet/eip1193.js';

export interface SepoliaHoldings {
  eth: bigint;
  tokens: Array<{ token: TokenEntry; balance: bigint | null }>;
  /** Where the numbers came from. */
  source: 'wallet' | 'public-rpc';
}

const BALANCE_OF = '0x70a08231';

export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

export const walletRpc =
  (provider: Eip1193Provider): RpcCall =>
  (method, params) =>
    provider.request({ method, params });

export function publicRpc(url: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): RpcCall {
  let id = 0;
  return async (method, params) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? 'rpc error');
    return body.result;
  };
}

const quantity = (v: unknown): bigint => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v)) throw new Error('not a hex quantity');
  return v === '0x' ? 0n : BigInt(v);
};

export async function readSepoliaHoldings(
  rpc: RpcCall,
  address: string,
  tokens: readonly TokenEntry[],
  source: SepoliaHoldings['source'],
): Promise<SepoliaHoldings> {
  const owner = address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const eth = quantity(await rpc('eth_getBalance', [address, 'latest']));
  const withAddress = tokens.filter((t) => t.sepoliaAddress !== '');
  const balances = await Promise.all(
    withAddress.map(async (token) => {
      try {
        return {
          token,
          balance: quantity(
            await rpc('eth_call', [{ to: token.sepoliaAddress, data: `${BALANCE_OF}${owner}` }, 'latest']),
          ),
        };
      } catch {
        return { token, balance: null };
      }
    }),
  );
  return { eth, tokens: balances, source };
}
