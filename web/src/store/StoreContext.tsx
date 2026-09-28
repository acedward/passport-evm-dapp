import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';

import { probeStorage, type StorageStatus } from './probe.js';
import { LocalStore } from './store.js';

export interface StoreState {
  status: StorageStatus;
  /** null when this browser will not let the bank keep data. */
  store: LocalStore | null;
  /** Changes whenever any record changes, here or in another tab. */
  revision: number;
}

const StoreCtx = createContext<StoreState | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const { status, store } = useMemo(() => {
    const probe = probeStorage();
    return {
      status: probe.status,
      store: probe.status === 'ok' && probe.storage ? new LocalStore(probe.storage) : null,
    };
  }, []);

  const revision = useSyncExternalStore(
    (onChange) => {
      if (!store) return () => {};
      const off = store.subscribe(() => {
        counter.value++;
        onChange();
      });
      return off;
    },
    () => counter.value,
  );

  useEffect(() => (store ? store.attach(window) : undefined), [store]);

  return <StoreCtx.Provider value={{ status, store, revision }}>{children}</StoreCtx.Provider>;
}

const counter = { value: 0 };

export function useStore(): StoreState {
  const v = useContext(StoreCtx);
  if (!v) throw new Error('useStore outside StoreProvider');
  return v;
}
