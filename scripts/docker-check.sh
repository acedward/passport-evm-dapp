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
    -v "$ROOT:/src:ro" -v "$APP:/app" -v "$BUNV:/opt/bun:ro" ${zip[@]+"${zip[@]}"} \
    -e PATH=/opt/bun:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    -e CI=1 -w /app "$PW_IMAGE" sleep infinity >/dev/null
  x 'node --version && bun --version'
}

copy_tree() {
  # Keep node_modules and the generated contract output; replace every other file.
  x 'find . -mindepth 1 \( -path ./node_modules -o -path ./.tools -o -path ./vendor/passport/contract/contracts/managed -o -path ./vendor/passport/contract/contracts/erc20-vault/managed -o -path ./vendor/passport/contract/contracts/erc20-vault/node_modules \) -prune -o \( -type f -o -type l \) -print0 | xargs -0 rm -f'
  x 'cd /src && tar cf - --exclude=./node_modules --exclude=.git --exclude=./.tools --exclude=dist --exclude=test-results --exclude=playwright-report --exclude=./vendor/passport/contract/contracts/managed --exclude=./vendor/passport/contract/contracts/erc20-vault/managed --exclude=./vendor/passport/contract/contracts/erc20-vault/node_modules . | (cd /app && tar xf -)'
}

sync() {
  # A bind mount can serve a stale copy of a file edited a moment ago, so check the copy against
  # the host's own hashes of every file git knows about, and copy again until they agree.
  # A temporary file, not one under .git: in a git worktree .git is a file, not a directory.
  local list
  list="$(mktemp)"
  (cd "$ROOT" && git ls-files -co --exclude-standard -z | grep -zv '^vendor/' | xargs -0 shasum -a 256) >"$list"
  docker cp "$list" "$C:/tmp/host.sha" >/dev/null
  rm -f "$list"
  for attempt in 1 2 3 4 5; do
    copy_tree
    if x 'sha256sum --quiet -c /tmp/host.sha >/dev/null 2>&1'; then return 0; fi
    echo "sync: the copy is stale (attempt $attempt); copying again" >&2
    sleep 1
  done
  echo "sync: the copy never matched the host" >&2
  return 1
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
    # Hash every file before and after formatting, and copy back ONLY the files the formatter
    # changed, and only while the host copy is still the one that was formatted: a bind mount can
    # serve a stale copy for a moment, and a fix must never overwrite a newer edit.
    x 'find . -path ./node_modules -prune -o -path ./vendor -prune -o -path ./.tools -prune -o -type f -print0 | xargs -0 sha256sum > /tmp/before.sha'
    x 'npx prettier --write . --log-level warn; npx eslint --fix . || true'
    x 'sha256sum -c /tmp/before.sha 2>/dev/null | grep ": FAILED$" | sed "s/: FAILED$//" > /tmp/changed || true; while read -r f; do printf "%s %s\n" "$(grep -F "  $f" /tmp/before.sha | head -1 | cut -d" " -f1)" "$f"; done < /tmp/changed > /tmp/changed.sha'
    docker exec "$C" cat /tmp/changed.sha | while read -r before path; do
      rel="${path#./}"
      host="$(shasum -a 256 "$ROOT/$rel" 2>/dev/null | cut -d' ' -f1)"
      if [[ "$host" == "$before" ]]; then
        docker exec -w /app "$C" cat "$rel" >"$ROOT/$rel"
        echo "fixed $rel"
      else
        echo "skipped $rel (changed on the host since the sync; run fix again)" >&2
      fi
    done
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
