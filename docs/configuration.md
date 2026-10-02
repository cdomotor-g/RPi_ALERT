# Configuration

Four ways in, one set of settings (`/etc/rpi-alert/config.json`, owned by the agent's user,
mode 0600 because it holds the ingest token):

| Where | Who it suits |
|---|---|
| **The web page** — `http://rpi-alert.local/` or the Pi's own screen | everyone; every setting is there |
| **`rpi-alert` over SSH** (PuTTY on Windows) | headless, scripted |
| **`rpi-alert.conf`** on the SD card's boot partition | setting a card up before the Pi ever boots |
| editing `config.json` | not needed; the others validate what they are given |

## The web page

- **Dashboard** — MegaNet, clock, location, power and temperature at a glance; each receiver's
  state; the bursts of the last 30 minutes; readings as they arrive (protocol, format, address,
  station, value in engineering units, signal, receiver).
- **Receivers** — everything known about each device: port, USB ids, speed, how it was recognised,
  firmware, battery and noise floor (Quansheng), wire format and receiver clock (ERT-A2), tuner,
  levels and spectrum (RTL-SDR), fix (GPS); a *Restart* button each.
- **Settings** — MegaNet, location, RTL-SDR, serial devices, audio, screen, network (Wi-Fi scan and
  join, hostname), web password, time zone, restart/reboot/shut down, update check.
- **Log** — the agent's log, live.

**Who may change settings.** The Pi's own screen and the `rpi-alert` command (both on the Pi
itself) always may. From other computers: anyone, until a web password is set — the page says so
in a banner — then only someone who has logged in. The ingest token is never sent back out, to
anyone; the page shows `mgn_ab…wxyz`. Where a receiver is (it may be someone's house) is hidden
from visitors who are not logged in.

## The command line

```
rpi-alert status                 receivers, MegaNet, clock, location, latest readings
rpi-alert top                    the same, live
rpi-alert setup                  questions for the essentials
rpi-alert token [mgn_…]          check a token against MegaNet and save it
rpi-alert config get [key]       e.g. rpi-alert config get receivers.sdr
rpi-alert config set key value   e.g. rpi-alert config set receivers.sdr.freqHz 151525000
rpi-alert password               the web page password
rpi-alert readings [n] · log [n] · test-audio [alert|alert2|beep] · send-now · version
sudo journalctl -u rpi-alert -f  the full log
sudo systemctl restart rpi-alert
```

## The boot-partition file (`rpi-alert.conf`)

`key = value` lines, `#` comments; applied at every boot in which the file is present, then
renamed `rpi-alert.conf.applied` with secrets blanked; results in `rpi-alert-boot.log`.
Example with every key: [os/boot/rpi-alert.conf.example](../os/boot/rpi-alert.conf.example).

| Key | Value | Setting |
|---|---|---|
| `token` | `mgn_…` | `meganet.token` |
| `name` | text | `name` — what MegaNet calls this base station |
| `latitude`, `longitude` | decimal degrees | `location` (approximate) |
| `location_station` (+ `location_station_name`) | MegaNet station id, with `latitude`/`longitude` | `location.source = station` |
| `use_gps` | yes / no | `location.useGps` |
| `sdr_frequency_mhz` | e.g. 151.5 | `receivers.sdr.freqHz` |
| `sdr_format` | binary / enhanced_iflows / ascii | `receivers.sdr.format` |
| `sdr_gain_db` | dB, or auto | `receivers.sdr.gainDb` |
| `sdr_ppm`, `sdr_sample_rate`, `sdr_bias_tee`, `sdr_squelch_db`, `sdr` (on/off) | | `receivers.sdr.*` |
| `auto_detect` | yes / no | `receivers.autoDetect` |
| `extra_ports` | e.g. /dev/serial0 | `receivers.extraPorts` (a GPIO-UART GPS, say) |
| `audio` | auto / live / synth / beep / off | `audio.mode` |
| `audio_device`, `audio_volume` | ALSA name; 0–100 | `audio.*` |
| `kiosk` | auto / on / off | `kiosk.mode` |
| `web_password` | text | stored hashed (scrypt) |
| `meganet`, `send_receptions` | yes / no | `meganet.enabled`, `meganet.receptions` |
| `timezone` | e.g. Australia/Brisbane | system time zone |
| `hostname` | e.g. mt-stuart-base | system hostname (after a reboot) |
| `wifi_ssid`, `wifi_password`, `wifi_country` | | a NetworkManager connection `rpi-alert-wifi` |
| `ssh` | on / off | the SSH service |

## `config.json` reference

| Key | Default | Meaning |
|---|---|---|
| `name` | `RPi ALERT <hostname>` | Base station name; each receiver reports as "name — receiver" |
| `meganet.enabled` | true | Send to MegaNet at all |
| `meganet.token` | — | The ingest token |
| `meganet.endpoints` | floodwarning.net `/api/db` proxy, then the Supabase project | Tried in order; the one that works is remembered |
| `meganet.receptions` | true | Also post every frame heard to `report_receptions` (Reception Map) |
| `meganet.stationsUrls` | floodwarning.net, then GitHub Pages `stations.json` | The register used to name stations (daily, cached) |
| `location.source` | none | none · manual · station · gps (GPS only) |
| `location.lat/lon/accuracy_m/station/stationName` | — | The fixed location |
| `location.useGps` | true | A GPS fix, when there is one, is used instead |
| `receivers.autoDetect` | true | Recognise serial devices from what they send |
| `receivers.ports[]` | — | Per-port overrides: `{ match, type: auto/quansheng/ert-a2/gps/ignore, baud, name }`; `match` is a `/dev/serial/by-id/…` path, a `/dev` name or `vvvv:pppp` |
| `receivers.extraPorts[]` | — | Non-USB ports to scan too |
| `receivers.sdr.enabled` | true | Use RTL-SDR sticks |
| `receivers.sdr.freqHz` | 151500000 | The ALERT channel |
| `receivers.sdr.format` | BINARY | BINARY · ENHANCED_IFLOWS · ASCII (one at a time: alert-dsp.js explains why) |
| `receivers.sdr.sampleRate` | 0 (auto) | 960000 on a 4-core Pi with ≥ 1 GB, else 240000 |
| `receivers.sdr.offsetHz` | 0 (auto) | Tune this far below the channel (default rate/4) to keep the DC spike off it |
| `receivers.sdr.gainDb` | 29.7 | null = tuner AGC |
| `receivers.sdr.ppm`, `biasTee`, `gate`, `squelchDb`, `minVotes`, `minVotesCrc` | 0, false, true, 8, 4, 4 | Tuner correction, bias tee, burst gate and decoder vote bars |
| `receivers.sdrDevices[]` | — | Per-stick overrides by USB serial: `{ serial, name, freqHz, format, gainDb, enabled }` |
| `audio.enabled`, `audio.mode`, `audio.device`, `audio.volume` | true, auto, default, 80 | The chirps |
| `web.port` | 80 | The dashboard (8080 if 80 is refused) |
| `kiosk.mode` | auto | auto: full-screen dashboard while a monitor is connected and the Pi has ≥ 900 MB |
| `system.timezone` | — | Set from the page; ALERT2 frame times are local |

Environment variables (for development and tests): `RPI_ALERT_CONFIG`, `RPI_ALERT_DATA`,
`RPI_ALERT_DEV`, `RPI_ALERT_SYSFS`, `RPI_ALERT_PRIV`, `RPI_ALERT_ASSUME_CLOCK=1`,
`RPI_ALERT_LOG_LEVEL=debug`, `RPI_ALERT_PORT` (the CLI).
