#!/usr/bin/env bash
# Light compile (--skip-zk: contract JavaScript and type declarations only, NO prover keys)
# of the Passport account and its callees, from the pinned submodule vendor/passport.
#
# Why: the browser needs the compiled account's `pureCircuits` (challenges, boot commitment,
# the offer's change nonce) and the vault's `depositPath`. The generated modules are not in
# git upstream, so every checkout builds them. Prover keys are a separate one-shot volume
# (relay-keys-init; plan P0.5 decision) and are never built here.
#
# Order (the compiler resolves a declared contract type to <compact-path>/<TypeName>, and the
# generated JS imports its callee by relative path, so callees go first and sit side by side):
#   1. SignetSigner   <- erc20-vault/src/vendor/signet-contract.compact
#   2. SignetCircuits <- node_modules/@sig-net/midnight/src/circuits.compact
#   3. Erc20Vault     <- erc20-vault/src/erc20-vault.compact
#   4. account        <- contracts/account.compact, with contracts/managed/{Erc20Vault,SignetSigner}
#                        linked to the vault's own output (upstream scripts/link-callees.sh)
#
# Outputs land in the submodule's git-ignored managed/ directories, exactly where the upstream
# sources import them from. A stamp over every input skips the work when nothing changed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
P="$ROOT/vendor/passport/contract"
V="$P/contracts/erc20-vault"
NM="$ROOT/node_modules"
SIG="$NM/@sig-net/midnight"

[[ -f "$P/contracts/account.compact" ]] || {
  echo "compile-contracts: $P is empty; run: git submodule update --init" >&2
  exit 66
}
[[ -f "$SIG/package.json" ]] || {
  echo "compile-contracts: $SIG is missing; run: bun install" >&2
  exit 66
}

COMPACTC="${COMPACTC:-}"
if [[ -z "$COMPACTC" ]]; then COMPACTC="$(bash "$ROOT/scripts/fetch-compactc.sh")"; fi
[[ "$("$COMPACTC" --version)" == "0.34.0" ]] || {
  echo "compile-contracts: compactc 0.34.0 required, got $("$COMPACTC" --version)" >&2
  exit 65
}
SIG_VERSION="$(node -p "require('$SIG/package.json').version" 2>/dev/null || bun -e "console.log(require('$SIG/package.json').version)")"
[[ "$SIG_VERSION" == "0.23.0" ]] || {
  echo "compile-contracts: @sig-net/midnight 0.23.0 required, got $SIG_VERSION" >&2
  exit 65
}

sha256() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi; }
inputs() {
  "$COMPACTC" --version
  echo "sig-net/midnight $SIG_VERSION"
  git -C "$ROOT/vendor/passport" rev-parse HEAD 2>/dev/null || true
  find "$P/contracts" -name '*.compact' -not -path '*/managed/*' -not -path '*/node_modules/*' | LC_ALL=C sort | xargs cat
  find "$SIG/src" -name '*.compact' | LC_ALL=C sort | xargs cat
  cat "$ROOT/scripts/compile-contracts.sh"
}
STAMP_VALUE="$(inputs | sha256 | cut -d' ' -f1)"
STAMP="$P/contracts/managed/.light-compile-stamp"
if [[ "${FORCE:-0}" != 1 && -f "$STAMP" && "$(cat "$STAMP")" == "$STAMP_VALUE" && -f "$P/contracts/managed/account/contract/index.js" ]]; then
  echo "compile-contracts: up to date ($STAMP_VALUE)" >&2
  exit 0
fi

compile() { # <compact-path> <source> <target>
  local t0=$SECONDS
  rm -rf "$3"
  COMPACT_PATH="$1" "$COMPACTC" --skip-zk --feature-zkir-v3 --compact-path "$1" "$2" "$3"
  echo "compile-contracts: $(basename "$3") in $((SECONDS - t0)) s" >&2
}

# The vault package imports @sig-net/midnight through ../node_modules (upstream
# src/signet-sdk.ts); the link makes that path resolve to the root install. Git-ignored upstream.
ln -sfn "$NM" "$V/node_modules"

mkdir -p "$V/managed" "$P/contracts/managed"
compile "$NM" "$V/src/vendor/signet-contract.compact" "$V/managed/SignetSigner"
compile "$NM" "$SIG/src/circuits.compact" "$V/managed/SignetCircuits"
compile "$NM:$V/managed" "$V/src/erc20-vault.compact" "$V/managed/Erc20Vault"

# upstream scripts/link-callees.sh: a real directory whose children are links
for name in Erc20Vault SignetSigner; do
  rm -rf "$P/contracts/managed/$name"
  mkdir -p "$P/contracts/managed/$name"
  for child in "$V/managed/$name"/*; do ln -s "$child" "$P/contracts/managed/$name/$(basename "$child")"; done
done
compile "$NM:$P/contracts/managed" "$P/contracts/account.compact" "$P/contracts/managed/account"

for d in "$V/managed/SignetSigner" "$V/managed/SignetCircuits" "$V/managed/Erc20Vault" "$P/contracts/managed/account"; do
  [[ -f "$d/contract/index.js" && -f "$d/contract/index.d.ts" ]] || {
    echo "compile-contracts: $d/contract/index.{js,d.ts} missing" >&2
    exit 70
  }
  if find "$d" -name '*.prover' | grep -q .; then
    echo "compile-contracts: $d holds prover keys; this script must never produce keys" >&2
    exit 70
  fi
done
echo "$STAMP_VALUE" >"$STAMP"
echo "compile-contracts: done ($STAMP_VALUE)" >&2
