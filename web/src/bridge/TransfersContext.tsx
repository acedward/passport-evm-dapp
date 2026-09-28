// Follows every transfer in flight while the page is open, whichever section is shown (plan
// L-BRG.1–.3): polls its relay job, records each stage and hash in local storage, marks a transfer
// to resume when the relay no longer knows it, and on completion applies the coins. In the tab
// where the customer started or resumed a withdrawal, it also re-files the change (Q13 A: the
// second signature); anywhere else the change shows as "not yet recorded" with a button.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';

import type { NetworkProfile } from '@mnbank/core';

import { syncAccount } from '../passport/operations.js';
import { findAccount, readSecret, type AccountRecord } from '../passport/records.js';
import { RelayClient } from '../relay/client.js';
import { useStore } from '../store/StoreContext.js';
import { useWallet } from '../wallet/WalletContext.js';
import { applyCoins, pendingTransfers, pollTransfer, secureTransferChange, type BridgeEnv } from './operations.js';
import { listTransfers, patchTransfer, type TransferRecord } from './records.js';

interface TransfersValue {
  account: AccountRecord | null;
  hasSecret: boolean;
  env: () => BridgeEnv | null;
  /** This tab started or resumed it: re-file its change automatically when it completes. */
  followActively: (id: string) => void;
}

const Ctx = createContext<TransfersValue | null>(null);

export const POLL_MS = 4_000;

export function TransfersProvider({
  network,
  relayUrl,
  children,
}: {
  network: NetworkProfile;
  relayUrl: string;
  children: ReactNode;
}) {
  const { store, revision } = useStore();
  const wallet = useWallet();
  const relay = useMemo(() => new RelayClient(relayUrl), [relayUrl]);
  const evmAddress = wallet.status === 'connected' ? wallet.address : null;
  const scope = useMemo(() => (evmAddress ? { network: network.name, evmAddress } : null), [evmAddress, network.name]);
  const account = useMemo(
    () => (store && scope ? findAccount(store, scope) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, scope, revision],
  );
  const hasSecret = !!(store && scope && account && readSecret(store, scope, account.address));
  const active = useRef(new Set<string>());
  const finishing = useRef(new Set<string>());

  const env = useCallback((): BridgeEnv | null => {
    if (!store || !scope || !wallet.provider || !wallet.address || store.readOnly) return null;
    return {
      relay,
      store,
      scope,
      provider: wallet.provider,
      owner: wallet.address,
      chainId: network.evm.chainId,
      network,
    };
  }, [store, scope, wallet.provider, wallet.address, relay, network]);

  const finish = useCallback(async (e: BridgeEnv, t: TransferRecord) => {
    if (finishing.current.has(t.id)) return;
    finishing.current.add(t.id);
    try {
      if (!t.applied) {
        applyCoins(e, t);
        await syncAccount(e, t.account).catch(() => undefined);
        patchTransfer(e.store, e.scope, t.account, t.id, (r) => ({ ...r, applied: true }));
      }
      if (t.change && !t.change.secured && !t.change.deferredReason && active.current.has(t.id)) {
        active.current.delete(t.id);
        await secureTransferChange(e, t);
      }
    } catch (err) {
      patchTransfer(e.store, e.scope, t.account, t.id, (r) =>
        r.change && !r.change.secured
          ? {
              ...r,
              change: {
                ...r.change,
                deferredReason: `Not recorded yet: ${err instanceof Error ? err.message : 'the wallet did not sign'}`,
              },
            }
          : r,
      );
    } finally {
      finishing.current.delete(t.id);
    }
  }, []);

  const accountAddress = account?.address ?? null;
  useEffect(() => {
    if (!accountAddress || !hasSecret) return;
    let stopped = false;
    const tick = async () => {
      const e = env();
      if (!e) return;
      for (const t of pendingTransfers(e, accountAddress)) {
        // A transfer to resume is asked about too: the bank may have closed it (plan P4-A).
        if (stopped || (t.state !== 'running' && t.state !== 'needs-resume')) continue;
        try {
          await pollTransfer(e, t);
        } catch {
          /* the relay is unreachable for a moment: the next tick tries again */
        }
      }
      for (const t of listTransfers(e.store, e.scope, accountAddress)) {
        if (stopped) break;
        if (t.state === 'succeeded' && (!t.applied || (t.change && !t.change.secured && active.current.has(t.id)))) {
          await finish(e, t);
        }
      }
    };
    const loop = async () => {
      while (!stopped) {
        await tick();
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    };
    void loop();
    return () => {
      stopped = true;
    };
  }, [accountAddress, hasSecret, env, finish]);

  const value = useMemo<TransfersValue>(
    () => ({
      account,
      hasSecret,
      env,
      followActively: (id: string) => active.current.add(id),
    }),
    [account, hasSecret, env],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTransfers(): TransfersValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTransfers outside TransfersProvider');
  return v;
}
