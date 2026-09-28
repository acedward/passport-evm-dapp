#!/usr/bin/env bash
# Plan L-ACC testing on a local ledger-9 stack (the plan's P0.5 recipe, `./up.sh --with aa`).
# Starts the relay beside the stack (from the checked-out source and the Docker check runner's
# node_modules volume, with the key volume mounted where a deployment mounts it), then drives the
# browser test (test/e2e/stack/accounts.stack.spec.ts) and funds the account between its phases.
#
#   test/stack/run-accounts.sh relay-up     start the relay on the stack's network
#   test/stack/run-accounts.sh e2e          run the browser test (background) and fund the account
#   test/stack/run-accounts.sh checks       the relay-keeps-no-user-data checks
#   test/stack/run-accounts.sh relay-down   remove the relay (and the runner's network link)
#
# Environment (nothing here is a secret; the seed FILES are secrets and are never printed):
#   STACK_PROJECT     the stack's compose project (its network is <project>_default)
#   STACK_RECEIPT     the stack's deploy receipt (aa-contracts.json), for the vault and colours
#   KEYS_DIR          the key volume on the host (default ~/.cache/aa-00039/keys)
#   SPONSOR_SEED      file with the relay sponsor's seed (a stack wallet no service holds open)
#   FUNDER_SEED       file with the funder's seed (a stack wallet holding the shielded colour)
#   TOKENS_FILE       the token list mapping the stack's colours to the usdc/stock roles
#   CHECK_NAME        the Docker check runner's name prefix (scripts/docker-check.sh)
#   E2E_PORT          the web preview's port inside the runner (random >= 10000)
#   FUND_AMOUNT       base units to deposit (default 10000000 = 10 tokens at 6 decimals)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${STACK_PROJECT:?}" "${STACK_RECEIPT:?}" "${SPONSOR_SEED:?}" "${FUNDER_SEED:?}" "${TOKENS_FILE:?}"
KEYS_DIR="${KEYS_DIR:-$HOME/.cache/aa-00039/keys}"
CHECK_NAME="${CHECK_NAME:-mnbank-check}"
RUNNER="$CHECK_NAME-runner"
APP="$CHECK_NAME-app"
NET="${STACK_PROJECT}_default"
RELAY="${RELAY_NAME:-aa00039-acc-relay}"
E2E_PORT="${E2E_PORT:-$((10000 + RANDOM % 40000))}"
BUN_IMAGE="${BUN_IMAGE:-oven/bun:1.3.11}"
MANAGED=/app/vendor/passport/contract/contracts/managed
SIGNALS=/app/test-results/stack

# A GET from inside the runner (on the stack network), printing the body; non-zero on HTTP errors.
rget() {
  docker exec "$RUNNER" node -e \
    'fetch(process.argv[1]).then(async (r) => { console.log(await r.text()); process.exit(r.ok ? 0 : 1); }).catch(() => process.exit(2))' "$1"
}

vault() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['vault']['address'])" "$STACK_RECEIPT"; }
colour() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['tokens'][0]['midnightColour'])" "$TOKENS_FILE"; }

relay_up() {
  docker rm -f "$RELAY" >/dev/null 2>&1 || true
  docker run -d --name "$RELAY" --network "$NET" --network-alias mnbank-relay \
    --read-only --tmpfs /tmp:rw,size=64m --cap-drop ALL --cap-add SYS_PTRACE --security-opt no-new-privileges:true \
    -v "$APP:/app:ro" -v "$KEYS_DIR:$MANAGED:ro" \
    -v "$SPONSOR_SEED:/run/secrets/sponsor:ro" -v "$TOKENS_FILE:/run/config/tokens.json:ro" \
    -w /app -e BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    -e RELAY_NETWORK=undeployed -e TOKENS_FILE=/run/config/tokens.json \
    -e MIDNIGHT_MANAGED_PATH="$MANAGED" -e RELAY_KEYS_FINGERPRINT="${RELAY_KEYS_FINGERPRINT:-}" \
    -e MIDNIGHT_PROOF_SERVER_URL=http://proof-server-rc6:6300 \
    -e BRIDGE_VAULT_ADDRESS="$(vault)" \
    -e SPONSOR_ENABLED=true -e SPONSOR_SEED_FILE=/run/secrets/sponsor \
    -e SPONSOR_FEE_BLOCKS_MARGIN="${SPONSOR_FEE_BLOCKS_MARGIN:-20}" \
    -e RELAY_CORS_ORIGINS="http://127.0.0.1:$E2E_PORT" \
    -e JOB_TTL_SECONDS="${JOB_TTL_SECONDS:-120}" -e HEALTH_CACHE_SECONDS=5 -e LOG_LEVEL=info \
    "$BUN_IMAGE" bun relay/src/main.ts >/dev/null
  docker network connect --alias mnbank-e2e "$NET" "$RUNNER" 2>/dev/null || true
  for _ in $(seq 1 90); do
    if rget http://mnbank-relay:8080/v1/config >/dev/null 2>&1; then break; fi
    sleep 2
  done
  rget http://mnbank-relay:8080/health || true
  docker diff "$RELAY" | sort >"${DIFF_BEFORE:-/tmp/relay-diff-before.txt}" || true
}

fund() {
  local account="$1"
  docker run --rm --name aa00039-acc-funder --network "$NET" \
    -v "$APP:/app:ro" -v "$KEYS_DIR:$MANAGED:ro" -v "$FUNDER_SEED:/run/secrets/funder:ro" \
    -w /app -e BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    -e FUND_ACCOUNT="$account" -e FUND_COLOUR="$(colour)" -e FUND_AMOUNT="${FUND_AMOUNT:-10000000}" \
    "$BUN_IMAGE" bun test/stack/fund-account.ts | sed -n 's/^FUNDED //p'
}

e2e() {
  # A preview server left by an interrupted run holds the port: stop it first.
  docker exec "$RUNNER" sh -c 'for p in $(ps -eo pid,args | grep -E "vite (build|preview)|playwright test" | grep -v grep | awk "{print \$1}"); do kill "$p"; done' || true
  docker exec "$RUNNER" rm -rf "$SIGNALS"
  local tokens
  tokens="$(cat "$TOKENS_FILE")"
  docker exec -w /app -e E2E_PORT="$E2E_PORT" -e STACK_RELAY_URL=http://mnbank-relay:8080 \
    -e STACK_TOKENS_JSON="$tokens" -e STACK_SIGNAL_DIR="$SIGNALS" "$RUNNER" \
    bash -lc 'npx playwright test -c test/e2e/playwright.config.ts test/e2e/stack/ --reporter=list' \
    >"${E2E_LOG:-/tmp/accounts-e2e.log}" 2>&1 &
  local pid=$!
  local account=""
  for _ in $(seq 1 600); do
    account="$(docker exec "$RUNNER" sh -c "cat $SIGNALS/registered.json 2>/dev/null" | python3 -c 'import json,sys; print(json.load(sys.stdin)["account"])' 2>/dev/null || true)"
    [[ -n "$account" ]] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 3
  done
  [[ -n "$account" ]] || { wait "$pid" || true; echo "no registration"; return 1; }
  echo "registered $account; funding"
  local funded
  funded="$(fund "$account")"
  echo "$funded"
  docker exec -i "$RUNNER" sh -c "cat > $SIGNALS/funded.json" <<<"$funded"
  wait "$pid"
}

checks() {
  echo "== relay filesystem: changes since start (read-only root, tmpfs /tmp)"
  docker diff "$RELAY" | sort >"${DIFF_AFTER:-/tmp/relay-diff-after.txt}" || true
  diff "${DIFF_BEFORE:-/tmp/relay-diff-before.txt}" "${DIFF_AFTER:-/tmp/relay-diff-after.txt}" && echo "no change"
  docker exec "$RELAY" sh -c 'find /tmp -type f | head -20; echo "tmp files: $(find /tmp -type f | wc -l)"'
  echo "== relay memory state (jobs, queue) after the job TTL"
  rget http://mnbank-relay:8080/v1/queue
}

relay_down() {
  docker network disconnect "$NET" "$RUNNER" 2>/dev/null || true
  docker rm -f "$RELAY" >/dev/null 2>&1 || true
}

case "${1:-}" in
  relay-up) relay_up ;;
  fund) fund "${2:?account}" ;;
  e2e) e2e ;;
  checks) checks ;;
  relay-down) relay_down ;;
  *)
    echo "usage: $0 relay-up|fund <account>|e2e|checks|relay-down" >&2
    exit 64
    ;;
esac
