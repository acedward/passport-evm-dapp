# MN Bank: deployment runbook

Status: **skeleton**. Sections marked _TODO_ are filled in as the features land; the complete
runbook is part of the final deployment bundle.

## What runs

| Service | What it is | Holds secrets? |
|---|---|---|
| `web` | The static site (nginx). Every per-user record stays in the customer's browser. | No |
| `relay` | Proves, pays DUST from the sponsor wallet, submits, and drives bridge requests. Keeps no per-user data. | The sponsor seed and the Sepolia RPC URL, from files mounted as secrets |
| `proof-server` | `midnightntwrk/proof-server:9.0.0-rc.6` (pinned by digest). Reached by the relay only. | No |
| key volume | The compiled contracts with the relay's prover keys (about 3.6 GB), built once and mounted read-only. | No (public artefacts) |

Owner-run dependencies: the ZSwap kernel and batcher, which must run with
`ALLOW_CONTRACT_MAKER_OFFERS=true` and `BATCHER_ALLOW_CONTRACT_TX=true`.

## Configuration

Every variable is listed, with its meaning, in [`.env.example`](.env.example). Secrets are never
put in the env file itself: pass the path of a file that contains them (`*_FILE` variables).

## Before the first start

1. _TODO_ Build the key volume (`relay-keys-init`) and note its fingerprint for `RELAY_KEYS_FINGERPRINT`.
2. _TODO_ Fund the sponsor wallet with DUST (a dedicated wallet; see "Sponsor wallet").
3. _TODO_ Register the bridged token names in the kernel: `POST /v1/known-tokens` for wStkA, wStkB, wStkC and wUSDC.
4. _TODO_ Fund the vault's EVM account with Sepolia ETH for withdrawal gas.

## Sponsor wallet

- Use a wallet dedicated to this relay. One wallet process per seed: a second process on the same
  seed breaks the first one's connection.
- If the relay must share a seed with other tools, set `SPONSOR_FUNDING_LOCK_FILE` to the shared
  lock file; the relay takes it before opening the wallet and refuses to start while another
  process holds it.

## Health

`GET /health` reports the sponsor's DUST, the proof server, the queue, the kernel and batcher, and
the gas ETH on the vault's EVM account. _TODO_ alert thresholds.

## Limits to know

- The batcher accepts 1000 requests per 24 h per target across all clients.
- Proofs run one at a time; a k=18 proof needs about 8 GB of RAM in the proof server.
