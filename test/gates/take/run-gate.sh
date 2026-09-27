#!/usr/bin/env bash
# run-gate.sh — the G-TAKE gate on a LOCAL ledger-9 stack (plan 00039, P2): can a Passport account
# take someone else's open offer? Everything runs in Docker; nothing here touches a live network.
#
#   test/gates/take/run-gate.sh prepare        host: copy the stack's test-faucet artefacts (44 MB)
#   test/gates/take/run-gate.sh up             the P0.5 stack (midnight-2-offers: --with aa --with
#                                               offerfiles, kernel at KERNEL_REF), the rc.6 prover
#   test/gates/take/run-gate.sh <step> [args]  one gate.ts step in the stack image, on its network
#   test/gates/take/run-gate.sh down           remove the prover and the stack, drop the image tags
#
# Steps (gate.ts): preflight, setup, register, fund, offer <label> <kind>,
#   take <evidence-label> <offer> <default|guaranteed> [--replay], relay-take <label> <offer> [--race],
#   status.
#
# Environment:
#   STACK_DIR          a midnight-2-offers clone at 773659c (the P0.5 recipe) — required for up/down
#   STACK_ENV          its env file (default $STACK_DIR/.env.gate-take; written by `up`)
#   STACK_LOCK         the one-local-stack lock file (required for up/down; holds "G-TAKE <pid> <start>")
#   GATE_EVIDENCE_DIR  public evidence (required for steps)
#   GATE_STATE_DIR     the accounts' keys and offers (default ~/.config/aa-00039/gate-take, mode 700)
#   KEYS_DIR           the verified account key cache (default ~/.cache/aa-00039/keys)
#   FAUCET_DIR         the faucet artefacts (default ~/.cache/aa-00039/gate-take/managed)
#   GATE_IMAGE_BASE    the byte-equivalent stack images to re-tag (default demo-infra-14580)
#   KERNEL_REF         the kernel commit (default 5d46e8de…, the staging ledger-v9 line)
#   MIN_DISK_GB        refuse to bring the stack up below this much free Docker VM disk (default 4)
#   STACK_PROFILES     default "--with aa --with offerfiles" (the plan's recipe). "--with aa" is the
#                      REDUCED stack (no kernel, batcher or Celestia; about 0.4 GB of Docker disk
#                      instead of about 2 GB): the driver then submits every settlement to the node.
#
# Rules this follows (plan 00039 "How to work"): one full local stack on the host, under a lock;
# random free ports >= 10000; names prefixed aa00039-take; the prover limited to 10 GB and started
# only with >= 10 GB of Docker memory headroom; images are RE-TAGGED, never compiled (Q17); every
# container and volume is removed by `down`; nothing is pruned.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
CMD="${1:?usage: run-gate.sh prepare|up|down|<step> [args]}"
shift || true

PREFIX="aa00039-take"
GATE_STATE_DIR="${GATE_STATE_DIR:-$HOME/.config/aa-00039/gate-take}"
KEYS_DIR="${KEYS_DIR:-$HOME/.cache/aa-00039/keys}"
FAUCET_DIR="${FAUCET_DIR:-$HOME/.cache/aa-00039/gate-take/managed}"
BASE_TAG="${GATE_IMAGE_BASE:-demo-infra-14580}"
KERNEL_REF="${KERNEL_REF:-5d46e8de329b68413e9348e3e4eead1094a3bc18}"
PROOF_IMAGE="midnightntwrk/proof-server@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b"
PP_GENERATION="b73584978fc560bb827fd9df3ad914b37a6f5ea434fe62e9fa0adad809d8486c"
MIN_DISK_GB="${MIN_DISK_GB:-4}"
PROVER="$PREFIX-prover"

say() { printf '== %s\n' "$*" >&2; }

disk_free_gb() { docker run --rm alpine:3 df -k / | awk 'NR==2 {printf "%d", $4/1024/1024}'; }

mem_headroom_gb() {
  docker stats --no-stream --format '{{.MemUsage}}' | python3 -c '
import re, sys
unit = {"B": 1, "KiB": 2**10, "MiB": 2**20, "GiB": 2**30, "KB": 1e3, "MB": 1e6, "GB": 1e9}
used, total = 0.0, 0.0
for line in sys.stdin:
    a, b = [s.strip() for s in line.split("/")]
    m, n = re.match(r"([\d.]+)(\w+)", a), re.match(r"([\d.]+)(\w+)", b)
    used += float(m.group(1)) * unit[m.group(2)]
    total = max(total, float(n.group(1)) * unit[n.group(2)])
print(int((total - used) / 2**30) if total else 99)'
}

env_of() { grep -E "^$1=" "$STACK_ENV" | tail -1 | cut -d= -f2-; }

stack_vars() {
  : "${STACK_DIR:?set STACK_DIR (a midnight-2-offers clone at 773659c)}"
  STACK_ENV="${STACK_ENV:-$STACK_DIR/.env.gate-take}"
}

case "$CMD" in
  prepare)
    # The stack's test faucet (mints the second shielded colour), copied out of the stack image to
    # the HOST disk, not Docker's. 44 MB.
    mkdir -p "$FAUCET_DIR" && chmod 700 "$(dirname "$FAUCET_DIR")"
    if [ ! -d "$FAUCET_DIR/faucet" ]; then
      SRC="$PREFIX-faucetsrc-$$"
      docker create --name "$SRC" --entrypoint true "midnight-2-offers/aa-contracts:$BASE_TAG" >/dev/null
      docker cp "$SRC:/aa/passport/contracts/managed/faucet" "$FAUCET_DIR/faucet"
      docker rm -f "$SRC" >/dev/null
    fi
    mkdir -p "$REPO/vendor/passport/contract/contracts/managed" # the key volume's mount point (git-ignored)
    say "prepared: faucet $FAUCET_DIR"
    ;;

  up)
    stack_vars
    : "${STACK_LOCK:?set STACK_LOCK}"
    FREE="$(disk_free_gb)"
    [ "$FREE" -ge "$MIN_DISK_GB" ] || { echo "Docker VM disk has ${FREE} GB free (< $MIN_DISK_GB)" >&2; exit 75; }
    if ( set -o noclobber; echo "G-TAKE $$ $(date -u +%FT%TZ)" >"$STACK_LOCK" ) 2>/dev/null; then :; else
      echo "the local stack is held: $(cat "$STACK_LOCK")" >&2; exit 75
    fi
    PROFILES="${STACK_PROFILES:---with aa --with offerfiles}"
    case " $PROFILES " in *" offerfiles "*) FULL=1 ;; *) FULL=0 ;; esac
    cd "$STACK_DIR"
    PROJECT_PREFIX="$PREFIX" BASE_MIN=20000 ./scripts/pick-ports.sh >"$STACK_ENV"
    echo "KERNEL_REF=$KERNEL_REF" >>"$STACK_ENV"
    echo "GATE_PROFILES=\"$PROFILES\"" >>"$STACK_ENV"
    P="$(env_of COMPOSE_PROJECT_NAME)"
    S="${P}"
    echo "G-TAKE $$ $(date -u +%FT%TZ) project=$P" >"$STACK_LOCK"
    say "project $P (ports from $(env_of NODE_HOST_PORT 2>/dev/null || echo '?'))"
    if [ "$FULL" = 1 ]; then
      docker build -q --build-arg KERNEL_REF="$KERNEL_REF" -t "midnight-2-offers/offerfiles-kernel:$S" images/offerfiles-kernel >/dev/null
    fi
    for s in aa-contracts postgres indexer celestia; do
      docker tag "midnight-2-offers/${s}:$BASE_TAG" "midnight-2-offers/${s}:$S"
    done
    # shellcheck disable=SC2086 # the profiles are words
    ENV_FILE="$STACK_ENV" ./up.sh $PROFILES
    if [ "$FULL" = 1 ]; then
      say "kernel flags: ALLOW_CONTRACT_MAKER_OFFERS=$(docker exec "$P-kernel-1" sh -c 'echo $ALLOW_CONTRACT_MAKER_OFFERS') BATCHER_ALLOW_CONTRACT_TX=$(docker exec "$P-batcher-1" sh -c 'echo $BATCHER_ALLOW_CONTRACT_TX')"
      say "kernel commit: $(docker exec "$P-kernel-1" cat /app/.kernel-commit)"
    fi
    # aa-console holds genesis-3 (the funder) open; one facade per seed.
    docker stop "$P-aa-console-1" >/dev/null 2>&1 || true
    docker run -d --name "$PROVER" --network "${P}_default" --network-alias proof-server-rc6 \
      --memory 10g --cap-drop ALL --security-opt no-new-privileges:true \
      -e PORT=6300 -e MIDNIGHT_PP="/proof-params/generations/$PP_GENERATION" \
      -e MIDNIGHT_PARAM_SOURCE=https://srs.midnight.network/ \
      -v "${P}_proof-params:/proof-params:ro" "$PROOF_IMAGE" >/dev/null
    say "stack up: $P; prover $PROVER; free disk $(disk_free_gb) GB"
    ;;

  down)
    stack_vars
    P="$(env_of COMPOSE_PROJECT_NAME)"
    docker rm -f "$PROVER" >/dev/null 2>&1 || true
    (cd "$STACK_DIR" && ENV_FILE="$STACK_ENV" ./down.sh -v)
    for s in aa-contracts offerfiles-kernel postgres indexer celestia proof-params; do
      docker rmi "midnight-2-offers/${s}:$P" >/dev/null 2>&1 || true
    done
    docker ps -a --format '{{.Names}}' | grep -F "$P" && { echo "containers left for $P" >&2; exit 1; }
    docker volume ls --format '{{.Name}}' | grep -F "$P" && { echo "volumes left for $P" >&2; exit 1; }
    [ -n "${STACK_LOCK:-}" ] && rm -f "$STACK_LOCK"
    say "stack $P removed; lock released; free disk $(disk_free_gb) GB"
    ;;

  *)
    stack_vars
    : "${GATE_EVIDENCE_DIR:?set GATE_EVIDENCE_DIR (public evidence)}"
    P="$(env_of COMPOSE_PROJECT_NAME)"
    case " $(env_of GATE_PROFILES | tr -d '"') " in *" offerfiles "*) GATE_KERNEL=1 ;; *) GATE_KERNEL=0 ;; esac
    mkdir -p "$GATE_STATE_DIR/logs" "$GATE_EVIDENCE_DIR" && chmod 700 "$GATE_STATE_DIR" "$GATE_STATE_DIR/logs"
    FREE="$(disk_free_gb)"
    [ "$FREE" -ge "$MIN_DISK_GB" ] || { echo "Docker VM disk has ${FREE} GB free (< $MIN_DISK_GB): tear down" >&2; exit 75; }
    case "$CMD" in
      setup|register|fund|offer|take|relay-take)
        for i in $(seq 1 31); do
          H="$(mem_headroom_gb)"
          [ "$H" -ge 10 ] && break
          [ "$i" = 31 ] && { echo "Docker memory headroom stayed below 10 GB for 30 min" >&2; exit 75; }
          say "Docker memory headroom ${H} GB < 10 GB; waiting 60 s ($i/30)"
          sleep 60
        done ;;
    esac
    LOG="$GATE_STATE_DIR/logs/$CMD-$(date -u +%Y%m%dT%H%M%SZ).log"
    say "log $LOG"
    set +e
    # The sources are COPIED into the container (about 4 MB) and the key cache is bind-mounted
    # beside them: with the key cache nested inside a bind-mounted tree, Bun intermittently fails
    # to resolve the compiled contracts' relative imports (`../../SignetSigner/...`).
    docker run --rm --name "$PREFIX-driver-$CMD-$$" --network "${P}_default" \
      --entrypoint sh -w /aa \
      -v "$REPO:/src:ro" \
      -v "$KEYS_DIR:/aa/gt/vendor/passport/contract/contracts/managed:ro" \
      -v "$FAUCET_DIR:/aa/gtf/managed:ro" \
      -v "$STACK_DIR/wallets/wallets.json:/run/secrets/wallets.json:ro" \
      -v "${P}_aa-out:/aa/out:ro" \
      -v "$GATE_STATE_DIR:/state" -v "$GATE_EVIDENCE_DIR:/out" \
      -e GATE_STATE_DIR=/state -e GATE_EVIDENCE_DIR=/out -e GATE_KERNEL="$GATE_KERNEL" \
      -e BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
      -e SPONSOR_FEE_BLOCKS_MARGIN="${SPONSOR_FEE_BLOCKS_MARGIN:-20}" \
      "midnight-2-offers/aa-contracts:$P" -c '(cd /src && tar cf - package.json bunfig.toml relay/src packages/core/src \
        test/gates/take vendor/passport/contract/package.json vendor/passport/contract/src) | tar xf - -C /aa/gt \
        && cd /aa/gt && exec bun test/gates/take/gate.ts "$@"' sh "$CMD" "$@" 2>&1 | tee "$LOG"
    STATUS="${PIPESTATUS[0]}"
    set -e
    exit "$STATUS"
    ;;
esac
