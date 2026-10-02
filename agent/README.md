# The RPi ALERT agent

One Node.js process (`bin/rpi-alert daemon`, run by `rpi-alert.service`) that finds the receivers
plugged into the Pi, decodes what they hear with MegaNet's own decoders, and posts it to MegaNet.
No npm dependencies — Node's standard library, `stty`, `rtl_sdr` and `aplay`.

```
bin/rpi-alert              daemon + CLI
lib/agent.js               wiring: devices → time → name → show/play → uplink; location; kiosk
lib/meganet-codecs.js      loads vendor/meganet/* (two of them in a V8 context of their own)
lib/devices/manager.js     sysfs scan every 2 s; port sessions (open, identify, reconnect); SDR sessions
lib/devices/sniff.js       what a port is, from what it sends; baud hunting on line noise
lib/devices/quansheng.js   ALERT firmware (schema 2 + legacy lines): DTR, clock, console
lib/devices/ert.js         ERT-A2: ALERT2 ASCII and USB binary
lib/devices/gps.js         NMEA fix and time
lib/devices/sdr.js         rtl_sdr supervisor;  sdr-worker.js: AlertDsp.Pipeline in a worker thread
lib/serial/port.js         a serial port with no native module (non-blocking fd + stty)
lib/serial/scan.js         ports, USB ids and RTL-SDR sticks from sysfs
lib/uplink.js, meganet.js  the queue on disk; ingest_http / report_ingest_point / report_receptions
lib/token-request.js       asking MegaNet for the token: a code, approved on MegaNet's Admin tab (0048)
lib/clock.js               is the time trustworthy (NTP, GPS); monotonic holding
lib/stations.js            MegaNet's register, for names
lib/audio.js               live SDR audio, re-synthesised bursts, beeps — via aplay
lib/bootconf.js            /boot/firmware/rpi-alert.conf
lib/web/server.js, web/    the dashboard, API and SSE; web/qr.js draws QR codes (page and CLI)
```

## Running it on a development machine

```sh
node --test test/*.test.js      # all tests (pty/end-to-end ones need socat)
scripts/simulate.sh             # simulated receivers + MegaNet stand-in; dashboard on :8099
```

Or by hand, against your own config and data directories:

```sh
RPI_ALERT_CONFIG=/tmp/ra/config.json RPI_ALERT_DATA=/tmp/ra RPI_ALERT_ASSUME_CLOCK=1 node bin/rpi-alert daemon
RPI_ALERT_PORT=8080 node bin/rpi-alert status
```

## The vendored decoders

`vendor/meganet/` is byte-for-byte MegaNet (`SOURCE` names the commit). Change them in MegaNet,
then `scripts/sync-meganet.sh` — it copies them, records the commit and runs the tests, which hold
them to the same vectors MegaNet does (the 4078 test rig's real off-air burst among them).
