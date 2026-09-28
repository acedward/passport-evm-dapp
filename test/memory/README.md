# Relay prover memory check

`run-prover-memory.sh` runs the relay's proving path in a container with a memory limit and **no
swap**, and fails when the relay's peak anonymous memory passes a budget, or when the kernel kills
it at the limit. It guards the fix of plan question Q25: the relay used to hold about eight copies
of a prover key per proof and peaked at 4.6 to 5.1 GB for a k=18 proof. It now streams the key to
the proof server and peaks at about 0.35 GB. `docs/PERFORMANCE.md` has the figures, and
`relay/src/prover/proving-provider.ts` explains the change.

The harness is `relay/src/tools/prover-memory.ts`. It runs in the relay image's base
(`oven/bun:1.3.11`, pinned by digest) with the repository's production dependencies, like the relay
itself.

| Mode | Needs | Time | Where it runs |
|---|---|---|---|
| `synthetic` | Docker only | about 1 minute | every CI run (job "Relay prover memory") |
| `real` | Docker, a key volume, about 10 GB of free memory for the proof server | 3 to 15 minutes (the proof server downloads its parameters first) | by hand, before a release that touches proving |

## Synthetic: no keys, no proof server

```sh
test/memory/run-prover-memory.sh synthetic
```

It generates a 544 MB prover key (the size of a k=18 account key) with its compiler manifest. It
then sends four `/prove` bodies for it, through the relay's own proof provider, to an in-process
server that reads each body to the end. The default limit is 1 GiB and the budget 512 MB. The
relay's path peaks at about 310 MB. The previous path (`--stock`, midnight-js's HTTP proof provider)
is killed at the limit:

```sh
test/memory/run-prover-memory.sh synthetic --stock    # expected: FAIL (killed at 1g)
```

## Real: a k=18 proof against the pinned proof server

```sh
KEYS_DIR=/path/to/keys test/memory/run-prover-memory.sh real
```

`KEYS_DIR` is a key volume in the relay's `MIDNIGHT_MANAGED_PATH` layout
(`account/`, `Erc20Vault/`, `SignetSigner/`, each with `keys/`, `zkir/`, `compiler/`,
`contract/`). A copy of the deployment's `keys` volume works, and so does the verified cache the
key job imports (RUNBOOK §6.4). The harness builds an `append_inbox_with_evm` call (k=18, prover key
544 MB) on an account it makes in process, with a throwaway EVM key. It proves the call four times
through `PassportRuntime`'s proof provider against `midnightntwrk/proof-server:9.0.0-rc.6`, pinned
by digest. Nothing touches a chain or a wallet, and nothing is submitted. The default limit is
1 GiB and the budget 768 MB. The relay's path peaks at about 340 to 370 MB.

Extra arguments go to the harness:

- `--compare-payload`: before the measured proofs, it checks that the relay's `/prove` body for
  the real key is **byte-identical** to the one the ledger's own `createProvingPayload` builds.
  This needs about 4 GB, so raise the limit, for example `MEM_LIMIT=6g BUDGET_MB=5000`.
- `--stock`: proves through the previous path (midnight-js's stock provider), for comparison.
- `--gc-each`: runs `Bun.gc(true)` after each proof.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `MEM_LIMIT` | `1g` | the harness container's memory limit (swap is off) |
| `BUDGET_MB` | 512 synthetic, 768 real | the peak anonymous memory allowed |
| `PROOFS` | 4 | proofs in a row |
| `OUT_DIR` | `test-results/prover-memory` | where the JSON report goes (`synthetic.json`, `real.json`) |
| `NAME` | `mnbank-mem` | prefix of the containers, the volumes and the network it creates |
| `KEEP` | 0 | 1 keeps the proof server and its downloaded parameters for the next run |

`test/memory/run-prover-memory.sh down` removes everything a `KEEP=1` run left. Without `KEEP`,
each run removes its containers, volumes and network when it ends, even when it fails.

The report shows these for the run, before, during and after each proof:

- the container's `memory.stat` anon, `memory.current`, `memory.peak` and `memory.events`, sampled
  every 100 ms by a separate process;
- the process's RSS, heap and ArrayBuffers.

The budget applies to the peak anonymous memory. `memory.current` also counts the page cache of
the key file, which the kernel reclaims under pressure.

The harness process has no sponsor wallet, so the measurement leaves out the relay's baseline. An
idle relay with a synced wallet holds about 1 to 1.2 GB (live acceptance, P4.3). What the fix
removed is the memory a proof adds on top of that.
