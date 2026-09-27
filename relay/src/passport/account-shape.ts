// The shape of every MN Bank account: the `evm` arm, the five bridge circuits and the offer
// circuit (plan L-ACC.1: `contractForBridgeAccount(['evm'], {withSwap: true})` deployed in the
// waves `bridgeWaves({withSwap: true})`).
//
// VENDORED LOGIC (Q12 option C, a client-only shim). Upstream: acedward/passport @
// 51c1fb4ad164af034c8ed60fbb047e43cdd509f5, `contract/src/wallet/bridge.ts`
// (`BRIDGE_GATED_BASES`, `BRIDGE_SETTLE_CIRCUITS`, `SWAP_CIRCUIT`, `bridgeWaves`,
// `contractForBridgeAccount`). The relay does not import `bridge.ts` itself, because that module
// also loads the vault's pre-0.23 relayer and the Sig Network SDK through relative file paths,
// none of which registering an account needs. relay/test/account-shape.test.ts compares these
// lists with upstream's on every run.
//
// The circuit ids are the deployed contract's IDENTITY: a client whose compiled contract lists
// circuits the account does not carry cannot connect to it (findDeployedContract compares every
// verifier key), so this list must stay equal to what was deployed.

import { accountCircuits, defaultWaves } from '../../../vendor/passport/contract/src/wallet/wave-deploy.js';

export const BRIDGE_CIRCUITS = [
  'bridge_deposit_start_with_evm',
  'bridge_withdraw_start_with_evm',
  'bridge_deposit_complete',
  'bridge_withdraw_complete',
  'bridge_withdraw_refund',
] as const;

export const SWAP_CIRCUIT = 'open_swap_shielded_with_evm';

/** Wave 1 (the node's measured ceiling of 8 operations) and wave 2 (the `evm` overflow, the
 *  bridge and the offer circuit, inserted by the maintenance update that retires the authority). */
export function accountWaves(): { waveOne: string[]; waveTwo: string[] } {
  const waves = defaultWaves('evm');
  return { waveOne: waves.waveOne, waveTwo: [...waves.waveTwo, ...BRIDGE_CIRCUITS, SWAP_CIRCUIT] };
}

/** Every circuit an MN Bank account carries. */
export function accountCircuitIds(): string[] {
  return [...accountCircuits(['evm']), ...BRIDGE_CIRCUITS, SWAP_CIRCUIT];
}

/** The compiled account contract restricted to the circuits an MN Bank account carries. */
export function restrictToAccountShape<C extends new (...args: never[]) => object>(Contract: C): C {
  const keep = new Set(accountCircuitIds());
  const Base = Contract as unknown as new (...args: unknown[]) => { provableCircuits: Record<string, unknown> };
  class MnBankAccountContract extends Base {
    constructor(...args: unknown[]) {
      super(...args);
      for (const id of Object.keys(this.provableCircuits)) if (!keep.has(id)) delete this.provableCircuits[id];
    }
  }
  return MnBankAccountContract as unknown as C;
}
