// The sponsor wallet session: ONE long-lived, synced wallet that pays every DUST fee. Lanes get
// exclusive use of it through `withWallet`, so transactions are balanced one at a time.

import { FifoLock } from '../queue/fifo-lock.js';

export type SponsorState = 'disabled' | 'starting' | 'syncing' | 'synced' | 'error' | 'stopped';

export interface SponsorStatus {
  configured: boolean;
  state: SponsorState;
  synced: boolean;
  /** DUST balance in specks (10^-15 DUST), or null when unknown. */
  dustSpecks: bigint | null;
  /** A public, secret-free description of the last failure. */
  error?: string;
}

/** The wallet handle a lane receives. Opaque here; the facade session defines its shape. */
export type SponsorWallet = unknown;

export interface SponsorSession {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): SponsorStatus;
  /** Run `fn` with exclusive use of the wallet. Refuses when the wallet is not synced. */
  withWallet<T>(fn: (wallet: SponsorWallet) => Promise<T>): Promise<T>;
}

export class SponsorUnavailableError extends Error {
  override name = 'SponsorUnavailableError';
}

/** No sponsor configured: health says so and every spending action is refused. */
export class DisabledSponsorSession implements SponsorSession {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  status(): SponsorStatus {
    return { configured: false, state: 'disabled', synced: false, dustSpecks: null };
  }
  async withWallet<T>(): Promise<T> {
    throw new SponsorUnavailableError('the relay has no sponsor wallet configured');
  }
}

/** Shared by real sessions: the exclusive-use lock. */
export abstract class ExclusiveSponsorSession implements SponsorSession {
  private readonly walletLock = new FifoLock();
  private seq = 0;

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract status(): SponsorStatus;
  protected abstract wallet(): SponsorWallet;

  async withWallet<T>(fn: (wallet: SponsorWallet) => Promise<T>): Promise<T> {
    if (!this.status().synced) throw new SponsorUnavailableError('the sponsor wallet is not synced yet');
    const release = await this.walletLock.acquire(`w${++this.seq}`);
    try {
      return await fn(this.wallet());
    } finally {
      release();
    }
  }
}
