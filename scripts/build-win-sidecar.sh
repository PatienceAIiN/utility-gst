#!/usr/bin/env bash
# Assemble a Windows Python sidecar FROM LINUX.
#
# PyInstaller cannot cross-compile, and the brief rightly forbids building it
# under Wine. But we do not actually need PyInstaller: Python ships an official
# Windows "embeddable" distribution, and pip can fetch win_amd64 wheels from any
# host. Assembling those two by hand produces a working sidecar without ever
# touching a Windows machine.
#
# The windows-latest CI job still builds a PyInstaller onedir for release --
# this is the fast local path so the app can be smoke-tested on Windows today.
# The Electron main process accepts either layout (see src/main/sidecar.ts).
set -euo pipefail

PYVER="${PYVER:-3.12.8}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/sidecar/dist/gstparse"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Windows sidecar: Python $PYVER -> $OUT"
rm -rf "$OUT"; mkdir -p "$OUT"

echo "==> Fetching Windows embeddable Python"
curl -fsSL -o "$WORK/py.zip" \
  "https://www.python.org/ftp/python/$PYVER/python-$PYVER-embed-amd64.zip"
unzip -q "$WORK/py.zip" -d "$OUT"

# The embeddable build ships a zipped stdlib and an isolated ._pth that disables
# site-packages by default. Rewrite it so our vendored wheels are importable.
# The stdlib zip name is read from disk rather than derived, so a PYVER bump
# cannot silently produce an unimportable bundle.
PTH="$(ls "$OUT"/python*._pth)"
ZIPNAME="$(cd "$OUT" && ls python3*.zip | head -1)"
printf '%s\n.\nLib/site-packages\nimport site\n' "$ZIPNAME" > "$PTH"

echo "==> Downloading win_amd64 wheels"
mkdir -p "$OUT/Lib/site-packages"
python3 -m pip download \
  --quiet --dest "$WORK/wheels" \
  --platform win_amd64 --only-binary=:all: \
  --python-version "${PYVER%.*}" \
  pdfplumber openpyxl python-dateutil

echo "==> Unpacking wheels"
for whl in "$WORK"/wheels/*.whl; do
  unzip -q -o "$whl" -d "$OUT/Lib/site-packages"
done

echo "==> Vendoring gstparse"
cp -r "$ROOT/sidecar/gstparse" "$OUT/Lib/site-packages/gstparse"
find "$OUT/Lib/site-packages/gstparse" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true

# Strip test/doc payloads that bloat the installer without being used.
find "$OUT/Lib/site-packages" -type d \( -name 'tests' -o -name 'test' -o -name '*.dist-info' \) \
  -exec rm -rf {} + 2>/dev/null || true

SIZE="$(du -sm "$OUT" | cut -f1)"
echo "==> Done: $OUT (${SIZE} MiB)"
echo "    entry: python.exe -m gstparse.cli rpc"
