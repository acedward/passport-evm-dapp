#!/usr/bin/env bash
# run-e2e.sh — the local end-to-end (plan 00039, P4-C): the whole MN Bank flow on a LOCAL ledger-9
# stack with the ZSwap kernel and batcher, driven through the page (Playwright, two injected
# EIP-1193 test wallets with random keys) and the relay over HTTP, as the product runs.
#
#   test/stack/run-e2e.sh all        up + test + down (the default; down also runs on failure)
#   test/stack/run-e2e.sh prepare    host: the account key cache and the test-faucet artefacts
#   test/stack/run-e2e.sh up         the stack (midnight-2-offers: --with aa --with offerfiles, the
#                                    kernel and batcher at KERNEL_REF, both contract flags on), the
#                                    rc.6 prover, the Docker check runner (install + light compile),
#                                    and the relay from source
#   test/stack/run-e2e.sh app        resume `up` after the stack: runner, token config, relay
#   test/stack/run-e2e.sh test       one browser run (test/e2e/stack/e2e.stack.spec.ts); the harness
#                                    funds the accounts, seeds the kernel and stops the kernel on the
#                                    spec's signals; results land in E2E_OUT_DIR
#   test/stack/run-e2e.sh down       remove everything `up` created (containers, volumes, networks,
#                                    image tags, the runner and its node_modules volumes, the lock)
#   test/stack/run-e2e.sh status     what is running, disk and memory
#
# What the browser run proves (see the spec's header): two registrations at once (one signature
# each, the second shows its queue position); funding by deposit_shielded; Markets = a manual
# computation over the local kernel's GET /v1/offers, with "no liquidity" and "exchange
# unavailable"; a guaranteed-proven offer made from account A and posted to the local kernel; B
# takes it through the local batcher in ONE transaction with ONE signature; the kernel marks it
# consumed; both pages reconcile; Export -> CLEAR ALL -> Import on B restores the same balances.
#
# Environment (nothing here is a secret; the stack's dev seeds stay in files, never printed):
#   STACK_DIR            a midnight-2-offers checkout at STACK_REF; cloned into E2E_STATE_DIR when unset
#   STACK_REF            default 773659c3ba09308203283387a1d72cd233fa871c (the plan's P0.5 recipe)
#   KERNEL_REF           default 5d46e8de329b68413e9348e3e4eead1094a3bc18 (the kernel's ledger-v9 line)
#   STACK_IMAGE_BASE     re-tag these byte-equivalent local images instead of building them
#                        (default demo-infra-14580; ignored when the tags do not exist: up.sh builds)
#   STACK_LOCK           optional one-stack-per-host lock file ("<label> <pid> <start> project=<P>")
#   E2E_LOCK_LABEL       the lock's label (default P4-C)
#   E2E_STATE_DIR        private state: env files, the relay's sponsor seed file, logs (mode 700;
#                        default ~/.cache/mnbank-e2e)
#   E2E_OUT_DIR          public results (default <repo>/test-results/e2e)
#   KEYS_DIR             the account's key cache (default ~/.cache/aa-00039/keys; `prepare` fills it
#                        from the stack's aa-contracts image when it is missing)
#   FAUCET_DIR           the stack's test-faucet artefacts (default ~/.cache/aa-00039/gate-take/managed)
#   RELAY_KEYS_FINGERPRINT   the key set's verifier-key fingerprint the relay insists on
#   MIN_DISK_GB_UP       free Docker VM disk needed before `up` (default 6.5)
#   MIN_DISK_GB          the floor while running; the monitor tears down below it (default 4)
#   MIN_MEM_HEADROOM_GB  free Docker memory needed before proving (default 10)
#   KEEP_STACK=1         `all` leaves everything up (for another `test`)
#
# Host rules this follows (plan 00039 "How to work"): one full local stack per host (STACK_LOCK);
# random free ports >= 10000 (pick-ports.sh; the page's port is random too); names prefixed
# E2E_PREFIX (default aa00039-e2e); the prover limited to 10 GB, one proof at a time (the relay's
# prover lane); node_modules only in Docker volumes; images are re-tagged, not compiled, where the
# host has them; nothing is pruned; `down` removes exactly what `up` created.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CMD="${1:-all}"
shift || true

PREFIX="${E2E_PREFIX:-aa00039-e2e}"
STACK_REPO="${STACK_REPO:-https://github.com/acedward/midnight-2-offers.git}"
STACK_REF="${STACK_REF:-773659c3ba09308203283387a1d72cd233fa871c}"
KERNEL_REF="${KERNEL_REF:-5d46e8de329b68413e9348e3e4eead1094a3bc18}"
BASE_TAG="${STACK_IMAGE_BASE:-demo-infra-14580}"
E2E_STATE_DIR="${E2E_STATE_DIR:-$HOME/.cache/mnbank-e2e}"
E2E_OUT_DIR="${E2E_OUT_DIR:-$ROOT/test-results/e2e}"
STACK_DIR="${STACK_DIR:-$E2E_STATE_DIR/midnight-2-offers}"
STACK_ENV="$E2E_STATE_DIR/stack.env"
RUN_ENV="$E2E_STATE_DIR/run.env"
KEYS_DIR="${KEYS_DIR:-$HOME/.cache/aa-00039/keys}"
FAUCET_DIR="${FAUCET_DIR:-$HOME/.cache/aa-00039/gate-take/managed}"
KEYS_FINGERPRINT="${RELAY_KEYS_FINGERPRINT:-d6de768ade27a1e65a721e68bd4d2ac1dc8c7580a981424c16ddf7bdc6a7c503}"
MIN_DISK_GB_UP="${MIN_DISK_GB_UP:-6.5}"
MIN_DISK_GB="${MIN_DISK_GB:-4}"
MIN_MEM_HEADROOM_GB="${MIN_MEM_HEADROOM_GB:-10}"
LOCK_LABEL="${E2E_LOCK_LABEL:-P4-C}"

PROOF_IMAGE="midnightntwrk/proof-server@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b"
PP_GENERATION="b73584978fc560bb827fd9df3ad914b37a6f5ea434fe62e9fa0adad809d8486c"
BUN_IMAGE="${BUN_IMAGE:-oven/bun:1.3.11}"
CHECK_NAME="$PREFIX-check"
RUNNER="$CHECK_NAME-runner"
APP="$CHECK_NAME-app"
PROVER="$PREFIX-prover"
RELAY="$PREFIX-relay"
SEEDER="$PREFIX-seed"
MONITOR_PID_FILE="$E2E_STATE_DIR/monitor.pid"
MANAGED=/app/vendor/passport/contract/contracts/managed
SIGNALS=/app/test-results/e2e-signals
IMAGES=(aa-contracts postgres indexer celestia proof-params)

say() { printf '== [%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { say "ERROR: $*"; exit 1; }

mkdir -p "$E2E_STATE_DIR/logs" && chmod 700 "$E2E_STATE_DIR" "$E2E_STATE_DIR/logs"

# ── host readings ────────────────────────────────────────────────────────────────────

disk_free_gb() { docker run --rm alpine:3 df -k / | awk 'NR==2 {printf "%.2f", $4/1024/1024}'; }
ge() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a >= b) }'; }

mem_headroom_gb() {
  local total
  total="$(docker info --format '{{.MemTotal}}')"
  docker stats --no-stream --format '{{.MemUsage}}' | python3 -c '
import re, sys
unit = {"B": 1, "KiB": 2**10, "MiB": 2**20, "GiB": 2**30, "KB": 1e3, "MB": 1e6, "GB": 1e9}
total = float(sys.argv[1]); used = 0.0
for line in sys.stdin:
    a = line.split("/")[0].strip()
    m = re.match(r"([\d.]+)(\w+)", a)
    if m: used += float(m.group(1)) * unit[m.group(2)]
print("%.1f" % ((total - used) / 2**30))' "$total"
}

resources_line() {
  printf '%s\tdisk_free_gb=%s\tmem_headroom_gb=%s\n' "$(date -u +%FT%TZ)" "$(disk_free_gb)" "$(mem_headroom_gb)"
}

# A background sampler: disk + per-container memory every 5 minutes (the plan asks for a disk check
# at least every ~20 minutes). Below MIN_DISK_GB it writes an abort flag the test loop obeys.
monitor_start() {
  monitor_stop
  local P
  P="$(project)"
  (
    while :; do
      line="$(resources_line)"
      echo "$line" >>"$E2E_STATE_DIR/logs/resources.tsv"
      docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}' |
        grep -E "^($PREFIX|${P:-none})" | sed "s/^/$(date -u +%FT%TZ)\t/" >>"$E2E_STATE_DIR/logs/memory.tsv" || true
      free="$(sed -n 's/.*disk_free_gb=\([0-9.]*\).*/\1/p' <<<"$line")"
      if [[ -n "$free" ]] && ! ge "$free" "$MIN_DISK_GB"; then
        echo "disk ${free} GB < ${MIN_DISK_GB} GB" >"$E2E_STATE_DIR/abort"
      fi
      sleep 300
    done
  ) >/dev/null 2>&1 &
  echo $! >"$MONITOR_PID_FILE"
}
monitor_stop() {
  if [[ -s "$MONITOR_PID_FILE" ]]; then
    kill "$(cat "$MONITOR_PID_FILE")" 2>/dev/null || true
    rm -f "$MONITOR_PID_FILE"
  fi
}

# ── state ────────────────────────────────────────────────────────────────────────────

env_of() { grep -E "^$1=" "$2" 2>/dev/null | tail -1 | cut -d= -f2-; }
project() { env_of COMPOSE_PROJECT_NAME "$STACK_ENV"; }
e2e_port() { env_of E2E_PORT "$RUN_ENV"; }

free_port() {
  python3 -c 'import random, socket
for _ in range(500):
    p = random.randint(10000, 60000); s = socket.socket()
    try:
        s.bind(("127.0.0.1", p)); s.close(); print(p); break
    except OSError:
        s.close()'
}

rget() {
  docker exec "$RUNNER" node -e \
    'fetch(process.argv[1]).then(async (r) => { console.log(await r.text()); process.exit(r.ok ? 0 : 1); }).catch(() => process.exit(2))' "$1"
}

# ── prepare: host caches ─────────────────────────────────────────────────────────────

prepare() {
  local img="midnight-2-offers/aa-contracts:$BASE_TAG"
  if [[ ! -d "$KEYS_DIR/account/keys" ]]; then
    docker image inspect "$img" >/dev/null 2>&1 || die "no key cache at $KEYS_DIR and no $img to copy it from"
    say "copying the account key set from $img to $KEYS_DIR (about 4.5 GB, host disk)"
    mkdir -p "$KEYS_DIR" && chmod 700 "$KEYS_DIR"
    local src="$PREFIX-keysrc-$$"
    docker create --name "$src" --entrypoint true "$img" >/dev/null
    docker cp "$src:/aa/passport/contracts/managed/account" "$KEYS_DIR/account"
    for c in Erc20Vault SignetSigner SignetCircuits; do
      docker cp "$src:/aa/passport/contracts/erc20-vault/managed/$c" "$KEYS_DIR/$c"
    done
    docker rm -f "$src" >/dev/null
  fi
  if [[ ! -d "$FAUCET_DIR/faucet" ]]; then
    docker image inspect "$img" >/dev/null 2>&1 || die "no faucet artefacts at $FAUCET_DIR and no $img"
    mkdir -p "$FAUCET_DIR"
    local src="$PREFIX-faucetsrc-$$"
    docker create --name "$src" --entrypoint true "$img" >/dev/null
    docker cp "$src:/aa/passport/contracts/managed/faucet" "$FAUCET_DIR/faucet"
    docker rm -f "$src" >/dev/null
  fi
  if [[ ! -x "$STACK_DIR/up.sh" ]]; then
    say "cloning the stack ($STACK_REPO @ $STACK_REF) into $STACK_DIR"
    git clone -q "$STACK_REPO" "$STACK_DIR"
    git -C "$STACK_DIR" checkout -q "$STACK_REF"
  fi
  [[ "$(git -C "$STACK_DIR" rev-parse HEAD)" == "$STACK_REF"* ]] ||
    die "$STACK_DIR is at $(git -C "$STACK_DIR" rev-parse --short HEAD), expected $STACK_REF"
  say "prepared: keys $KEYS_DIR, faucet $FAUCET_DIR, stack $STACK_DIR"
}

# ── up ───────────────────────────────────────────────────────────────────────────────

take_lock() {
  [[ -n "${STACK_LOCK:-}" ]] || return 0
  if ! (set -o noclobber; echo "$LOCK_LABEL $$ $(date -u +%FT%TZ)" >"$STACK_LOCK") 2>/dev/null; then
    die "the local stack is held: $(cat "$STACK_LOCK")"
  fi
}

stack_up() {
  local free
  free="$(disk_free_gb)"
  ge "$free" "$MIN_DISK_GB_UP" || die "Docker VM disk has $free GB free (< $MIN_DISK_GB_UP): not starting a stack"
  say "Docker VM disk free: $free GB; memory headroom $(mem_headroom_gb) GB"
  take_lock
  (cd "$STACK_DIR" && PROJECT_PREFIX="$PREFIX" BASE_MIN=20000 ./scripts/pick-ports.sh) >"$STACK_ENV"
  echo "KERNEL_REF=$KERNEL_REF" >>"$STACK_ENV"
  chmod 600 "$STACK_ENV"
  local P
  P="$(project)"
  [[ -n "$P" ]] || die "pick-ports.sh gave no project name"
  if [[ -n "${STACK_LOCK:-}" ]]; then echo "$LOCK_LABEL $$ $(date -u +%FT%TZ) project=$P" >"$STACK_LOCK"; fi
  echo "E2E_PORT=$(free_port)" >"$RUN_ENV"
  say "project $P; page port $(e2e_port)"

  say "kernel image at $KERNEL_REF"
  docker build -q --build-arg KERNEL_REF="$KERNEL_REF" -t "midnight-2-offers/offerfiles-kernel:$P" \
    "$STACK_DIR/images/offerfiles-kernel" >/dev/null
  for s in "${IMAGES[@]}"; do
    if docker image inspect "midnight-2-offers/${s}:$BASE_TAG" >/dev/null 2>&1; then
      docker tag "midnight-2-offers/${s}:$BASE_TAG" "midnight-2-offers/${s}:$P"
    fi
  done
  say "up.sh --with aa --with offerfiles"
  (cd "$STACK_DIR" && ENV_FILE="$STACK_ENV" ./up.sh --with aa --with offerfiles) >"$E2E_STATE_DIR/logs/up.log" 2>&1 ||
    { tail -40 "$E2E_STATE_DIR/logs/up.log" >&2; die "up.sh failed (log $E2E_STATE_DIR/logs/up.log)"; }
  local flags
  flags="ALLOW_CONTRACT_MAKER_OFFERS=$(docker exec "$P-kernel-1" sh -c 'echo $ALLOW_CONTRACT_MAKER_OFFERS') BATCHER_ALLOW_CONTRACT_TX=$(docker exec "$P-batcher-1" sh -c 'echo $BATCHER_ALLOW_CONTRACT_TX')"
  say "kernel $(docker exec "$P-kernel-1" cat /app/.kernel-commit 2>/dev/null | cut -c1-12); $flags"
  [[ "$flags" == *"ALLOW_CONTRACT_MAKER_OFFERS=1"* || "$flags" == *"ALLOW_CONTRACT_MAKER_OFFERS=true"* ]] ||
    die "the kernel refuses contract makers ($flags)"
  [[ "$flags" == *"BATCHER_ALLOW_CONTRACT_TX=true"* ]] || die "the batcher refuses contract transactions ($flags)"
  # aa-console holds genesis-3 (the funder) open; one facade per seed.
  docker stop "$P-aa-console-1" >/dev/null 2>&1 || true
  docker rm -f "$PROVER" >/dev/null 2>&1 || true
  docker run -d --name "$PROVER" --network "${P}_default" --network-alias proof-server-rc6 \
    --memory 10g --cap-drop ALL --security-opt no-new-privileges:true \
    -e PORT=6300 -e MIDNIGHT_PP="/proof-params/generations/$PP_GENERATION" \
    -e MIDNIGHT_PARAM_SOURCE=https://srs.midnight.network/ \
    -v "${P}_proof-params:/proof-params:ro" "$PROOF_IMAGE" >/dev/null
  say "stack up: $P (log $E2E_STATE_DIR/logs/up.log); disk free $(disk_free_gb) GB"
}

runner_up() {
  local P
  P="$(project)"
  say "check runner $RUNNER: sync, frozen install, contracts light compile"
  DOCKER_CHECK_NAME="$CHECK_NAME" "$ROOT/scripts/docker-check.sh" up >/dev/null
  DOCKER_CHECK_NAME="$CHECK_NAME" "$ROOT/scripts/docker-check.sh" sync
  DOCKER_CHECK_NAME="$CHECK_NAME" "$ROOT/scripts/docker-check.sh" run 'bun install --frozen-lockfile >/dev/null && bun run contracts' \
    >"$E2E_STATE_DIR/logs/runner-install.log" 2>&1 ||
    { tail -30 "$E2E_STATE_DIR/logs/runner-install.log" >&2; die "install or light compile failed"; }
  # The stack's test faucet, inside the source volume (its compiled JS resolves the repo's SDK).
  docker exec "$RUNNER" sh -c 'rm -rf /app/.e2e-faucet && mkdir -p /app/.e2e-faucet/managed'
  docker cp "$FAUCET_DIR/faucet" "$RUNNER:/app/.e2e-faucet/managed/faucet" >/dev/null
  docker network connect --alias mnbank-e2e "${P}_default" "$RUNNER" 2>/dev/null || true
}

# One e2e-seed.ts command in a Bun container on the stack's network (the runner's source volume,
# read-only; the key cache where the relay mounts it; the stack's receipt and wallets read-only).
seed_cmd() {
  local P="$1" step="$2"
  shift 2
  docker run --rm --name "$SEEDER-$step-$$" --network "${P}_default" \
    -v "$APP:/app:ro" -v "$KEYS_DIR:$MANAGED:ro" \
    -v "$STACK_DIR/wallets/wallets.json:/run/secrets/wallets.json:ro" -v "${P}_aa-out:/aa/out:ro" \
    -w /app -e BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$@" \
    "$BUN_IMAGE" bun test/stack/e2e-seed.ts "$step"
}

tokens_file() {
  local P colours
  P="$(project)"
  colours="$(seed_cmd "$P" colours 2>"$E2E_STATE_DIR/logs/colours.log" | sed -n 's/^COLOURS //p')"
  [[ -n "$colours" ]] || { tail -20 "$E2E_STATE_DIR/logs/colours.log" >&2; die "no colours"; }
  # The stack's colours, mapped to the roles by configuration: shielded-a = the stock (wStkA),
  # shielded-b = USDC, and a third faucet colour as a second stock that no USDC offer trades.
  python3 - "$colours" >"$E2E_STATE_DIR/tokens.json" <<'PY'
import json, sys
c = json.loads(sys.argv[1])
print(json.dumps({"tokens": [
  {"symbol": "USDC", "midnightName": "wUSDC", "role": "usdc", "decimals": 6, "midnightColour": c["usdc"]},
  {"symbol": "stkA", "midnightName": "wStkA", "role": "stock", "decimals": 6, "midnightColour": c["stock"]},
  {"symbol": "stkB", "midnightName": "wStkB", "role": "stock", "decimals": 6, "midnightColour": c["stock2"]},
]}, indent=2))
PY
  cp "$E2E_STATE_DIR/tokens.json" "$E2E_OUT_DIR/tokens.json"
  say "tokens: $(python3 -c 'import json,sys; print(", ".join(t["midnightName"]+"="+t["midnightColour"][:8] for t in json.load(open(sys.argv[1]))["tokens"]))' "$E2E_STATE_DIR/tokens.json")"
}

relay_up() {
  local P vault
  P="$(project)"
  vault="$(docker run --rm -v "${P}_aa-out:/aa/out:ro" alpine:3 cat /aa/out/aa-contracts.json |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["vault"]["address"])')"
  # The relay's sponsor: the stack's genesis-funded `lace-test` wallet (no stack service holds it).
  (umask 077 && python3 - "$STACK_DIR/wallets/wallets.json" >"$E2E_STATE_DIR/sponsor.seed" <<'PY'
import json, sys
w = next(x for x in json.load(open(sys.argv[1]))["wallets"] if x["name"] == "lace-test")
print("SEED=" + w["seed"].removeprefix("0x"))
PY
  )
  docker rm -f "$RELAY" >/dev/null 2>&1 || true
  docker run -d --name "$RELAY" --network "${P}_default" --network-alias mnbank-relay \
    --read-only --tmpfs /tmp:rw,size=64m --cap-drop ALL --security-opt no-new-privileges:true \
    -v "$APP:/app:ro" -v "$KEYS_DIR:$MANAGED:ro" \
    -v "$E2E_STATE_DIR/sponsor.seed:/run/secrets/sponsor:ro" -v "$E2E_STATE_DIR/tokens.json:/run/config/tokens.json:ro" \
    -w /app -e BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    -e RELAY_NETWORK=undeployed -e TOKENS_FILE=/run/config/tokens.json \
    -e MIDNIGHT_MANAGED_PATH="$MANAGED" -e RELAY_KEYS_FINGERPRINT="$KEYS_FINGERPRINT" \
    -e MIDNIGHT_PROOF_SERVER_URL=http://proof-server-rc6:6300 \
    -e BRIDGE_VAULT_ADDRESS="$vault" \
    -e SPONSOR_ENABLED=true -e SPONSOR_SEED_FILE=/run/secrets/sponsor \
    -e SPONSOR_FEE_BLOCKS_MARGIN="${SPONSOR_FEE_BLOCKS_MARGIN:-20}" \
    -e RELAY_CORS_ORIGINS="http://127.0.0.1:$(e2e_port)" \
    -e JOB_TTL_SECONDS=3600 -e HEALTH_CACHE_SECONDS=5 -e LOG_LEVEL=info \
    "$BUN_IMAGE" bun relay/src/main.ts >/dev/null
  say "relay starting; waiting for the sponsor to sync"
  for _ in $(seq 1 120); do
    if rget http://mnbank-relay:8080/health 2>/dev/null |
      python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin)["sponsor"]["synced"] else 1)' 2>/dev/null; then
      break
    fi
    sleep 5
  done
  rget http://mnbank-relay:8080/health >"$E2E_OUT_DIR/relay-health.json" || die "the relay is not healthy"
  docker diff "$RELAY" | sort >"$E2E_STATE_DIR/relay-diff-before.txt" || true
  say "relay up: $(python3 -c 'import json,sys; h=json.load(open(sys.argv[1])); print(h["status"], "sponsor synced:", h["sponsor"]["synced"])' "$E2E_OUT_DIR/relay-health.json")"
}

# Everything after the stack itself (also the way to resume when `up` stopped after the stack).
app_up() {
  mkdir -p "$E2E_OUT_DIR"
  [[ -n "$(project)" ]] || die "no stack (run: $0 up)"
  [[ -s "$MONITOR_PID_FILE" ]] || monitor_start
  runner_up
  tokens_file
  relay_up
}

up() {
  mkdir -p "$E2E_OUT_DIR"
  prepare
  stack_up
  monitor_start
  app_up
}

# ── test ─────────────────────────────────────────────────────────────────────────────

# (The bracket keeps pkill from matching its own shell's command line.)
stop_browser_run() { docker exec "$RUNNER" sh -c 'pkill -f "[p]laywright test" || true' || true; }

signal_file() { docker exec "$RUNNER" sh -c "cat $SIGNALS/$1.json 2>/dev/null" || true; }

e2e_test() {
  local P pid log status=0
  P="$(project)"
  [[ -n "$P" ]] && docker inspect "$RELAY" >/dev/null 2>&1 || die "the stack is not up (run: $0 up)"
  mkdir -p "$E2E_OUT_DIR"
  rm -f "$E2E_STATE_DIR/abort"
  DOCKER_CHECK_NAME="$CHECK_NAME" "$ROOT/scripts/docker-check.sh" sync
  # The sync removes every file it does not own, the faucet's included: copy it again.
  docker exec "$RUNNER" sh -c 'rm -rf /app/.e2e-faucet && mkdir -p /app/.e2e-faucet/managed'
  docker cp "$FAUCET_DIR/faucet" "$RUNNER:/app/.e2e-faucet/managed/faucet" >/dev/null
  # A preview server left by an interrupted run holds the port: stop it first.
  docker exec "$RUNNER" sh -c 'for p in $(ps -eo pid,args | grep -E "vite (build|preview)|playwright test" | grep -v grep | awk "{print \$1}"); do kill "$p"; done' || true
  docker exec "$RUNNER" rm -rf "$SIGNALS" /app/test-results/e2e
  log="$E2E_STATE_DIR/logs/e2e-$(date -u +%Y%m%dT%H%M%SZ).log"
  say "browser run (log $log)"
  docker exec -w /app -e E2E_PORT="$(e2e_port)" -e STACK_RELAY_URL=http://mnbank-relay:8080 \
    -e STACK_KERNEL_URL=http://kernel:9999 -e STACK_TOKENS_JSON="$(cat "$E2E_STATE_DIR/tokens.json")" \
    -e STACK_SIGNAL_DIR="$SIGNALS" -e E2E_OUT_DIR=/app/test-results/e2e "$RUNNER" \
    bash -lc 'npx playwright test -c test/e2e/playwright.config.ts test/e2e/stack/e2e.stack.spec.ts --reporter=list' \
    >"$log" 2>&1 &
  pid=$!

  local registered="" seeded="" stopped=0
  while kill -0 "$pid" 2>/dev/null; do
    if [[ -s "$E2E_STATE_DIR/abort" ]]; then
      say "ABORT: $(cat "$E2E_STATE_DIR/abort")"
      stop_browser_run
      status=75
      break
    fi
    if [[ -z "$registered" ]]; then
      registered="$(signal_file registered)"
      if [[ -n "$registered" ]]; then
        local a b
        a="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["A"]["account"])' "$registered")"
        b="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["B"]["account"])' "$registered")"
        say "registered A=$a B=$b; seeding: mint, deposits, the kernel's wallet offers"
        local mem
        mem="$(mem_headroom_gb)"
        say "Docker memory headroom ${mem} GB before seeding"
        seeded="$(seed_cmd "$P" seed -e E2E_ACCOUNT_A="$a" -e E2E_ACCOUNT_B="$b" \
          2>"$E2E_STATE_DIR/logs/seed.log" | sed -n 's/^SEEDED //p')" || true
        if [[ -z "$seeded" ]]; then
          tail -30 "$E2E_STATE_DIR/logs/seed.log" >&2
          stop_browser_run
          status=1
          break
        fi
        printf '%s\n' "$seeded" >"$E2E_OUT_DIR/seeded.json"
        docker exec -i "$RUNNER" sh -c "cat > $SIGNALS/funded.json" <<<"$seeded"
        say "seeded: $(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print("deposits", d["deposits"]["A"]["txId"][:12], d["deposits"]["B"]["txId"][:12], "bid", d["offers"]["bid"]["offerId"][:12])' "$seeded")"
      fi
    fi
    if [[ "$stopped" == 0 && -n "$(signal_file stop-kernel)" ]]; then
      docker stop "$P-kernel-1" >/dev/null
      stopped=1
      docker exec -i "$RUNNER" sh -c "cat > $SIGNALS/kernel-stopped.json" <<<'{"stopped":true}'
      say "kernel stopped for the 'exchange unavailable' check"
    fi
    sleep 3
  done
  if [[ "$status" == 0 ]]; then wait "$pid" || status=$?; else wait "$pid" 2>/dev/null || true; fi
  [[ "$stopped" == 1 ]] && docker start "$P-kernel-1" >/dev/null && say "kernel restarted"
  tail -12 "$log" >&2
  docker cp "$RUNNER:/app/test-results/e2e/." "$E2E_OUT_DIR/" >/dev/null 2>&1 || true
  docker logs "$RELAY" >"$E2E_STATE_DIR/logs/relay-$(date -u +%Y%m%dT%H%M%SZ).jsonl" 2>&1 || true
  # The relay keeps no user data: its filesystem is unchanged since start (read-only root, tmpfs /tmp).
  docker diff "$RELAY" | sort >"$E2E_STATE_DIR/relay-diff-after.txt" || true
  if diff -q "$E2E_STATE_DIR/relay-diff-before.txt" "$E2E_STATE_DIR/relay-diff-after.txt" >/dev/null; then
    say "relay filesystem unchanged since start; /tmp files: $(docker exec "$RELAY" sh -c 'find /tmp -type f | wc -l' 2>/dev/null | tr -d ' ')"
  else
    say "relay filesystem CHANGED since start (see $E2E_STATE_DIR/relay-diff-after.txt)"
  fi
  resources_line | tee -a "$E2E_STATE_DIR/logs/resources.tsv" >&2
  if [[ "$status" == 0 ]]; then say "E2E PASSED (results in $E2E_OUT_DIR)"; else say "E2E FAILED ($status); log $log"; fi
  return "$status"
}

# ── down ─────────────────────────────────────────────────────────────────────────────

down() {
  monitor_stop
  local P
  P="$(project)"
  docker rm -f "$RELAY" "$PROVER" >/dev/null 2>&1 || true
  docker ps -a --format '{{.Names}}' | grep -E "^$SEEDER-" | xargs -r docker rm -f >/dev/null 2>&1 || true
  if [[ -n "$P" ]]; then
    docker network disconnect "${P}_default" "$RUNNER" >/dev/null 2>&1 || true
    (cd "$STACK_DIR" && ENV_FILE="$STACK_ENV" ./down.sh -v) >"$E2E_STATE_DIR/logs/down.log" 2>&1 || true
    tail -3 "$E2E_STATE_DIR/logs/down.log" >&2 || true
    for s in "${IMAGES[@]}" offerfiles-kernel; do
      docker rmi "midnight-2-offers/${s}:$P" >/dev/null 2>&1 || true
    done
    docker ps -a --format '{{.Names}}' | grep -F "$P" && say "containers left for $P" >&2
    docker volume ls --format '{{.Name}}' | grep -F "$P" && say "volumes left for $P" >&2
    docker network ls --format '{{.Name}}' | grep -F "$P" && say "networks left for $P" >&2
  fi
  if [[ "${KEEP_RUNNER:-0}" != 1 ]]; then
    DOCKER_CHECK_NAME="$CHECK_NAME" "$ROOT/scripts/docker-check.sh" down >/dev/null 2>&1 || true
  fi
  rm -f "$E2E_STATE_DIR/sponsor.seed" "$STACK_ENV" "$RUN_ENV"
  if [[ -n "${STACK_LOCK:-}" && -f "$STACK_LOCK" ]] && grep -q "^$LOCK_LABEL " "$STACK_LOCK"; then
    rm -f "$STACK_LOCK"
    say "stack lock released"
  fi
  say "down: $P removed; disk free $(disk_free_gb) GB"
}

status_cmd() {
  local P
  P="$(project)"
  say "project ${P:-none}; lock: $(cat "${STACK_LOCK:-/nonexistent}" 2>/dev/null || echo none)"
  docker ps --format '{{.Names}}\t{{.Status}}' | grep -E "^($PREFIX|${P:-none})" || true
  resources_line
}

case "$CMD" in
  prepare) prepare ;;
  up) up ;;
  app) app_up ;;
  test) e2e_test ;;
  down) down ;;
  status) status_cmd ;;
  all)
    if [[ "${KEEP_STACK:-0}" != 1 ]]; then trap 'down' EXIT; fi
    up
    e2e_test
    ;;
  *)
    echo "usage: $0 all|prepare|up|app|test|down|status" >&2
    exit 64
    ;;
esac
