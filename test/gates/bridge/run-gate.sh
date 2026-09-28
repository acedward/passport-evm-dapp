#!/usr/bin/env bash
# run-gate.sh — run one step of the G-BRIDGE live gate (gate.ts) against Midnight stagenet and
# Sepolia, in Docker, with the owner's secrets mounted READ-ONLY and never on a command line.
#
#   test/gates/bridge/run-gate.sh prepare            # host: key bundles, the 0.23 SDK, the link layout
#   test/gates/bridge/run-gate.sh keys-verify        # read-only
#   test/gates/bridge/run-gate.sh preflight          # read-only
#   test/gates/bridge/run-gate.sh deploy             # Midnight spend (the sponsor wallet, locked)
#   test/gates/bridge/run-gate.sh fund               # Sepolia spend
#   test/gates/bridge/run-gate.sh deposit-start      # Midnight spend
#   test/gates/bridge/run-gate.sh relay-deposit      # broadcasts the MPC-signed sweep
#   test/gates/bridge/run-gate.sh deposit-complete   # Midnight spend
#   test/gates/bridge/run-gate.sh withdraw-gas       # Sepolia spend, only if the vault lacks gas
#   test/gates/bridge/run-gate.sh withdraw-start     # Midnight spend
#   test/gates/bridge/run-gate.sh relay-withdraw     # broadcasts the MPC-signed transfer
#   test/gates/bridge/run-gate.sh withdraw-complete  # Midnight spend
#   test/gates/bridge/run-gate.sh status
#
# What it does, per step:
#   * steps that PROVE start the pinned proof server (9.0.0-rc.6, by digest) on a random free
#     127.0.0.1 port >= 10000, after waiting for >= 10 GB of Docker memory headroom (a k=18 proof
#     takes about 8 GB), and the gate joins its network namespace;
#   * steps that open the Midnight wallet take the SHARED funding-wallet lock
#     (~/.stagenet-offer-ladders/funding.lock, the Offer Files protocol: one process per seed),
#     waiting up to 30 minutes, and mount the mnemonic file read-only;
#   * steps that send from the Sepolia funder wait while another agent's bridge driver runs
#     (concurrent sends collide on the nonce), and mount the key file read-only;
#   * every container is removed on exit, and the lock is released, whatever happens.
#
# Environment:
#   GATE_EVIDENCE_DIR (required: public evidence), STAGENET_WALLET_FILE_HOST and
#   SEPOLIA_KEY_FILE_HOST (required for spending steps), PASSPORT_CONTRACT_DIR (default: the
#   vendor/passport submodule's contract/), GATE_KEYS_DIR, GATE_LAYOUT_DIR, GATE_SDK_DIR,
#   GATE_STATE_DIR (defaults under ~/.cache/aa-00039 and ~/.config/aa-00039), GATE_IMAGE,
#   SEPOLIA_RPC_URL (optional; public default).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
CMD="${1:?usage: run-gate.sh <command>}"
shift || true

PASSPORT_CONTRACT_DIR="${PASSPORT_CONTRACT_DIR:-$REPO/vendor/passport/contract}"
GATE_KEYS_DIR="${GATE_KEYS_DIR:-$HOME/.cache/aa-00039/keys-gate-bridge}"
GATE_LAYOUT_DIR="${GATE_LAYOUT_DIR:-$HOME/.cache/aa-00039/gate-bridge-layout}"
GATE_SDK_DIR="${GATE_SDK_DIR:-$HOME/.cache/aa-00039/sdk-0.23}"
GATE_STATE_DIR="${GATE_STATE_DIR:-$HOME/.config/aa-00039}"
GATE_IMAGE="${GATE_IMAGE:-midnight-2-offers/aa-contracts:demo-infra-14580}"
PROOF_IMAGE="midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b"
LOCK="$HOME/.stagenet-offer-ladders/funding.lock"
PREFIX="aa00039-gbr"
TAG="$$"
PROOF_NAME="$PREFIX-proof-$TAG"
RUN_NAME="$PREFIX-run-$CMD-$TAG"
CONTAINER_ROOT=/aa/g/contract

say() { printf '== %s\n' "$*" >&2; }

# ---- prepare: everything the gate image needs, on the HOST disk (not Docker's) --------------------
if [ "$CMD" = prepare ]; then
  # The managed bundles (contract JS, verifier keys, zkir, the prover keys the gate proves with),
  # copied out of the image that carries the pinned account's full compile. keys-verify checks them.
  mkdir -p "$GATE_KEYS_DIR/account/keys" && chmod 700 "$GATE_KEYS_DIR"
  SRC="$PREFIX-keysrc-$TAG"
  docker create --name "$SRC" --entrypoint true "$GATE_IMAGE" >/dev/null
  trap 'docker rm -f "$SRC" >/dev/null 2>&1 || true' EXIT
  V=/aa/passport/contracts/erc20-vault/managed
  A=/aa/passport/contracts/managed/account
  for d in Erc20Vault SignetSigner SignetCircuits; do
    [ -d "$GATE_KEYS_DIR/$d" ] || docker cp "$SRC:$V/$d" "$GATE_KEYS_DIR/$d"
  done
  for d in contract compiler zkir; do
    [ -d "$GATE_KEYS_DIR/account/$d" ] || docker cp "$SRC:$A/$d" "$GATE_KEYS_DIR/account/$d"
  done
  docker cp "$SRC:/aa/passport/contracts/account.compact" "$GATE_KEYS_DIR/account.compact"
  docker run --rm --entrypoint sh "$GATE_IMAGE" -c "ls $A/keys" | grep '\.verifier$' | while read -r f; do
    [ -f "$GATE_KEYS_DIR/account/keys/$f" ] || docker cp "$SRC:$A/keys/$f" "$GATE_KEYS_DIR/account/keys/$f"
  done
  for c in activate_initial_device_with_evm bridge_deposit_start_with_evm bridge_deposit_complete \
    bridge_withdraw_start_with_evm bridge_withdraw_complete bridge_withdraw_refund append_inbox_with_evm; do
    [ -f "$GATE_KEYS_DIR/account/keys/$c.prover" ] || docker cp "$SRC:$A/keys/$c.prover" "$GATE_KEYS_DIR/account/keys/$c.prover"
  done
  chmod -R go-rwx "$GATE_KEYS_DIR"

  # @sig-net/midnight(-serde) 0.23.0 exactly as the vault's lock pins them, integrity-checked, and
  # nothing else: every other package resolves to the image's one copy (one compact-runtime).
  LOCKFILE="$PASSPORT_CONTRACT_DIR/contracts/erc20-vault/package-lock.json"
  mkdir -p "$GATE_SDK_DIR/tgz" && chmod 700 "$GATE_SDK_DIR"
  (cd "$GATE_SDK_DIR/tgz" && for spec in @sig-net/midnight@0.23.0 @sig-net/midnight-serde@0.23.0 @noble/hashes@2.4.0; do
    npm pack "$spec" --silent >/dev/null
  done)
  python3 - "$LOCKFILE" "$GATE_SDK_DIR/tgz" <<'PY'
import base64, hashlib, json, sys
lock = json.load(open(sys.argv[1]))['packages']
want = {'sig-net-midnight-0.23.0.tgz': 'node_modules/@sig-net/midnight',
        'sig-net-midnight-serde-0.23.0.tgz': 'node_modules/@sig-net/midnight-serde',
        'noble-hashes-2.4.0.tgz': 'node_modules/@sig-net/midnight/node_modules/@noble/hashes'}
for f, k in want.items():
    algo, b64 = lock[k]['integrity'].split('-', 1)
    got = base64.b64encode(hashlib.new(algo, open(f'{sys.argv[2]}/{f}', 'rb').read()).digest()).decode()
    if got != b64:
        sys.exit(f'{f}: integrity mismatch against the vault lock')
    print(f'{f}: integrity OK')
PY
  N="$GATE_SDK_DIR/node_modules"
  rm -rf "$N" && mkdir -p "$N/@sig-net/midnight" "$N/@sig-net/midnight-serde" "$N/@sig-net/midnight/node_modules/@noble/hashes"
  tar -xzf "$GATE_SDK_DIR/tgz/sig-net-midnight-0.23.0.tgz" -C "$N/@sig-net/midnight" --strip-components=1
  tar -xzf "$GATE_SDK_DIR/tgz/sig-net-midnight-serde-0.23.0.tgz" -C "$N/@sig-net/midnight-serde" --strip-components=1
  tar -xzf "$GATE_SDK_DIR/tgz/noble-hashes-2.4.0.tgz" -C "$N/@sig-net/midnight/node_modules/@noble/hashes" --strip-components=1

  # contracts/managed as link-callees.sh lays it out: real bundle directories whose CHILDREN link
  # into the vault package's managed/ (nodeZkConfigRegistry skips a bundle that is itself a link),
  # so the account's callee and the vault package load ONE copy of each compiled module.
  rm -rf "$GATE_LAYOUT_DIR" && mkdir -p "$GATE_LAYOUT_DIR/managed"
  for b in account Erc20Vault SignetSigner; do
    mkdir -p "$GATE_LAYOUT_DIR/managed/$b"
    for child in contract compiler keys zkir; do
      ln -s "$CONTAINER_ROOT/contracts/erc20-vault/managed/$b/$child" "$GATE_LAYOUT_DIR/managed/$b/$child"
    done
  done
  say "prepared: keys $GATE_KEYS_DIR, sdk $GATE_SDK_DIR/node_modules, layout $GATE_LAYOUT_DIR"
  exit 0
fi

case "$CMD" in
  deploy|deposit-start|deposit-complete|withdraw-start|withdraw-complete)
    NEEDS_PROOF=1; NEEDS_WALLET=1; NEEDS_SEPOLIA=0 ;;
  fund|withdraw-gas) NEEDS_PROOF=0; NEEDS_WALLET=0; NEEDS_SEPOLIA=1 ;;
  keys-verify|preflight|relay-deposit|relay-withdraw|status) NEEDS_PROOF=0; NEEDS_WALLET=0; NEEDS_SEPOLIA=0 ;;
  *) echo "unknown command $CMD" >&2; exit 2 ;;
esac
: "${GATE_EVIDENCE_DIR:?set GATE_EVIDENCE_DIR (public evidence)}"
mkdir -p "$GATE_STATE_DIR/work" "$GATE_STATE_DIR/logs" "$GATE_EVIDENCE_DIR"
chmod 700 "$GATE_STATE_DIR" "$GATE_STATE_DIR/work" "$GATE_STATE_DIR/logs"

cleanup() {
  docker rm -f "$RUN_NAME" >/dev/null 2>&1 || true
  docker rm -f "$PROOF_NAME" >/dev/null 2>&1 || true
  if [ "${LOCK_TAKEN:-0}" = 1 ]; then rm -f "$LOCK"; fi
}
trap cleanup EXIT INT TERM

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
  for i in $(seq 1 16); do
    if ! wallet_in_use && ( set -o noclobber
      printf '{"purpose":"aa-00039 gate-bridge %s","pid":%s,"host":"%s","at":"%s"}' \
        "$CMD" "$$" "$(hostname)" "$(date -u +%FT%TZ)" > "$LOCK" ) 2>/dev/null; then
      LOCK_TAKEN=1; break
    fi
    [ "$i" = 16 ] && { echo "the funding wallet is still busy after 30 min: $(cat "$LOCK" 2>/dev/null)" >&2; exit 75; }
    say "the funding wallet is busy ($(cat "$LOCK" 2>/dev/null || echo 'a container has it mounted')); waiting 120 s ($i/15)"
    sleep 120
  done
  say "funding lock taken"
fi

if [ "$NEEDS_SEPOLIA" = 1 ]; then
  : "${SEPOLIA_KEY_FILE_HOST:?set SEPOLIA_KEY_FILE_HOST}"
  [ -f "$SEPOLIA_KEY_FILE_HOST" ] || { echo "no Sepolia key file at the configured path" >&2; exit 2; }
  for i in $(seq 1 16); do
    if ! ps -axo pid,command | grep -E 'run-stagenet|deposit-fund|stagenet\.ts' | grep -v grep >/dev/null; then break; fi
    [ "$i" = 16 ] && { echo "another bridge driver is still sending from the funder after 30 min" >&2; exit 75; }
    say "another bridge driver is running; waiting 120 s before sending from the funder ($i/15)"
    sleep 120
  done
fi

NET_ARGS=()
if [ "$NEEDS_PROOF" = 1 ]; then
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
    if [ "$HEADROOM" -ge 10 ]; then break; fi
    [ "$i" = 31 ] && { echo "Docker memory headroom stayed below 10 GB for 30 min" >&2; exit 75; }
    say "Docker memory headroom ${HEADROOM} GB < 10 GB (another proof?); waiting 60 s ($i/30)"
    sleep 60
  done
  PORT="$(python3 -c 'import random, socket
for _ in range(200):
    p = random.randint(10000, 60000); s = socket.socket()
    try: s.bind(("127.0.0.1", p)); s.close(); print(p); break
    except OSError: s.close()')"
  say "proof server $PROOF_NAME on 127.0.0.1:$PORT (headroom ${HEADROOM} GB)"
  docker run -d --name "$PROOF_NAME" -p "127.0.0.1:$PORT:6300" --memory 12g "$PROOF_IMAGE" >/dev/null
  for _ in $(seq 1 120); do curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null || { echo "the proof server did not become healthy" >&2; docker logs --tail 40 "$PROOF_NAME" >&2; exit 1; }
  say "proof server version $(curl -fsS "http://127.0.0.1:$PORT/version" || echo '?')"
  NET_ARGS=(--network "container:$PROOF_NAME")
fi

SECRET_ARGS=()
if [ "$NEEDS_WALLET" = 1 ]; then
  SECRET_ARGS+=(-v "$STAGENET_WALLET_FILE_HOST:/secrets/stagenet:ro" -e STAGENET_WALLET_FILE=/secrets/stagenet)
fi
if [ "$NEEDS_SEPOLIA" = 1 ]; then
  SECRET_ARGS+=(-v "$SEPOLIA_KEY_FILE_HOST:/secrets/sepolia:ro" -e SEPOLIA_KEY_FILE=/secrets/sepolia)
fi

LOG="$GATE_STATE_DIR/logs/$CMD-$(date -u +%Y%m%dT%H%M%SZ).log"
say "log $LOG"
set +e
docker run --rm --name "$RUN_NAME" \
  ${NET_ARGS[@]+"${NET_ARGS[@]}"} \
  ${SECRET_ARGS[@]+"${SECRET_ARGS[@]}"} \
  --entrypoint bun -w /state/work \
  -v "$PASSPORT_CONTRACT_DIR/src:$CONTAINER_ROOT/src:ro" \
  -v "$PASSPORT_CONTRACT_DIR/contracts/erc20-vault/src:$CONTAINER_ROOT/contracts/erc20-vault/src:ro" \
  -v "$PASSPORT_CONTRACT_DIR/contracts/erc20-vault/deploy:$CONTAINER_ROOT/contracts/erc20-vault/deploy:ro" \
  -v "$PASSPORT_CONTRACT_DIR/contracts/erc20-vault/deployments:$CONTAINER_ROOT/contracts/erc20-vault/deployments:ro" \
  -v "$GATE_KEYS_DIR:$CONTAINER_ROOT/contracts/erc20-vault/managed:ro" \
  -v "$GATE_LAYOUT_DIR/managed:$CONTAINER_ROOT/contracts/managed:ro" \
  -v "$GATE_SDK_DIR/node_modules:$CONTAINER_ROOT/contracts/erc20-vault/node_modules:ro" \
  -v "$HERE:/aa/g/gate:ro" \
  -v "$REPO/relay/src/bridge:/relay/src/bridge:ro" \
  -v "$GATE_STATE_DIR:/state" \
  -v "$GATE_EVIDENCE_DIR:/evidence" \
  -e GATE_STATE_DIR=/state -e GATE_EVIDENCE_DIR=/evidence \
  -e MIDNIGHT_NETWORK=stagenet \
  -e MIDNIGHT_PROOF_SERVER_URL=http://127.0.0.1:6300 -e PROOF_SERVER_URL=http://127.0.0.1:6300 \
  -e FEE_BLOCKS_MARGIN="${FEE_BLOCKS_MARGIN:-5}" \
  ${SEPOLIA_RPC_URL:+-e SEPOLIA_RPC_URL="$SEPOLIA_RPC_URL"} \
  "$GATE_IMAGE" /aa/g/gate/gate.ts "$CMD" "$@" 2>&1 | tee "$LOG"
STATUS="${PIPESTATUS[0]}"
set -e
exit "$STATUS"
