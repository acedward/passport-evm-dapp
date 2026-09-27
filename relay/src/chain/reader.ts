// Public chain reads the relay serves to the browser: an account's ledger state and its inbox
// ciphertexts (the browser decrypts; the relay never sees the secret). A localnet indexer sends
// no CORS headers, and the relay keeps the parsing of ledger state off the browser (plan P0.4).
//
// L-ACC implements this over the indexer; P1 ships the interface and a stub that says so.

export interface AccountStateView {
  account: string;
  booted: boolean;
  deviceCount: number;
  authNonce: string;
  inboxCount: number;
  /** The account's encryption public key (hex). */
  encKey: string;
  vault: string;
}

export interface InboxPage {
  account: string;
  from: number;
  /** 192-byte entries as hex, in inbox order from `from`. */
  entries: string[];
  total: number;
}

export interface ChainReader {
  accountState(account: string): Promise<AccountStateView | null>;
  inbox(account: string, from: number, limit: number): Promise<InboxPage | null>;
}

export class ChainReadNotImplementedError extends Error {
  override name = 'ChainReadNotImplementedError';
}

export const notImplementedChainReader: ChainReader = {
  async accountState() {
    throw new ChainReadNotImplementedError('account reads land with plan lane L-ACC');
  },
  async inbox() {
    throw new ChainReadNotImplementedError('inbox reads land with plan lane L-ACC');
  },
};
