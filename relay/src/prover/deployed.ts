// The verifier keys of the contracts the relay calls but does not deploy: the vault and the Signet
// singleton, as PR #4 deployed them on stagenet. Their SHA-256 hashes come from the vendored
// deployment record (packages/core/src/tokens/deployments/stagenet-vault.json, provenance in the
// PROVENANCE.md beside it), so a key volume built from other sources is refused at start-up
// (./keys.ts). The local stack deploys its own vault per run, so it has no record to check.

import type { NetworkName } from '@mnbank/core';

import { artefacts, vaultContractAddress } from '../../../packages/core/src/tokens/deployments/stagenet-vault.json';
import { KEY_VOLUME_CONTRACTS } from './required.js';

/** "<contract>/<circuit>" → the deployed verifier key's SHA-256, for `network` and `vault`. */
export function deployedVerifierKeys(network: NetworkName, vaultAddress: string): Record<string, string> {
  if (network !== 'stagenet') return {};
  // A deployment pointed at another vault (BRIDGE_VAULT_ADDRESS) has no record here.
  if (vaultAddress.replace(/^0x/, '').toLowerCase() !== vaultContractAddress) return {};
  const out: Record<string, string> = {};
  for (const [c, sha] of Object.entries(artefacts.vault.verifierKeys)) out[`${KEY_VOLUME_CONTRACTS.vault}/${c}`] = sha;
  for (const [c, sha] of Object.entries(artefacts.signetSigner.verifierKeys))
    out[`${KEY_VOLUME_CONTRACTS.signet}/${c}`] = sha;
  return out;
}
