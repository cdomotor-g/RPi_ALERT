#!/bin/bash
# RPi ALERT installer — turns Raspberry Pi OS (Trixie or Bookworm, Lite or
# Desktop, 64- or 32-bit) into an RPi ALERT base station. The SD-card image is
# this same script run in a chroot over Raspberry Pi OS Lite (build/build-image.sh).
#
# On a Pi that is already running Raspberry Pi OS:
#   curl -fsSL https://raw.githubusercontent.com/cdomotor-g/RPi_ALERT/main/os/bootstrap.sh | sudo bash
# or from a checkout:
#   sudo ./os/install.sh
#
# Options
#   --no-kiosk     do not install the screen dashboard (cage + Chromium, ~400 MB)
#   --kiosk        install it even on a Pi with under 1 GB of RAM
#   --no-watchdog  leave the hardware watchdog alone
#   --build-rtl    build the RTL-SDR Blog driver even if the system's knows the V4
#   --image        building an SD image in a chroot: set image defaults, start nothing
#   --upgrade      reinstall over an existing install (rpi-alert-update uses this)
#   --uninstall    remove RPi ALERT (settings and queue kept unless --purge)
#
# It never overwrites settings (/etc/rpi-alert) or data (/var/lib/rpi-alert).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX=/opt/rpi-alert
IMAGE=0; KIOSK=auto; WATCHDOG=1; BUILD_RTL=auto; UPGRADE=0; UNINSTALL=0; PURGE=0

for a in "$@"; do
  case "$a" in
    --image) IMAGE=1 ;;
    --no-kiosk) KIOSK=0 ;;
    --kiosk) KIOSK=1 ;;
    --no-watchdog) WATCHDOG=0 ;;
    --build-rtl) BUILD_RTL=1 ;;
    --upgrade) UPGRADE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $a (try --help)" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
apt_install() { DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends -o Dpkg::Options::=--force-confold "$@"; }
# systemctl in a chroot can enable/disable but not start anything.
sysd() { if [ "$IMAGE" = 1 ]; then systemctl "$@" 2>/dev/null || true; else systemctl "$@"; fi; }

[ "$(id -u)" = 0 ] || die "run as root: sudo $0 $*"
[ -f "$SRC/agent/bin/rpi-alert" ] || die "cannot find the agent next to this script ($SRC/agent)"

FW=/boot/firmware; [ -d "$FW" ] || FW=/boot

# ── uninstall ────────────────────────────────────────────────────────────────
if [ "$UNINSTALL" = 1 ]; then
  say "Removing RPi ALERT"
  systemctl disable --now rpi-alert.service rpi-alert-boot-config.service rpi-alert-kiosk.service rpi-alert-btgps.service rpi-alert-update-auto.timer rpi-alert-access.timer 2>/dev/null || true
  rm -f /dev/rpi-alert-gps
  rm -f /etc/systemd/system/rpi-alert*.service /etc/systemd/system/rpi-alert*.timer /etc/udev/rules.d/60-rpi-alert.rules /etc/modprobe.d/rpi-alert-blacklist-dvb.conf \
        /etc/sudoers.d/rpi-alert /etc/pam.d/rpi-alert-kiosk /etc/systemd/journald.conf.d/rpi-alert.conf \
        /etc/systemd/system.conf.d/rpi-alert-watchdog.conf /etc/issue.d/rpi-alert.issue /etc/profile.d/rpi-alert.sh /usr/local/bin/rpi-alert
  # SSH: the key list and its drop-in go (the alert account's keys with them);
  # every other account's ~/.ssh/authorized_keys was never touched.
  rm -f /etc/ssh/sshd_config.d/10-rpi-alert.conf /etc/sudoers.d/rpi-alert-maint
  rm -rf /etc/ssh/rpi-alert /var/lib/rpi-alert-access
  systemctl try-reload-or-restart ssh.service 2>/dev/null || true
  rm -rf "$PREFIX"
  if [ "$PURGE" = 1 ]; then rm -rf /etc/rpi-alert /var/lib/rpi-alert /var/lib/rpi-alert-kiosk; userdel rpi-alert 2>/dev/null || true; userdel rpi-alert-kiosk 2>/dev/null || true; userdel -r alert 2>/dev/null || true; fi
  systemctl daemon-reload || true
  say "Done.$([ "$PURGE" = 1 ] || echo ' Settings kept in /etc/rpi-alert and data in /var/lib/rpi-alert (--purge removes them).')"
  exit 0
fi

# ── what are we on? ──────────────────────────────────────────────────────────
# shellcheck source=/dev/null
. /etc/os-release
ARCH=$(dpkg --print-architecture)
say "RPi ALERT $(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$SRC/agent/package.json") on ${PRETTY_NAME:-$ID} ($ARCH)$([ "$IMAGE" = 1 ] && echo ', building an image')"
case "${VERSION_CODENAME:-}" in
  trixie|bookworm|forky|sid) ;;
  bullseye|buster) die "Raspberry Pi OS ${VERSION_CODENAME} is too old (Node.js 18+ is needed). Flash Raspberry Pi OS Lite (Trixie) or the RPi ALERT image." ;;
  *) warn "untested OS release '${VERSION_CODENAME:-unknown}' — carrying on" ;;
esac
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$KIOSK" = auto ]; then
  if [ "$IMAGE" = 1 ] || [ "$MEM_MB" -ge 900 ]; then KIOSK=1; else KIOSK=0; say "Under 1 GB of RAM: skipping the screen dashboard (--kiosk installs it anyway)"; fi
fi

# ── packages ─────────────────────────────────────────────────────────────────
say "Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
# bluez and python3: a Bluetooth GPS (rpi-alert-btgps), used only when rpi-alert.conf names one.
PKGS=(nodejs rtl-sdr alsa-utils avahi-daemon curl ca-certificates sudo procps bluez python3)
apt_install "${PKGS[@]}"
if [ "$KIOSK" = 1 ]; then
  say "Installing the screen dashboard (cage + Chromium)"
  apt_install cage chromium fonts-dejavu-core || apt_install cage chromium-browser fonts-dejavu-core || warn "could not install the kiosk packages; the dashboard is still on the network"
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18 or newer is needed (found $(node -v 2>/dev/null || echo none))"

# ── RTL-SDR: the Blog V4 needs a librtlsdr that knows it ────────────────────
rtl_knows_v4() {
  local lib
  for lib in $(ldconfig -p 2>/dev/null | awk '/librtlsdr\.so/ {print $NF}'); do
    grep -aq "Blog V4" "$lib" 2>/dev/null && return 0
  done
  return 1
}
if [ "$BUILD_RTL" = 1 ] || ! rtl_knows_v4; then
  say "This system's librtlsdr does not know the RTL-SDR Blog V4 — building rtlsdrblog/rtl-sdr-blog"
  apt_install git cmake build-essential pkg-config libusb-1.0-0-dev
  # Its README: remove the distribution's library first, or rtl_sdr can load the old one.
  apt-get purge -y 'librtlsdr*' rtl-sdr 2>/dev/null || true
  tmp=$(mktemp -d)
  git clone --depth 1 https://github.com/rtlsdrblog/rtl-sdr-blog "$tmp/rtl-sdr-blog"
  cmake -S "$tmp/rtl-sdr-blog" -B "$tmp/build" -DINSTALL_UDEV_RULES=ON -DDETACH_KERNEL_DRIVER=ON -DCMAKE_INSTALL_PREFIX=/usr/local >/dev/null
  make -C "$tmp/build" -j"$(nproc)" install >/dev/null
  ldconfig
  rm -rf "$tmp"
  if rtl_knows_v4; then say "RTL-SDR Blog driver installed (V2, V3, V4 and generic sticks)"; else warn "the RTL-SDR Blog build finished but its library was not found"; fi
else
  say "librtlsdr knows the RTL-SDR Blog V4 already ($(ldconfig -p | awk '/librtlsdr\.so/ {print $NF; exit}'))"
fi

# ── users ────────────────────────────────────────────────────────────────────
say "Creating the agent's user"
getent group plugdev >/dev/null || groupadd --system plugdev
id rpi-alert >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/rpi-alert --no-create-home --shell /usr/sbin/nologin --comment "RPi ALERT agent" rpi-alert
usermod -aG dialout,plugdev,audio,video rpi-alert
if [ "$KIOSK" = 1 ]; then
  id rpi-alert-kiosk >/dev/null 2>&1 || useradd --system --user-group --create-home --home-dir /var/lib/rpi-alert-kiosk --shell /usr/sbin/nologin --comment "RPi ALERT screen" rpi-alert-kiosk
  for g in video render input audio; do getent group "$g" >/dev/null && usermod -aG "$g" rpi-alert-kiosk; done
fi
# The maintenance account (docs/access.md): the same user name on every base
# station, no password — SSH keys only, from the list `rpi-alert access` shows
# — and sudo. With no key on the list, nobody can log in as it. A system user
# id, so the person Raspberry Pi Imager sets up at first boot still gets 1000.
if ! id alert >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /home/alert --shell /bin/bash --comment "RPi ALERT maintenance (SSH keys; docs/access.md)" alert
  # '*': no password that can be typed, and not a locked account (which sshd
  # would refuse even with a key).
  usermod -p '*' alert
fi
for g in adm systemd-journal dialout plugdev video audio; do getent group "$g" >/dev/null && usermod -aG "$g" alert; done

# ── the agent ────────────────────────────────────────────────────────────────
say "Installing the agent in $PREFIX"
NEW="$PREFIX.new"
rm -rf "$NEW"
install -d -m 0755 "$NEW" "$NEW/libexec" "$NEW/os"
cp -a "$SRC/agent/bin" "$SRC/agent/lib" "$SRC/agent/vendor" "$SRC/agent/web" "$SRC/agent/package.json" "$NEW/"
cp -a "$SRC/os/files" "$SRC/os/boot" "$SRC/os/install.sh" "$NEW/os/"
[ -f "$SRC/os/bootstrap.sh" ] && cp -a "$SRC/os/bootstrap.sh" "$NEW/os/"
install -m 0755 "$SRC/os/libexec/"* "$NEW/libexec/"
# The Bluetooth GPS bridge is Python, kept apart from the shell helpers in libexec.
install -m 0755 "$SRC/os/files/btgps/rpi-alert-btgps" "$NEW/libexec/"
chown -R root:root "$NEW"
chmod 0755 "$NEW/bin/rpi-alert" "$NEW/bin/rpi-alert-access"
if [ -d "$PREFIX" ]; then rm -rf "$PREFIX.old"; mv "$PREFIX" "$PREFIX.old"; fi
mv "$NEW" "$PREFIX"
rm -rf "$PREFIX.old"
ln -sf "$PREFIX/bin/rpi-alert" /usr/local/bin/rpi-alert
ln -sf "$PREFIX/libexec/rpi-alert-update" /usr/local/sbin/rpi-alert-update

install -d -o rpi-alert -g rpi-alert -m 0750 /etc/rpi-alert /var/lib/rpi-alert
[ -f /etc/rpi-alert/config.json ] && chown rpi-alert:rpi-alert /etc/rpi-alert/config.json && chmod 0600 /etc/rpi-alert/config.json
chown -R rpi-alert:rpi-alert /var/lib/rpi-alert

# ── system integration ───────────────────────────────────────────────────────
say "Installing services, device rules and the root helper"
F="$SRC/os/files"
install -m 0644 "$F/systemd/rpi-alert.service" "$F/systemd/rpi-alert-boot-config.service" "$F/systemd/rpi-alert-btgps.service" /etc/systemd/system/
# Over-the-air updates: the installer the web page starts, and the nightly timer
# (off until turned on in Settings → System or with auto_update = on in
# rpi-alert.conf; an upgrade leaves it as it was).
install -m 0644 "$F/systemd/rpi-alert-update.service" "$F/systemd/rpi-alert-update-auto.service" "$F/systemd/rpi-alert-update-auto.timer" /etc/systemd/system/
# SSH keys fetched from GitHub and MegaNet, refreshed hourly (rpi-alert-access).
install -m 0644 "$F/systemd/rpi-alert-access.service" "$F/systemd/rpi-alert-access.timer" /etc/systemd/system/
[ "$KIOSK" = 1 ] && install -m 0644 "$F/systemd/rpi-alert-kiosk.service" /etc/systemd/system/
install -m 0644 "$F/udev/60-rpi-alert.rules" /etc/udev/rules.d/
install -m 0644 "$F/modprobe/rpi-alert-blacklist-dvb.conf" /etc/modprobe.d/
install -d /etc/systemd/journald.conf.d && install -m 0644 "$F/journald/rpi-alert.conf" /etc/systemd/journald.conf.d/
install -d /etc/issue.d && install -m 0644 "$F/issue/rpi-alert.issue" /etc/issue.d/
install -m 0644 "$F/profile/rpi-alert.sh" /etc/profile.d/
install -m 0644 "$F/pam/rpi-alert-kiosk" /etc/pam.d/
for s in rpi-alert rpi-alert-maint; do
  install -m 0440 "$F/sudoers/$s" "/etc/sudoers.d/$s.tmp"
  if visudo -cf "/etc/sudoers.d/$s.tmp" >/dev/null; then mv "/etc/sudoers.d/$s.tmp" "/etc/sudoers.d/$s"
  else rm -f "/etc/sudoers.d/$s.tmp"; die "the sudoers rule $s did not validate"; fi
done
# The alert account's key list: root's, outside /etc/rpi-alert (the agent owns
# that directory, and sshd rightly refuses a key file another user could
# replace). The drop-in that points sshd at it is checked with sshd -t before
# it is kept — see lib/access.js.
install -d -m 0755 /etc/ssh/rpi-alert
[ -f /etc/ssh/rpi-alert/alert.keys ] || install -m 0644 /dev/null /etc/ssh/rpi-alert/alert.keys
if [ -d /etc/ssh ]; then
  if ! out=$(RPI_ALERT_ACCESS_NO_RELOAD=$IMAGE node "$PREFIX/bin/rpi-alert-access" apply 2>&1); then warn "SSH key login for the alert account is not set up: $out"; fi
fi
if [ "$WATCHDOG" = 1 ]; then
  install -d /etc/systemd/system.conf.d && install -m 0644 "$F/system-conf/rpi-alert-watchdog.conf" /etc/systemd/system.conf.d/
fi

# ── the boot partition ───────────────────────────────────────────────────────
if [ -d "$FW" ] && [ -w "$FW" ]; then
  install -m 0644 "$SRC/os/boot/rpi-alert.conf.example" "$SRC/os/boot/RPI-ALERT-README.txt" "$FW/" 2>/dev/null || warn "could not write to $FW"
  # The audio jack (Pi 3/4/400): on by default in Raspberry Pi OS; make sure.
  if [ -f "$FW/config.txt" ] && ! grep -qE '^\s*dtparam=audio=on' "$FW/config.txt"; then
    if grep -qE '^\s*#\s*dtparam=audio=on' "$FW/config.txt"; then sed -i -E 's/^\s*#\s*(dtparam=audio=on)/\1/' "$FW/config.txt"
    else printf '\n[all]\n# RPi ALERT: the audio jack, for the chirps\ndtparam=audio=on\n' >> "$FW/config.txt"; fi
  fi
fi

# ── an image's defaults ──────────────────────────────────────────────────────
if [ "$IMAGE" = 1 ]; then
  say "Image defaults: hostname rpi-alert, time zone Australia/Brisbane, Bluetooth off"
  echo rpi-alert > /etc/hostname
  if grep -q '^127\.0\.1\.1' /etc/hosts; then sed -i 's/^127\.0\.1\.1.*/127.0.1.1\trpi-alert/' /etc/hosts; else echo -e '127.0.1.1\trpi-alert' >> /etc/hosts; fi
  ln -sf /usr/share/zoneinfo/Australia/Brisbane /etc/localtime
  echo Australia/Brisbane > /etc/timezone
  # Not needed by a base station; a USB GPS or receiver never uses them. Re-enable with systemctl enable.
  # (gps_bluetooth in rpi-alert.conf turns Bluetooth back on for a Bluetooth GPS.)
  for s in hciuart.service bluetooth.service triggerhappy.service triggerhappy.socket ModemManager.service; do systemctl disable "$s" 2>/dev/null || true; done
  # Each Pi makes its own machine id at first boot (and so its own receiver ids).
  : > /etc/machine-id
  rm -f /var/lib/dbus/machine-id
  # SSH on, so a headless base station can be reached (password login needs the user set in Raspberry Pi Imager).
  systemctl enable ssh 2>/dev/null || true
fi

# ── go ───────────────────────────────────────────────────────────────────────
sysd daemon-reload
sysd enable rpi-alert.service rpi-alert-boot-config.service rpi-alert-access.timer
if [ "$IMAGE" = 0 ]; then
  udevadm control --reload-rules 2>/dev/null || true
  udevadm trigger --subsystem-match=usb --subsystem-match=tty 2>/dev/null || true
  # Let go of any RTL-SDR the TV driver already holds (the blacklist covers the next boot).
  for m in dvb_usb_rtl28xxu rtl2832_sdr rtl2832 rtl2830 r820t; do modprobe -r "$m" 2>/dev/null || true; done
  systemctl restart rpi-alert.service
  systemctl start rpi-alert-access.timer 2>/dev/null || true
  sleep 2
  host=$(hostname)
  ip4=$(hostname -I 2>/dev/null | awk '{print $1}')
  [ -n "$ip4" ] || ip4="this-pi's-address"
  say "RPi ALERT is $([ "$UPGRADE" = 1 ] && echo upgraded and running || echo running)."
  echo "    Dashboard:  http://${host}.local/   (or http://${ip4}/)"
  echo "    Set up:     rpi-alert setup      Status: rpi-alert status"
  [ "$WATCHDOG" = 1 ] && echo "    The hardware watchdog takes effect at the next reboot."
fi
exit 0
