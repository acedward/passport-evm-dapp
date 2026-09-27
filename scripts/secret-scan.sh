#!/usr/bin/env bash
# The secret scan: run it before every push (the repository is public), and CI runs it too.
#
#   bash scripts/secret-scan.sh
#
#   1. gitleaks (pinned, .gitleaks.toml: the default rules plus wallet-secret, mnemonic,
#      keyed-RPC-URL and labelled-private-key patterns) over the full git history and the
#      working tree, and over SECRET_SCAN_EXTRA_PATHS (for example a built web bundle);
#   2. the owner's secrets (scripts/secret-scan-custom.mjs): the files named in
#      SECRET_SCAN_FILES / SECRET_SCAN_KEY_DIRS are read in-process and compared (3-word
#      windows of a mnemonic, a key's hex); nothing secret is printed or stored.
#
# gitleaks runs from its image unless a gitleaks binary is on PATH. Exits non-zero on any finding.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${GITLEAKS_IMAGE:-ghcr.io/gitleaks/gitleaks:v8.28.0}"

gitleaks_run() { # <mode> <path relative to ROOT> [extra flags]
  if command -v gitleaks >/dev/null 2>&1; then
    (cd "$ROOT" && gitleaks "$@" --config .gitleaks.toml --redact --no-banner --log-level warn)
  else
    docker run --rm -v "$ROOT:/repo:ro" -w /repo --entrypoint sh "$IMAGE" -c \
      'git config --global --add safe.directory "*" >/dev/null 2>&1; gitleaks "$@" --config .gitleaks.toml --redact --no-banner --log-level warn' \
      sh "$@"
  fi
}

# Self-test: random fake secrets (generated now, removed on exit) must trip every custom rule.
selftest="$ROOT/test-results/secret-scan-selftest"
rm -rf "$selftest" && mkdir -p "$selftest"
trap 'rm -rf "$selftest"' EXIT
rnd() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
words=(abandon ability absorb abstract absurd access accident account accuse achieve acid acoustic acquire across action actor actress actual adapt addict address adjust admit adult)
phrase="$(for i in $(seq 1 24); do printf '%s ' "${words[$((RANDOM % ${#words[@]}))]}"; done)"
{
  echo "WALLET=${phrase% }"
  echo "mnemonic: ${phrase% }"
  echo "rpc = \"https://sepolia.infura.io/v3/$(rnd 16)\""
  echo "privateKey: \"0x$(rnd 32)\""
} >"$selftest/fake.env"
echo "secret-scan: self-test of the custom rules"
rules="$( (gitleaks_run dir test-results/secret-scan-selftest --verbose 2>&1 || true) | grep -o 'RuleID: *[a-z0-9-]*' | awk '{print $2}' | sort -u | tr '\n' ' ')"
for rule in env-style-wallet-secret bip39-mnemonic-labelled keyed-rpc-url labelled-hex-private-key; do
  case " $rules " in *" $rule "*) ;; *) echo "secret-scan: self-test FAILED: rule $rule did not catch its planted fake" >&2; exit 2 ;; esac
done
echo "secret-scan: self-test PASS (every custom rule caught its planted fake)"
rm -rf "$selftest"

echo "secret-scan: gitleaks over the git history"
gitleaks_run git .
echo "secret-scan: gitleaks over the working tree"
gitleaks_run dir .
if [[ -n "${SECRET_SCAN_EXTRA_PATHS:-}" ]]; then
  IFS=':' read -r -a extra <<<"$SECRET_SCAN_EXTRA_PATHS"
  for p in "${extra[@]}"; do
    [[ -z "$p" ]] && continue
    rel="$(cd "$ROOT" && python3 -c 'import os,sys; print(os.path.relpath(os.path.abspath(sys.argv[1])))' "$p")"
    case "$rel" in ..*) echo "secret-scan: extra path must be inside the repository: $p" >&2; exit 2 ;; esac
    echo "secret-scan: gitleaks over $rel"
    gitleaks_run dir "$rel"
  done
fi

echo "secret-scan: the owner's secrets"
node "$ROOT/scripts/secret-scan-custom.mjs"
echo "secret-scan: clean"
