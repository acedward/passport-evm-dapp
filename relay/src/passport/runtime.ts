// The relay's Passport runtime: the pinned Passport client, bound to the KEY VOLUME's compiled
// contracts, plus the midnight-js providers the account operations run on.
//
// Everything here is loaded dynamically by `loadPassportRuntime`, only when a key volume is
// mounted: the client imports the compiled account from
// `vendor/passport/contract/contracts/managed/account/contract/index.js`, and in a deployment that
// directory IS the key volume (deploy/compose.keys.yml mounts it there, the P0.5 decision). The
// light compile (`scripts/compile-contracts.sh`, no keys, an EMPTY `expectedVk` table) must never
// be what the relay proves with, so `bindingCheck` refuses to start the runtime unless the loaded
// module's `expectedVk` equals the SHA-256 of every verifier key in the volume.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Logger } from '../log.js';
import { MemoryPrivateStateProvider } from './private-state.js';
import { walletProviderFor, type RelayWalletProvider, type SponsorWalletHandle } from './wallet-provider.js';

export class PassportRuntimeError extends Error {
  override name = 'PassportRuntimeError';
}

export interface PassportRuntimeOptions {
  /** The key volume: `<root>/<contract>/{contract,keys,zkir,compiler}`. */
  managedPath: string;
  networkId: string;
  indexerUrl: string;
  indexerWsUrl: string;
  proofServerUrl: string;
  /** Proof requests may take minutes (k=18); the HTTP provider's timeout, ms. */
  proofTimeoutMs?: number;
  /** A balanced transaction's time to live, ms (the node's fee window is short). */
  txTtlMs?: number;
  log: Logger;
}

const VENDOR = '../../../vendor/passport/contract';

/** The client modules, loaded once. `compiled` is the very module `contract.js` re-exports
 *  (same path, so the same instance), imported directly for its `expectedVk` table. */
async function importClient() {
  const [account, signer, contract, compiled, witnesses, shape, compactJs] = await Promise.all([
    import(`${VENDOR}/src/wallet/account.js`),
    import(`${VENDOR}/src/wallet/signer.js`),
    import(`${VENDOR}/src/wallet/contract.js`),
    import(`${VENDOR}/contracts/managed/account/contract/index.js`),
    import(`${VENDOR}/src/wallet/witnesses.js`),
    import('./account-shape.js'),
    import('@midnight-ntwrk/compact-js'),
  ]);
  return { account, signer, contract, compiled, witnesses, shape, compactJs };
}
export type PassportClient = Awaited<ReturnType<typeof importClient>>;

/** The loaded account module's `expectedVk` must be the key volume's verifier keys. */
export function bindingCheck(expectedVk: Record<string, string>, managedPath: string): { circuits: number } {
  const keysDir = join(managedPath, 'account', 'keys');
  if (!existsSync(keysDir)) throw new PassportRuntimeError('the key volume has no account keys');
  const entries = Object.entries(expectedVk ?? {});
  if (entries.length === 0) {
    throw new PassportRuntimeError(
      'the loaded account contract has no verifier-key table: it is the light compile, not the key volume',
    );
  }
  for (const [circuit, sha] of entries) {
    const file = join(keysDir, `${circuit}.verifier`);
    if (!existsSync(file)) throw new PassportRuntimeError(`the key volume lacks the verifier key of ${circuit}`);
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (actual !== sha) throw new PassportRuntimeError(`the verifier key of ${circuit} does not match the loaded code`);
  }
  const onDisk = readdirSync(keysDir).filter((f) => f.endsWith('.verifier')).length;
  if (onDisk !== entries.length)
    throw new PassportRuntimeError('the key volume and the loaded code list different circuits');
  return { circuits: entries.length };
}

export interface PassportProviders {
  privateStateProvider: MemoryPrivateStateProvider;
  publicDataProvider: unknown;
  zkConfigProvider: unknown;
  proofProvider: unknown;
  walletProvider: unknown;
  midnightProvider: unknown;
}

export class PassportRuntime {
  private constructor(
    readonly client: PassportClient,
    readonly options: PassportRuntimeOptions,
    private readonly shared: { publicDataProvider: unknown; zkConfigProvider: unknown; proofProvider: unknown },
  ) {}

  static async load(options: PassportRuntimeOptions): Promise<PassportRuntime> {
    const managedPath = resolve(options.managedPath);
    const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
    setNetworkId(options.networkId as never);
    const client = await importClient();
    const binding = bindingCheck(readExpectedVk(client), managedPath);

    const { indexerPublicDataProvider } = await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider');
    const { NodeZkConfigProvider, nodeZkConfigRegistry } =
      await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
    const { httpClientProofProvider } = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');
    if (!('WebSocket' in globalThis)) {
      const { WebSocket } = await import('ws');
      (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
    }
    const pdp = indexerPublicDataProvider(options.indexerUrl, options.indexerWsUrl) as unknown as Record<
      string,
      (...a: unknown[]) => Promise<unknown>
    >;
    for (const name of ['watchForTxData', 'watchForDeployTxData']) {
      const original = pdp[name];
      if (typeof original === 'function') pdp[name] = retryOnDrop(name, original.bind(pdp), options.log);
    }
    const shared = {
      publicDataProvider: pdp,
      zkConfigProvider: new NodeZkConfigProvider(join(managedPath, 'account')),
      proofProvider: httpClientProofProvider(options.proofServerUrl, await nodeZkConfigRegistry(managedPath), {
        timeout: options.proofTimeoutMs ?? 900_000,
      }),
    };
    options.log.info('passport runtime loaded', { circuits: binding.circuits, network: options.networkId });
    return new PassportRuntime(client, { ...options, managedPath }, shared);
  }

  /** The indexer-backed public data provider every job shares (the bridge's relayer reads the
   *  vault's request records through it). */
  get publicDataProvider(): unknown {
    return this.shared.publicDataProvider;
  }

  /** The compiled account (the MN Bank shape), with the coin-store witnesses and the key
   *  volume's assets. */
  compiledAccount(): unknown {
    const { compactJs, contract, shape, witnesses } = this.client;
    const { CompiledContract } = compactJs;
    return CompiledContract.make('account', shape.restrictToAccountShape(contract.Contract) as never).pipe(
      CompiledContract.withWitnesses(witnesses.makeWitnesses() as never),
      CompiledContract.withCompiledFileAssets(join(this.options.managedPath, 'account')),
    );
  }

  /** Providers for one job: shared read and prove paths, the sponsor wallet, and a private
   *  state that lives only as long as the job. */
  async providers(
    wallet: SponsorWalletHandle,
    privateState = new MemoryPrivateStateProvider(),
  ): Promise<PassportProviders & { walletProvider: RelayWalletProvider }> {
    const walletProvider = walletProviderFor(wallet, {
      txTtlMs: this.options.txTtlMs ?? 60_000,
      log: this.options.log,
    });
    await walletProvider.ready;
    return {
      privateStateProvider: privateState,
      ...this.shared,
      walletProvider,
      midnightProvider: walletProvider,
    };
  }

  /** The account's public ledger state, or null when there is no contract at the address. */
  async ledgerState(account: string): Promise<AccountLedger | null> {
    const pdp = this.shared.publicDataProvider as { queryContractState(a: string): Promise<{ data: unknown } | null> };
    const state = await pdp.queryContractState(account);
    if (!state) return null;
    return this.client.contract.ledger(state.data as never) as AccountLedger;
  }
}

/** The fields of the account's ledger the relay reads. */
export interface AccountLedger {
  readonly booted: boolean;
  readonly device_count: bigint;
  readonly device_epoch: bigint;
  readonly auth_nonce: bigint;
  readonly inbox_count: bigint;
  readonly enc_key: Uint8Array;
  readonly evm_domain_salt: Uint8Array;
  readonly vault_address: { bytes: Uint8Array };
  devices: { member(e: Uint8Array): boolean; [Symbol.iterator](): Iterator<Uint8Array> };
  inbox: { member(k: bigint): boolean; lookup(k: bigint): Uint8Array };
}

function readExpectedVk(client: PassportClient): Record<string, string> {
  return (client.compiled as { expectedVk?: Record<string, string> }).expectedVk ?? {};
}

/** Retry an indexer finalisation wait that drops mid-connection ("Premature close"), as the
 *  reference client does. */
function retryOnDrop(
  name: string,
  fn: (...args: unknown[]) => Promise<unknown>,
  log: Logger,
): (...args: unknown[]) => Promise<unknown> {
  return async (...args: unknown[]) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn(...args);
      } catch (e) {
        if (attempt > 3 || !/Premature close/.test(String(e))) throw e;
        log.warn('indexer wait dropped; retrying', { name, attempt });
        await new Promise((r) => setTimeout(r, Math.min(3000, 500 * attempt)));
      }
    }
  };
}
