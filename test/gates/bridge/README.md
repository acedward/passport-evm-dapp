# G-BRIDGE — the account-path bridge on Midnight stagenet

A live, script-level gate: a **Passport account** starts a deposit through the ERC20 vault, Sig Network's stagenet MPC signs it, the relay broadcasts the signed Sepolia transaction, and the round trip settles; then the account withdraws the token back to Sepolia. Nothing here runs in CI except the offline tests of the relay composition.

| File | What it is |
|---|---|
| `relay-compose.ts` | Pure helpers for the dApp relay (L-BRG): the request-id match, the options of the vault's `relayRequest`, the signature budget, the resumable JSON codec. Unit tested (`relay-compose.test.ts`, vitest project `gate-bridge`). |
| `gate.ts` | The live driver. One command per step, state outside the repository, resumable by request id. Runs under Bun inside the gate image. |
| `run-gate.sh` | The Docker wrapper: the shared funding-wallet lock, the pinned proof server, memory headroom, read-only mounts of every secret. |

## The request-id rule (why `relay-compose.ts` exists)

Passport's `AccountBridge` (`acedward/passport`, `contract/src/wallet/bridge.ts`) takes "the newest open id in the shared vault" as the id of the request a start just created. The vault is shared by everyone who bridges, so that is a race as soon as there is a second user. The relay instead:

1. reads the direction's open ids before the start and after it;
2. keeps the new ones;
3. keeps those whose stored derivation path is the expected one: `depositPath(right(account))` for a deposit, `vaultPath()` for a withdrawal;
4. requires exactly one.

Withdrawals all carry the vault's own path, so the relay's global withdrawal lane (one at a time) is what keeps step 2 to one id. The relay composes the vault's `relayRequest` (erc20-vault `src/relayer.ts`, `@sig-net/midnight` 0.23.0) directly, with the indexer URL, the MPC output cache, separate signature (20 min from the start) and attestation (13 + 20 min from the broadcast) deadlines, and progress persisted per stage, so a restarted relay resumes by request id.

## Inputs

| What | Pin |
|---|---|
| Passport client and vault package | `acedward/passport` PR #4 (`51c1fb4` = the `vendor/passport` submodule, or `07d8ea4`; every file the gate loads is identical at both) |
| Runtime and SDK set | the `midnight-2-offers/aa-contracts` image (Bun 1.3.11; midnight-js 5.0.0-beta.7, ledger-v9 1.0.0-rc.3, wallet-sdk facade 5.0.0-beta.2, one compact-runtime 0.19.0) |
| Signet SDK | `@sig-net/midnight` and `@sig-net/midnight-serde` 0.23.0 only, from `npm pack`, integrity-checked against the vault's `package-lock.json` |
| Compiled contracts and keys | copied from the same image (the account's full compile with the bridge keys); `keys-verify` checks them against the compiled `expectedVk`, PR #4's `stagenet-vault.json` artefact fingerprints and the verifier keys deployed on stagenet |
| Proof server | `midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819ea…` |
| Network | stagenet node `2.0.0-d9729c13` (checked by `preflight`); vault `7771c9e5…`, singleton `1df4ce25…`, stkA `0x2Ab7…FB52` → wStkA `5eb2a3ce…` |
| EVM gas the device signs | 100,000 gas × 10 gwei (1 gwei tip), AA 00037's proven values |

## Running it

```sh
export GATE_EVIDENCE_DIR=<public evidence directory>
export STAGENET_WALLET_FILE_HOST=<the sponsor's WALLET= mnemonic file>   # read in-process only
export SEPOLIA_KEY_FILE_HOST=<the funder's SK= key file>                  # read in-process only
G=test/gates/bridge/run-gate.sh
$G prepare && $G keys-verify && $G preflight
$G deploy            # prints the account and its Sepolia deposit address
$G fund              # 1 stkA + the sweep's gas ETH to the deposit address
$G deposit-start && $G relay-deposit && $G deposit-complete
$G withdraw-gas      # only sends when the vault's EVM account lacks gas
$G withdraw-start && $G relay-withdraw && $G withdraw-complete
$G status
```

`prepare` writes to the host disk only (`~/.cache/aa-00039/…`): Docker's VM disk on the reference host is nearly full, so nothing is compiled and no key enters an image. The device key (`gate-bridge-device.key`) and the state file (the account's encryption secret and its coin store) live in `GATE_STATE_DIR` (default `~/.config/aa-00039`, mode 700), never in the repository or the evidence.

**Stop rule** (plan 00039, G-BRIDGE): if the MPC has not signed within 20 minutes of the start, `relay-deposit` stops with exit code 3 and records the request id and the explorer link. Do not retry blindly.
