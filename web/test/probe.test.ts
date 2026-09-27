import { describe, expect, it } from 'vitest';

import { probeStorage } from '../src/store/probe.js';

describe('probeStorage', () => {
  it('accepts a working localStorage and leaves no probe key behind', () => {
    localStorage.clear();
    const r = probeStorage();
    expect(r.status).toBe('ok');
    expect(localStorage.length).toBe(0);
  });

  it('reports storage that throws on access as blocked', () => {
    const r = probeStorage(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(r).toEqual({ status: 'blocked', storage: null });
  });

  it('reports a missing storage as unavailable, and a full one as full', () => {
    expect(probeStorage(() => null).status).toBe('unavailable');
    const full = {
      setItem() {
        throw new DOMException('full', 'QuotaExceededError');
      },
      getItem: () => null,
      removeItem() {},
    } as unknown as Storage;
    expect(probeStorage(() => full).status).toBe('full');
  });
});
