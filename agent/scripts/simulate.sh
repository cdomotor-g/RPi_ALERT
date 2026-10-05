#!/bin/bash
# A whole simulated base station on a development machine — no Pi, no radios:
#   * a Quansheng ALERT radio, an ERT-A2 and a GPS on socat pseudo-terminals,
#   * RTL-SDR Blog V4 sticks (fake sysfs entries and test/helpers/fake-rtl_sdr),
#     all with serial 00000001, as real ones come: the first hears a station
#     on 151.5 MHz, each other one another station 100 kHz further up — give it
#     that channel under Settings → RTL-SDR → Each stick,
#   * a MegaNet stand-in on :8098 that prints what it receives.
# The agent's dashboard is then on http://localhost:8099/.  Ctrl+C stops it all.
#
#   agent/scripts/simulate.sh [sticks]   (1–4 RTL-SDR sticks, default 1; needs node and socat)
set -euo pipefail
A="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
n_sdr=${1:-1}
[[ "$n_sdr" =~ ^[1-4]$ ]] || { echo "usage: simulate.sh [1-4]" >&2; exit 2; }
S=$(mktemp -d "${TMPDIR:-/tmp}/rpi-alert-sim.XXXXXX")
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$S"; }
trap cleanup EXIT INT TERM
command -v socat >/dev/null || { echo "install socat first (apt install socat)" >&2; exit 1; }

mkdir -p "$S/dev" "$S/data" "$S/etc" "$S/bin"
fake='{"1-1.3": {"frames": "2088:143,2089:12"}'
for ((i = 1; i <= n_sdr; i++)); do
  port="1-1.$((i + 2))"; d="$S/sys/bus/usb/devices/$port"
  mkdir -p "$d"
  echo 0bda > "$d/idVendor"; echo 2838 > "$d/idProduct"; echo 00000001 > "$d/serial"; echo RTLSDRBlog > "$d/manufacturer"; echo "Blog V4" > "$d/product"; echo 1 > "$d/busnum"; echo $((i + 3)) > "$d/devnum"
  if (( i > 1 )); then fake+=", \"$port\": {\"channelHz\": $((151500000 + (i - 1) * 100000)), \"frames\": \"$((3000 + i)):77\"}"; fi
done
fake+='}'
ln -s "$A/test/helpers/fake-rtl_sdr" "$S/bin/rtl_sdr"
printf '#!/bin/sh\ncat > /dev/null\n' > "$S/bin/aplay"; chmod +x "$S/bin/aplay"
for n in 0 1 2; do socat "pty,raw,echo=0,link=$S/dev/ttyUSB$n" "pty,raw,echo=0,link=$S/peer$n" & pids+=($!); done
sleep 1
cat > "$S/etc/config.json" <<JSON
{ "name": "Simulated base", "web": { "port": 8099 },
  "meganet": { "token": "mgn_test_token", "endpoints": ["http://127.0.0.1:8098/rest/v1"], "stationsUrls": ["http://127.0.0.1:8098/stations.json"] },
  "location": { "source": "manual", "lat": -27.4698, "lon": 153.0251, "useGps": true } }
JSON
node "$A/test/helpers/meganet-stub.js" 8098 & pids+=($!)
PATH="$S/bin:$PATH" RPI_ALERT_CONFIG="$S/etc/config.json" RPI_ALERT_DATA="$S/data" RPI_ALERT_DEV="$S/dev" RPI_ALERT_SYSFS="$S/sys" \
  RPI_ALERT_ASSUME_CLOCK=1 RPI_ALERT_PRIV=/nonexistent RPI_ALERT_FAKE_STICKS="$fake" node "$A/bin/rpi-alert" daemon & pids+=($!)

nmea() { local body="$1" c=0 j; for ((j = 0; j < ${#body}; j++)); do c=$(( c ^ $(printf '%d' "'${body:$j:1}") )); done; printf '$%s*%02X\r\n' "$body" "$c"; }
sleep 2
printf 'HDR,fw,4d06107f,schema,2\r\n' > "$S/peer0"
echo "Dashboard: http://localhost:8099/   CLI: RPI_ALERT_PORT=8099 $A/bin/rpi-alert status"
if (( n_sdr > 1 )); then echo "RTL-SDR 2 hears a station on 151.6 MHz: give it that channel under Settings → RTL-SDR, or: RPI_ALERT_PORT=8099 $A/bin/rpi-alert sdr 2 freq 151.6"; fi
k=0
while true; do
  printf 'STA,,%d,-121,-124,0,7890,78,%d,%d,-104,OK,1045,5969,BUILTIN MegaNet:95f6f8d\r\n' $((k * 10000)) "$k" "$k" > "$S/peer0"
  if (( k % 2 == 0 )); then
    printf 'DEC,%d,,%d,12,6129,LOUDOUN BR,LVL,%d,%d,,ABF,NEG,0,0,-%d,-121,-109,40,412,16067B23,0\r\n' "$k" $((k * 10000)) $((1590 + k)) $((1590 + k)) $((60 + k % 20)) > "$S/peer0"
  fi
  if (( k % 3 == 1 )); then
    printf 'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,28,32.582,0,0,0,0,0,1,0,0,0,7,11,9999,74,69,20,2D,13,8A,00,2C,13,0C,00\r\n' > "$S/peer1"
  fi
  nmea 'GPGGA,123519,2727.000,S,15301.500,E,1,08,0.9,545.4,M,46.9,M,,' > "$S/peer2"
  k=$((k + 1))
  sleep 5 & wait $!   # so Ctrl+C stops everything at once
done
