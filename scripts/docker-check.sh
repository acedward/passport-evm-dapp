#!/usr/bin/env bash
# Run the repository's install, checks and browser tests inside Docker.
#
# node_modules live in a named volume, not on the host: installs onto a macOS bind mount fail
# (ENOTDIR). The working tree is bind-mounted read-only and copied into the volume by `sync`.
#
#   scripts/docker-check.sh up          start the runner container (idempotent)
#   scripts/docker-check.sh sync        copy the working tree into the volume
#   scripts/docker-check.sh install     bun install, then copy bun.lock back into the tree
#   scripts/docker-check.sh run <cmd>   run a shell command in /app
#   scripts/docker-check.sh fix         prettier --write + eslint --fix in /app, copied back into the tree
#   scripts/docker-check.sh all         up + sync + frozen install + contracts + check + web build + e2e
#   scripts/docker-check.sh down        remove the container and its volumes
#
# Environment:
#   DOCKER_CHECK_NAME   prefix of the container and volumes (default mnbank-check)
#   PLAYWRIGHT_IMAGE    Playwright image with Chromium for @playwright/test 1.62.0
#   BUN_IMAGE           image the Bun 1.3.11 binary is copied from
#   COMPACTC_ZIP        optional local compactc 0.34.0 archive (still SHA-256 verified)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${DOCKER_CHECK_NAME:-mnbank-check}"
PW_IMAGE="${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.62.0-noble}"
BUN_IMAGE="${BUN_IMAGE:-oven/bun:1.3.11}"
C="$NAME-runner"
APP="$NAME-app"
BUNV="$NAME-bun"

running() { [[ "$(docker inspect -f '{{.State.Running}}' "$C" 2>/dev/null)" == true ]]; }
x() { docker exec -w /app "$C" bash -lc "$*"; }

up() {
  running && return 0
  docker rm -f "$C" >/dev/null 2>&1 || true
  docker volume create "$APP" >/dev/null
  docker volume create "$BUNV" >/dev/null
  docker run --rm -v "$BUNV:/out" "$BUN_IMAGE" sh -c 'cp /usr/local/bin/bun /out/bun && ln -sf bun /out/bunx'
  local zip=()
  if [[ -n "${COMPACTC_ZIP:-}" ]]; then zip=(-v "$COMPACTC_ZIP:/in/compactc.zip:ro" -e COMPACTC_ZIP=/in/compactc.zip); fi
  docker run -d --name "$C" --init \
    -v "$ROOT:/src:ro" -v "$APP:/app" -v "$BUNV:/opt/bun:ro" "${zip[@]}" \
    -e PATH=/opt/bun:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    -e CI=1 -w /app "$PW_IMAGE" sleep infinity >/dev/null
  x 'node --version && bun --version'
}

sync() {
  # Keep node_modules and the generated contract output; replace every other file.
  x 'find . -mindepth 1 \( -path ./node_modules -o -path ./.tools -o -path ./vendor/passport/contract/contracts/managed -o -path ./vendor/passport/contract/contracts/erc20-vault/managed -o -path ./vendor/passport/contract/contracts/erc20-vault/node_modules \) -prune -o \( -type f -o -type l \) -print0 | xargs -0 rm -f'
  x 'cd /src && tar cf - --exclude=./node_modules --exclude=.git --exclude=./.tools --exclude=dist --exclude=test-results --exclude=playwright-report --exclude=./vendor/passport/contract/contracts/managed --exclude=./vendor/passport/contract/contracts/erc20-vault/managed --exclude=./vendor/passport/contract/contracts/erc20-vault/node_modules . | (cd /app && tar xf -)'
}

cmd="${1:-all}"
shift || true
case "$cmd" in
  up) up ;;
  sync) sync ;;
  install)
    x 'bun install'
    docker cp "$C:/app/bun.lock" "$ROOT/bun.lock"
    ;;
  run) x "$*" ;;
  fix)
    sync
    x 'npx prettier --write . --log-level warn && npx eslint --fix . || true'
    # copy back every file git knows about (tracked or new, not ignored), except the submodule
    (cd "$ROOT" && git ls-files -co --exclude-standard | grep -v '^vendor/') >"$ROOT/.git/docker-check-files"
    docker cp "$ROOT/.git/docker-check-files" "$C:/tmp/files"
    docker exec -w /app "$C" tar cf - -T /tmp/files | tar xf - -C "$ROOT"
    rm -f "$ROOT/.git/docker-check-files"
    ;;
  all)
    up
    sync
    x 'bun install --frozen-lockfile'
    x 'bun run contracts'
    x 'bun run check'
    x 'bun run build:web'
    x 'bun run e2e'
    ;;
  down)
    docker rm -f "$C" >/dev/null 2>&1 || true
    docker volume rm "$APP" "$BUNV" >/dev/null 2>&1 || true
    echo "removed $C, $APP, $BUNV"
    ;;
  *)
    echo "usage: $0 up|sync|install|run <cmd>|all|down" >&2
    exit 64
    ;;
esac
