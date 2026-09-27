// The relay's /health as the error walkthroughs serve it (plan P4-A): healthy by default, with the
// one field each walkthrough breaks.

export function healthBody(
  opts: {
    dustLow?: boolean;
    syncing?: boolean;
    proverDown?: boolean;
    vaultGasLow?: boolean;
    batcherDown?: boolean;
    batcherRefusal?: number;
    mpcTimeouts?: number;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return {
    status: opts.proverDown ? 'down' : opts.dustLow || opts.vaultGasLow || opts.batcherDown ? 'degraded' : 'ok',
    network: 'stagenet',
    version: 'e2e',
    uptimeSeconds: 60,
    sponsor: {
      configured: true,
      state: opts.syncing ? 'syncing' : 'synced',
      synced: !opts.syncing,
      dustSpecks: opts.dustLow ? '3000000000000000' : '50000000000000000000',
      dustLow: !!opts.dustLow,
    },
    proofServer: {
      reachable: !opts.proverDown,
      version: '9.0.0-rc.6',
      jobCapacity: 10,
      keys: { present: true, fingerprint: 'f'.repeat(64), pinned: true, matchesPin: true, complete: true, problems: 0 },
    },
    queue: { jobs: 0, lanes: {} },
    kernel: { reachable: true, synced: true },
    batcher: {
      reachable: !opts.batcherDown,
      lastRefusal: opts.batcherRefusal ? { httpStatus: opts.batcherRefusal, at: now - 30 } : null,
    },
    vaultGas: {
      address: '0x648216975e722494bFF92E88FFc68C8F8d438FaA',
      balanceWei: opts.vaultGasLow ? '1428415000000000' : '20000000000000000',
      low: !!opts.vaultGasLow,
    },
    bridge: {
      available: true,
      mpc: { lastSignatureAfterSeconds: 110, timeouts24h: opts.mpcTimeouts ?? 0, inFlight: 0 },
      staleRequests: {
        enabled: true,
        lastScanAt: now - 60,
        open: { deposit: 0, withdraw: 0 },
        waiting: 0,
        closing: 0,
        closed24h: 0,
        maxPerDay: 24,
        recent: [],
        paused: null,
      },
    },
  };
}
