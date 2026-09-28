// The relay composition moved into the relay itself (plan L-BRG.4): relay/src/bridge/relay-compose.ts.
// This re-export keeps the gate (gate.ts, run-gate.sh mounts relay/src/bridge) and its tests working.
export * from '../../../relay/src/bridge/relay-compose.js';
