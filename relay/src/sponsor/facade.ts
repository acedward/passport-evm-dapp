// The real sponsor session: one wallet-sdk facade, opened once, kept synced, watching its DUST.
//
// The SDK is loaded lazily inside `openFacadeWallet`, so importing this module (tests, health)
// costs nothing and never connects anywhere. The wallet construction mirrors the pinned Passport
// client's `createWallet` (vendor/passport/contract/src/node/wallet.ts @ 51c1fb4), with every
// endpoint passed in rather than read from the environment, and the fee margin configurable
// (the SDK default of 100 blocks burns far more DUST than needed; 5 is the tested value).
//
// When a funding-lock path is configured (a live seed shared with other tools), the lock is
// taken BEFORE the wallet opens and released after it closes; a held lock stops the relay.

import type * as HdModule from '@midnightntwrk/wallet-sdk-hd';

import type { Logger } from '../log.js';
import { type FundingLock, takeFundingLock } from './funding-lock.js';
import { ExclusiveSponsorSession, type SponsorState, type SponsorStatus, type SponsorWallet } from './session.js';

export interface WalletEndpoints {
  networkId: string;
  indexerUrl: string;
  indexerWsUrl: string;
  nodeWsUrl: string;
  proofServerUrl: string;
}

export interface OpenedWallet {
  /** What lanes receive through withWallet: the facade and its keys. */
  handle: SponsorWallet;
  subscribe(onState: (s: { synced: boolean; dustSpecks: bigint }) => void, onError: (e: unknown) => void): () => void;
  stop(): Promise<void>;
}

export type WalletFactory = (
  seedHex: string,
  endpoints: WalletEndpoints,
  options: { feeBlocksMargin: number },
) => Promise<OpenedWallet>;

export interface FacadeSessionConfig {
  seedHex: string;
  endpoints: WalletEndpoints;
  feeBlocksMargin: number;
  fundingLockFile: string | null;
  purpose: string;
}

export class FacadeSponsorSession extends ExclusiveSponsorSession {
  private state: SponsorState = 'stopped';
  private synced = false;
  private dust: bigint | null = null;
  private lastError: string | undefined;
  private lock: FundingLock | null = null;
  private opened: OpenedWallet | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly config: FacadeSessionConfig,
    private readonly factory: WalletFactory,
    private readonly log: Logger,
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.state !== 'stopped' && this.state !== 'error') return;
    this.state = 'starting';
    this.lastError = undefined;
    try {
      if (this.config.fundingLockFile) {
        this.lock = takeFundingLock(this.config.fundingLockFile, this.config.purpose);
        this.log.info('funding lock taken', { lockFile: this.config.fundingLockFile });
      }
      this.opened = await this.factory(this.config.seedHex, this.config.endpoints, {
        feeBlocksMargin: this.config.feeBlocksMargin,
      });
      this.state = 'syncing';
      this.unsubscribe = this.opened.subscribe(
        (s) => {
          this.synced = s.synced;
          this.dust = s.dustSpecks;
          if (this.state === 'syncing' || this.state === 'synced') this.state = s.synced ? 'synced' : 'syncing';
        },
        (e) => {
          this.state = 'error';
          this.synced = false;
          this.lastError = 'the sponsor wallet lost its connection';
          this.log.warn('sponsor wallet error', { error: e });
        },
      );
      this.log.info('sponsor wallet opened');
    } catch (e) {
      this.state = 'error';
      this.lastError = 'the sponsor wallet could not be opened';
      this.lock?.release();
      this.lock = null;
      throw e;
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    try {
      await this.opened?.stop();
    } finally {
      this.opened = null;
      this.synced = false;
      this.state = 'stopped';
      this.lock?.release();
      this.lock = null;
    }
  }

  status(): SponsorStatus {
    return {
      configured: true,
      state: this.state,
      synced: this.synced && this.state === 'synced',
      dustSpecks: this.dust,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  protected wallet(): SponsorWallet {
    if (!this.opened) throw new Error('the sponsor wallet is not open');
    return this.opened.handle;
  }
}

// ── The wallet-sdk factory (not exercised in P1: no live wallet is opened) ────

/** No transaction history is kept: the relay reads chain state from the indexer. */
const NoopTxHistoryStorage = {
  gotPending: async () => undefined,
  gotFinalized: async () => undefined,
  gotRejected: async () => undefined,
  getAll: async () => [] as unknown[],
  get: async () => undefined,
  serialize: async () => '[]',
};

export const openFacadeWallet: WalletFactory = async (seedHex, endpoints, options) => {
  const [ledger, facadeMod, dustMod, hdMod, shieldedMod, unshieldedMod] = await Promise.all([
    import('@midnightntwrk/ledger-v9'),
    import('@midnightntwrk/wallet-sdk-facade'),
    import('@midnightntwrk/wallet-sdk-dust-wallet'),
    import('@midnightntwrk/wallet-sdk-hd'),
    import('@midnightntwrk/wallet-sdk-shielded'),
    import('@midnightntwrk/wallet-sdk-unshielded-wallet'),
  ]);
  if (!('WebSocket' in globalThis)) {
    const { WebSocket } = await import('ws');
    (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
  }

  const keys = deriveSponsorKeys(hdMod, seedHex);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys.zswap);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys.dust);
  const unshieldedKeystore = unshieldedMod.createKeystore(
    { kind: 'schnorr', secret: keys.night } as never,
    endpoints.networkId as never,
  );

  const configuration = {
    networkId: endpoints.networkId,
    indexerClientConnection: { indexerHttpUrl: endpoints.indexerUrl, indexerWsUrl: endpoints.indexerWsUrl },
    provingServerUrl: new URL(endpoints.proofServerUrl),
    relayURL: new URL(endpoints.nodeWsUrl),
    costParameters: { feeBlocksMargin: options.feeBlocksMargin },
    txHistoryStorage: NoopTxHistoryStorage,
  };
  type Facade = Awaited<ReturnType<typeof facadeMod.WalletFacade.init>>;
  const init = facadeMod.WalletFacade.init as unknown as (p: Record<string, unknown>) => Promise<Facade>;
  const wallet = await init({
    configuration,
    shielded: (c: never) => shieldedMod.ShieldedWallet(c).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (c: never) =>
      unshieldedMod.UnshieldedWallet(c).startWithPublicKey(unshieldedMod.PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (c: never) =>
      dustMod.DustWallet(c).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });
  await wallet.start(shieldedSecretKeys, dustSecretKey);

  return {
    handle: { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore },
    subscribe(onState, onError) {
      const sub = wallet.state().subscribe({
        next: (s: { isSynced: boolean; dust: { balance(t: Date): unknown } }) =>
          onState({ synced: s.isSynced === true, dustSpecks: s.dust.balance(new Date()) as bigint }),
        error: onError,
      });
      return () => sub.unsubscribe();
    },
    stop: () => wallet.stop(),
  };
};

/** The sponsor's three role keys from its seed (account 0, index 0), as the Passport client
 *  and the Offer Files tools derive them. The HD wallet is cleared after use. */
export function deriveSponsorKeys(
  hd: typeof HdModule,
  seedHex: string,
): { zswap: Uint8Array; night: Uint8Array; dust: Uint8Array } {
  const created = hd.HDWallet.fromSeed(Uint8Array.from(Buffer.from(seedHex, 'hex')));
  if (created.type !== 'seedOk') throw new Error('invalid sponsor seed');
  const derived = created.hdWallet
    .selectAccount(0)
    .selectRoles([hd.Roles.Zswap, hd.Roles.NightExternal, hd.Roles.Dust])
    .deriveKeysAt(0);
  created.hdWallet.clear();
  if (derived.type !== 'keysDerived') throw new Error('sponsor key derivation failed');
  return {
    zswap: derived.keys[hd.Roles.Zswap],
    night: derived.keys[hd.Roles.NightExternal],
    dust: derived.keys[hd.Roles.Dust],
  };
}
