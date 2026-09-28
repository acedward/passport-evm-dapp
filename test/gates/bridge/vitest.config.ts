import { defineConfig } from 'vitest/config';

// The offline half of the G-BRIDGE gate: the relay composition's pure helpers. The live gate
// (gate.ts) runs against stagenet and Sepolia only through run-gate.sh, never in CI.
export default defineConfig({
  test: {
    name: 'gate-bridge',
    environment: 'node',
    include: ['*.test.ts'],
  },
});
