// The bank's status as the page knows it (plan P4-A error states): /health read when the page
// opens, every minute, and when the tab comes back into view. Pages ask `useBankStatus()` for the
// notices of their place (./status.ts) and for whether an action would be refused, so a paused
// action is explained BEFORE the wallet is asked to sign anything.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Notice } from '../design/index.js';
import { RelayClient } from './client.js';
import { bankNotices, spendingPaused, withdrawalsPaused, type BankState, type NoticePlace } from './status.js';

export const HEALTH_POLL_MS = 60_000;

interface BankStatusValue extends BankState {
  refresh(): Promise<void>;
}

const Ctx = createContext<BankStatusValue | null>(null);

export function BankStatusProvider({
  relayUrl,
  pollMs = HEALTH_POLL_MS,
  children,
}: {
  relayUrl: string;
  pollMs?: number;
  children: ReactNode;
}) {
  const relay = useMemo(() => new RelayClient(relayUrl), [relayUrl]);
  const [state, setState] = useState<BankState>({ health: null, reachable: null, checkedAt: null });
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(() => {
    if (!inFlight.current) {
      inFlight.current = relay
        .health()
        .then(
          (health) => setState({ health, reachable: true, checkedAt: Date.now() }),
          (e: unknown) => {
            const unreachable = (e as { code?: string } | null)?.code === 'unreachable';
            setState((s) => ({
              // A body that is not a health report (a proxy error page): keep the last report.
              health: unreachable ? null : s.health,
              reachable: unreachable ? false : s.reachable,
              checkedAt: Date.now(),
            }));
          },
        )
        .finally(() => {
          inFlight.current = null;
        });
    }
    return inFlight.current;
  }, [relay]);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const every = setInterval(() => void refresh(), pollMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(first);
      clearInterval(every);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, pollMs]);

  const value = useMemo(() => ({ ...state, refresh }), [state, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Outside a provider (a component test), the bank is simply "not read yet". */
const UNKNOWN: BankStatusValue = { health: null, reachable: null, checkedAt: null, refresh: async () => {} };

export function useBankStatus(): BankStatusValue & {
  /** Why actions the bank pays fees for are paused now, or null. */
  spendingPaused: string | null;
  /** Why withdrawals to Sepolia are paused now, or null. */
  withdrawalsPaused: string | null;
} {
  const v = useContext(Ctx) ?? UNKNOWN;
  return { ...v, spendingPaused: spendingPaused(v), withdrawalsPaused: withdrawalsPaused(v) };
}

/** The notices of one place, as design-system Notices (each with its own test id). */
export function BankNotices({ place, className }: { place: NoticePlace; className?: string }) {
  const s = useBankStatus();
  const notices = bankNotices(s).filter((n) => n.place === place);
  if (notices.length === 0) return null;
  return (
    <>
      {notices.map((n) => (
        <Notice
          key={n.id}
          tone={n.tone}
          role="status"
          title={n.title}
          className={className}
          data-testid={`bank-${n.id}`}
        >
          {n.text}
        </Notice>
      ))}
    </>
  );
}
