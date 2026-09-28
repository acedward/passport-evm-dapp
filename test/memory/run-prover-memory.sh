#!/usr/bin/env bash
# The relay's prover memory check (plan 00039 P5.1b, question Q25). See test/memory/README.md.
#
#   test/memory/run-prover-memory.sh synthetic [harness args]   no keys, no proof server (what CI runs)
#   test/memory/run-prover-memory.sh real [harness args]        a real k=18 proof against the pinned
#                                                              proof server (needs KEYS_DIR)
#   test/memory/run-prover-memory.sh down                       remove everything it started
#
# The harness (relay/src/tools/prover-memory.ts) runs in the relay's base image, in a container
# with MEM_LIMIT and NO swap, and fails when its peak anonymous memory passes BUDGET_MB. Past the
# limit the kernel kills it, which also fails (exit 137). Everything is torn down at the end unless
# KEEP=1 (the proof server's parameters then stay cached for the next run).
#
# Environment:
#   KEYS_DIR     (real) the key volume on the host, in the relay's MIDNIGHT_MANAGED_PATH layout
#                (<bundle>/{keys,zkir,compiler,contract}, e.g. a copy of the deployment's `keys` volume)
#   MEM_LIMIT    the harness container's memory limit (default 1g)
#   BUDGET_MB    the peak anonymous memory allowed (default 768 real, 512 synthetic)
#   PROOFS       proofs in a row (default 4)
#   OUT_DIR      where the JSON report goes (default test-results/prover-memory)
#   NAME         prefix of the containers, volumes and network (default mnbank-mem)
#   KEEP         1 keeps the network, the proof server and the volumes after the run
#   PARAMS_SEED_DIR  (real) optional directory of proof-server parameters (bls_midnight_2p*, zswap/,
#                dust/) copied into the proof server's volume first, to skip their download
#   PROOF_SERVER_WAIT  (real) seconds to wait for the proof server to listen (default 1800)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAME="${NAME:-mnbank-mem}"
BUN_IMAGE="${BUN_IMAGE:-oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7}"
PROOF_IMAGE="${PROOF_IMAGE:-midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b}"
MEM_LIMIT="${MEM_LIMIT:-1g}"
PROOFS="${PROOFS:-4}"
OUT_DIR="${OUT_DIR:-$ROOT/test-results/prover-memory}"
APP="$NAME-app"
NET="$NAME-net"
PROVER="$NAME-proof-server"
PARAMS="$NAME-proof-params"
HARNESS="$NAME-harness"

say() { echo "prover-memory: $*" >&2; }

down() {
  docker rm -f "$HARNESS" "$PROVER" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$APP" "$PARAMS" >/dev/null 2>&1 || true
  say "removed $HARNESS, $PROVER, $NET, $APP, $PARAMS"
}

# The working tree and its production dependencies in a volume, as the relay image holds them.
prepare() {
  docker volume create "$APP" >/dev/null
  docker run --rm -v "$ROOT:/src:ro" -v "$APP:/app" "$BUN_IMAGE" sh -c '
    set -e
    find /app -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
    cd /src && tar cf - --exclude=./node_modules --exclude=./.git --exclude=./test-results \
      --exclude=./vendor/passport/contract/contracts/managed . | (cd /app && tar xf -)
    mkdir -p /app/vendor/passport/contract/contracts/managed
    cd /app && bun install --frozen-lockfile --production --ignore-scripts >/dev/null'
}

harness() {
  local mode="$1"
  shift
  local budget="$BUDGET_MB"
  local args=(--proofs "$PROOFS" --budget-mb "$budget" --out "/out/$mode.json")
  # As the invoking user, so it can write the report into OUT_DIR on any host.
  local run=(docker run --rm --name "$HARNESS" --memory "$MEM_LIMIT" --memory-swap "$MEM_LIMIT"
    --user "$(id -u):$(id -g)" -e HOME=/tmp --cap-drop ALL --security-opt no-new-privileges:true
    -v "$APP:/app:ro" -v "$OUT_DIR:/out" -w /app)
  if [[ "$mode" == synthetic ]]; then
    args+=(--synthetic)
  else
    run+=(--network "$NET" -v "$KEYS_DIR:/app/vendor/passport/contract/contracts/managed:ro"
      -e MIDNIGHT_MANAGED_PATH=/app/vendor/passport/contract/contracts/managed
      -e MIDNIGHT_PROOF_SERVER_URL=http://proof-server:6300)
  fi
  mkdir -p "$OUT_DIR"
  say "$mode: $PROOFS proof(s) in a container limited to $MEM_LIMIT without swap, budget $budget MB"
  local rc=0
  "${run[@]}" "$BUN_IMAGE" bun relay/src/tools/prover-memory.ts "${args[@]}" "$@" >/dev/null || rc=$?
  if [[ "$rc" == 137 ]]; then
    say "FAIL: the kernel killed the harness at the $MEM_LIMIT limit (out of memory)"
  elif [[ -f "$OUT_DIR/$mode.json" ]]; then
    say "$(docker run --rm -v "$OUT_DIR:/out:ro" "$BUN_IMAGE" bun -e "const r = require('/out/$mode.json'); console.log(r.result + ': peak anonymous ' + r.peakAnonMb + ' MB (budget ' + r.budgetMb + ' MB); proofs ' + r.proofRuns.map((p) => p.ms + ' ms').join(', '))" 2>/dev/null || echo "exit $rc")"
    say "report: $OUT_DIR/$mode.json"
  fi
  return "$rc"
}

cmd="${1:-synthetic}"
shift || true
case "$cmd" in
  down) down ;;
  synthetic)
    BUDGET_MB="${BUDGET_MB:-512}"
    [[ "${KEEP:-0}" == 1 ]] || trap 'rc=$?; down; exit $rc' EXIT
    prepare
    harness synthetic "$@"
    ;;
  real)
    BUDGET_MB="${BUDGET_MB:-768}"
    [[ -n "${KEYS_DIR:-}" && -d "$KEYS_DIR/account/keys" ]] || { say "KEYS_DIR must be a key volume (with account/keys)"; exit 64; }
    [[ "${KEEP:-0}" == 1 ]] || trap 'rc=$?; down; exit $rc' EXIT
    prepare
    docker network create "$NET" >/dev/null 2>&1 || true
    docker volume create "$PARAMS" >/dev/null
    if [[ -n "${PARAMS_SEED_DIR:-}" ]]; then
      docker run --rm -v "$PARAMS_SEED_DIR:/seed:ro" -v "$PARAMS:/proof-params" "$BUN_IMAGE" \
        sh -c 'cp -Rn /seed/. /proof-params/ && chmod -R a+rwX /proof-params'
    fi
    if [[ "$(docker inspect -f '{{.State.Running}}' "$PROVER" 2>/dev/null)" != true ]]; then
      docker rm -f "$PROVER" >/dev/null 2>&1 || true
      docker run -d --name "$PROVER" --network "$NET" --network-alias proof-server --memory 12g \
        --cap-drop ALL --security-opt no-new-privileges:true -e PORT=6300 -e MIDNIGHT_PP=/proof-params \
        -v "$PARAMS:/proof-params" "$PROOF_IMAGE" >/dev/null
    fi
    # Ready when it answers /version on the harness's network. A first start downloads its public
    # parameters from srs.midnight.network before it listens (KEEP=1 keeps them for the next run).
    say "waiting for the proof server (at most ${PROOF_SERVER_WAIT:-1800} s)"
    docker run --rm --network "$NET" "$BUN_IMAGE" bun -e "
      const until = Date.now() + ${PROOF_SERVER_WAIT:-1800} * 1000;
      while (Date.now() < until) {
        try { const r = await fetch('http://proof-server:6300/version'); if (r.ok) process.exit(0); } catch {}
        await Bun.sleep(5000);
      }
      process.exit(1);" || { say "the proof server did not come up (docker logs $PROVER)"; exit 1; }
    harness real "$@"
    ;;
  *)
    echo "usage: $0 synthetic|real|down [harness args]" >&2
    exit 64
    ;;
esac
