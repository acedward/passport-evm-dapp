// The sponsor wallet as midnight-js's wallet and midnight providers: it balances every Passport
// transaction with DUST (and, for a debit, nothing else: the account's own coin pays the
// payment) and submits it.
//
// A port of the pinned reference client's `createProviders` wallet half
// (vendor/passport/contract/src/node/wallet.ts @ 51c1fb4), with the wallet handed in by the
// sponsor session instead of opened from the environment.

import type { Logger } from '../log.js';

/** What the sponsor session's `withWallet` hands a lane (see ../sponsor/facade.ts). */
export interface SponsorWalletHandle {
  wallet: {
    state(): { pipe(...ops: unknown[]): unknown };
    balanceUnboundTransaction(tx: unknown, keys: unknown, opts: { ttl: Date }): Promise<unknown>;
    signRecipe(recipe: unknown, sign: (payload: Uint8Array) => Promise<unknown>): Promise<unknown>;
    finalizeRecipe(recipe: unknown): Promise<unknown>;
    submitTransaction(tx: unknown): Promise<unknown>;
    estimateTransactionFee?(tx: unknown, dustSecretKey: unknown, opts: { ttl: Date }): Promise<unknown>;
  };
  shieldedSecretKeys: unknown;
  dustSecretKey: unknown;
  unshieldedKeystore: { signDataAsync(payload: Uint8Array): Promise<unknown> };
}

export interface SubmittedTx {
  txId: string;
  at: number;
}

export interface RelayWalletProvider {
  getCoinPublicKey(): string;
  getEncryptionPublicKey(): string;
  balanceTx(tx: unknown, ttl?: Date): Promise<unknown>;
  submitTx(tx: unknown): Promise<string>;
  /** Every transaction this provider submitted successfully, in order. */
  readonly submitted: SubmittedTx[];
}

const errorText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** The coin and encryption public keys of the synced wallet, read once per provider. */
export async function syncedKeys(
  handle: SponsorWalletHandle,
): Promise<{ coinPublicKey: string; encryptionPublicKey: string }> {
  const Rx = await import('rxjs');
  const state = (await Rx.firstValueFrom(
    handle.wallet.state().pipe(Rx.filter((s: unknown) => (s as { isSynced?: boolean }).isSynced === true)) as never,
  )) as { shielded: { coinPublicKey: { toHexString(): string }; encryptionPublicKey: { toHexString(): string } } };
  return {
    coinPublicKey: state.shielded.coinPublicKey.toHexString(),
    encryptionPublicKey: state.shielded.encryptionPublicKey.toHexString(),
  };
}

export function walletProviderFor(
  handle: SponsorWalletHandle,
  opts: { txTtlMs: number; log: Logger; keys?: { coinPublicKey: string; encryptionPublicKey: string } },
): RelayWalletProvider & { ready: Promise<void> } {
  let keys = opts.keys ?? null;
  const ready = keys
    ? Promise.resolve()
    : syncedKeys(handle).then((k) => {
        keys = k;
      });
  const need = () => {
    if (!keys) throw new Error('the sponsor wallet keys are not read yet (await provider.ready)');
    return keys;
  };
  const submitted: SubmittedTx[] = [];

  // The wallet's DUST view lags the chain by a sync cycle; a transaction built before enough DUST
  // has generated fails to balance. Poll the fee estimate until the wallet can cover it.
  const waitForDust = async (tx: unknown, ttl: Date) => {
    if (!handle.wallet.estimateTransactionFee) return;
    const deadline = Date.now() + 600_000;
    let waiting = false;
    for (;;) {
      try {
        await handle.wallet.estimateTransactionFee(tx, handle.dustSecretKey, { ttl });
        return;
      } catch (e) {
        if (!/insufficient funds|could not balance dust/i.test(errorText(e))) throw e;
      }
      if (!waiting) opts.log.info('waiting for the sponsor wallet to generate enough DUST');
      waiting = true;
      if (Date.now() >= deadline) throw new Error('timed out waiting for enough DUST for the fee');
      await new Promise((r) => setTimeout(r, 5_000));
    }
  };

  return {
    ready,
    submitted,
    getCoinPublicKey: () => need().coinPublicKey,
    getEncryptionPublicKey: () => need().encryptionPublicKey,
    async balanceTx(tx: unknown, ttl?: Date) {
      // Node 2.x enforces a short fee window: keep the TTL short (the reference client's note).
      const transactionTtl = ttl ?? new Date(Date.now() + opts.txTtlMs);
      await waitForDust(tx, transactionTtl);
      const recipe = await handle.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: handle.shieldedSecretKeys, dustSecretKey: handle.dustSecretKey },
        { ttl: transactionTtl },
      );
      const signed = await handle.wallet.signRecipe(recipe, (payload) =>
        handle.unshieldedKeystore.signDataAsync(payload),
      );
      return handle.wallet.finalizeRecipe(signed);
    },
    async submitTx(tx: unknown) {
      const id = String(await handle.wallet.submitTransaction(tx));
      submitted.push({ txId: id, at: Date.now() });
      return id;
    },
  };
}
