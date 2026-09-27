// The live bridge backend (plan L-BRG.4): the pinned Passport client and the vault's compiled
// module from the KEY VOLUME, the vault's 0.23 relayer (vendored verbatim, ./vendor/relayer.ts),
// Sepolia over JSON-RPC and the sponsor wallet. The service (./service.ts) decides everything;
// this file only performs.
//
// What is composed, and where it comes from (all acedward/passport @ 51c1fb4, = 07d8ea4 for these):
//   - the account calls: `CustodyAccount.connect(...).callTx.bridge_*` exactly as
//     `contract/src/wallet/bridge.ts` makes them (AccountBridge.startDeposit/startWithdraw/settle),
//     without importing bridge.ts itself (it loads the vault package through paths that only
//     resolve in its own install, and its request id is "the newest open id": research finding 7);
//   - the account shape: `restrictToAccountShape` = `contractForBridgeAccount(['evm'], {withSwap:true})`
//     (relay/src/passport/account-shape.ts, compared with upstream by a test);
//   - the vault's colours, deposit paths and derived addresses: the compiled Erc20Vault module and
//     the vendored derivation in @mnbank/core/passport (vendor/signet-derive.ts);
//   - the relayer loop: `relayRequest`, with the options G-BRIDGE proved live (relay-compose.ts).
//
// The coin a settle mints gets its inbox entry sealed HERE to the account's PUBLIC key (read from
// its ledger): the settles are permissionless and never need the browser's secret.

import { randomBytes } from 'node:crypto';

import type {
  BridgeCoinJson,
  BridgeDepositPayload,
  BridgeKind,
  BridgeWithdrawPayload,
  NetworkProfile,
} from '@mnbank/core';

import type { IndexerClient } from '../chain/indexer.js';
import type { Logger } from '../log.js';
import { MemoryPrivateStateProvider } from '../passport/private-state.js';
import type { PassportRuntime } from '../passport/runtime.js';
import type { SponsorWalletHandle } from '../passport/wallet-provider.js';
import type { SponsorSession } from '../sponsor/session.js';
import {
  jsonRpcEvmReader,
  type BridgeBackend,
  type OpenRequests,
  type RelayOutcome,
  type SettleCircuit,
  type SettleView,
  type StartAuth,
  type TxFacts,
} from './backend.js';
import { normaliseHex, relayOptionsFor } from './relay-compose.js';

const VENDOR = '../../../vendor/passport/contract';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (h: string) => Uint8Array.from(Buffer.from(normaliseHex(h), 'hex'));

export interface LiveBridgeOptions {
  runtime: PassportRuntime;
  sponsor: SponsorSession;
  network: NetworkProfile;
  /** Sepolia JSON-RPC (may carry a key: never logged). */
  evmRpcUrl: string;
  indexer: IndexerClient;
  log: Logger;
}

export class BridgeConfigError extends Error {
  override name = 'BridgeConfigError';
}

/** The dust-state race retry every Passport submission gets (upstream account.ts / bridge.ts). */
async function submitWithDustRetry<T>(label: string, log: Logger, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/SubmissionError|Invalid Transaction|DustDoubleSpend|NotNormalized/.test(msg) || attempt >= 3) throw e;
      log.warn('submission rejected (dust-state race); retrying in 10 s', { circuit: label, attempt });
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

const txIdOf = (r: unknown): string => {
  const p = (r as { public?: { txId?: unknown; transactionHash?: unknown } } | null)?.public;
  const id = p?.txId ?? p?.transactionHash;
  if (!id) throw new Error('the contract call returned without a transaction id');
  return String(id);
};

/** The circuit's declared result (upstream `circuitResult`). */
function circuitResult(r: unknown): unknown {
  const x = r as { private?: { result?: unknown; circuitResult?: unknown; returnValue?: unknown }; result?: unknown };
  for (const v of [x?.private?.result, x?.private?.circuitResult, x?.private?.returnValue, x?.result]) {
    if (v !== undefined) return v;
  }
  return undefined;
}

type Coin = { nonce: Uint8Array; color: Uint8Array; value: bigint };
const coinJson = (c: Coin): BridgeCoinJson => ({
  nonce: hex(c.nonce),
  color: hex(c.color),
  value: BigInt(c.value).toString(10),
});

/** A settle's claimed coin: the refund returns it bare, the other two a Maybe. */
function claimedOf(r: unknown): Coin | null {
  const v = circuitResult(r) as { is_some?: boolean; value?: Coin } | Coin | undefined;
  if (v === undefined) return null;
  if ((v as { is_some?: boolean }).is_some === undefined) return v as Coin;
  return (v as { is_some: boolean }).is_some ? ((v as { value: Coin }).value ?? null) : null;
}

type Either = { is_left: boolean; left: { bytes: Uint8Array }; right: { bytes: Uint8Array } };

export async function loadLiveBridgeBackend(opts: LiveBridgeOptions): Promise<BridgeBackend> {
  const { runtime: rt, sponsor, network, log } = opts;
  const b = network.bridge;
  if (!b.vaultAddress || !b.vaultEvmAddress || !b.signetSingleton || !b.mpcRootPublicKey || !b.mpcOutputCacheUrl) {
    throw new BridgeConfigError('the network profile names no complete bridge (vault, singleton, MPC key, cache)');
  }
  const vaultAddress = normaliseHex(b.vaultAddress);
  const [vaultMod, derive, ledgerV9, relayer, sdk] = await Promise.all([
    import(`${VENDOR}/contracts/managed/Erc20Vault/contract/index.js`) as Promise<{
      ledger: (data: unknown) => Record<string, unknown>;
      pureCircuits: {
        vaultResponseSchema(): Uint8Array;
        vaultTokenDomainSeparator(erc20: Uint8Array): Uint8Array;
      };
    }>,
    import('@mnbank/core/passport'),
    import('@midnightntwrk/ledger-v9'),
    import('./vendor/relayer.js'),
    import('./vendor/signet-sdk.js'),
  ]);

  const root = derive.normaliseSecp256k1PublicKey(b.mpcRootPublicKey);
  const derivedVaultEvm = derive.deriveVaultEvmAddress(root, vaultAddress);
  if (derivedVaultEvm.toLowerCase() !== b.vaultEvmAddress.toLowerCase()) {
    throw new BridgeConfigError('the configured vault EVM address is not the one the MPC key derives for the vault');
  }
  const depositPathHex = (account: string) => hex(derive.depositPathBytes(derive.contractRecipient(unhex(account))));
  const vaultPathHex = hex(derive.vaultPathBytes());
  const responseKey = sdk.deriveMidnightResponseKey(root as never, vaultAddress) as {
    x: bigint;
    y: bigint;
    identity: boolean;
  };
  const vaultConstants = {
    vaultAddress,
    signetAddress: normaliseHex(b.signetSingleton),
    depositRequestsPath: derive.VAULT_DEPOSIT_REQUESTS_PATH,
    withdrawRequestsPath: derive.VAULT_WITHDRAW_REQUESTS_PATH,
    responseSchema: vaultMod.pureCircuits.vaultResponseSchema(),
    mpcResponseKey: responseKey,
  };
  const colourOf = (erc20: string) =>
    hex(
      ledgerV9.encodeRawTokenType(
        ledgerV9.rawTokenType(vaultMod.pureCircuits.vaultTokenDomainSeparator(unhex(erc20)), vaultAddress),
      ),
    );

  const pdp = rt.publicDataProvider as { queryContractState(a: string): Promise<{ data: unknown } | null> };
  const vaultLedger = async () => {
    const state = await pdp.queryContractState(vaultAddress);
    if (!state) throw new Error('no contract state at the vault');
    return vaultMod.ledger(state.data) as Record<string, unknown> & {
      depositEventMap: unknown;
      withdrawEventMap: unknown;
      depositSettleViews: { member(k: Uint8Array): boolean; lookup(k: Uint8Array): Record<string, unknown> };
      withdrawSettleViews: { member(k: Uint8Array): boolean; lookup(k: Uint8Array): Record<string, unknown> };
    };
  };

  const openRequests = async (kind: BridgeKind): Promise<OpenRequests> => {
    const l = await vaultLedger();
    const index = sdk.toSignBidirectionalEventIndex(
      (kind === 'deposit' ? l.depositEventMap : l.withdrawEventMap) as never,
    ) as Map<unknown, { path?: unknown }>;
    const records = new Map<string, { path?: unknown }>();
    for (const [id, record] of index.entries()) records.set(normaliseHex(String(id)), record);
    return {
      ids: [...records.keys()],
      pathOf: (id) => {
        const p = records.get(normaliseHex(id))?.path;
        return p === undefined ? undefined : typeof p === 'string' ? normaliseHex(p) : hex(p as Uint8Array);
      },
    };
  };

  const settleView = async (kind: BridgeKind, requestId: string): Promise<SettleView | null> => {
    const l = await vaultLedger();
    const views = kind === 'deposit' ? l.depositSettleViews : l.withdrawSettleViews;
    const id = unhex(requestId);
    if (!views.member(id)) return null;
    const v = views.lookup(id) as { recipient?: Either; refundRecipient?: Either; erc20: Uint8Array; amount: bigint };
    const who = (kind === 'deposit' ? v.recipient : v.refundRecipient) as Either;
    return { account: who.is_left ? null : hex(who.right.bytes), erc20: `0x${hex(v.erc20)}`, amount: BigInt(v.amount) };
  };

  /** Run `fn` with the sponsor wallet and a connected account whose private state holds `coin`. */
  const withAccount = <T>(
    account: string,
    coin: { nonce: Uint8Array; color: Uint8Array; value: bigint; mtIndex: bigint } | null,
    fn: (callTx: Record<string, (...a: unknown[]) => Promise<unknown>>) => Promise<T>,
  ): Promise<T> =>
    sponsor.withWallet(async (w) => {
      const privateState = new MemoryPrivateStateProvider();
      try {
        const providers = await rt.providers(w as SponsorWalletHandle, privateState);
        const { account: accountMod, witnesses } = rt.client;
        const store = coin ? witnesses.withCoin(witnesses.emptyCoinStore(), coin) : witnesses.emptyCoinStore();
        const custody = await accountMod.CustodyAccount.connect(providers, rt.compiledAccount(), account, store);
        return await fn(custody.callTx as Record<string, (...a: unknown[]) => Promise<unknown>>);
      } finally {
        privateState.wipe();
      }
    });

  const authArgs = (auth: StartAuth) => rt.client.signer.authArgs(auth as never) as unknown[];
  const evmArgs = (e: BridgeDepositPayload['evm']) => [
    BigInt(e.nonce),
    BigInt(e.gasLimit),
    BigInt(e.maxFeePerGas),
    BigInt(e.maxPriorityFeePerGas),
    BigInt(e.keyVersion),
  ];

  return {
    evm: jsonRpcEvmReader(opts.evmRpcUrl),
    vaultEvmAddress: b.vaultEvmAddress,
    depositAddress: (account) =>
      derive.deriveDepositEvmAddress(root, vaultAddress, derive.contractRecipient(unhex(account))),
    depositPathHex,
    vaultPathHex: () => vaultPathHex,
    colourOf,
    openRequests,
    settleView,

    async startDeposit({
      account,
      payload,
      auth,
    }: {
      account: string;
      payload: BridgeDepositPayload;
      auth: StartAuth;
    }) {
      const r = await withAccount(account, null, (callTx) =>
        submitWithDustRetry('bridge_deposit_start_with_evm', log, () =>
          callTx.bridge_deposit_start_with_evm!(
            unhex(payload.erc20),
            BigInt(payload.amount),
            ...evmArgs(payload.evm),
            ...authArgs(auth),
          ),
        ),
      );
      return { txId: txIdOf(r), change: null };
    },

    async startWithdraw({
      account,
      payload,
      auth,
    }: {
      account: string;
      payload: BridgeWithdrawPayload;
      auth: StartAuth;
    }) {
      const coin = {
        nonce: unhex(payload.coin.nonce),
        color: unhex(payload.coin.color),
        value: BigInt(payload.coin.value),
        mtIndex: BigInt(payload.coin.mtIndex),
      };
      const r = await withAccount(account, coin, (callTx) =>
        submitWithDustRetry('bridge_withdraw_start_with_evm', log, () =>
          callTx.bridge_withdraw_start_with_evm!(
            unhex(payload.dest),
            unhex(payload.color),
            BigInt(payload.amount),
            ...evmArgs(payload.evm),
            unhex(payload.erc20),
            // The change cannot be predicted before the call (upstream Q46): 192 zero bytes, and
            // the page re-files the change with append_inbox_with_evm afterwards (Q13 A).
            new Uint8Array(192),
            ...authArgs(auth),
          ),
        ),
      );
      const v = circuitResult(r) as { is_some?: boolean; value?: Coin } | undefined;
      return { txId: txIdOf(r), change: v?.is_some && v.value ? coinJson(v.value) : null };
    },

    async relay({ kind, requestId, expectedSigner, signatureTimeoutMs, onProgress }) {
      const result = (await relayer.relayRequest(
        relayOptionsFor({
          kind,
          requestId,
          expectedSigner,
          vault: vaultConstants,
          endpoints: {
            indexerUrl: network.midnight.indexerUrl,
            evmRpcUrl: opts.evmRpcUrl,
            outputCache: { networkId: network.midnightNetworkId, cacheUrl: b.mpcOutputCacheUrl },
          },
          publicDataProvider: rt.publicDataProvider,
          signatureTimeoutMs,
          onProgress: onProgress as (p: unknown) => void,
          log: (line: string) => log.info('relayer', { requestId, line: line.trim() }),
        }) as never,
      )) as unknown as RelayOutcome & { evmTxHash?: string };
      return result;
    },

    async settle({ kind, circuit, account, requestId, relay }) {
      const view = await settleView(kind, requestId);
      if (!view) throw new Error(`the vault holds no ${kind} settle view for ${requestId}`);
      if (view.account !== normaliseHex(account)) throw new Error('the request does not belong to this account');
      const ledger = await rt.ledgerState(account);
      if (!ledger) throw new Error('no account at this address');
      const mintNonce = Uint8Array.from(randomBytes(32));
      const planned: Coin = { nonce: mintNonce, color: unhex(colourOf(view.erc20)), value: view.amount };
      const entry = await derive.sealEntryPortable(ledger.enc_key, planned);
      const r = await withAccount(account, null, (callTx) =>
        submitWithDustRetry(circuit, log, () =>
          callTx[circuit as SettleCircuit]!(unhex(requestId), relay.event, relay.serializedOutput, mintNonce, entry),
        ),
      );
      const claimed = claimedOf(r);
      const matches =
        claimed !== null &&
        hex(claimed.nonce) === hex(planned.nonce) &&
        hex(claimed.color) === hex(planned.color) &&
        BigInt(claimed.value) === planned.value;
      return {
        txId: txIdOf(r),
        coin: claimed ? coinJson(claimed) : null,
        entryMatchesCoin: claimed === null || matches,
      };
    },

    async txFacts(txId: string): Promise<TxFacts> {
      const data = await opts.indexer.graphql<{
        transactions?: Array<{ hash?: string; block?: { height?: number; timestamp?: number | string } }>;
      }>(`query($offset: TransactionOffset!) { transactions(offset: $offset) { hash block { height timestamp } } }`, {
        offset: { identifier: normaliseHex(txId) },
      });
      const t = data.transactions?.[0];
      return {
        hash: t?.hash ?? null,
        blockHeight: t?.block?.height ?? null,
        blockMs: t?.block?.timestamp === undefined ? null : Number(t.block.timestamp),
      };
    },
  };
}
