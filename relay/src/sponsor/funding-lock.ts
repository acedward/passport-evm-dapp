// The shared funding-wallet lock. Tools that open a SHARED seed (the owner's live test wallet)
// take this lock first, so two processes never drive one wallet: a second wallet facade on the
// same seed breaks the first one's connection.
//
// Same convention as the Offer Files tools that introduced the lock: the file is created with
// O_CREAT|O_EXCL (mode 600) and holds one JSON line {purpose, pid, host, at}. The holder
// removes it when done. A lock left behind by a crash is removed by hand after checking that
// no process holds the wallet; this code never steals a lock.

import { closeSync, constants, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';

export class FundingLockHeldError extends Error {
  override name = 'FundingLockHeldError';
}

export interface FundingLock {
  readonly path: string;
  release(): void;
}

export function takeFundingLock(path: string, purpose: string): FundingLock {
  let fd: number;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      let holder = 'unknown holder';
      try {
        const h = JSON.parse(readFileSync(path, 'utf8')) as {
          purpose?: unknown;
          pid?: unknown;
          host?: unknown;
          at?: unknown;
        };
        holder = `${String(h.purpose)} (pid ${String(h.pid)} on ${String(h.host)} since ${String(h.at)})`;
      } catch {
        /* unreadable: report it as unknown */
      }
      throw new FundingLockHeldError(
        `the funding wallet is locked by another process: ${holder}; if none is running, remove ${path}`,
      );
    }
    throw e;
  }
  try {
    writeSync(fd, JSON.stringify({ purpose, pid: process.pid, host: hostname(), at: new Date().toISOString() }));
  } finally {
    closeSync(fd);
  }
  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      try {
        const h = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown };
        if (h.pid !== process.pid) return; // not ours any more: leave it alone
        unlinkSync(path);
      } catch {
        /* already gone */
      }
    },
  };
}
