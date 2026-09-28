# MN Bank: operator runbook (stagenet)

This runbook deploys and runs MN Bank on Midnight **stagenet** with Ethereum **Sepolia**. Both are
test networks: nothing here carries real value. Every command runs from the repository root unless
it says otherwise.

## Contents

1. [What runs](#1-what-runs)
2. [Prerequisites and sizing](#2-prerequisites-and-sizing)
3. [First deployment](#3-first-deployment)
4. [The sponsor wallet](#4-the-sponsor-wallet)
5. [The Sepolia RPC file](#5-the-sepolia-rpc-file)
6. [The key volume](#6-the-key-volume)
7. [Register the tokens in the kernel](#7-register-the-tokens-in-the-kernel)
8. [Gas for withdrawals: the vault's EVM account](#8-gas-for-withdrawals-the-vaults-evm-account)
9. [Health monitoring](#9-health-monitoring)
10. [Capacity and limits](#10-capacity-and-limits)
11. [What customers must know](#11-what-customers-must-know)
12. [Known limits](#12-known-limits)
13. [Start, stop, upgrade and re-pin](#13-start-stop-upgrade-and-re-pin)
14. [Incidents](#14-incidents)
15. [Reference: pins and addresses](#15-reference-pins-and-addresses)

## 1. What runs

`deploy/compose.yml` runs four services. They start in this order.

| Service | What it does | Public? | Holds a secret? |
|---|---|---|---|
| `keys` | A one-shot job. It compiles the Passport account, the ERC20 vault and the Signet singleton with compactc 0.34.0, keeps the prover keys the relay needs, checks them, and writes them to the `keys` volume. Then it exits. Later starts only re-check the volume (a few seconds). | No | No |
| `proof-server` | `midnightntwrk/proof-server:9.0.0-rc.6`, pinned by digest. It proves every Passport call and the sponsor wallet's DUST spends. | No | No |
| `relay` | Proves, pays every DUST fee from the sponsor wallet, submits, and drives bridge requests to completion. It also closes bridge requests their owners left open (section 14.1). It keeps no customer data. | Only through `web`, under `/relay/` | The sponsor seed and the Sepolia RPC URL, as files |
| `web` | The static site on an unprivileged nginx. It also passes `/relay/` to the relay, so the site and the relay share one origin. | Yes, behind your TLS proxy | No |

Volumes:

| Volume | Size | Content |
|---|---|---|
| `<project>_keys` | about 3.4 GB | The compiled contracts with the relay's prover keys, and the check report `.mnbank-keys.json`. Public artefacts. |
| `<project>_zk-params` | about 0.2 GB | The public parameters the key compile downloads. |
| `<project>_proof-params` | about 0.3 GB | The proof server's public parameters and zswap keys, fetched at its first start. |

Services you do not run here: the stagenet ZSwap kernel (`https://stagenet.api-zswap.zkdojo.com`)
and batcher (`https://stagenet.batcher-zswap.zkdojo.com`). They must run with
`ALLOW_CONTRACT_MAKER_OFFERS=true` and `BATCHER_ALLOW_CONTRACT_TX=true`, or every Passport offer
and take is refused.

## 2. Prerequisites and sizing

**Software**: Linux with Docker Engine 25 or newer and the Compose plugin (v2.24 or newer), git,
and `curl`. A TLS reverse proxy (Caddy, nginx, a tunnel) for the public site.

**Memory**:

| What | Memory |
|---|---|
| Proof server, during a k=18 proof (every signed account call except registration) | about 8 GB; its limit is `PROOF_SERVER_MEM_LIMIT=12g` |
| Relay | 1 to 2 GB idle; a proof adds about 0.15 GB (it streams the prover key to the proof server); limit `RELAY_MEM_LIMIT=8g` |
| Web | under 50 MB; limit 256 MB |
| Key job, once, while it compiles | limit `KEYS_JOB_MEM_LIMIT=12g` |

Plan for about **16 GB of RAM**: the proof server needs about 8 GB during every k=18 proof and the
relay 1 to 2 GB. The relay proves one call at a time, so the proof server never needs more than one
k=18 proof's memory. Keep `RELAY_MEM_LIMIT` at its default, 8g: it is a cap, not a reservation, and
the relay stays far below it. `test/memory/README.md` has a check you can run on your host, and
`docs/PERFORMANCE.md` the measurements.

Builds before the relay-memory fix (plan P5.1b; up to master `a0b760b`) held several copies of the
prover key per proof and peaked at about 5 to 7 GB. They need the 24 GB sizing and at least 8g: under
4 GiB, a host without swap can OOM-kill that relay in the middle of a proof, and the customer's job
is lost (plan question Q25; measured in the live acceptance run).

**Disk**: about 20 GB free before the first start. The images take about 1.8 GB, the key volume
3.4 GB, and the key compile needs about 8 GB more while it runs (it deletes the extra afterwards).

**CPU**: 4 cores or more. A k=18 proof takes 30 to 80 seconds on 8 to 12 cores.

**Network**: the host needs outbound HTTPS and WSS to:

- `rpc.stagenet.shielded.tools` (node) and `indexer.stagenet.shielded.tools` (indexer);
- `stagenet.api-zswap.zkdojo.com` (kernel) and `stagenet.batcher-zswap.zkdojo.com` (batcher);
- `storage.googleapis.com` (Sig Network's MPC output cache);
- `srs.midnight.network` (public parameters for the key job and the proof server);
- your Sepolia RPC provider;
- at build time only: `registry.npmjs.org`, `github.com` (compactc) and Docker Hub.

Customers' browsers talk to your site, to the kernel (prices), and to their own wallet.

## 3. First deployment

Do these steps in order. Sections 4 to 6 explain each one.

```sh
# 1. The code, with the pinned Passport sources.
git clone https://github.com/acedward/passport-evm-dapp.git mnbank
cd mnbank
git checkout <release branch or commit>
git submodule update --init

# 2. A private directory for the two secret files (section 4 and 5 fill it).
sudo install -d -m 700 -o "$(id -u)" -g "$(id -g)" /srv/mnbank/secrets

# 3. The settings.
cp deploy/.env.example deploy/.env
# Edit deploy/.env: at least SPONSOR_SEED_HOST_FILE, SEPOLIA_RPC_URL_HOST_FILE and
# RELAY_USER="$(id -u):$(id -g)". Keep comments on their own lines.

# 4. Build the three images (about 5 minutes).
docker compose -f deploy/compose.yml build

# 5. The sponsor wallet (section 4) and the Sepolia RPC file (section 5).

# 6. The key volume (section 6): about 15 to 60 minutes the first time. Watch it finish.
docker compose -f deploy/compose.yml up keys

# 7. Start everything.
docker compose -f deploy/compose.yml up -d
docker compose -f deploy/compose.yml ps     # relay and web must show "healthy"
curl -s http://127.0.0.1:18080/health       # section 9

# 8. Register the missing token name in the kernel (section 7), and check the vault's gas (section 8).
```

Then put your TLS proxy in front of `127.0.0.1:18081`. With Caddy:

```
bank.example.com {
    reverse_proxy 127.0.0.1:18081
}
```

The web container believes the `X-Forwarded-For` header only from the addresses in
`WEB_TRUSTED_PROXIES`. The default (loopback and the private ranges) fits a proxy on the same host.
If your proxy runs elsewhere, put its address there. If this is wrong, every customer shares one
rate-limit bucket, and one busy customer slows everyone down.

Open the site. It should show the MN Bank shell, and Markets should show the live stagenet book.

## 4. The sponsor wallet

The relay pays every Midnight fee (DUST) for every customer from one wallet: the sponsor wallet.
Customers never need DUST.

### 4.1 Use a dedicated wallet, not the shared `.stagenet` wallet

Create a new wallet that only this relay uses, and fund it from the owner's `.stagenet` wallet.
Do not give the relay the `.stagenet` seed itself. The reasons:

- **One wallet process per seed.** The relay keeps its wallet open all the time. If another tool
  opens the same seed, the second connection knocks the first one off, so either the relay or the
  other tool stops working.
- **The shared wallet has a lock.** Other tools (the Offer Files ladders, live test runs) take
  `funding.lock` before they use `.stagenet`. A relay holding that lock forever would block them
  all, and a relay that ignored it would collide with them.
- **Coin clashes.** Two processes spending from one wallet pick the same DUST and fail each
  other's transactions.
- **A smaller blast radius.** The relay's seed sits on a server. If that server is compromised, a
  dedicated wallet loses only what you put in it.
- **Clear accounting.** The dedicated wallet's balance is exactly what the bank has spent.

### 4.2 Create it

The relay image carries the tool. It writes a new 24-word mnemonic to a file, with mode 600, and
never overwrites an existing file. It prints only the public NIGHT address.

```sh
docker run --rm --user "$(id -u):$(id -g)" -v /srv/mnbank/secrets:/out \
  mnbank/relay:local bun relay/src/tools/sponsor-wallet.ts new --out /out/sponsor.seed --network stagenet
```

Output:

```json
{ "wrote": "/out/sponsor.seed", "mode": "600", "network": "stagenet",
  "nightAddress": "mn_addr_stagenet1…" }
```

Back up `sponsor.seed` like any wallet seed. It is the only secret the bank holds. To print the
address again later:

```sh
docker run --rm --user "$(id -u):$(id -g)" -v /srv/mnbank/secrets/sponsor.seed:/s/seed:ro \
  mnbank/relay:local bun relay/src/tools/sponsor-wallet.ts address --seed-file /s/seed --network stagenet
```

### 4.3 How DUST is generated

DUST is not transferred; it is **generated** by NIGHT that is registered for DUST generation. The
live stagenet parameters (read on 2026-09-27) are:

| Parameter | Value | Meaning |
|---|---|---|
| Cap | 5 DUST per NIGHT | A registered NIGHT generates DUST until the wallet holds 5 DUST for each NIGHT. |
| Time to cap | 604,815 s (7.0 days) | From empty to the cap. |
| Rate | about 0.714 DUST per NIGHT per day | The generation speed while under the cap. |
| Grace period | 3 hours | How long spent DUST stays attributed after a spend. |

So the NIGHT you register sets both the **ceiling** (5 × NIGHT) and the **daily income**
(0.714 × NIGHT per day). `sponsor-wallet status` prints the parameters live.

What the bank spends (margin 20, measured on stagenet; `docs/PERFORMANCE.md` has every figure):

| Action | DUST from the sponsor |
|---|---|
| Open an account (registration: two deploys and an activation) | about 60 |
| Bridge deposit (start and complete) | about 2.5 |
| Bridge withdrawal (start and complete) | about 2.6; with the change re-filed, about 3.1 |
| Shielded withdrawal to a wallet, change re-filing | about 1 each |
| Make an offer; take an offer | 0 (the batcher pays the settlement) |
| Close a customer's stale bridge request (section 14.1) | one settle or `abandonDeposit`, about 0.1 to 0.3; at most 24 a day |

Sizing example: 1,000 NIGHT gives a ceiling of 5,000 DUST and about 714 DUST a day, which pays for
about 11 new accounts a day, or several hundred bridge transfers. Registration dominates.

### 4.4 Fund and register it

1. **Send NIGHT** to the sponsor's `nightAddress` from `.stagenet`, the way you usually move
   stagenet NIGHT (a wallet UI, or your own tooling). For the tooling, take
   `~/.stagenet-offer-ladders/funding.lock` first, as usual.
2. **Register the NIGHT for DUST generation.** This is one transaction; its fee comes from the DUST
   that the NIGHT generates first, so the tool waits (a few minutes) until there is enough. The
   relay must be stopped, because the tool opens the same wallet:

   ```sh
   docker compose -f deploy/compose.yml stop relay
   docker compose -f deploy/compose.yml up -d proof-server
   docker compose -f deploy/compose.yml run --rm --no-deps relay \
     bun relay/src/tools/sponsor-wallet.ts register-dust
   docker compose -f deploy/compose.yml start relay
   ```

   The tool refuses to run while the relay holds the wallet. Run `register-dust` again after every
   new NIGHT top-up: only registered NIGHT generates DUST.
3. **Check it**:

   ```sh
   docker compose -f deploy/compose.yml stop relay
   docker compose -f deploy/compose.yml run --rm --no-deps relay bun relay/src/tools/sponsor-wallet.ts status
   docker compose -f deploy/compose.yml start relay
   ```

   It prints the NIGHT balance, how much of it is registered, the DUST balance, and the expected
   ceiling and daily income. While the relay runs, `/health` shows the DUST balance without
   stopping anything (section 9).

`register-dust` follows the recipe the Offer Files ladder tools use on stagenet with the same
wallet SDK. It was not run during the build of this bundle, because it spends; watch the first
run.

### 4.5 Low DUST

Below `SPONSOR_DUST_LOW_SPECKS` (default 10 DUST) the relay refuses new actions with a clear
message and `/health` shows `sponsor.dustLow: true`. Registration needs about 60 DUST, so keep
the balance well above that: register more NIGHT, or wait for generation. A relay whose wallet
holds 0 DUST still starts and serves reads; it only refuses to spend.

## 5. The Sepolia RPC file

The relay uses a Sepolia JSON-RPC endpoint to follow bridge transfers (broadcast, finality) and to
read the vault's gas. A keyed provider (Infura, Alchemy, …) is recommended: a bridge transfer polls
Sepolia for about 20 minutes. The URL usually carries an API key, so it is a secret. Write it to a
file without putting it in your shell history:

```sh
install -m 600 /dev/null /srv/mnbank/secrets/sepolia-rpc.url
${EDITOR:-vi} /srv/mnbank/secrets/sepolia-rpc.url     # one line: the https URL
```

Set `SEPOLIA_RPC_URL_HOST_FILE=/srv/mnbank/secrets/sepolia-rpc.url` in `deploy/.env`.

Both secret files are mounted into the relay at `/run/secrets/`, read-only. The relay runs as
`RELAY_USER` (default `1000:1000`) and must be able to read them: set `RELAY_USER` to your own
`uid:gid` and keep the files mode 600, or `chown 1000:1000` them. The relay registers both values
with its log redactor at start; they never appear in logs, `/health` or `/v1/config`.

## 6. The key volume

The relay proves with a key set that must match what is deployed on stagenet: the vault
`7771c9e5…` and the Signet singleton `1df4ce25…` that every account calls, and the account contract
every existing account was deployed from. The `keys` job builds that set once and proves it is the
right one before anything else starts.

### 6.1 What the job does

1. Checks its pinned inputs: compactc 0.34.0 (release archive, SHA-256 checked when the image is
   built), `@sig-net/midnight` 0.23.0, and `account.compact` with SHA-256
   `44cff904f6ed58440b2534f64c429e0d422bfae082dbe8c82465002fb50e9fcf` (acedward/passport @
   `51c1fb4`).
2. Compiles, with keys: the Signet singleton, the Signet module's circuits (JavaScript only), the
   vault, then the account (33 circuits). This is the slow step.
3. Deletes every prover key the relay does not use (7.2 GB down to about 3 GB for the account),
   and removes them from each bundle's manifest.
4. Verifies the set (G-BRIDGE's method):
   - every verifier key equals its compiled `expectedVk` table (43 keys);
   - the vault's 7 and the singleton's 3 verifier keys equal the ones **deployed** at their
     stagenet addresses (read from the indexer), and PR #4's deployment record;
   - the 17 kept prover keys are present;
   - the fingerprint over all verifier keys equals `RELAY_KEYS_FINGERPRINT`
     (`d6de768a…c503`, the set every stagenet account so far was deployed with).
5. Installs the set into the volume and writes the report `.mnbank-keys.json`.

Any failure exits non-zero, and Compose then does not start the relay or the web site. On later
starts the job sees the report, finds the same inputs, and only re-verifies (about 2 seconds,
including the read from the indexer).

The relay checks the volume again when it starts, and refuses to start (exit code 78, with the
list of problems in its first log line) when:
- any of the 16 circuits it proves lacks its prover key, verifier key or ZKIR;
- the vault's or the singleton's verifier keys are not the deployed ones (PR #4's record);
- the fingerprint is not `RELAY_KEYS_FINGERPRINT`;
- no volume is mounted (compose sets `RELAY_REQUIRE_KEYS=true`).

Measured on a 12-core host with the job capped at 4 CPUs: the compile took 14 minutes (12.5 of
them for the account's 33 circuits), peaked at 3.7 GB of memory and 7.9 GB of disk, and left
3.4 GB. It reproduced the pinned fingerprint bit for bit. Budget up to an hour on a small host.

### 6.2 Run it

```sh
docker compose -f deploy/compose.yml up keys      # attached: you see the progress, it exits when done
```

The end of a good run:

```
key-volume: verdict VERIFIED (fingerprint d6de768ade27a1e65a721e68bd4d2ac1dc8c7580a981424c16ddf7bdc6a7c503)
key-volume: OK: key volume installed and verified in … s (3.4G)
```

Read the report at any time:

```sh
docker compose -f deploy/compose.yml run --rm --entrypoint cat keys \
  /app/vendor/passport/contract/contracts/managed/.mnbank-keys.json
```

### 6.3 If it fails

| Message | Meaning | Action |
|---|---|---|
| `…differs from the deployed verifier key` or `not deployed on chain` | The compile does not match what runs on stagenet. | Do not start the relay. Check that the submodule is at the pinned commit and that `BRIDGE_VAULT_ADDRESS` / `BRIDGE_SIGNET_SINGLETON` are empty (the defaults) or correct. If stagenet's vault really changed, re-pin (section 13.3). |
| `fingerprint … differs from RELAY_KEYS_FINGERPRINT` | The set is not the pinned one. | As above. Never "fix" this by changing the pin without reading the report's on-chain checks. |
| `…a build needs 10 GB` | Not enough disk for the compile. | Free disk, or build elsewhere and import (6.4). |
| `the deployed verifier keys of … could not be read` | The indexer did not answer (5 tries over about 2 minutes). | Retry later. To let restarts go on without the indexer, set `KEYS_VERIFY_ONCHAIN_EVERY_START=false`: the check still runs whenever the keys are built. |
| Exit 137 | The compile ran out of memory. | Raise `KEYS_JOB_MEM_LIMIT`. |

### 6.4 Import a set built elsewhere

On a small server, build the volume on a bigger machine, copy the four bundle directories
(`account`, `Erc20Vault`, `SignetSigner`, `SignetCircuits`) over, and import them. An imported set
is **not trusted**: it goes through the same prune and the same checks.

```sh
cat > deploy/compose.import.yml <<'EOF'
services:
  keys:
    environment:
      KEYS_IMPORT_DIR: /import
    volumes:
      - /path/to/copied/bundles:/import:ro
EOF
docker compose -f deploy/compose.yml -f deploy/compose.import.yml up keys
```

## 7. Register the tokens in the kernel

The dApp takes token names and colours from its own vendored records, so it works without this
step. The kernel's own site and API show names only for registered colours. On 2026-09-27 the
stagenet kernel had **wStkA, wStkB and wUSDC registered, and wStkC not yet**.

Register wStkC:

```sh
curl -sS -X POST https://stagenet.api-zswap.zkdojo.com/v1/known-tokens \
  -H 'content-type: application/json' \
  -d '{"color":"db8ae472c587a0709094eeaf98b81a0d46752db1a807e77bd209814e808f19d9","name":"wStkC","kind":"shielded","decimals":6}'
```

The full set, for a new kernel:

| Token | Request body |
|---|---|
| wStkA | `{"color":"5eb2a3cebb2ebe7ba910c78f62c9e28e0d74acbd00c810730def3578860e6a02","name":"wStkA","kind":"shielded","decimals":6}` |
| wStkB | `{"color":"e7ca18cb056477a5aca5cce387306d56526c2f226b4a4e34f068e3a3e8179588","name":"wStkB","kind":"shielded","decimals":6}` |
| wStkC | `{"color":"db8ae472c587a0709094eeaf98b81a0d46752db1a807e77bd209814e808f19d9","name":"wStkC","kind":"shielded","decimals":6}` |
| wUSDC | `{"color":"e5afe273bcb1252cfbc81ad6ca1caaafe22312c8c29f9b104a2fe3ead980bb2d","name":"wUSDC","kind":"shielded","decimals":6,"asset_id":"usd-coin"}` |

Answers: `200 {"success":true,…}` registered; `409` the name or colour is already registered;
`404 NOT_ENABLED` the kernel runs with `ENABLE_TOKEN_REGISTRY=false` (the kernel operator must
enable it for the call, or insert the row); `400` a bad colour or an unknown `asset_id`.

Two things to know:

- The kernel at `ledger-v9` @ `5d46e8d` stores a name sent through this route **in upper case**
  (`WSTKC`). The three rows already there are mixed case (`wStkA`), so they were written another
  way. To match them, the kernel operator can insert the row directly:
  `INSERT INTO known_tokens (token_color, name, kind, decimals, asset_id) VALUES ('db8ae472c587a0709094eeaf98b81a0d46752db1a807e77bd209814e808f19d9', 'wStkC', 'shielded', 6, NULL);`
- Check the result: `curl -s https://stagenet.api-zswap.zkdojo.com/v1/known-tokens`.

## 8. Gas for withdrawals: the vault's EVM account

Every withdrawal to Sepolia is a transfer **from the vault's own EVM account**,
`0x648216975e722494bFF92E88FFc68C8F8d438FaA`, signed by Sig Network's MPC. That account pays the
Sepolia gas. Nobody else can pay it, so the bank must keep it funded.

| Fact | Value |
|---|---|
| Gas each withdrawal is signed with | limit 100,000 at up to 10 gwei (priority 1 gwei) |
| Needed in the account **at the start** of a withdrawal | 0.001 ETH (limit × max fee); the relay refuses to start below it |
| Actually spent per withdrawal | about 0.0001 ETH (0.00007 to 0.00013 measured) |
| `/health` warns (`vaultGas.low`) below | 0.002 ETH (`VAULT_GAS_LOW_WEI`) |
| Recommended top-up | to 0.01 ETH whenever `vaultGas.low` is true: about 80 withdrawals |
| Balance on 2026-09-27 | 0.00107 ETH: **top it up before opening the bank** |

Send Sepolia ETH to the address from any funded Sepolia wallet. Check the balance with
`/health` (`vaultGas.balanceWei`) or any Sepolia explorer.

Deposits are different: the customer's own wallet sends the gas for their deposit (the page asks
for both transactions). The bank pays nothing on Sepolia for deposits.

## 9. Health monitoring

`GET /health` on the relay. From the host: `curl -s http://127.0.0.1:18080/health`. It is also
reachable through the site at `/relay/health` (it holds public facts only). Probes of the kernel,
batcher, proof server and Sepolia are cached for `HEALTH_CACHE_SECONDS` (15 s); one refresh runs
at a time however many requests arrive, and the key volume is re-scanned hourly. `/health` is
rate-limited per client address (`RATE_LIMIT_HEALTH_PER_MIN`, 60), so poll it at most once a second.

The HTTP status is 200 for `ok` and `degraded`, and 503 for `down`. Docker marks the relay
unhealthy only when `/health` answers 503.

| Field | Meaning | What to do |
|---|---|---|
| `status` | `ok`; `degraded` (something below needs attention, the bank still works for what it can); `down` (the proof server is unreachable, the sponsor wallet is in error, or the key set is not the pinned one). | Alert on `down` at once; on `degraded` for more than 10 minutes. |
| `network`, `version`, `uptimeSeconds` | What runs, and since when. | An `uptimeSeconds` that keeps resetting means restarts: read `docker compose logs relay`. |
| `sponsor.configured` | A sponsor seed is set. | `false`: set `SPONSOR_ENABLED=true` and the seed file. |
| `sponsor.state` | `starting`, `syncing`, `synced`, `error`, `stopped`, `disabled`. | `syncing` for a few minutes after a start is normal (about 2 minutes on stagenet). `error`: the wallet lost its connection; the relay reports `down`; restart it (`docker compose restart relay`) and check the node and indexer. |
| `sponsor.synced` | The wallet is caught up; spending needs it. | `false` for more than 10 minutes: check the indexer. |
| `sponsor.dustSpecks` | DUST balance, in specks (10^15 per DUST). | Section 4.3 for the costs. |
| `sponsor.dustLow` | Below `SPONSOR_DUST_LOW_SPECKS`: new actions are refused. | Register more NIGHT, or wait for generation (section 4.4). |
| `proofServer.reachable` | The relay can reach the proof server. | `false`: `docker compose ps proof-server`, `docker compose logs proof-server`; an out-of-memory kill shows as a restart. |
| `proofServer.version` | Must be `9.0.0-rc.6` (`PROOF_SERVER_EXPECTED_VERSION`). | A mismatch makes `status` degraded: someone changed the image. |
| `proofServer.jobCapacity` | Jobs the proof server accepts at once (10). | Informational. |
| `proofServer.keys.present` | The key volume is mounted and readable. | `false`: the `keys` volume is missing or empty; run the `keys` job. |
| `proofServer.keys.fingerprint`, `pinned`, `matchesPin` | The key set's identity and the pin check. | `matchesPin: false` never happens on a running relay (it refuses to start); if it does, stop and see section 6.3. |
| `proofServer.keys.complete`, `problems` | Every circuit the relay proves has its keys, as deployed; `problems` counts the ones that do not. | Always `true` / `0` on a running relay (it refuses to start otherwise). |
| `queue.jobs` | Jobs held in memory (running, waiting, and finished within `JOB_TTL_SECONDS`). | Informational. |
| `queue.lanes.prover` | Proofs running (at most 1) and waiting. | A `waiting` above 5 for long means customers wait minutes: the one-proof limit (section 10). |
| `queue.lanes.deposit` | Bridge deposits running and waiting (one at a time per account). | Informational. |
| `queue.lanes.withdrawal` | Bridge withdrawals running and waiting (one at a time for the whole bank). | A withdrawal stuck for more than 40 minutes: section 14.1. |
| `kernel.reachable`, `kernel.synced` | The ZSwap kernel answers and has caught up with the chain. | `false`: prices show "exchange unavailable" and offers cannot be made or taken; accounts and the bridge still work. Tell the kernel operator (section 14.3). |
| `batcher.reachable` | The batcher answers. | `false`: takes fail; tell the kernel operator. |
| `batcher.lastRefusal` | The batcher's last refusal of a take this relay sent: `httpStatus` (429 = its request cap, 500 = a generic failure; a replayed settlement answers 500 too) and `at` (Unix seconds); `null` when none. | A recent 429: the daily cap (section 10); takes resume when the window moves. Repeated 500s: tell the kernel operator. |
| `vaultGas.address`, `balanceWei`, `low` | The vault's EVM account and its Sepolia ETH; `low` below `VAULT_GAS_LOW_WEI`. `balanceWei: null` means the Sepolia RPC did not answer. | `low: true`: top it up (section 8). `null` for long: check the RPC file and provider. |
| `bridge.available` | The bridge is loaded: the key volume, the vault profile and the Sepolia RPC file are all there. | `false`: deposits and withdrawals are refused; read the relay's start-up log. |
| `bridge.mpc.lastSignatureAfterSeconds` | How long Sig Network's MPC took to sign the last request this relay drove; `null` before any. | Normally 20 to 110 s. Several minutes: the MPC is slow (section 14.2). |
| `bridge.mpc.timeouts24h` | Requests whose signature did not arrive within 20 minutes, last 24 hours. | Above 0: section 14.2. |
| `bridge.mpc.inFlight` | Requests being driven now (waiting for the MPC or for Sepolia). | Informational; each lasts about 20 minutes. |
| `bridge.staleRequests.enabled`, `lastScanAt` | The closer is on (`STALE_CLOSE_ENABLED`), and when it last read the vault (Unix seconds). | A `lastScanAt` older than twice `STALE_CLOSE_INTERVAL_SECONDS`: the relay cannot read the vault; check the indexer. |
| `bridge.staleRequests.open.deposit`, `open.withdraw` | Requests open in the vault right now, from every requester (not only this bank's customers). | Informational. |
| `bridge.staleRequests.waiting`, `closing` | This bank's stale requests waiting to be closed, and the one being closed. | `waiting` that does not fall: read `paused`. |
| `bridge.staleRequests.closed24h`, `maxPerDay` | Closes the sponsor paid for in the last 24 hours, and the cap (`STALE_CLOSE_MAX_PER_DAY`). | Near the cap every day: someone may be starting requests and leaving them; check `recent`, and lower the cap if needed. |
| `bridge.staleRequests.recent` | The newest closes: `kind`, `requestId`, `circuit`, `tx`, `at` (public values). | For support: a customer's request id shows what happened to it. |
| `bridge.staleRequests.paused` | Why the closer holds back (the sponsor is under `STALE_CLOSE_MIN_DUST_SPECKS`, the daily cap is reached), or `null`. | Add DUST (section 4), or wait for the window. |

Also watch:

- `docker compose -f deploy/compose.yml ps`: `relay` and `web` show `(healthy)`. The proof server
  image has no shell or HTTP client, so it has no Docker health check; the relay reports it.
- `docker compose -f deploy/compose.yml logs -f relay`: JSON lines. Every request is one `http`
  line (method, path, status, time). Secrets are redacted by key and by value.
- `docker compose -f deploy/compose.yml logs web`: one line per request, without query strings.

## 10. Capacity and limits

| Limit | Value | Effect |
|---|---|---|
| Proofs | one at a time, bank-wide | A signed action takes about 1 to 2 minutes of proving; others queue, and the page shows the position. About 30 to 60 proved actions an hour. |
| Bridge withdrawals | one open at a time, bank-wide | They all spend from the vault's one EVM account. Each is open about 20 minutes (Sepolia finality), so about 3 an hour. The next customer is told to try again in a few minutes. |
| Bridge deposits | one open at a time per account | Each takes about 20 minutes. Different accounts run in parallel. |
| Batcher | **1,000 requests per 24 hours per IP per target, and 1,000 per 24 hours for all clients together** | Every take the relay settles is one request from the relay's IP, so the bank can settle at most 1,000 takes a day, and fewer if other clients of the staging batcher use the shared allowance. Past it, takes fail until the window moves. |
| Kernel | 600 requests per minute per IP | Browsers read prices directly; the relay posts offers. |
| Relay, per customer address | reads 240/min, `/health` 60/min, nonces 30/min, actions 10/min, actions per account owner 5/min | Tune with `RATE_LIMIT_*`. |
| Relay jobs | kept `JOB_TTL_SECONDS` (24 h), at most `JOB_MAX` (10,000) | In memory only. When full, finished outcomes are dropped early (failed ones first) to make room; the relay answers "busy" only when `JOB_MAX` jobs are waiting or running. |
| Change re-filing (`append-inbox`) | only against the relay's single-use entitlement for that change, at most `APPEND_INBOX_MAX_PER_ACCOUNT_PER_DAY` (20) per account per day | The relay issues the entitlement in the withdrawal's result; the page keeps it with the change coin (valid `APPEND_ENTITLEMENT_TTL_SECONDS`, 30 days). Its key is derived from the sponsor seed: a NEW sponsor seed voids the entitlements already issued, so customers must secure their change before a sponsor change. |
| Fee margin | `SPONSOR_FEE_BLOCKS_MARGIN=20` | The sponsor pays about 2.5 times each fee. At 5 the registration's activation is refused (plan question Q19). |
| Scale | a demo bank | A handful of customers at a time, one proof at a time, with a visible queue. |

## 11. What customers must know

Put this where customers read it (the site says the same in its pages):

- **Your data lives only in your browser.** The bank keeps no copy. Your account's secret key,
  your list of coins, your transfers and your offers are in this browser's storage.
- **Export after every change.** Use Local data → Export after opening the account, after every
  deposit, withdrawal or trade. Keep the file private: it holds your account's secret key.
- **Clearing the browser, or CLEAR ALL without an export, loses the account for good.** The bank
  cannot recover it: without the secret, the coins cannot be found or spent.
- **One account per wallet address per browser.** A new browser or computer does not find your
  account by itself: Import your export there. Import takes only an export MN Bank itself made, for
  the connected wallet, and writes it all or nothing. It never replaces your account's secret key
  with a different one unless the chain says the new key is your account's.
- **One live offer at a time.** Any other signed action (a withdrawal, a bridge transfer, a second
  offer) cancels a live offer. The page warns first.
- **One coin per payment.** The largest amount you can pay or withdraw at once is your largest
  single coin ("largest single payment" on the page).
- **A withdrawal that leaves change asks for a second signature**, to record the change in your
  account. **Sending to a Midnight wallet address** asks for one more before it: it confirms the
  recipient's address (its encryption key) to the bank.
- **Bridge transfers take about 20 minutes** (Sepolia finality). You can close the page; the
  transfer resumes from Transfers when you come back.
- **These are test networks and test tokens.** There is no faucet: ask the bank for test tokens.

## 12. Known limits

These are accepted for this version (plan question Q9), and the UI explains them:

- one live offer per account;
- one coin per payment, with no merging of coins;
- a withdrawal's change needs a second signature to be recorded;
- all customer data in the browser, with Export and Import as the only backup;
- no on-chain lookup from an EVM address to its account;
- the relay's jobs live in memory: a relay restart forgets running jobs. A bridge transfer is
  resumed from the customer's page by its request id; a registration or a trade that was running
  during a restart is not resumed, and the customer starts it again (a registration cut off after
  its first deploy pays its DUST again). Whenever you can, restart the relay when every lane in
  `/health` `queue.lanes` shows 0 running and 0 waiting;
- proofs one at a time, and withdrawals one at a time for the whole bank (section 10);
- stocks without a bid show "no liquidity" and are left out of the total value;
- change coins created on a relay older than the security-review fix F-B3 (the bank pays for
  recording change in the inbox only against an entitlement it issued with that change) cannot be
  recorded in the inbox after the upgrade. They stay spendable from the customer's browser, and
  the customer's Export keeps them; only a restore from the chain alone would miss them (plan
  question Q26, accepted).

## 13. Start, stop, upgrade and re-pin

All commands take `-f deploy/compose.yml`; add `--env-file` if your settings are not in
`deploy/.env`.

### 13.1 Everyday commands

| Task | Command |
|---|---|
| Start (or apply changed settings) | `docker compose -f deploy/compose.yml up -d` |
| Status | `docker compose -f deploy/compose.yml ps` |
| Logs | `docker compose -f deploy/compose.yml logs -f relay` (or `web`, `proof-server`, `keys`) |
| Restart the relay | `docker compose -f deploy/compose.yml restart relay` (the sponsor wallet re-syncs, about 2 minutes) |
| Stop (keeps volumes) | `docker compose -f deploy/compose.yml stop` |
| Remove containers (keeps volumes) | `docker compose -f deploy/compose.yml down` |
| Remove everything, keys included | `docker compose -f deploy/compose.yml down -v` (the next start compiles the keys again) |

Stopping the relay while a bridge transfer runs is safe: the customer resumes it later.

**Back up** only the sponsor seed file. The key volume can be rebuilt, and the server holds no
customer data.

### 13.2 Upgrade to a new version of this repository

```sh
git fetch && git checkout <new release> && git submodule update --init
docker compose -f deploy/compose.yml build
docker compose -f deploy/compose.yml up -d
```

The `keys` job re-verifies. If the new version changed a key input (the Passport commit, compactc,
the Signet module, the kept keys), it compiles again first: stop the relay before
(`docker compose stop relay`), keep about 12 GB of disk free, and run `up keys` attached.

**Upgrading from `a0b760b` or earlier** (before the relay-memory fix, plan P5.1b): the commands
above. Only the relay image changes: no setting, no key and no page. A proof then adds about 0.15 GB
to the relay instead of 3.5 to 5 GB.

**Upgrading a deployment made from `423f44e`** (before the security-review fixes):

- set `RELAY_MEM_LIMIT=8g` in your `deploy/.env` (a copy of the old `.env.example` says 4g, and it
  overrides the new default);
- rebuild and restart the relay and the web images **together**: the new relay refuses the old
  page's change re-filing (it has no entitlement) and its payments to a Midnight wallet address
  (they have no envelope), and the new page needs the new relay;
- change that customers have not recorded yet cannot be recorded after the upgrade (section 12).

### 13.3 Re-pin when something upstream moves

Check stagenet before and after any change:

```sh
curl -s -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"system_version","params":[]}' https://rpc.stagenet.shielded.tools
# pinned: "2.0.0-d9729c13" (ledger crate-ledger-9.1.0.0-rc.3)
```

| What moved | What to do |
|---|---|
| **acedward/passport PR #4** (the vault or the bridge records) | If the canonical addresses or colours changed, the code must be re-vendored (`packages/core/src/tokens/deployments/`, see its `PROVENANCE.md`) and a new release built. If the vault was redeployed, the `keys` job's on-chain check fails until the new sources are pinned: bump `vendor/passport`, build, run `up keys` with `RELAY_KEYS_FINGERPRINT` empty, read the report (the on-chain checks must pass), then pin the fingerprint it printed. A new **account** contract is a different contract: existing accounts keep the old one, so this is a new bank, not an upgrade. |
| **The Midnight SDK set** (ledger, midnight-js, wallet SDK) | A code change: a new release of this repository with the whole set moved together (the relay image). The keys do not change unless compactc or the compact runtime changes. |
| **The stagenet ledger or node** (for example a new ledger release or DUST version) | Wait for a release of this repository that moves the SDK set, the proof server digest and, if needed, compactc together. Until then, expect fees or proofs to be refused. Do not mix versions. |
| **The proof server** | Only together with the SDK set: change the digest in `deploy/compose.yml` and `PROOF_SERVER_EXPECTED_VERSION`. |
| **The kernel or batcher URL** | `ZSWAP_KERNEL_URL` / `ZSWAP_BATCHER_URL` in `deploy/.env`, then `up -d`. |

## 14. Incidents

### 14.1 A bridge request is stuck (plan question Q21)

A bridge request is "open" in the vault from its start until its settle. The relay refuses a new
deposit of the same account while an earlier one is open, because both are swept from the same
deposit address. It refuses **every** new withdrawal while any withdrawal is open, because all of
them pay from the vault's one EVM account. So one request that nobody finishes can block one
customer's deposits, or the whole bank's withdrawals.

**The relay closes such requests itself.** At start-up and then every `STALE_CLOSE_INTERVAL_SECONDS`
(5 minutes), it reads the vault's open requests. A request is stale when no job of this relay is
driving it and it has been open for `STALE_CLOSE_AFTER_SECONDS` (15 minutes) since the relay first
saw it. For a stale request of an MN Bank account:

- **a withdrawal**: the relay finishes following it (the MPC's signature, Sepolia, the
  attestation), then runs the settle (`bridge_withdraw_complete`, or `bridge_withdraw_refund` when
  the transfer never ran). The settle is permissionless and pinned: any coin it mints goes to the
  account the vault names, with its inbox entry sealed to that account's key. Nothing can be
  redirected;
- **a deposit** that Sig Network attested as never executed: the vault's permissionless
  `abandonDeposit`. Nothing is minted or moved: the tokens stay at the customer's deposit address,
  and their next deposit sweeps them. Any other deposit stays the customer's to resume.

Requests of wallets and of other contracts are never touched.

**What the sponsor pays.** Each close is one transaction whose DUST fee the sponsor pays: the
settle or `abandonDeposit` (about 0.1 to 0.3 DUST). Following a request costs no DUST, and a
withdrawal's Sepolia gas comes from the vault's EVM account, as for every withdrawal. Someone could
start requests to accounts and walk away, so the spend is capped:

- at most `STALE_CLOSE_MAX_PER_DAY` (24) closes in any rolling 24 hours;
- none while the sponsor holds less than `STALE_CLOSE_MIN_DUST_SPECKS` (default twice the
  low-DUST level: 20 DUST), so customers' own actions keep priority;
- one close at a time; a failed close is retried after `STALE_CLOSE_RETRY_SECONDS` (30 minutes).

**What customers see.** A customer who presses Resume while the bank is closing the same request
waits for the bank's run and gets its result. A page whose transfer the bank closed reads
`GET /relay/v1/bridge/closed/<request id>` and shows "A stale request was closed", with the
circuit and the transaction. The route answers 404 when this relay has not closed that request
recently (the record lives in memory, like jobs). A deposit whose sweep never ran is now abandoned
by its own job at once, instead of blocking the account.

What to do when a customer reports a block:

1. Ask them to open Transfers and press **Resume**. It continues the same request, and the MPC may
   already have signed.
2. Read `/health` `bridge.staleRequests`: `waiting` and `closing` show the closer's work, `recent`
   what it closed, and `paused` why it waits. If it is paused for DUST, add DUST (section 4).
3. With `STALE_CLOSE_ENABLED=false`, only the customer's Resume closes a request.

### 14.2 The MPC is slow

Sig Network's MPC normally signs within 20 to 110 seconds, and attests after Sepolia finality,
15 to 19 minutes after the start. The relay waits 20 minutes for the signature and 33 minutes for
the attestation.

- If the MPC has not signed within 20 minutes, the transfer shows "Needs you to resume it".
  Nothing moved on Sepolia. The customer resumes later; the request is not lost. `/health`
  counts these in `bridge.mpc.timeouts24h`, and shows the last signing time in
  `bridge.mpc.lastSignatureAfterSeconds`, and the site shows customers a notice while the MPC
  is slow.
- Check the request on Sig Network's explorer:
  `https://sig-net.github.io/explorer/midnight/explorer?networkId=stagenet`.
- If every request is slow, the MPC network is degraded. Tell customers to expect delays; there is
  nothing to restart on your side.

### 14.3 The kernel (or the batcher) is down

- The site shows "exchange unavailable" on Markets and Trade, and never shows stale prices.
- Offers cannot be made or taken. Accounts, balances, deposits and withdrawals still work.
- `/health` shows `kernel.reachable: false` (or `batcher.reachable: false`) and `degraded`.
- Tell the kernel operator. Nothing to restart here; the site recovers by itself.
- A batcher that answers 429 means the daily cap (section 10): takes resume when the window moves.
  `/health` `batcher.lastRefusal` shows the last refusal and when it happened.

### 14.4 Other failures

| Symptom | Likely cause | Action |
|---|---|---|
| `proofServer.reachable: false`, proof server restarting | Out of memory during a k=18 proof | Raise `PROOF_SERVER_MEM_LIMIT` (at least 10g). |
| Actions refused, `sponsor.dustLow: true` | Out of DUST | Section 4.4. |
| `sponsor.state: error` | The wallet's connection to the node or indexer failed | `docker compose restart relay`; if it repeats, check stagenet's status. |
| Relay exits with code 78 | A configuration error, or a key volume that is missing, incomplete or not the pinned one | Read the first error line: it names the setting, or lists the missing and mismatched keys. Then section 6. |
| Relay exits with code 75 | The sponsor wallet could not be opened (for example a held lock file) | Read the log; check the seed file and `SPONSOR_FUNDING_LOCK_FILE`. |
| `keys` exits non-zero | Section 6.3 | Section 6.3. |
| Withdrawals refused before they start: "vault gas" | The vault's EVM account holds less than 0.001 ETH | Section 8. |
| Proofs refused after a stagenet upgrade | The ledger moved | Section 13.3. |

## 15. Reference: pins and addresses

| Item | Pin |
|---|---|
| Stagenet node / ledger | `2.0.0-d9729c13` / `crate-ledger-9.1.0.0-rc.3` |
| Proof server | `midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b` |
| Compact compiler | compactc 0.34.0 (language 0.26.0, runtime 0.19.0), `--feature-zkir-v3`; archives SHA-256: `x86_64-unknown-linux-musl` `775ccddf5a71399835329bbf7471ba5a8c54fcc825d372c75e19ba7042069584`, `aarch64-unknown-linux-musl` `d3e292c4f48e257dcd6b3d3e3e4743d7d8ea0729f48953eab91a366d44cd026d` |
| Base images | `oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7`, `nginx:1.31.5-alpine@sha256:72ba65eb42c10344912a84ff42408db7d34f2feb642204570ab8fc5ffd29f1d3` |
| Passport sources | `vendor/passport` = acedward/passport @ `51c1fb4ad164af034c8ed60fbb047e43cdd509f5`; `account.compact` SHA-256 `44cff904f6ed58440b2534f64c429e0d422bfae082dbe8c82465002fb50e9fcf` |
| Key set fingerprint | `d6de768ade27a1e65a721e68bd4d2ac1dc8c7580a981424c16ddf7bdc6a7c503` |
| SDK set | `@midnightntwrk/ledger-v9` 1.0.0-rc.3, midnight-js 5.0.0-beta.7, wallet-sdk-facade 5.0.0-beta.2, compact-runtime 0.19.0, `@sig-net/midnight` 0.23.0 |
| Vault (Midnight) | `7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637` |
| Vault's EVM account (Sepolia) | `0x648216975e722494bFF92E88FFc68C8F8d438FaA` |
| Signet singleton | `1df4ce25fc9f9c03dc6f4d0eb12ddf3d0db094995d4c70aca1142eebb3b77a5d` |
| MPC output cache | `https://storage.googleapis.com/midnight-cache-storage-testnet/v1/stagenet` |
| Tokens (Sepolia → Midnight, 6 decimals each) | stkA `0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52` → wStkA `5eb2a3ce…6a02`; stkB `0xF2bEFf36543219C8feC2AB2f42070AA65D3C844B` → wStkB `e7ca18cb…9588`; stkC `0x70c5c1978e5d428fa5C82111980e1aF0A64a270D` → wStkC `db8ae472…19d9`; USDC (Circle) `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` → wUSDC `e5afe273…bb2d` |
| Endpoints | node `https://rpc.stagenet.shielded.tools`; indexer `https://indexer.stagenet.shielded.tools/api/v4/graphql`; kernel `https://stagenet.api-zswap.zkdojo.com`; batcher `https://stagenet.batcher-zswap.zkdojo.com` (target `midnight-balancer`); exchange site `https://stagenet.zswap.zkdojo.com` |

For development and tests, `deploy/compose.dev.yml` (with `compose.stack.yml`, `compose.keys.yml`
and `compose.secrets.yml`) runs the relay alone against a local ledger-9 stack; it is not the
deployment bundle.
