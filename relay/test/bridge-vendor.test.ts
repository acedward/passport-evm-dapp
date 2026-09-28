// The vendored bridge code stays what it claims to be (Q12 option C: every shim names its upstream
// source and commit): the relayer is upstream's file byte for byte, the SDK shim reaches the same
// @sig-net/midnight 0.23.0 through the root install, and the relayer's pure helpers agree with the
// vault's compiled response schema.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const UPSTREAM = join(ROOT, 'vendor/passport/contract/contracts/erc20-vault/src');
const MARKER = '// ---- upstream relayer.ts below this line ----\n';

describe('the vendored vault relayer', () => {
  it('is upstream relayer.ts byte for byte below its header', () => {
    const ours = readFileSync(join(ROOT, 'relay/src/bridge/vendor/relayer.ts'), 'utf8');
    const i = ours.indexOf(MARKER);
    expect(i).toBeGreaterThan(0);
    expect(ours.slice(i + MARKER.length)).toBe(readFileSync(join(UPSTREAM, 'relayer.ts'), 'utf8'));
    expect(ours.slice(0, i)).toContain('51c1fb4ad164af034c8ed60fbb047e43cdd509f5');
  });

  it('imports only ethers and the shim beside it', () => {
    const src = readFileSync(join(ROOT, 'relay/src/bridge/vendor/relayer.ts'), 'utf8');
    const froms = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(froms).toEqual(['ethers', './signet-sdk.js']);
  });

  it('the shim loads @sig-net/midnight 0.23.0 from the root install, with every export the relayer uses', async () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'node_modules/@sig-net/midnight/package.json'), 'utf8')) as {
      version: string;
    };
    const sdk = await import('../src/bridge/vendor/signet-sdk.js');
    expect(pkg.version).toBe(sdk.SIG_NET_MIDNIGHT_VERSION);
    const upstreamShim = readFileSync(join(UPSTREAM, 'signet-sdk.ts'), 'utf8');
    const relayerUses = [
      'MPC_FAILURE_OUTPUT',
      'MpcOutputCacheReader',
      'requestIdBytes',
      'respondBidirectionalEventToCircuitInput',
      'serializeRespondOutput',
      'signetEventSourceFromIndexer',
      'SignetRequestResponseReader',
      'verifyRespondBidirectionalSignature',
    ];
    for (const name of [
      ...relayerUses,
      'toSignBidirectionalEventIndex',
      'deriveMidnightResponseKey',
      'normaliseSecp256k1PublicKey',
    ]) {
      expect((sdk as Record<string, unknown>)[name], name).toBeDefined();
    }
    // Ours reads the same dist files upstream's shim does, only through the root install.
    const ours = readFileSync(join(ROOT, 'relay/src/bridge/vendor/signet-sdk.ts'), 'utf8');
    const files = [...ours.matchAll(/node_modules\/@sig-net\/midnight\/dist\/([a-z0-9-]+\.js)/g)].map((m) => m[1]);
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(upstreamShim).toContain(`../node_modules/@sig-net/midnight/dist/${f}`);
  });

  it("classifies the three attestable outputs of the vault's compiled response schema", async () => {
    const relayer = await import('../src/bridge/vendor/relayer.js');
    const sdk = await import('../src/bridge/vendor/signet-sdk.js');
    const vault = (await import(
      join(ROOT, 'vendor/passport/contract/contracts/managed/Erc20Vault/contract/index.js')
    )) as { pureCircuits: { vaultResponseSchema(): Uint8Array } };
    const schema = vault.pureCircuits.vaultResponseSchema();
    const kinds = relayer.boolOutputCandidates(schema).map((c) => [c.kind, relayer.classifyOutput(schema, c.bytes)]);
    expect(kinds).toEqual([
      ['success', 'success'],
      ['returned-false', 'returned-false'],
      ['never-executed', 'never-executed'],
    ]);
    expect(relayer.classifyOutput(schema, sdk.MPC_FAILURE_OUTPUT)).toBe('never-executed');
    expect(relayer.POLL_TIMEOUT_MS).toBe(20 * 60_000);
  });
});
