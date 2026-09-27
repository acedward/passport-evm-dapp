// Moved to relay/src/trade/batcher-client.ts (plan L-TRD): the relay's trade executors use it. This re-export
// keeps the G-TAKE gate (gate.ts) and its offline tests pointing at the same code.
export * from '../../../relay/src/trade/batcher-client.js';
