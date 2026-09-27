// Every circuit the relay PROVES, as "<contract>/<circuit>" in the key volume's layout (plan P4-A,
// "key-volume completeness"). The start-up check (./keys.ts `verifyKeyVolume`) refuses to start the
// relay when any of them lacks its prover key, verifier key or ZKIR, so a missing key is found at
// deploy time instead of in a customer's job an hour later.
//
// Where each one is proven:
//   account/activate_initial_device_with_evm   registration (actions/account-actions.ts)
//   account/withdraw_shielded_with_evm         a shielded withdrawal (actions/account-actions.ts)
//   account/append_inbox_with_evm              re-filing a change coin's entry, Q13 (actions/account-actions.ts)
//   account/bridge_* (5)                       the bridge starts and settles (bridge/live-backend.ts)
//   account/open_swap_shielded_with_evm        making and taking offers (trade/account-offer.ts)
//   Erc20Vault/startDeposit, startWithdraw     called by the account's bridge starts
//   Erc20Vault/completeDeposit, completeWithdraw, refundWithdraw
//                                              called by the account's bridge settles
//   Erc20Vault/abandonDeposit                  closing a never-executed deposit, Q21 A (bridge/live-backend.ts)
//   SignetSigner/signBidirectional             called by the vault's two starts
//
// relay/test/key-completeness.test.ts checks that every circuit name the relay's sources call is listed
// here, and that every account circuit here is in the MN Bank account shape.

// Plain names, no import of ../passport/account-shape.ts: that module loads the Passport client,
// which needs the compiled contracts, and this list is read at start-up before (and without) any
// key volume. The test checks these names against account-shape's lists.
export const ACCOUNT_PROVEN_CIRCUITS = [
  'activate_initial_device_with_evm',
  'withdraw_shielded_with_evm',
  'append_inbox_with_evm',
  'bridge_deposit_start_with_evm',
  'bridge_withdraw_start_with_evm',
  'bridge_deposit_complete',
  'bridge_withdraw_complete',
  'bridge_withdraw_refund',
  'open_swap_shielded_with_evm',
] as const;

export const VAULT_PROVEN_CIRCUITS = [
  'startDeposit',
  'completeDeposit',
  'abandonDeposit',
  'startWithdraw',
  'completeWithdraw',
  'refundWithdraw',
] as const;

export const SIGNET_PROVEN_CIRCUITS = ['signBidirectional'] as const;

/** The contract directories of the key volume the relay reads. */
export const KEY_VOLUME_CONTRACTS = { account: 'account', vault: 'Erc20Vault', signet: 'SignetSigner' } as const;

export const RELAY_PROVEN_CIRCUITS: readonly string[] = [
  ...ACCOUNT_PROVEN_CIRCUITS.map((c) => `${KEY_VOLUME_CONTRACTS.account}/${c}`),
  ...VAULT_PROVEN_CIRCUITS.map((c) => `${KEY_VOLUME_CONTRACTS.vault}/${c}`),
  ...SIGNET_PROVEN_CIRCUITS.map((c) => `${KEY_VOLUME_CONTRACTS.signet}/${c}`),
];
