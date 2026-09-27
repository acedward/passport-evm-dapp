#!/usr/bin/env bash
# Plan L-BRG testing, LIVE on Midnight stagenet and Sepolia (Q8 caps), through the UI.
#
#   test/stack/run-bridge-live.sh eoa                  the test EOA (key generated in-process, mode 600)
#   test/stack/run-bridge-live.sh fund                 fund the test EOA from the owner's Sepolia funder
#   test/stack/run-bridge-live.sh up                   funding lock + proof server + relay (stagenet)
#   test/stack/run-bridge-live.sh phase <name> [TOKEN AMOUNT]
#                                                      one phase of test/e2e/stack/bridge-live.stack.spec.ts
#   test/stack/run-bridge-live.sh restart-relay        stop and start the relay (its jobs are lost)
#   test/stack/run-bridge-live.sh health               the relay's /health
#   test/stack/run-bridge-live.sh down                 remove the relay, the proof server and the network;
#                                                      release the funding lock
#
# The relay runs from the Docker check runner's source volume (scripts/docker-check.sh; no image is
# built), with the key volume read-only at the path a deployment mounts it, and the sponsor seed
# file read-only (read in-process, never printed). The funding lock (~/.stagenet-offer-ladders/
# funding.lock, the Offer Files protocol) is held from `up` to `down` by a placeholder process, and
# the relay runs with SPONSOR_DEDICATED_WALLET=true inside that window (as L-ACC's live run did).
#
# Environment (secrets are FILES, never values):
#   STAGENET_WALLET_FILE   the sponsor's WALLET= file (shared: under the lock)
#   SEPOLIA_KEY_FILE       the funder's SK= file (fund only)
#   DOCKER_CHECK_NAME      the check runner's prefix (default aa00039-brg-check)
#   LIVE_DIR               private state (default ~/.config/aa-00039/l-brg-live, mode 700)
#   EOA_KEY_FILE           default ~/.config/aa-00039/l-brg-test-eoa.key (mode 600)
#   EVIDENCE_DIR           public evidence (required for phase)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CMD="${1:?usage: run-bridge-live.sh eoa|fund|up|phase|restart-relay|health|down}"
shift || true

CHECK="${DOCKER_CHECK_NAME:-aa00039-brg-check}"
APP="$CHECK-app"
BUNV="$CHECK-bun"
PREFIX=aa00039-brg
NET="$PREFIX-net"
PROOF="$PREFIX-proof"
RELAY="$PREFIX-relay"
PROOF_IMAGE="midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b"
BUN_IMAGE="${BUN_IMAGE:-oven/bun:1.3.11}"
PW_IMAGE="${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.62.0-noble}"
KEYS_DIR="${KEYS_DIR:-$HOME/.cache/aa-00039/keys}"
KEYS_FINGERPRINT="${RELAY_KEYS_FINGERPRINT:-d6de768ade27a1e65a721e68bd4d2ac1dc8c7580a981424c16ddf7bdc6a7c503}"
LIVE_DIR="${LIVE_DIR:-$HOME/.config/aa-00039/l-brg-live}"
EOA_KEY_FILE="${EOA_KEY_FILE:-$HOME/.config/aa-00039/l-brg-test-eoa.key}"
LOCK="$HOME/.stagenet-offer-ladders/funding.lock"
SEPOLIA_RPC="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
MANAGED=/app/vendor/passport/contract/contracts/managed
EXPECTED_NODE="${EXPECTED_NODE_VERSION:-2.0.0-d9729c13}"

say() { printf '== [%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
mkdir -p "$LIVE_DIR/signals" "$LIVE_DIR/logs" && chmod 700 "$LIVE_DIR" "$LIVE_DIR/signals" "$LIVE_DIR/logs"

port() {
  if [[ ! -s "$LIVE_DIR/port" ]]; then
    python3 -c 'import random, socket
for _ in range(200):
    p = random.randint(10000, 60000); s = socket.socket()
    try: s.bind(("127.0.0.1", p)); s.close(); print(p); break
    except OSError: s.close()' >"$LIVE_DIR/port"
  fi
  cat "$LIVE_DIR/port"
}

rget() { docker exec "$RELAY" bun -e 'fetch(process.argv[1]).then(async (r) => { console.log(await r.text()); process.exit(r.ok ? 0 : 1); }).catch(() => process.exit(2))' "$1"; }

synced() { rget http://127.0.0.1:8080/health 2>/dev/null | python3 -c 'import json,sys; h=json.load(sys.stdin); sys.exit(0 if h["sponsor"]["synced"] else 1)'; }

wait_synced() {
  for _ in $(seq 1 120); do
    if synced; then say "relay synced"; return 0; fi
    sleep 5
  done
  say "the relay's sponsor did not sync in 10 minutes"; return 1
}

headroom_ok() {
  local h
  h="$(docker stats --no-stream --format '{{.MemUsage}}' | python3 -c '
import re, sys
unit = {"B": 1, "KiB": 2**10, "MiB": 2**20, "GiB": 2**30, "KB": 1e3, "MB": 1e6, "GB": 1e9}
used, total = 0.0, 0.0
for line in sys.stdin:
    a, b = [s.strip() for s in line.split("/")]
    m, n = re.match(r"([\d.]+)(\w+)", a), re.match(r"([\d.]+)(\w+)", b)
    used += float(m.group(1)) * unit[m.group(2)]
    total = max(total, float(n.group(1)) * unit[n.group(2)])
print(int((total - used) / 2**30) if total else 99)')"
  say "Docker memory headroom ${h} GB"
  [[ "$h" -ge 10 ]]
}

disk_ok() {
  local free
  free="$(docker run --rm alpine df -k / | awk 'NR==2 {print int($4/1024/1024)}')"
  say "Docker VM disk free ${free} GB"
  [[ "$free" -ge 4 ]]
}

relay_run() {
  : "${STAGENET_WALLET_FILE:?set STAGENET_WALLET_FILE}"
  docker run -d --name "$RELAY" --network "$NET" --network-alias mnbank-relay \
    --read-only --tmpfs /tmp:rw,size=64m --cap-drop ALL --security-opt no-new-privileges:true \
    -v "$APP:/app:ro" -v "$KEYS_DIR:$MANAGED:ro" -v "$STAGENET_WALLET_FILE:/run/secrets/sponsor:ro" \
    -w /app -e BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    -e RELAY_NETWORK=stagenet \
    -e MIDNIGHT_MANAGED_PATH="$MANAGED" -e RELAY_KEYS_FINGERPRINT="$KEYS_FINGERPRINT" \
    -e MIDNIGHT_PROOF_SERVER_URL="http://$PROOF:6300" \
    -e SPONSOR_ENABLED=true -e SPONSOR_SEED_FILE=/run/secrets/sponsor -e SPONSOR_DEDICATED_WALLET=true \
    -e SPONSOR_FEE_BLOCKS_MARGIN="${SPONSOR_FEE_BLOCKS_MARGIN:-20}" \
    -e SEPOLIA_RPC_URL="$SEPOLIA_RPC" \
    -e RELAY_CORS_ORIGINS="http://127.0.0.1:$(port)" \
    -e JOB_TTL_SECONDS=86400 -e HEALTH_CACHE_SECONDS=5 -e LOG_LEVEL=info \
    "$BUN_IMAGE" bun relay/src/main.ts >/dev/null
}

save_logs() { docker logs "$RELAY" >"$LIVE_DIR/logs/relay-$(date -u +%Y%m%dT%H%M%SZ).jsonl" 2>&1 || true; }

case "$CMD" in
  eoa)
    mkdir -p "$(dirname "$EOA_KEY_FILE")" && chmod 700 "$(dirname "$EOA_KEY_FILE")"
    docker run --rm --name "$PREFIX-eoa" -v "$APP:/app:ro" -v "$(dirname "$EOA_KEY_FILE"):/state" -w /app \
      -e KEY_FILE="/state/$(basename "$EOA_KEY_FILE")" "$BUN_IMAGE" bun test/stack/new-test-eoa.ts
    ;;

  fund)
    : "${SEPOLIA_KEY_FILE:?set SEPOLIA_KEY_FILE}"
    : "${FUND_TO:?set FUND_TO (the test EOA address)}"
    for i in $(seq 1 16); do
      if ! ps -axo pid,command | grep -E 'run-stagenet|deposit-fund|stagenet\.ts|gate\.ts' | grep -v grep >/dev/null; then break; fi
      [[ "$i" == 16 ]] && { say "another sender is still active after 30 min"; exit 75; }
      say "another bridge driver is running; waiting 120 s ($i/15)"; sleep 120
    done
    docker run --rm --name "$PREFIX-fund" -v "$APP:/app:ro" -v "$SEPOLIA_KEY_FILE:/secrets/sepolia:ro" -w /app \
      -e SEPOLIA_KEY_FILE=/secrets/sepolia -e FUND_TO -e FUND_ETH_WEI="${FUND_ETH_WEI:-0}" -e FUND_TOKENS="${FUND_TOKENS:-}" \
      -e SEPOLIA_RPC_URL="$SEPOLIA_RPC" "$BUN_IMAGE" bun test/stack/fund-eoa.ts
    ;;

  up)
    : "${STAGENET_WALLET_FILE:?set STAGENET_WALLET_FILE}"
    version="$(curl -fsS -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"system_version","params":[]}' https://rpc.stagenet.shielded.tools | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"])')"
    say "stagenet system_version $version"
    [[ "$version" == "$EXPECTED_NODE" ]] || { say "stagenet runs $version, expected $EXPECTED_NODE: stop"; exit 3; }
    disk_ok || { say "less than 4 GB free on the Docker VM disk"; exit 3; }
    for i in $(seq 1 31); do headroom_ok && break; [[ "$i" == 31 ]] && exit 75; sleep 60; done
    # The shared funding wallet: wait (2-min polls, 30 min at most) for the lock, then hold it.
    mkdir -p "$(dirname "$LOCK")"
    for i in $(seq 1 16); do
      ids="$(docker ps -q)"
      mounted=0
      if [[ -n "$ids" ]] && docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}' $ids 2>/dev/null | grep -F "/Offer Files/.stagenet" >/dev/null; then mounted=1; fi
      if [[ ! -e "$LOCK" && "$mounted" == 0 ]]; then
        nohup sleep 86400 >/dev/null 2>&1 &
        holder=$!
        if ( set -o noclobber; printf '{"purpose":"aa-00039 L-BRG live bridge relay (%s)","pid":%s,"host":"%s","at":"%s"}' \
          "$RELAY" "$holder" "$(hostname)" "$(date -u +%FT%TZ)" >"$LOCK" ) 2>/dev/null; then
          chmod 600 "$LOCK"; echo "$holder" >"$LIVE_DIR/lock-holder.pid"; say "funding lock taken (holder pid $holder)"; break
        fi
        kill "$holder" 2>/dev/null || true
      fi
      [[ "$i" == 16 ]] && { say "the funding wallet is still busy after 30 min: $(cat "$LOCK" 2>/dev/null)"; exit 75; }
      say "the funding wallet is busy ($(cat "$LOCK" 2>/dev/null || echo 'a container has it mounted')); waiting 120 s ($i/15)"
      sleep 120
    done
    docker network create "$NET" >/dev/null 2>&1 || true
    docker rm -f "$PROOF" "$RELAY" >/dev/null 2>&1 || true
    docker run -d --name "$PROOF" --network "$NET" --memory 12g "$PROOF_IMAGE" >/dev/null
    relay_run
    say "relay starting (CORS origin http://127.0.0.1:$(port))"
    wait_synced
    rget http://127.0.0.1:8080/health
    ;;

  phase)
    : "${EVIDENCE_DIR:?set EVIDENCE_DIR}"
    name="${1:?phase name}"
    token="${2:-stkA}"
    amount="${3:-1}"
    rm -f "$LIVE_DIR/signals/"*
    docker rm -f "$PREFIX-live" >/dev/null 2>&1 || true
    log="$LIVE_DIR/logs/phase-$name-$token-$amount-$(date -u +%Y%m%dT%H%M%SZ).log"
    say "phase $name $token $amount (log $log)"
    docker run --rm --name "$PREFIX-live" --network "$NET" --init \
      -v "$APP:/app" -v "$BUNV:/opt/bun:ro" -v "$EOA_KEY_FILE:/secrets/eoa.key:ro" \
      -v "$LIVE_DIR:/live" -v "$EVIDENCE_DIR:/evidence" \
      -e PATH=/opt/bun:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin -e CI=1 \
      -e E2E_PORT="$(port)" -e LIVE_RELAY_URL=http://mnbank-relay:8080 -e LIVE_PHASE="$name" \
      -e LIVE_TOKEN="$token" -e LIVE_AMOUNT="$amount" ${LIVE_DEST:+-e LIVE_DEST="$LIVE_DEST"} \
      -e LIVE_STATE_FILE=/live/browser-state.json -e LIVE_EOA_KEY_FILE=/secrets/eoa.key \
      -e LIVE_SIGNAL_DIR=/live/signals -e LIVE_OUT_DIR=/evidence -e LIVE_SEPOLIA_RPC="$SEPOLIA_RPC" \
      -w /app "$PW_IMAGE" npx playwright test -c test/e2e/playwright.config.ts test/e2e/stack/bridge-live.stack.spec.ts --reporter=list \
      >"$log" 2>&1 &
    pid=$!
    if [[ "$name" == deposit-resume ]]; then
      for _ in $(seq 1 720); do
        [[ -e "$LIVE_DIR/signals/kill-relay" ]] && break
        kill -0 "$pid" 2>/dev/null || break
        sleep 2
      done
      if [[ -e "$LIVE_DIR/signals/kill-relay" ]]; then
        say "the page saw the start: stopping the relay"
        save_logs
        docker stop -t 20 "$RELAY" >/dev/null
        stopped="$(date -u +%FT%TZ)"
        say "relay stopped at $stopped; starting it again"
        docker start "$RELAY" >/dev/null
        wait_synced
        printf '{"stoppedAt":"%s","restartedAt":"%s"}' "$stopped" "$(date -u +%FT%TZ)" >"$LIVE_DIR/signals/relay-restarted"
      fi
    fi
    set +e
    wait "$pid"
    status=$?
    set -e
    tail -5 "$log" >&2
    save_logs
    exit "$status"
    ;;

  restart-relay)
    save_logs
    docker stop -t 20 "$RELAY" >/dev/null && docker start "$RELAY" >/dev/null && wait_synced
    ;;

  health)
    rget http://127.0.0.1:8080/health
    ;;

  down)
    save_logs
    docker rm -f "$RELAY" "$PROOF" "$PREFIX-live" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    if [[ -s "$LIVE_DIR/lock-holder.pid" ]]; then
      holder="$(cat "$LIVE_DIR/lock-holder.pid")"
      if grep -q "\"pid\":$holder," "$LOCK" 2>/dev/null; then rm -f "$LOCK"; say "funding lock released"; fi
      kill "$holder" 2>/dev/null || true
      rm -f "$LIVE_DIR/lock-holder.pid"
    fi
    ;;

  *)
    echo "unknown command $CMD" >&2
    exit 64
    ;;
esac
