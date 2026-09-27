# G-TAKE — can a Passport account take an offer?

Plan 00039, gate G-TAKE (P2), on a **local** ledger-9 stack. No account had ever taken an offer: a
Passport call's value legs sit where its transcript runs, balancing is checked per token per
segment, and the batcher's `midnight-balancer` only adds DUST. This gate finds out, with evidence,
which way an account can take.

## What is here

| File | What it is | For L-TRD |
|---|---|---|
| `offer-codec.ts` | MIP-0005 `swapoffer1…` encode/decode and the offer id (SHA-256 of the bytes); matches `@effectstream/mip-zswap-offer` byte for byte | the make and take wire form |
| `tx-structure.ts` | Reads a ledger-9 transaction's segments, intents (and whether each call's transcript is guaranteed or fallible), Zswap offers and every per-segment imbalance; an unreadable imbalance is an error | the pre-submit check |
| `merge.ts` | The take merge helper: `complementOf` (what the taker must offer), `planTake` (can the two artefacts settle, and why not), `mergeTake` (merge, refuse an unbalanced result unless measuring) | the atomic take |
| `partition.ts` | Steers midnight-js's transcript partitioner so an account call runs fully GUARANTEED and its legs land in segment 0 (see below) | building the take (and makes) |
| `batcher-client.ts` | `POST /send-input` to `midnight-balancer`, the zswap SPA's body byte for byte | submitting |
| `relay-take.ts` | The relay-assisted take (Q15 option A) as pure orchestration: withdraw the whole coin to the bank's taker wallet, take as a wallet, deposit the stock and the change back; refund when the offer is gone or the take does not settle | the fallback |
| `gate.ts` | The live driver (runs only on a local stack, never in CI) | reference |
| `run-gate.sh` | Host orchestration: the P0.5 stack under the one-stack lock, the rc.6 prover, one driver step per run | reference |
| `*.test.ts`, `fake-tx.ts` | The offline half, in the `gate-take` vitest project | |

## The mechanism in one paragraph

A Zswap input or output proof binds the segment it was proven for, and a contract call's coins
are matched at segment 0 when its transcript is guaranteed and at its own intent's segment when
it is fallible (midnight-ledger 9.1.0.0-rc.3, `verify.rs` `effects_check`). midnight-js decides the
split with the ledger's `partitionTranscripts`, a client-side heuristic against the ledger
parameters' `min_time_to_dismiss` (15 ms); a gated Passport circuit does not fit it, so by default
its legs land in a random fallible segment and can never meet a wallet's segment-0 legs.
`partition.ts` hands the partitioner a copy of the parameters with a larger
`min_time_to_dismiss` (the same-length SCALE encoding patched in place and checked by a round
trip), so the call is proven fully guaranteed. The node still enforces the real time-to-dismiss
of the whole transaction; the gate's evidence says whether it accepts.

## Running it

```sh
export STACK_DIR=<midnight-2-offers clone at 773659c>      # the plan's P0.5 recipe
export STACK_LOCK=<the one-local-stack lock file>
export GATE_EVIDENCE_DIR=<public evidence dir>
test/gates/take/run-gate.sh prepare
test/gates/take/run-gate.sh up
test/gates/take/run-gate.sh preflight
test/gates/take/run-gate.sh setup                      # mint USDC, stock to the maker, USDC to the competitor
test/gates/take/run-gate.sh register                   # accounts T (taker) and M (maker)
test/gates/take/run-gate.sh fund                       # USDC coins into T, stock into M
test/gates/take/run-gate.sh offer O1 wallet
test/gates/take/run-gate.sh take 10-variant-a O1 default
test/gates/take/run-gate.sh take 11-variant-b O1 guaranteed --replay
test/gates/take/run-gate.sh offer M1 account-default
test/gates/take/run-gate.sh take 12-variant-c1 M1 guaranteed
test/gates/take/run-gate.sh offer M2 account-guaranteed
test/gates/take/run-gate.sh take 13-variant-c2 M2 guaranteed
test/gates/take/run-gate.sh offer O2 wallet
test/gates/take/run-gate.sh relay-take 20-variant-d O2
test/gates/take/run-gate.sh offer O3 wallet
test/gates/take/run-gate.sh relay-take 21-variant-d-refund O3 --race
test/gates/take/run-gate.sh down
```

Roles: `lace-test` is the relay's sponsor and, in (d), its taker wallet; `genesis-3` funds
(`run-gate.sh up` stops the stack's `aa-console`, which holds it); `demo-alice` is the wallet maker;
`demo-bob` takes an offer first in the refund run. The stack's `shielded-a` colour plays the stock
and `shielded-b` the USDC (`STOCK_COLOUR_LABEL`, `USDC_COLOUR_LABEL`). The accounts' device keys and
encryption secrets live only in `GATE_STATE_DIR` (mode 600); evidence files carry public values.
