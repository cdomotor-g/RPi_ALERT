#!/bin/bash
# Build the RPi ALERT SD-card image: official Raspberry Pi OS Lite + os/install.sh,
# run in a chroot under qemu-user. Needs root, losetup, sfdisk, e2fsck/resize2fs,
# xz, python3 and qemu-user-static with binfmt (GitHub's ubuntu runners have or
# can apt-install all of it; see .github/workflows/build-image.yml).
#
#   sudo build/build-image.sh                       # 64-bit (Pi 3, 4, 400, 5, Zero 2 W)
#   sudo build/build-image.sh --arch armhf          # 32-bit (also Pi 1, 2, Zero)
#   sudo build/build-image.sh --base raspios.img.xz # a base image already downloaded
#
# Output in build/out/: rpi-alert-<version>-<arch>.img.xz, its .sha256, and
# os-list-<arch>.json — the Raspberry Pi Imager entry for it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/.." && pwd)"
ARCH=arm64; BASE=""; OUT="$HERE/out"; CACHE="$HERE/cache"; GROW_MB=1800; KIOSK=1; SHRINK=1; COMPRESS=1
OS_LIST=https://downloads.raspberrypi.com/os_list_imagingutility_v4.json

while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH=$2; shift ;;
    --base) BASE=$2; shift ;;
    --out) OUT=$2; shift ;;
    --grow-mb) GROW_MB=$2; shift ;;
    --no-kiosk) KIOSK=0 ;;
    --no-shrink) SHRINK=0 ;;
    --no-compress) COMPRESS=0 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
case "$ARCH" in arm64|armhf) ;; *) echo "--arch arm64 or armhf" >&2; exit 2 ;; esac
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
for t in losetup sfdisk e2fsck resize2fs xz python3 chroot mount; do command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 1; }; done

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
VERSION=$(python3 -c "import json;print(json.load(open('$SRC/agent/package.json'))['version'])")
mkdir -p "$OUT" "$CACHE"

# ── the base image ───────────────────────────────────────────────────────────
BASE_NAME=""; BASE_DATE=""
if [ -z "$BASE" ]; then
  want="Raspberry Pi OS Lite (64-bit)"; [ "$ARCH" = armhf ] && want="Raspberry Pi OS Lite (32-bit)"
  say "Finding the current \"$want\""
  read -r BASE BASE_DATE < <(curl -fsSL "$OS_LIST" | python3 -c "
import json, sys
want = sys.argv[1]
def walk(items):
    for o in items:
        if o.get('name') == want and o.get('url'):
            print(o['url'], o.get('release_date', '')); sys.exit(0)
        walk(o.get('subitems', []))
walk(json.load(sys.stdin)['os_list'])
sys.exit('not found: ' + want)" "$want")
  BASE_NAME=$want
fi
if [[ "$BASE" =~ ^https?:// ]]; then
  f="$CACHE/$(basename "$BASE")"
  if [ ! -s "$f" ]; then say "Downloading $BASE"; curl -fSL --retry 3 -o "$f.part" "$BASE"; mv "$f.part" "$f"; fi
  BASE=$f
fi
[ -s "$BASE" ] || { echo "no base image at $BASE" >&2; exit 1; }
BASE_NAME=${BASE_NAME:-$(basename "$BASE")}

WORK=$(mktemp -d "${TMPDIR:-/tmp}/rpi-alert-build.XXXXXX")
IMG="$WORK/rpi-alert.img"
MNT="$WORK/root"
LOOP_ROOT=""; LOOP_BOOT=""; BOOT_MTOOLS=0
cleanup() {
  set +e
  for m in "$MNT/boot/firmware" "$MNT/dev/pts" "$MNT/dev" "$MNT/proc" "$MNT/sys" "$MNT/run" "$MNT"; do mountpoint -q "$m" && umount -l "$m"; done
  [ -n "$LOOP_BOOT" ] && losetup -d "$LOOP_BOOT" 2>/dev/null
  [ -n "$LOOP_ROOT" ] && losetup -d "$LOOP_ROOT" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

say "Unpacking $(basename "$BASE")"
case "$BASE" in *.xz) xz -dc -T0 "$BASE" > "$IMG" ;; *.img) cp --sparse=always "$BASE" "$IMG" ;; *) echo "base must be .img or .img.xz" >&2; exit 1 ;; esac

part() { sfdisk -J "$IMG" | python3 -c "import json,sys;p=json.load(sys.stdin)['partitiontable']['partitions'][int(sys.argv[1])-1];print(p['start'],p['size'])" "$1"; }

# ── room for the agent, Node.js and the kiosk ───────────────────────────────
say "Growing the root file system by ${GROW_MB} MB"
truncate -s +"${GROW_MB}M" "$IMG"
echo ", +" | sfdisk --no-reread --quiet -N 2 "$IMG" >/dev/null
read -r RSTART RSIZE < <(part 2)
read -r BSTART BSIZE < <(part 1)
LOOP_ROOT=$(losetup -f --show -o $((RSTART * 512)) --sizelimit $((RSIZE * 512)) "$IMG")
e2fsck -fy "$LOOP_ROOT" >/dev/null || true
resize2fs "$LOOP_ROOT" >/dev/null

mkdir -p "$MNT"
mount "$LOOP_ROOT" "$MNT"
LOOP_BOOT=$(losetup -f --show -o $((BSTART * 512)) --sizelimit $((BSIZE * 512)) "$IMG")
if ! mount -t vfat "$LOOP_BOOT" "$MNT/boot/firmware" 2>/dev/null; then
  # A build container without vfat: the boot partition is edited with mtools afterwards.
  command -v mcopy >/dev/null || { echo "cannot mount the FAT boot partition and mtools is not installed" >&2; exit 1; }
  BOOT_MTOOLS=1
  say "No vfat in this kernel — the boot partition will be written with mtools"
  export MTOOLS_SKIP_CHECK=1
  mcopy -i "$LOOP_BOOT" ::/config.txt "$WORK/config.txt"
  cp "$WORK/config.txt" "$MNT/boot/firmware/config.txt"
fi
for d in dev dev/pts proc sys run; do mkdir -p "$MNT/$d"; mount --bind "/$d" "$MNT/$d"; done

# qemu: binfmt with the F flag needs nothing in the chroot; without it, copy the binary in.
QEMU=qemu-aarch64; [ "$ARCH" = armhf ] && QEMU=qemu-arm
if ! grep -qs '^flags:.*F' "/proc/sys/fs/binfmt_misc/$QEMU"; then
  [ -x "/usr/bin/$QEMU-static" ] || { echo "qemu-user-static ($QEMU) with binfmt is needed" >&2; exit 1; }
  cp "/usr/bin/$QEMU-static" "$MNT/usr/bin/"
fi

cp "$MNT/etc/resolv.conf" "$WORK/resolv.conf.orig" 2>/dev/null || true
rm -f "$MNT/etc/resolv.conf"; cp /etc/resolv.conf "$MNT/etc/resolv.conf"
printf '#!/bin/sh\nexit 101\n' > "$MNT/usr/sbin/policy-rc.d"; chmod +x "$MNT/usr/sbin/policy-rc.d"

say "Installing RPi ALERT in the image"
rm -rf "$MNT/tmp/rpi-alert-src"; mkdir -p "$MNT/tmp/rpi-alert-src"
cp -a "$SRC/agent" "$SRC/os" "$MNT/tmp/rpi-alert-src/"
rm -rf "$MNT/tmp/rpi-alert-src/agent/test"
args=(--image); [ "$KIOSK" = 0 ] && args+=(--no-kiosk)
# A clean environment: nothing of the build machine's (proxies, CA bundles,
# locales) leaks into the image.
in_chroot() { chroot "$MNT" /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8 TERM=dumb "$@"; }
in_chroot /bin/bash /tmp/rpi-alert-src/os/install.sh "${args[@]}"
# Sanity: the agent runs, under emulation, inside the image.
in_chroot /usr/bin/node /opt/rpi-alert/bin/rpi-alert version

say "Cleaning up the image"
in_chroot apt-get clean
rm -rf "$MNT/tmp/rpi-alert-src" "$MNT/var/lib/apt/lists/"* "$MNT/usr/sbin/policy-rc.d" "$MNT/usr/bin/$QEMU-static" "$MNT/root/.bash_history"
rm -f "$MNT/etc/resolv.conf"
[ -e "$WORK/resolv.conf.orig" ] && cp -a "$WORK/resolv.conf.orig" "$MNT/etc/resolv.conf"
echo "RPi ALERT $VERSION, built $(date -u +%Y-%m-%d) from $BASE_NAME${BASE_DATE:+ ($BASE_DATE)}" > "$MNT/etc/rpi-alert-release"

if [ "$BOOT_MTOOLS" = 1 ]; then
  mcopy -o -i "$LOOP_BOOT" "$MNT/boot/firmware/config.txt" ::/config.txt
  for f in rpi-alert.conf.example RPI-ALERT-README.txt; do mcopy -o -i "$LOOP_BOOT" "$MNT/boot/firmware/$f" "::/$f"; done
  find "$MNT/boot/firmware" -mindepth 1 -delete
fi

for d in run sys proc dev/pts dev; do umount -l "$MNT/$d"; done
mountpoint -q "$MNT/boot/firmware" && umount "$MNT/boot/firmware"
# Zeros compress to nothing: fill the free space once, then delete it.
dd if=/dev/zero of="$MNT/zero.fill" bs=4M status=none 2>/dev/null || true
rm -f "$MNT/zero.fill"
umount "$MNT"

# ── shrink to what is used (+ headroom); the Pi expands it at first boot ────
if [ "$SHRINK" = 1 ]; then
  say "Shrinking the root file system"
  e2fsck -fy "$LOOP_ROOT" >/dev/null || true
  resize2fs -M "$LOOP_ROOT" >/dev/null 2>&1
  BS=$(dumpe2fs -h "$LOOP_ROOT" 2>/dev/null | awk -F: '/^Block size/ {gsub(/ /,"",$2); print $2}')
  BC=$(dumpe2fs -h "$LOOP_ROOT" 2>/dev/null | awk -F: '/^Block count/ {gsub(/ /,"",$2); print $2}')
  NEW_BYTES=$(( BC * BS + 300 * 1024 * 1024 ))
  resize2fs "$LOOP_ROOT" $(( NEW_BYTES / 1024 ))K >/dev/null
  losetup -d "$LOOP_ROOT"; LOOP_ROOT=""
  NEW_SECTORS=$(( (NEW_BYTES + 511) / 512 ))
  echo "${RSTART},${NEW_SECTORS}" | sfdisk --no-reread --quiet -N 2 "$IMG" >/dev/null
  truncate -s $(( (RSTART + NEW_SECTORS) * 512 )) "$IMG"
fi
[ -n "$LOOP_ROOT" ] && { losetup -d "$LOOP_ROOT"; LOOP_ROOT=""; }
losetup -d "$LOOP_BOOT"; LOOP_BOOT=""

NAME="rpi-alert-$VERSION-$ARCH"
EXTRACT_SIZE=$(stat -c %s "$IMG")
EXTRACT_SHA=$(sha256sum "$IMG" | cut -d' ' -f1)
if [ "$COMPRESS" = 1 ]; then
  say "Compressing (xz)"
  xz -T0 -6 -c "$IMG" > "$OUT/$NAME.img.xz"
  FILE="$NAME.img.xz"
else
  mv "$IMG" "$OUT/$NAME.img"; FILE="$NAME.img"
fi
( cd "$OUT" && sha256sum "$FILE" > "$FILE.sha256" )
DL_SIZE=$(stat -c %s "$OUT/$FILE")
DL_SHA=$(cut -d' ' -f1 "$OUT/$FILE.sha256")

# The Raspberry Pi Imager entry. init_format follows the base image (Trixie:
# cloud-init), so Imager's customisation — user, Wi-Fi, SSH, hostname — works.
INIT=cloudinit-rpi; grep -q bookworm <<<"$BASE_NAME$BASE" && INIT=systemd
DEVICES='["pi5-64bit","pi4-64bit","pi3-64bit"]'
[ "$ARCH" = armhf ] && DEVICES='["pi5-32bit","pi4-32bit","pi3-32bit","pi2-32bit","pi1-32bit"]'
DESC="ALERT flood-warning base station: RTL-SDR, Quansheng and ERT-A2 receivers to MegaNet. Raspberry Pi OS Lite underneath."
[ "$ARCH" = armhf ] && DESC="$DESC 32-bit, for Pi 1, 2 and Zero (and any other)."
python3 - "$OUT/os-list-$ARCH.json" <<PY
import json, sys
entry = {
  "name": "RPi ALERT ($ARCH)",
  "description": "$DESC",
  "icon": "https://cdomotor-g.github.io/RPi_ALERT/icon.png",
  "url": "https://github.com/cdomotor-g/RPi_ALERT/releases/download/v$VERSION/$FILE",
  "extract_size": $EXTRACT_SIZE,
  "extract_sha256": "$EXTRACT_SHA",
  "image_download_size": $DL_SIZE,
  "image_download_sha256": "$DL_SHA",
  "release_date": "$(date -u +%Y-%m-%d)",
  "init_format": "$INIT",
  "devices": $DEVICES,
  "website": "https://github.com/cdomotor-g/RPi_ALERT",
}
json.dump(entry, open(sys.argv[1], "w"), indent=2)
PY
say "Done: $OUT/$FILE ($(( DL_SIZE / 1048576 )) MB; $(( EXTRACT_SIZE / 1048576 )) MB written to the card)"
