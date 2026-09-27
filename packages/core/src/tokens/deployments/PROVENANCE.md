# Vendored deployment records

These two files are copied **byte for byte** from `acedward/passport` (PR #4, the canonical
Midnight bridge), so the token registry is configuration taken from the bridge's own records.
Do not edit them by hand: re-vendor them from a newer commit and update this table.

| File | Upstream path | Commit | Git blob | SHA-256 |
|---|---|---|---|---|
| `stagenet-vault.json` | `contract/contracts/erc20-vault/deployments/stagenet-vault.json` | `2178b57a5b9ad7d106aa188d80309b7101697824` | `9c302bf177fa179bfe2f7290a1e0f4b0696dd828` | `a32253517be6dfd45a7c12fca2c12622514eed9834d60c49898b92c8ba653e3f` |
| `sepolia-stk.json` | `contract/contracts/erc20-vault/deployments/sepolia-stk.json` | `2178b57a5b9ad7d106aa188d80309b7101697824` | `4ea866e05986c9ac3755d81e7accf3635df8e56f` | `0c9718001ad5e58ef7fb46de740ba1c9cd452d5257a465c6a4ada99918e7bee7` |

Vendored 2026-09-27. `test/tokens.test.ts` re-checks both SHA-256 values.

## What the registry takes from them

- `stagenet-vault.json`: the vault (`vaultContractAddress`, `vaultEvmAddress`), the Signet
  singleton, the MPC root key and output cache, and `bridgedTokens` (ERC20 address, Midnight
  name and colour, decimals) for stkA, stkB, stkC and USDC.
- `sepolia-stk.json`: the stock ERC20s' symbols, decimals and supply on Sepolia.

## USDC is provisional

At `2178b57` the vault record lists Circle's Sepolia USDC
(`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`) bridged as **wUSDC**, confirmed by one deposit.
The owner's canonical token list is expected in PR #4's description. Until it appears, the
registry marks the USDC entry `provisional: true`, and the UI may say so.
