# Proof times and DUST per action

Measured on Midnight stagenet (node `2.0.0-d9729c13`, ledger 9 rc.3) and Ethereum Sepolia in
September 2026, with the relay's pinned proof server `midnightntwrk/proof-server:9.0.0-rc.6` and a
sponsor fee margin of 20 (Q19). Local figures come from the ledger-9 stack of the development
recipe. Times depend on the proof server's host, the chain and, for the bridge, on Sig Network's MPC
and Sepolia finality.

## How to read the table

- **Proof** is the time to prove the one circuit the customer signs, as the relay measured it. A
  k=18 circuit needs about 8 GB of RAM on the proof server, and the relay proves one circuit at a
  time.
- **Click to done** runs from the customer's signature to the page showing the result.
- **Fees** are what the chain charges, as the indexer reports them. **Sponsor spend** is how far the
  sponsor wallet's DUST balance fell. At margin 20 the wallet declares the fee × 1.046^20 (about
  2.46×), and the whole declared amount leaves the wallet.
- The bank pays every DUST fee except a take's, which the exchange's batcher pays.

## Per action

| Action | Circuits proven | Proof | Click to done | Fees (DUST) | Sponsor spend (DUST) |
|---|---|---|---|---|---|
| Open an account | two deploy transactions (verifier keys only), then `activate_initial_device_with_evm` (k=16) | about 6.4 s for the activation (local) | 67.5 s, 78.6 s and 79.9 s on stagenet; 67.1 s local | 24.39 (13.21 + 10.89 + 0.29) | 59.9–60.3 |
| Send from the account (a shielded withdrawal) | `withdraw_shielded_with_evm` (k=18) | about 60 s including the submission (local) | about 60 s (local) | 0.44 (local) | about 1.1 |
| Record a change coin in the inbox (Q13) | `append_inbox_with_evm` (k=18) | about 66 s including the submission (local) | about 66 s (local) | 0.10 on stagenet, 0.40 local | about 0.25 |
| Deposit, Sepolia to Midnight | start: `bridge_deposit_start_with_evm` (calls the vault's `startDeposit` and the singleton's `signBidirectional`); settle: `bridge_deposit_complete` (calls `completeDeposit`) | 67–74 s for the start | 21.5 and 21.8 min | 0.91 start + 0.14 settle | 2.49–2.50 |
| Withdraw, Midnight to Sepolia | start: `bridge_withdraw_start_with_evm` (calls `startWithdraw` and `signBidirectional`); settle: `bridge_withdraw_complete` or `bridge_withdraw_refund` | 66–77 s for the start | 18.2–20.7 min | 1.01–1.14 start + 0.11 settle | 2.63 (whole coin); 3.10 for a partial one with its change recorded |
| Make an offer | `open_swap_shielded_with_evm` (k=18), fully guaranteed | one proof, as for a take | 77 s until the exchange lists it | none until someone takes it | 0 |
| Take an offer | `open_swap_shielded_with_evm` (k=18), fully guaranteed, merged with the maker's offer | 46.2 s | 74 s and 97 s until settled | 0.28–0.30, paid by the batcher | 0 |
| Close a stale request (Q21 A) | a withdrawal's settle as above, or the vault's `abandonDeposit` (k=15) | not measured on stagenet | the relayer loop's remaining wait, then one proof | as the settle it runs | one settle; capped per day (see below) |

## Bridge waits

Most of a transfer's time is spent waiting outside Midnight:

| Stage | Deposit | Withdrawal |
|---|---|---|
| Sig Network signs the Sepolia transaction | 53–109 s after the start | 36–110 s |
| The transaction is broadcast | 59–117 s | 42–126 s |
| Sepolia finality | 945–1,101 s | 850–1,168 s |
| The MPC attests | 1,066–1,171 s | 989–1,255 s |

The bridge gate counted from the start transaction's block, and the bridge lane from the start of
the relay's loop, so the lower ends of the first two rows are the lane's. The relay waits up to 20
minutes for the signature, and up to 33 minutes after the broadcast for the attestation.

Each withdrawal's Sepolia gas is paid by the vault's own EVM account, not by the sponsor. A transfer
cost that account 0.000067–0.000126 ETH, and a withdrawal needs 0.001 ETH available when it starts
(100,000 gas × 10 gwei).

## Stale requests

The relay closes bridge requests whose owners left them open (Q21 A; `relay/src/bridge/stale.ts`).
Each close is one transaction paid by the sponsor: a withdrawal's settle, or the vault's
`abandonDeposit`. Reading the vault and running the relayer loop cost no DUST.

The closer is bounded in three ways:

- by default at most 24 closes are paid for in any 24 hours;
- it pays for nothing while the sponsor holds less than twice the level at which the relay refuses
  customers' actions;
- it runs one close at a time.

`/health` reports the count, the cap and the most recent closes under `bridge.staleRequests`.

## Sources

The figures come from the project's evidence: the account lane's local and live registration, the
bridge gate and the bridge lane's live runs through the UI, the trading lane's live take and
make/take through the UI, and the stack recipe's activation proof.
