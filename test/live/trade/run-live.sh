#!/usr/bin/env bash
# run-live.sh — L-TRD.0, the take path LIVE on the staging exchange (plan 00039), in Docker.
#
#   test/live/trade/run-live.sh preflight   read-only (node, exchange, batcher, live ledger parameters)
#   test/live/trade/run-live.sh window      the live window: A funded with one wUSDC coin takes the best
#                                           ladder ask (b); B registered and funded for (c2); verify
#                                           (holds the SHARED funding lock for its whole run)
#   test/live/trade/run-live.sh c2          A offers, B takes it (c2) through the relay's executors
#   test/live/trade/run-live.sh verify      read-only: kernel status and both accounts' inbox walks
#   test/live/trade/run-live.sh replay      re-submits the settled take to the batcher (must be refused)
#
# The driver (l-trd0.ts) runs in oven/bun:1.3.11 on the Docker check runner's node_modules volume
# (scripts/docker-check.sh with DOCKER_CHECK_NAME, synced first), with the verified key cache
# mounted where a deployment mounts the key volume, the proof server (9.0.0-rc.6, by digest) in its
# network namespace, and the sponsor's mnemonic file mounted READ-ONLY for `window` only.
#
# Rules (plan "How to work", Q8, Q17): the funding lock is taken with the Offer Files protocol
# (O_EXCL, one JSON line) and released on exit, whatever happens; a proof waits for >= 10 GB of
# Docker memory headroom; every container is named aa00039-trd-* and removed on exit; nothing is
# built or pruned.
#
# Environment: TRD_EVIDENCE_DIR (required), STAGENET_WALLET_FILE_HOST (required for `window`),
# DOCKER_CHECK_NAME (default aa00039-trd-check), KEYS_DIR (default ~/.cache/aa-00039/keys),
# TRD_STATE_DIR (default ~/.config/aa-00039), LOCK_WAIT_MIN (default 30).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
CMD="${1:?usage: run-live.sh preflight|window|c2|verify|replay}"
CHECK="${DOCKER_CHECK_NAME:-aa00039-trd-check}"
APP="$CHECK-app"
KEYS_DIR="${KEYS_DIR:-$HOME/.cache/aa-00039/keys}"
TRD_STATE_DIR="${TRD_STATE_DIR:-$HOME/.config/aa-00039}"
BUN_IMAGE="oven/bun:1.3.11"
PROOF_IMAGE="midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b"
LOCK="$HOME/.stagenet-offer-ladders/funding.lock"
TAG="$$"
PROOF_NAME="aa00039-trd-proof-$TAG"
RUN_NAME="aa00039-trd-run-$CMD-$TAG"
MANAGED=/app/vendor/passport/contract/contracts/managed
: "${TRD_EVIDENCE_DIR:?set TRD_EVIDENCE_DIR (public evidence)}"

say() { printf '== %s\n' "$*" >&2; }

cleanup() {
  docker rm -f "$RUN_NAME" >/dev/null 2>&1 || true
  docker rm -f "$PROOF_NAME" >/dev/null 2>&1 || true
  if [ "${LOCK_TAKEN:-0}" = 1 ]; then rm -f "$LOCK" && say "funding lock released"; fi
}
trap cleanup EXIT INT TERM

case "$CMD" in
  window|c2) NEEDS_WALLET=1 ;;
  preflight|verify|replay) NEEDS_WALLET=0 ;;
  *) echo "unknown command $CMD" >&2; exit 2 ;;
esac
mkdir -p "$TRD_EVIDENCE_DIR" "$TRD_STATE_DIR/logs"
chmod 700 "$TRD_STATE_DIR" "$TRD_STATE_DIR/logs"

# The runner's volume holds node_modules; copy the current tree into it first.
DOCKER_CHECK_NAME="$CHECK" "$REPO/scripts/docker-check.sh" up >/dev/null
DOCKER_CHECK_NAME="$CHECK" "$REPO/scripts/docker-check.sh" sync >/dev/null

wallet_in_use() {
  local ids
  ids="$(docker ps -q)"
  [ -n "$ids" ] && docker inspect --format '{{.Name}} {{range .Mounts}}{{.Source}} {{end}}' $ids 2>/dev/null |
    grep -F "/Offer Files/.stagenet" >/dev/null
}

if [ "$NEEDS_WALLET" = 1 ]; then
  : "${STAGENET_WALLET_FILE_HOST:?set STAGENET_WALLET_FILE_HOST}"
  [ -f "$STAGENET_WALLET_FILE_HOST" ] || { echo "no mnemonic file at the configured path" >&2; exit 2; }
  mkdir -p "$(dirname "$LOCK")"
  WAIT_MIN="${LOCK_WAIT_MIN:-30}"
  TRIES=$(( WAIT_MIN / 2 + 1 ))
  for i in $(seq 1 "$TRIES"); do
    if ! wallet_in_use && ( set -o noclobber
      printf '{"purpose":"aa-00039 L-TRD.0 live window (%s)","pid":%s,"host":"%s","at":"%s"}' \
        "$CMD" "$$" "$(hostname)" "$(date -u +%FT%TZ)" > "$LOCK" ) 2>/dev/null; then
      LOCK_TAKEN=1; break
    fi
    [ "$i" = "$TRIES" ] && { echo "the funding wallet is still busy after $WAIT_MIN min: $(cat "$LOCK" 2>/dev/null)" >&2; exit 75; }
    say "the funding wallet is busy ($(cat "$LOCK" 2>/dev/null || echo 'a container has it mounted')); waiting 120 s ($i/$TRIES)"
    sleep 120
  done
  say "funding lock taken"
  # A proof takes about 8 GB: wait for 10 GB of Docker memory headroom (another lane may be proving).
  for i in $(seq 1 31); do
    HEADROOM="$(docker stats --no-stream --format '{{.MemUsage}}' | python3 -c '
import re, sys
unit = {"B": 1, "KiB": 2**10, "MiB": 2**20, "GiB": 2**30, "KB": 1e3, "MB": 1e6, "GB": 1e9}
used, total = 0.0, 0.0
for line in sys.stdin:
    a, b = [s.strip() for s in line.split("/")]
    m, n = re.match(r"([\d.]+)(\w+)", a), re.match(r"([\d.]+)(\w+)", b)
    used += float(m.group(1)) * unit[m.group(2)]
    total = max(total, float(n.group(1)) * unit[n.group(2)])
print(int((total - used) / 2**30) if total else 99)')"
    [ "$HEADROOM" -ge 10 ] && break
    [ "$i" = 31 ] && { echo "Docker memory headroom stayed below 10 GB for 30 min" >&2; exit 75; }
    say "Docker memory headroom ${HEADROOM} GB < 10 GB; waiting 60 s ($i/30)"
    sleep 60
  done
fi

# The proof server (also needed to load the runtime, which checks its keys; it proves only in `window`).
docker run -d --name "$PROOF_NAME" --memory 12g "$PROOF_IMAGE" >/dev/null
for _ in $(seq 1 120); do
  docker exec "$PROOF_NAME" sh -c 'exit 0' >/dev/null 2>&1 && break
  sleep 1
done
say "proof server $PROOF_NAME up"

SECRET_ARGS=()
if [ "$NEEDS_WALLET" = 1 ]; then
  SECRET_ARGS=(-v "$STAGENET_WALLET_FILE_HOST:/secrets/stagenet:ro" -e STAGENET_WALLET_FILE=/secrets/stagenet)
fi

LOG="$TRD_STATE_DIR/logs/l-trd0-$CMD-$(date -u +%Y%m%dT%H%M%SZ).log"
say "log $LOG"
set +e
docker run --rm --name "$RUN_NAME" --network "container:$PROOF_NAME" \
  ${SECRET_ARGS[@]+"${SECRET_ARGS[@]}"} \
  -v "$APP:/app:ro" -v "$KEYS_DIR:$MANAGED:ro" \
  -v "$TRD_STATE_DIR:/state" -v "$TRD_EVIDENCE_DIR:/evidence" \
  -w /app -e BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
  -e TRD_STATE_DIR=/state -e TRD_EVIDENCE_DIR=/evidence -e MIDNIGHT_MANAGED_PATH="$MANAGED" \
  -e MIDNIGHT_PROOF_SERVER_URL=http://127.0.0.1:6300 \
  -e SPONSOR_FEE_BLOCKS_MARGIN="${SPONSOR_FEE_BLOCKS_MARGIN:-20}" \
  "$BUN_IMAGE" bun test/live/trade/l-trd0.ts "$CMD" 2>&1 | tee "$LOG"
STATUS="${PIPESTATUS[0]}"
set -e
exit "$STATUS"
