# Local-stack tests

These scripts run MN Bank against a **local** ledger-9 Midnight stack (the
[midnight-2-offers](https://github.com/acedward/midnight-2-offers) demo stack, pinned) and, for the
capped live runs, against stagenet. None of them runs in GitHub's hosted CI: they need a Docker
host with far more memory and disk than a hosted runner has (see the table at the end).

| Script | What it drives |
|---|---|
| `run-e2e.sh` | **The local end-to-end** (below): the whole product, two customers, one command. |
| `run-accounts.sh` | Registration, holdings, a k=18 spend and Export/Import for one account (lane L-ACC). |
| `run-bridge-live.sh` | The bridge through the page on stagenet + Sepolia (live, capped; lane L-BRG). |
| `run-trade-live.sh` | A make and a take through the page on the staging exchange (live, capped; lane L-TRD). |
| `fund-account.ts`, `fund-eoa.ts`, `new-test-eoa.ts` | Helpers the scripts above run in containers. |
| `e2e-seed.ts` | The stack-side half of `run-e2e.sh`: faucet mints, deposits, the seeded kernel offers. |

## The local end-to-end: `run-e2e.sh`

```sh
test/stack/run-e2e.sh all            # up + test + down (down also runs when a step fails)
```

or step by step, to re-run the browser part against a stack that stays up:

```sh
test/stack/run-e2e.sh up             # about 12 minutes on a warm host
test/stack/run-e2e.sh test           # about 20 minutes; repeatable (new accounts every run)
test/stack/run-e2e.sh down
```

### What one run proves

The spec is `test/e2e/stack/e2e.stack.spec.ts`. Playwright drives the real web build, and the
page talks to the relay over HTTP, as in production. Each customer is a separate browser context
with an injected EIP-1193 wallet whose key is random for the run.

1. **Two customers open accounts at once.** Each signs once. The second waits behind the first on
   the relay's one prover lane, and its page shows its queue position. Both accounts read back
   `booted`, one device (the wallet), and `enc_key` equal to the key stored in that browser.
2. **Funding.** The harness makes third-party `deposit_shielded` calls: 10 "stock" into A and 10
   "USDC" into B, from the stack's funder wallet. It also seeds the local kernel with a wallet
   maker's bid (1.9 USDC for 2 stock, so 0.95) and a stock-to-stock offer.
3. **Markets equals a manual computation** over the local kernel's `GET /v1/offers`. The
   computation is written independently of the app's code. The second stock, which only trades
   against the first stock, shows "No liquidity".
4. **A makes an offer**: sell 2 stock at 1.05, with one signature. The relay proves it fully
   guaranteed and posts it to the local kernel. Markets shows the new ask and still equals the
   manual computation.
5. **B takes it** through the local batcher (`midnight-balancer`): one signature, one
   transaction. The kernel marks the offer `consumed`.
6. **Both pages reconcile.** B holds 2 stock and 7.9 USDC; A holds 8 stock and 2.1 USDC, and A's
   offer shows Filled with its settling transaction.
7. **Export, CLEAR ALL, Import** on B restores the same balances, and CLEAR ALL leaves no
   `mn-bank/` key behind.
8. **The harness stops the kernel**, and Markets says "Exchange unavailable".

The run writes public values only (addresses, transaction and offer ids, timings, every relay
job's stages) to `E2E_OUT_DIR` (`e2e-result.json`, `seeded.json`, `tokens.json`,
`relay-health.json`). The harness also checks that the relay's filesystem did not change during
the run: its root is read-only and `/tmp` is a tmpfs.

### What `up` builds

- **The stack:** midnight-2-offers at `STACK_REF` (`773659c`), started with
  `./up.sh --with aa --with offerfiles`. The kernel and batcher image is built at `KERNEL_REF`
  (`5d46e8d`, the kernel's ledger-v9 line), and both contract flags are checked
  (`ALLOW_CONTRACT_MAKER_OFFERS`, `BATCHER_ALLOW_CONTRACT_TX`). Ports are a random free block of
  at least 10000 on 127.0.0.1.
- **The relay's prover:** `midnightntwrk/proof-server:9.0.0-rc.6` (pinned by digest), capped at
  10 GB of memory, on the stack's network as `proof-server-rc6`.
- **The Docker check runner** (`scripts/docker-check.sh`). It holds the repository with its
  `node_modules` in a Docker volume, compiles the contracts' JavaScript, and runs Playwright.
- **The relay**, from source, on the stack's network. Its root is read-only, the key cache is
  mounted read-only, and its sponsor is the stack's genesis-funded `lace-test` wallet, read from
  a mode-600 file and never printed.

Tokens are configuration. The stack's test colours are mapped to the roles in `tokens.json`:
`shielded-a` is the stock (shown as wStkA), `shielded-b` is USDC, and a third colour minted by
the stack's test faucet is a second stock (wStkB).

### Requirements and configuration

| Need | Why |
|---|---|
| Docker with **≥ 30 GB of memory** | The stack uses about 7 GB, and a k=18 proof about 8 GB more. |
| **≥ 6.5 GB free** on Docker's disk before `up` (`MIN_DISK_GB_UP`) | The stack's volumes and the kernel image. A monitor samples disk and memory every 5 minutes, and the run aborts below `MIN_DISK_GB` (4). |
| The account's **key cache**, about 4.5 GB on the host (`KEYS_DIR`) | The relay proves every account circuit. `run-e2e.sh prepare` copies it, and the stack's test-faucet artefacts (`FAUCET_DIR`), out of the stack's `aa-contracts` image when they are missing. The relay refuses a key set whose fingerprint differs from `RELAY_KEYS_FINGERPRINT`. |
| The stack's images | When `midnight-2-offers/*:$STACK_IMAGE_BASE` exist, they are re-tagged, not rebuilt. Otherwise `up.sh` builds them, and the `aa-contracts` compile needs about 15 GB of disk and a long time the first time. |
| `STACK_LOCK` (optional) | Holds the one full stack a shared host allows. `down` releases it. |

`E2E_STATE_DIR` (default `~/.cache/mnbank-e2e`, mode 700) keeps the env files, the sponsor's seed
file and the logs: `up.log`, the seed and relay logs, `resources.tsv` and `memory.tsv`. `down`
removes every container, volume, network and image tag that `up` created, the runner and its
`node_modules` volumes, and the seed file. It prunes nothing else.

### CI

Do **not** add this to the hosted GitHub Actions workflow: a hosted `ubuntu-24.04` runner has
16 GB of memory and about 14 GB of free disk, too little for the stack plus one k=18 proof. On a
**self-hosted** runner that meets the table above, a job is:

```yaml
e2e-local-stack:
  runs-on: [self-hosted, linux, x64, docker-30g]
  timeout-minutes: 90
  steps:
    - uses: actions/checkout@v7
      with: { submodules: true, persist-credentials: false }
    - run: test/stack/run-e2e.sh all
      env:
        E2E_STATE_DIR: ${{ runner.temp }}/mnbank-e2e
        E2E_OUT_DIR: ${{ github.workspace }}/test-results/e2e
    - if: always()
      uses: actions/upload-artifact@v7
      with: { name: e2e-local-stack, path: test-results/e2e }
```

The runner needs Docker, `git`, `python3` and `bash`. It must keep the key cache between jobs
(`KEYS_DIR`), or `prepare` copies it again, and it must never run two stacks at once.

### The bridge on the local stack (optional; off by default)

The bridge is proven live on stagenet and Sepolia (the `run-bridge-live.sh` lane). A local run
adds the stack's `signet` fakenet profile (`./up.sh --with aa --with offerfiles --with signet`).
That profile needs:

- a real Sepolia RPC in the stack's env file (`SIGNET_EVM_RPC_URL`; a secret, so never commit it
  or print it);
- Sepolia ETH and test tokens for the deposits;
- at least 12 GB of free Docker disk, because the signet image rebuild takes about 1.2 GB.

`run-e2e.sh` does not start it. To try it, bring the stack up by hand with that profile, then
drive the Transfers page as `test/e2e/stack/bridge-live.stack.spec.ts` does.
