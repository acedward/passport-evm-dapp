#!/usr/bin/env bash
# The one-shot key-volume job (deploy/compose.yml service `keys`): compile the Passport account,
# the ERC20 vault and the Signet singleton WITH prover and verifier keys, keep only the keys the
# relay proves with, verify the set, and install it into the key volume the relay mounts
# read-only. On later starts it only re-verifies (a few seconds) unless an input changed.
#
# Inputs, all pinned in the image (deploy/key-volume.Dockerfile):
#   compactc 0.34.0 (release archive, SHA-256 checked at image build)   /opt/compactc
#   the Passport sources (vendor/passport @ PASSPORT_COMMIT)              /app/vendor/passport/contract/contracts
#   @sig-net/midnight 0.23.0 (the Signet Compact module)                  /app/node_modules/@sig-net/midnight
#
# The volume is mounted at the path the relay mounts it, so the compiled modules resolve
# /app/node_modules exactly as they will in the relay. Layout after a build:
#   <root>/{account,Erc20Vault,SignetSigner,SignetCircuits}/{contract,compiler,zkir,keys}
#   <root>/.mnbank-keys.json      the verification report (public values), written last
#
# Checks (relay/src/tools/key-volume.ts `verify`, G-BRIDGE's method): verifier keys = compiled
# expectedVk; vault + singleton verifier keys = the ones deployed on the network; the kept prover
# keys are present; the fingerprint = RELAY_KEYS_FINGERPRINT. Any failure exits non-zero, so the
# proof server and the relay (which depend on this job) do not start.
set -euo pipefail
umask 022

APP=/app
OUT="${KEYS_DIR:-$APP/vendor/passport/contract/contracts/managed}"
SRC="$APP/vendor/passport/contract/contracts"
V="$SRC/erc20-vault"
NM="$APP/node_modules"
CC=/opt/compactc/compactc
KV=(bun "$APP/relay/src/tools/key-volume.ts")
ACCOUNT_PIN="${KEYS_ACCOUNT_SOURCE_SHA256:-44cff904f6ed58440b2534f64c429e0d422bfae082dbe8c82465002fb50e9fcf}"
MIN_FREE_GB="${KEYS_MIN_FREE_GB:-10}"
export MIDNIGHT_PP="${MIDNIGHT_PP:-/tmp/zk-params}"

say() { printf 'key-volume: %s\n' "$*" >&2; }
die() {
  say "FAILED: $*"
  exit 1
}
# PID 1 in a container ignores SIGTERM unless it is trapped: stop promptly (and clean up) on
# `docker compose stop`.
trap 'say "stopped by a signal"; exit 143' TERM INT

[[ -d "$OUT" && -w "$OUT" ]] || die "the key volume at $OUT is missing or not writable by uid $(id -u)"
mkdir -p "$MIDNIGHT_PP" 2>/dev/null || true

# ── the pinned inputs ────────────────────────────────────────────────────────
COMPACTC_VERSION="$("$CC" --version)"
[[ "$COMPACTC_VERSION" == 0.34.0 ]] || die "compactc 0.34.0 required, found $COMPACTC_VERSION"
ARCHIVE_SHA="$(cat /opt/compactc/.archive-sha256 2>/dev/null || echo unknown)"
SIG_VERSION="$(bun -e "console.log(require('$NM/@sig-net/midnight/package.json').version)")"
[[ "$SIG_VERSION" == 0.23.0 ]] || die "@sig-net/midnight 0.23.0 required, found $SIG_VERSION"
ACCOUNT_SHA="$(sha256sum "$SRC/account.compact" | cut -d' ' -f1)"
[[ "$ACCOUNT_SHA" == "$ACCOUNT_PIN" ]] ||
  die "account.compact is $ACCOUNT_SHA, not the pinned $ACCOUNT_PIN (set KEYS_ACCOUNT_SOURCE_SHA256 when re-pinning)"

inputs() {
  echo mnbank-key-volume/1
  echo "compactc $COMPACTC_VERSION archive $ARCHIVE_SHA"
  echo "sig-net/midnight $SIG_VERSION"
  (cd "$APP" && find vendor/passport/contract/contracts node_modules/@sig-net/midnight/src -name '*.compact' \
    -not -path '*/managed/*' | LC_ALL=C sort | xargs sha256sum)
  printf '%s\n' "${KEYS_KEEP_PROVERS:-default}" | tr ' ,' '\n\n' | grep . | LC_ALL=C sort
}
INPUTS="$(inputs | sha256sum | cut -d' ' -f1)"
export KV_COMPACTC_VERSION="$COMPACTC_VERSION" KV_COMPACTC_ARCHIVE_SHA256="$ARCHIVE_SHA" \
  KV_SIGNET_VERSION="$SIG_VERSION" KV_PASSPORT_COMMIT="${PASSPORT_COMMIT:-unknown}" KV_ACCOUNT_SHA256="$ACCOUNT_SHA"
say "inputs $INPUTS (compactc $COMPACTC_VERSION, @sig-net/midnight $SIG_VERSION, passport ${PASSPORT_COMMIT:-unknown})"

# ── already built from these inputs: re-verify only ──────────────────────────
current="$("${KV[@]}" marker-inputs "$OUT")" || die "the verification tool does not run (see the error above)"
if [[ "$current" == "$INPUTS" ]]; then
  say "the key volume was built from these inputs; re-verifying"
  "${KV[@]}" verify "$OUT" --inputs "$INPUTS" --recheck --write-marker ||
    die "the installed key set no longer verifies (the problems are listed above)"
  say "OK: the key volume is verified"
  exit 0
fi

# ── build ────────────────────────────────────────────────────────────────────
free_kb="$(df -Pk "$OUT" | awk 'NR == 2 { print $4 }')"
((free_kb >= MIN_FREE_GB * 1024 * 1024)) ||
  die "the key volume's disk has $((free_kb / 1024 / 1024)) GB free; a build needs ${MIN_FREE_GB} GB (KEYS_MIN_FREE_GB)"

W="$OUT/.work"
rm -rf "$W"
mkdir -p "$W"
ok=0
cleanup() { if [[ "$ok" != 1 ]]; then rm -rf "$W"; fi; }
trap cleanup EXIT

compile() { # <label> <compact-path> <source> <target> [flags]
  local label="$1" cpath="$2" src="$3" target="$4"
  shift 4
  local t0=$SECONDS
  say "compiling $label"
  COMPACT_PATH="$cpath" "$CC" "$@" --feature-zkir-v3 --compact-path "$cpath" "$src" "$target"
  say "$label done in $((SECONDS - t0)) s"
}

started=$SECONDS
if [[ -n "${KEYS_IMPORT_DIR:-}" ]]; then
  # A key set built elsewhere (for example on a larger machine), mounted read-only. It is NOT
  # trusted: it goes through exactly the same prune and verification as a fresh compile.
  for b in account Erc20Vault SignetSigner SignetCircuits; do
    [[ -d "$KEYS_IMPORT_DIR/$b" ]] || die "KEYS_IMPORT_DIR has no $b bundle"
    say "importing $b from $KEYS_IMPORT_DIR"
    cp -RL "$KEYS_IMPORT_DIR/$b" "$W/$b"
  done
  export KV_SOURCE=import
else
  # Callees first: the compiler resolves a declared contract type to <compact-path>/<TypeName>,
  # and a caller's generated JavaScript imports its callee by relative path, so all four sit side
  # by side.
  compile SignetSigner "$NM" "$V/src/vendor/signet-contract.compact" "$W/SignetSigner"
  compile SignetCircuits "$NM" "$NM/@sig-net/midnight/src/circuits.compact" "$W/SignetCircuits" --skip-zk
  compile Erc20Vault "$NM:$W" "$V/src/erc20-vault.compact" "$W/Erc20Vault"
  compile account "$NM:$W" "$SRC/account.compact" "$W/account"
  export KV_SOURCE=compile
fi
export KV_COMPILE_SECONDS=$((SECONDS - started))
say "${KV_SOURCE} took ${KV_COMPILE_SECONDS} s; $(du -sh "$W" | cut -f1) before pruning"

"${KV[@]}" prune "$W"
say "$(du -sh "$W" | cut -f1) after pruning"

"${KV[@]}" verify "$W" --inputs "$INPUTS" --write-marker ||
  die "the compiled key set does not verify (the problems are listed above)"

# Install: replace the previous set, then the report last.
for b in account Erc20Vault SignetSigner SignetCircuits; do
  rm -rf "${OUT:?}/$b"
  mv "$W/$b" "$OUT/$b"
done
mv "$W/.mnbank-keys.json" "$OUT/.mnbank-keys.json"
rm -rf "$W"
ok=1
say "OK: key volume installed and verified in $((SECONDS - started)) s ($(du -sh "$OUT" | cut -f1))"
