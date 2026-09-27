#!/usr/bin/env bash
# Install the pinned Compact compiler (compactc 0.34.0) into .tools/compactc-0.34.0/.
#
# The release archive is verified against the SHA-256 pinned below before it is unpacked.
# Pass COMPACTC_ZIP=<path> to use an archive you already have (it is verified the same way);
# otherwise the archive for this platform is downloaded from the pinned release.
#
# Prints the compactc path on stdout (everything else goes to stderr).
set -euo pipefail

VERSION=0.34.0
BASE_URL="https://github.com/LFDT-Minokawa/compact/releases/download/compactc-v${VERSION}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${COMPACTC_DIR:-$ROOT/.tools/compactc-$VERSION}"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ASSET="compactc_v${VERSION}_x86_64-unknown-linux-musl.zip"
    SHA=775ccddf5a71399835329bbf7471ba5a8c54fcc825d372c75e19ba7042069584 ;;
  Linux-aarch64 | Linux-arm64) ASSET="compactc_v${VERSION}_aarch64-unknown-linux-musl.zip"
    SHA=d3e292c4f48e257dcd6b3d3e3e4743d7d8ea0729f48953eab91a366d44cd026d ;;
  Darwin-arm64) ASSET="compactc_v${VERSION}_aarch64-darwin.zip"
    SHA=ce458c4062f1a1dd2920591a0bb5ab657be02f4ab8422f2d76988773f60103c3 ;;
  *) echo "fetch-compactc: no pinned compactc $VERSION archive for $(uname -s)-$(uname -m)" >&2; exit 64 ;;
esac

if [[ -x "$DEST/compactc" ]] && [[ "$("$DEST/compactc" --version 2>/dev/null)" == "$VERSION" ]]; then
  echo "$DEST/compactc"
  exit 0
fi

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
zip="$tmp/$ASSET"
if [[ -n "${COMPACTC_ZIP:-}" ]]; then
  cp "$COMPACTC_ZIP" "$zip"
else
  echo "fetch-compactc: downloading $ASSET" >&2
  curl -fsSL --retry 3 -o "$zip" "$BASE_URL/$ASSET"
fi
got="$(sha256 "$zip")"
if [[ "$got" != "$SHA" ]]; then
  echo "fetch-compactc: SHA-256 mismatch for $ASSET: expected $SHA, got $got" >&2
  exit 65
fi
mkdir -p "$DEST"
if command -v unzip >/dev/null; then
  unzip -o -q "$zip" -d "$DEST"
else
  python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$zip" "$DEST"
fi
chmod +x "$DEST"/compactc "$DEST"/compactc.bin "$DEST"/zkir "$DEST"/zkir-v3 2>/dev/null || true
test "$("$DEST/compactc" --version)" == "$VERSION"
echo "fetch-compactc: compactc $VERSION verified ($SHA) in $DEST" >&2
echo "$DEST/compactc"
