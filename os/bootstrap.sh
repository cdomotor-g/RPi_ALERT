#!/bin/bash
# Install RPi ALERT on a Raspberry Pi that already runs Raspberry Pi OS:
#
#   curl -fsSL https://raw.githubusercontent.com/cdomotor-g/RPi_ALERT/main/os/bootstrap.sh | sudo bash
#
# Options go after "bash -s --", e.g. ... | sudo bash -s -- --no-kiosk
# RPI_ALERT_REF picks a branch or tag (default: main).
set -euo pipefail
REPO=${RPI_ALERT_REPO:-cdomotor-g/RPi_ALERT}
REF=${RPI_ALERT_REF:-main}
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
command -v curl >/dev/null || { apt-get update -q && apt-get install -y -q curl ca-certificates; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Downloading RPi ALERT ($REPO@$REF)…"
curl -fsSL "https://github.com/$REPO/archive/$REF.tar.gz" | tar -xz -C "$tmp" --strip-components=1
bash "$tmp/os/install.sh" "$@"
