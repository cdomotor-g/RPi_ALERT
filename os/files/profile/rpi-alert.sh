# shellcheck shell=sh
# RPi ALERT: a one-line reminder at an interactive login (SSH or console).
case $- in *i*)
if command -v rpi-alert >/dev/null 2>&1; then
  printf '\n  RPi ALERT — %s   status: rpi-alert status   live: rpi-alert top   set up: rpi-alert setup\n\n' "$(hostname).local"
fi
;; esac
