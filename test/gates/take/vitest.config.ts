import { defineConfig } from 'vitest/config';

// The offline half of the G-TAKE gate: the swapoffer1 codec, the transaction-structure readers,
// the take merge helper, the partition steering and the relay-assisted take's orchestration. The
// live gate (gate.ts) runs only on a local stack through run-gate.sh, never in CI.
export default defineConfig({
  test: {
    name: 'gate-take',
    environment: 'node',
    include: ['*.test.ts'],
  },
});
