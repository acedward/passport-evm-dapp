#!/usr/bin/env bash
# Plan L-TRD testing, LIVE through the UI on the staging exchange (Q8 caps), after L-TRD.0 funded
# the two accounts. One make and one take, by the accounts' own pages:
#
#   test/stack/run-trade-live.sh up                    funding lock + proof server + relay (stagenet)
#   test/stack/run-trade-live.sh phase make B          B's page: sell 1 wStkA at 1.00 (one signature)
#   test/stack/run-trade-live.sh phase take A          A's page: takes that offer whole (one signature)
#   test/stack/run-trade-live.sh phase reconcile B     B's page: My offers shows it filled
#   test/stack/run-trade-live.sh down                  remove the relay, the proof server and the
#                                                      network; release the funding lock
#
# The relay runs from the Docker check runner's source volume (no image is built), with the key cache
# read-only where a deployment mounts the key volume, and the sponsor's mnemonic file read-only (read
# in-process, never printed). The shared funding lock is held from `up` to `down` by a placeholder
# process (the Offer Files protocol), and the relay runs with SPONSOR_DEDICATED_WALLET=true inside
# that window, as L-ACC's and L-BRG's live runs do. Neither a make nor a take spends the sponsor's
# DUST: a make is never submitted, and the exchange's batcher pays for a take.
#
# Environment (secrets are FILES, never values):
#   STAGENET_WALLET_FILE   the sponsor's WALLET= file (shared: under the lock)
#   EVIDENCE_DIR           public evidence (required for phase)
#   DOCKER_CHECK_NAME      the check runner's prefix (default aa00039-trd-check)
#   LIVE_DIR               private state (default ~/.config/aa-00039/l-trd-live, mode 700)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CMD="${1:?usage: run-trade-live.sh up|phase <make|take|reconcile> <A|B>|down}"
shift || true

CHECK="${DOCKER_CHECK_NAME:-aa00039-trd-check}"
APP="$CHECK-app"
BUNV="$CHECK-bun"
PREFIX=aa00039-trd
NET="$PREFIX-net"
PROOF="$PREFIX-proof"
RELAY="$PREFIX-relay"
PROOF_IMAGE="midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b"
BUN_IMAGE="${BUN_IMAGE:-oven/bun:1.3.11}"
PW_IMAGE="${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.62.0-noble}"
KEYS_DIR="${KEYS_DIR:-$HOME/.cache/aa-00039/keys}"
KEYS_FINGERPRINT="${RELAY_KEYS_FINGERPRINT:-d6de768ade27a1e65a721e68bd4d2ac1dc8c7580a981424c16ddf7bdc6a7c503}"
CFG="$HOME/.config/aa-00039"
LIVE_DIR="${LIVE_DIR:-$CFG/l-trd-live}"
LOCK="$HOME/.stagenet-offer-ladders/funding.lock"
MANAGED=/app/vendor/passport/contract/contracts/managed
EXPECTED_NODE="${EXPECTED_NODE_VERSION:-2.0.0-d9729c13}"

say() { printf '== [%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
mkdir -p "$LIVE_DIR/logs" && chmod 700 "$LIVE_DIR" "$LIVE_DIR/logs"

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

save_logs() { docker logs "$RELAY" >"$LIVE_DIR/logs/relay-$(date -u +%Y%m%dT%H%M%SZ).jsonl" 2>&1 || true; }

case "$CMD" in
  up)
    : "${STAGENET_WALLET_FILE:?set STAGENET_WALLET_FILE}"
    version="$(curl -fsS -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"system_version","params":[]}' https://rpc.stagenet.shielded.tools | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"])')"
    say "stagenet system_version $version"
    [[ "$version" == "$EXPECTED_NODE" ]] || { say "stagenet runs $version, expected $EXPECTED_NODE: stop"; exit 3; }
    for i in $(seq 1 31); do headroom_ok && break; [[ "$i" == 31 ]] && exit 75; sleep 60; done
    mkdir -p "$(dirname "$LOCK")"
    for i in $(seq 1 16); do
      ids="$(docker ps -q)"
      mounted=0
      if [[ -n "$ids" ]] && docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}' $ids 2>/dev/null | grep -F "/Offer Files/.stagenet" >/dev/null; then mounted=1; fi
      if [[ ! -e "$LOCK" && "$mounted" == 0 ]]; then
        nohup sleep 86400 >/dev/null 2>&1 &
        holder=$!
        if ( set -o noclobber; printf '{"purpose":"aa-00039 L-TRD live trade relay (%s)","pid":%s,"host":"%s","at":"%s"}' \
          "$RELAY" "$holder" "$(hostname)" "$(date -u +%FT%TZ)" >"$LOCK" ) 2>/dev/null; then
          chmod 600 "$LOCK"; echo "$holder" >"$LIVE_DIR/lock-holder.pid"; say "funding lock taken (holder pid $holder)"; break
        fi
        kill "$holder" 2>/dev/null || true
      fi
      [[ "$i" == 16 ]] && { say "the funding wallet is still busy after 30 min: $(cat "$LOCK" 2>/dev/null)"; exit 75; }
      say "the funding wallet is busy ($(cat "$LOCK" 2>/dev/null || echo 'a container has it mounted')); waiting 120 s ($i/15)"
      sleep 120
    done
    DOCKER_CHECK_NAME="$CHECK" "$ROOT/scripts/docker-check.sh" sync >/dev/null
    docker network create "$NET" >/dev/null 2>&1 || true
    docker rm -f "$PROOF" "$RELAY" >/dev/null 2>&1 || true
    docker run -d --name "$PROOF" --network "$NET" --memory 12g "$PROOF_IMAGE" >/dev/null
    docker run -d --name "$RELAY" --network "$NET" --network-alias mnbank-relay \
      --read-only --tmpfs /tmp:rw,size=64m --cap-drop ALL --security-opt no-new-privileges:true \
      -v "$APP:/app:ro" -v "$KEYS_DIR:$MANAGED:ro" -v "$STAGENET_WALLET_FILE:/run/secrets/sponsor:ro" \
      -w /app -e BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
      -e RELAY_NETWORK=stagenet \
      -e MIDNIGHT_MANAGED_PATH="$MANAGED" -e RELAY_KEYS_FINGERPRINT="$KEYS_FINGERPRINT" \
      -e MIDNIGHT_PROOF_SERVER_URL="http://$PROOF:6300" \
      -e SPONSOR_ENABLED=true -e SPONSOR_SEED_FILE=/run/secrets/sponsor -e SPONSOR_DEDICATED_WALLET=true \
      -e SPONSOR_FEE_BLOCKS_MARGIN="${SPONSOR_FEE_BLOCKS_MARGIN:-20}" \
      -e RELAY_CORS_ORIGINS="http://127.0.0.1:$(port)" \
      -e JOB_TTL_SECONDS=86400 -e HEALTH_CACHE_SECONDS=5 -e LOG_LEVEL=info \
      "$BUN_IMAGE" bun relay/src/main.ts >/dev/null
    say "relay starting (CORS origin http://127.0.0.1:$(port))"
    for _ in $(seq 1 120); do synced && break; sleep 5; done
    synced || { say "the relay's sponsor did not sync in 10 minutes"; exit 1; }
    rget http://127.0.0.1:8080/health
    ;;

  phase)
    : "${EVIDENCE_DIR:?set EVIDENCE_DIR}"
    name="${1:?phase name}"
    whom="${2:?A or B}"
    docker rm -f "$PREFIX-live" >/dev/null 2>&1 || true
    DOCKER_CHECK_NAME="$CHECK" "$ROOT/scripts/docker-check.sh" sync >/dev/null
    for i in $(seq 1 31); do headroom_ok && break; [[ "$i" == 31 ]] && exit 75; sleep 60; done
    log="$LIVE_DIR/logs/phase-$name-$whom-$(date -u +%Y%m%dT%H%M%SZ).log"
    say "phase $name as $whom (log $log)"
    set +e
    docker run --rm --name "$PREFIX-live" --network "$NET" --init \
      -v "$APP:/app" -v "$BUNV:/opt/bun:ro" \
      -v "$CFG/l-trd-state.json:/cfg/l-trd-state.json:ro" -v "$CFG/l-trd-B.key:/cfg/l-trd-B.key:ro" \
      -v "$CFG/gate-bridge-state.json:/cfg/gate-bridge-state.json:ro" \
      -v "$CFG/gate-bridge-device.key:/cfg/gate-bridge-device.key:ro" \
      -v "$LIVE_DIR:/live" -v "$EVIDENCE_DIR:/evidence" \
      -e PATH=/opt/bun:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin -e CI=1 \
      -e E2E_PORT="$(port)" -e LIVE_RELAY_URL=http://mnbank-relay:8080 -e LIVE_PHASE="$name" \
      -e LIVE_ACCOUNT="$whom" -e LIVE_CFG_DIR=/cfg -e LIVE_STATE_DIR=/live -e LIVE_OUT_DIR=/evidence \
      ${LIVE_QTY:+-e LIVE_QTY="$LIVE_QTY"} ${LIVE_PRICE:+-e LIVE_PRICE="$LIVE_PRICE"} \
      -w /app "$PW_IMAGE" npx playwright test -c test/e2e/playwright.config.ts test/e2e/stack/trade-live.stack.spec.ts --reporter=list \
      >"$log" 2>&1
    status=$?
    set -e
    tail -8 "$log" >&2
    save_logs
    exit "$status"
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
