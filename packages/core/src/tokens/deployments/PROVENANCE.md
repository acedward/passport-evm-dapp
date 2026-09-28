# Vendored deployment records

These two files are copied **byte for byte** from `acedward/passport` (PR #4, the canonical
Midnight bridge), so the token registry is configuration taken from the bridge's own records.
Do not edit them by hand: re-vendor them from a newer commit and update this table.

| File | Upstream path | Commit | Git blob | SHA-256 |
|---|---|---|---|---|
| `stagenet-vault.json` | `contract/contracts/erc20-vault/deployments/stagenet-vault.json` | `07d8ea4f4e83ad264b3d2eef536be02047308827` | `b899671df7c01a84ad5c58e1527a7e9613486998` | `5a0a2538d12ed8e1814fbf97c410bebcc333ab737316960673d58f0005ea4d4c` |
| `sepolia-stk.json` | `contract/contracts/erc20-vault/deployments/sepolia-stk.json` | `07d8ea4f4e83ad264b3d2eef536be02047308827` | `4ea866e05986c9ac3755d81e7accf3635df8e56f` | `0c9718001ad5e58ef7fb46de740ba1c9cd452d5257a465c6a4ada99918e7bee7` |

Vendored 2026-09-27 from `2178b57`, re-vendored the same day from `07d8ea4` (PR #4's head when its
description published the canonical addresses). Between the two commits only the vault record's
run history changed (`updatedUtc` and the two 10,000-token P8 runs); every field the dApp ships
(the vault, its EVM account, the singleton, the MPC key and cache, `explorer`, `bridgedTokens`)
is identical, and `sepolia-stk.json` is byte-identical. `test/tokens.test.ts` re-checks both
SHA-256 values.

## What the registry takes from them

- `stagenet-vault.json`: the vault (`vaultContractAddress`, `vaultEvmAddress`), the Signet
  singleton, the MPC root key and output cache, and `bridgedTokens` (ERC20 address, Midnight
  name and colour, decimals) for stkA, stkB, stkC and USDC.
- `sepolia-stk.json`: the stock ERC20s' symbols, decimals and supply on Sepolia.

## USDC is canonical

PR #4's description lists its canonical addresses at `07d8ea4`, and they match these records:
Circle's Sepolia USDC (`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`) is bridged by vault
`7771c9e5…cd637` as **wUSDC**, colour
`e5afe273bcb1252cfbc81ad6ca1caaafe22312c8c29f9b104a2fe3ead980bb2d`, 6 decimals. The registry
therefore no longer marks the USDC entry provisional (it was `provisional: true` while vendored
from `2178b57`, before that list existed).
