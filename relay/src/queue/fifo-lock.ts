// A first-in-first-out lock that can say where each waiter stands.

export class FifoLock {
  private holder: string | null = null;
  private readonly waiters: Array<{ id: string; grant: () => void }> = [];

  /** Wait for the lock; resolves to its release function. */
  acquire(id: string): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.holder = id;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.release(id);
        });
      };
      if (this.holder === null && this.waiters.length === 0) grant();
      else this.waiters.push({ id, grant });
    });
  }

  private release(id: string): void {
    if (this.holder !== id) return;
    this.holder = null;
    const next = this.waiters.shift();
    if (next) next.grant();
  }

  /** 1-based place in the queue of a waiter; 0 for the holder; undefined if unknown. */
  position(id: string): number | undefined {
    if (this.holder === id) return 0;
    const i = this.waiters.findIndex((w) => w.id === id);
    return i === -1 ? undefined : i + 1;
  }

  get running(): number {
    return this.holder === null ? 0 : 1;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  get idle(): boolean {
    return this.holder === null && this.waiters.length === 0;
  }
}
