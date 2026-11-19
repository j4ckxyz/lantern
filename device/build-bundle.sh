#!/usr/bin/env bash
# Build a release bundle for the desk: the screen's UI, the service as a wheel (with the UI inside
# it), its dependencies as arm64 wheels, and the device files. Runs on a Mac, Linux or CI; nothing
# is compiled on the Pi.
#
#   bash device/build-bundle.sh            -> dist/lantern-<version>-arm64.tar.zst
#
# Needs Node 20+ and Python 3.11+. With MINISIGN_KEY set (a minisign secret key file), the
# checksums are signed too, for the update flow.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' pyproject.toml | head -n1)"
[ -n "$VERSION" ] || { echo "no version in pyproject.toml" >&2; exit 1; }
NAME="lantern-$VERSION-arm64"
OUT="$REPO/dist"
WORK="$(mktemp -d)"
STAGE="$WORK/$NAME"
PYTHON="${PYTHON:-python3}"
trap 'rm -rf "$WORK" "$REPO/src/lantern/ui"' EXIT

echo "==> Building the screen's UI"
(cd ui && npm ci --no-audit --no-fund && npm run build)

echo "==> Building the service wheel (with the UI inside)"
# setuptools reuses build/, which would carry the last build's UI files into this wheel.
rm -rf src/lantern/ui build
cp -R ui/dist src/lantern/ui
mkdir -p "$STAGE/wheels"
"$PYTHON" -m pip wheel --quiet --no-deps --wheel-dir "$STAGE/wheels" .

echo "==> Fetching dependencies for 64-bit ARM (Python 3.13, Raspberry Pi OS Trixie)"
"$PYTHON" -m pip download --quiet --dest "$STAGE/wheels" --only-binary=:all: \
    --platform manylinux2014_aarch64 --platform manylinux_2_17_aarch64 --platform manylinux_2_28_aarch64 \
    --python-version 3.13 --implementation cp "websockets>=13,<17"

echo "==> Adding the device files"
mkdir -p "$STAGE/device"
cp -R device/kiosk.sh device/install.sh device/systemd device/plymouth device/system "$STAGE/device/"
echo "$VERSION" >"$STAGE/VERSION"
SUMS="$WORK/SHA256SUMS"
(cd "$STAGE" && find . -type f -print0 | sort -z | xargs -0 sha256sum >"$SUMS")
mv "$SUMS" "$STAGE/SHA256SUMS"
if [ -n "${MINISIGN_KEY:-}" ]; then
    minisign -S -s "$MINISIGN_KEY" -m "$STAGE/SHA256SUMS" -t "lantern $VERSION"
fi

mkdir -p "$OUT"
tar --zstd -cf "$OUT/$NAME.tar.zst" -C "$WORK" "$NAME"
echo "==> $OUT/$NAME.tar.zst ($(du -h "$OUT/$NAME.tar.zst" | cut -f1))"
