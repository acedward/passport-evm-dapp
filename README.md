# Passport EVM dApp

A bank-style web app for opening and using Passport accounts on Midnight with an EVM wallet.

## What this is

A customer with only an EVM wallet (MetaMask or any EIP-1193 wallet) can:

1. **Open an account.** Connect the wallet and open a Passport account on Midnight with one signature. The wallet is the account's key; no Midnight wallet is needed.
2. **See holdings.** See the tokens held on Sepolia and in the Passport account, side by side, like a bank statement.
3. **Bridge both ways.** Move tokens from Sepolia into the Passport account on Midnight, and back out to any Sepolia address.
4. **See prices.** See the USDC price of each tokenised stock, taken only from the live ZSwap offer book. A pair with no live offers shows "no liquidity".
5. **Buy and sell.** Trade a stock against USDC by making an offer at a chosen price, or by taking an offer already in the book.
6. **Keep data in the browser.** Everything the dApp stores about a customer stays in the browser. A Local data tab shows it and offers Export, Import and Clear all.

## Architecture

- **Web app**: a static site. It connects the EVM wallet, holds the customer's records in local storage, and computes balances and prices in the browser.
- **Relay**: a stateless service. It proves each transaction, pays the Midnight fees from a sponsor wallet, and drives bridge requests to completion. It stores nothing about individual customers.
- **Networks**: Midnight stagenet and Ethereum Sepolia. Both are test networks; nothing here carries real value.

## How this branch works

`00039-passport-evm-dapp` is the master branch of this project's single pull request into `main`. Work is done on short-lived branches whose temporary pull requests target this branch, and each is merged in with a merge commit once its checks are green. The master pull request stays a draft until the work is complete.

## Repository layout

| Path | What it holds |
|---|---|
| `packages/core` | Shared, environment-neutral TypeScript: network profiles, the token registry, amount maths, the relay's action authorisation and API types, and the browser-safe Passport client surface (`@mnbank/core/passport`). |
| `relay/` | The relay service (Bun + Hono). |
| `web/` | The web app (Vite + React). |
| `deploy/` | Compose files, Dockerfiles, `.env.example` and the runbook. |
| `docs/` | Reference notes: `PERFORMANCE.md` (proof times and DUST per action, from the live runs). |
| `scripts/` | The contract light compile, the Docker check runner and the secret scan. |
| `test/` | Browser end-to-end tests (Playwright). |
| `vendor/passport` | A git submodule: [`acedward/passport`](https://github.com/acedward/passport), pinned. The account contract and its client come from here. |

## Development

Requirements: Bun 1.3.11 and Node 24 (for the test runner), or Docker only.

```sh
git submodule update --init          # the pinned Passport sources
bun install
bun run contracts                    # compile the Passport contracts' JavaScript (no proving keys)
bun run check                        # format, lint, typecheck, unit tests
bun run build:web
```

`bun run contracts` downloads the pinned Compact compiler (0.34.0) into `.tools/` and checks its
SHA-256 first. It builds JavaScript and type declarations only, never proving keys.

To run everything in Docker instead (`node_modules` stays in a Docker volume):

```sh
scripts/docker-check.sh all          # install, compile, check, build, browser tests
scripts/docker-check.sh down         # remove the container and volumes
```

## Deployment

`deploy/compose.yml` is the deployment bundle for stagenet: a one-shot job that builds and
verifies the relay's proving keys, the proof server, the relay and the web site.
[`deploy/RUNBOOK.md`](deploy/RUNBOOK.md) is the operator's guide (sizing, the sponsor wallet,
secrets, health, limits, upgrades and incidents), and [`deploy/.env.example`](deploy/.env.example)
documents every setting.

## Checks and the secret scan

CI (`.github/workflows/ci.yml`) runs on every push and pull request: typecheck, lint, format,
unit tests, the web build, a relay start-up check under Bun, the Playwright smoke, a keyless
relay image build, and the secret scan over the full history.

This repository is public. Run the secret scan before every push:

```sh
SECRET_SCAN_FILES=/path/to/secret-file:/path/to/another bash scripts/secret-scan.sh
```

It runs gitleaks (the default rules plus wallet-secret, mnemonic, keyed-RPC-URL and
labelled-private-key rules, each proven by a self-test on random fakes) over the whole history
and the working tree. With `SECRET_SCAN_FILES`, it also reads those files in-process and checks
that no 3-word window of a mnemonic and no key's hex appears anywhere in the tree or the
history. It never prints a secret.
