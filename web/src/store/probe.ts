// Is localStorage usable here? A private window, blocked site data or a full quota all make the
// dApp unable to keep an account in this browser, and the page must say so (spec edge cases).

export type StorageStatus = 'ok' | 'blocked' | 'full' | 'unavailable';

const PROBE_KEY = 'mn-bank/probe';

/** Returns the Storage if it can be read and written, with the reason when it cannot. */
export function probeStorage(get: () => Storage | null | undefined = () => globalThis.localStorage): {
  status: StorageStatus;
  storage: Storage | null;
} {
  let storage: Storage | null | undefined;
  try {
    storage = get();
  } catch {
    return { status: 'blocked', storage: null };
  }
  if (!storage) return { status: 'unavailable', storage: null };
  try {
    storage.setItem(PROBE_KEY, '1');
    const ok = storage.getItem(PROBE_KEY) === '1';
    storage.removeItem(PROBE_KEY);
    return ok ? { status: 'ok', storage } : { status: 'blocked', storage: null };
  } catch (e) {
    const name = (e as { name?: string } | null)?.name ?? '';
    if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return { status: 'full', storage };
    return { status: 'blocked', storage: null };
  }
}
