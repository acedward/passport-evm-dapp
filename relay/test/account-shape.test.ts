// The vendored account shape (relay/src/passport/account-shape.ts) must equal upstream's
// `bridgeWaves({withSwap: true})` and `contractForBridgeAccount(['evm'], {withSwap: true})` at the
// pinned commit: the circuit list IS a deployed account's identity.

import { describe, expect, it } from 'vitest';

import { Contract } from '../../vendor/passport/contract/src/wallet/contract.js';
import { makeWitnesses } from '../../vendor/passport/contract/src/wallet/witnesses.js';
import { accountCircuitIds, accountWaves, restrictToAccountShape } from '../src/passport/account-shape.js';

describe('the MN Bank account shape', () => {
  it('equals upstream bridge.ts at the pinned commit', async () => {
    const upstream = await import('../../vendor/passport/contract/src/wallet/bridge.js');
    expect(accountWaves()).toEqual(upstream.bridgeWaves({ withSwap: true }));
    const ours = new (restrictToAccountShape(Contract))(makeWitnesses() as never) as { provableCircuits: object };
    const theirs = new (upstream.contractForBridgeAccount(['evm'], { withSwap: true }))(makeWitnesses() as never) as {
      provableCircuits: object;
    };
    expect(Object.keys(ours.provableCircuits).sort()).toEqual(Object.keys(theirs.provableCircuits).sort());
  });

  it('is the 16 circuits P0.5 deployed: 8 in wave 1, 8 in wave 2', () => {
    const { waveOne, waveTwo } = accountWaves();
    expect(waveOne).toHaveLength(8);
    expect(waveTwo).toHaveLength(8);
    expect([...waveOne, ...waveTwo].sort()).toEqual([...accountCircuitIds()].sort());
    expect(waveTwo).toContain('open_swap_shielded_with_evm');
    expect(waveTwo).toContain('bridge_withdraw_start_with_evm');
    expect(waveOne).toContain('activate_initial_device_with_evm');
    expect(waveOne).toContain('withdraw_shielded_with_evm');
    expect(waveOne).toContain('append_inbox_with_evm');
  });
});
