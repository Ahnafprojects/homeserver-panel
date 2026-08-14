#!/usr/bin/env bash
# Mengambil Monaco Editor (inti editor VS Code) ke public/vendor/monaco.
# Dipisah dari repo karena ukurannya 12 MB dan seluruhnya kode pihak ketiga.
set -euo pipefail
VER=${1:-0.52.2}
DEST="$(cd "$(dirname "$0")/.." && pwd)/public/vendor"
mkdir -p "$DEST"
cd "$DEST"
echo "Mengunduh monaco-editor $VER..."
curl -fsSL -o monaco.tgz "https://registry.npmjs.org/monaco-editor/-/monaco-editor-${VER}.tgz"
tar xzf monaco.tgz
rm -rf monaco && mkdir -p monaco
cp -r package/min/vs monaco/
rm -rf package monaco.tgz
# Buang terjemahan selain Inggris dan source map agar hemat ruang.
rm -f monaco/vs/nls.messages.*.js
find monaco -name '*.map' -delete
echo "Selesai: $DEST/monaco ($(du -sh monaco | cut -f1))"
