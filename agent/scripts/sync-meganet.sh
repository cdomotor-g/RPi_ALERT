#!/bin/bash
# Refresh agent/vendor/meganet from MegaNet, so the Pi keeps decoding exactly
# what floodwarning.net decodes. Copies the files byte for byte (alert2.js has
# a literal NUL that must survive), records the commit, and runs the tests.
#
#   agent/scripts/sync-meganet.sh                 # clone MegaNet's main into a temp dir
#   agent/scripts/sync-meganet.sh ~/src/MegaNet   # or use a checkout you have
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$HERE/vendor/meganet"
SRC=${1:-}
if [ -z "$SRC" ]; then
  SRC=$(mktemp -d)
  trap 'rm -rf "$SRC"' EXIT
  git clone --depth 1 https://github.com/cdomotor-g/MegaNet "$SRC" >/dev/null
fi
commit=$(git -C "$SRC" rev-parse HEAD)
date=$(git -C "$SRC" log -1 --format=%cs)
for f in alert-dsp.js quansheng.js alert2.js serial-gps.js LICENSE; do cp "$SRC/$f" "$VENDOR/$f"; done
cp "$SRC/test/fixtures/sdr/testrig_burst_240k.iq8" "$HERE/test/fixtures/"
sed -i -E "s/^commit: .*/commit:     $commit ($date)/" "$VENDOR/SOURCE"
echo "vendor/meganet now at MegaNet $commit ($date)"
git -C "$HERE/.." diff --stat -- agent/vendor agent/test/fixtures || true
cd "$HERE" && node --test test/*.test.js
