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
  USB port, levels and spectrum (RTL-SDR), fix (GPS); a *Restart* button each, and *Remove* for one
  that is unplugged.
- **Settings** — MegaNet, location, RTL-SDR (the settings every stick shares, and each stick's
  own), serial devices, audio, screen, network (Wi-Fi scan and join, hostname), web password, time
  zone, restart/reboot/shut down, update check.

**Several RTL-SDR sticks.** Each stick is a receiver of its own, with its own MegaNet receiver id
(`rpi-<host>-sdr1`, `-sdr2`, …) and name (*RTL-SDR*, *RTL-SDR 2*, …, numbered in USB port order).
Under **Settings → RTL-SDR → Each stick**, any stick can have its own name, frequency, frame format,
gain, ppm, squelch and bias tee, or be turned off; a blank field is the shared setting above it. So
one Pi can listen to two networks at once — or one channel in both ALERT Binary and Enhanced
iFLOWS, a stick each. Changing one stick's frequency, gain, ppm or bias tee restarts only that
stick's `rtl_sdr`; a format or squelch change does not restart anything.

Most sticks share one serial number (`00000001`), so sticks are told apart by the **USB port** they
are in: keep each in its port and it keeps its name, settings and receiver id, across replugs and
reboots, whatever else is plugged in. (A stick plugged into another port takes the place of a stick
like it that is missing — the one seen last — so a stick moved on its own keeps who it is. A stick
with a serial of its own is recognised in any port.)
A stick that is unplugged stays listed, as *unplugged*, with when it was last seen, until it comes
back or you press **Remove** — which forgets its name, its own settings and its receiver id; plugged
in again, it is found as a new receiver.
- **Log** — the agent's log, live.

**Getting the token.** *Request a token* (Settings → MegaNet, or the banner while there is none)
makes a token on the Pi and asks MegaNet to approve it; the Pi shows a code and a QR code, an
administrator signed in to MegaNet anywhere approves the request on MegaNet's **Admin** tab →
**Ingest tokens**, and the token is saved by itself. The token being asked about waits in
`/var/lib/rpi-alert/token-request.json` (0600) so a restart carries on asking; it becomes
`meganet.token` only once approved. Pasting a token still works.

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
rpi-alert request-token          ask MegaNet for the token: a code and a QR code, approved by an
                                 administrator on MegaNet's Admin tab (--cancel stops asking)
rpi-alert token [mgn_…]          check a token against MegaNet and save it
rpi-alert config get [key]       e.g. rpi-alert config get receivers.sdr
rpi-alert config set key value   e.g. rpi-alert config set receivers.sdr.freqHz 151525000
rpi-alert sdr                    the RTL-SDR sticks: number, name, channel, USB port, state
rpi-alert sdr 2 freq 151.525     one stick's own setting: freq (MHz), format, gain (dB or auto),
                                 ppm, squelch, bias-tee, name — "shared" goes back to the shared
                                 one; rpi-alert sdr 2 off / on. A stick by number, name or USB port
rpi-alert sdr remove 3           forget an unplugged stick (name, settings, receiver id)
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
| `request_token` | yes / no | `meganet.autoRequest` — with no token, ask MegaNet for one at boot and keep asking until an administrator approves it |
| `name` | text | `name` — what MegaNet calls this base station |
| `latitude`, `longitude` | decimal degrees | `location` (approximate) |
| `location_station` (+ `location_station_name`) | MegaNet station id, with `latitude`/`longitude` | `location.source = station` |
| `use_gps` | yes / no | `location.useGps` |
| `gps_bluetooth` | Bluetooth address, or off | a Bluetooth GPS (an Emlid Reach set to *Position output → Bluetooth, NMEA*): Bluetooth turned on, the receiver paired and kept connected by `rpi-alert-btgps.service`, read as `/dev/rpi-alert-gps` (added to `receivers.extraPorts`); turns `location.useGps` on unless `use_gps` says otherwise. For a mobile unit |
| `gps_bluetooth_pin` | e.g. 123456 | the PIN the receiver asks for when pairing (Emlid's default is 123456) |
| `gps_bluetooth_channel` | 1–30 | its serial channel, if not 1 (else 1 to 10 are tried) |
| `sdr_frequency_mhz` | e.g. 151.5 | `receivers.sdr.freqHz` |
| `sdr_format` | binary / enhanced_iflows / ascii | `receivers.sdr.format` |
| `sdr_gain_db` | dB, or auto | `receivers.sdr.gainDb` |
| `sdr_ppm`, `sdr_sample_rate`, `sdr_bias_tee`, `sdr_squelch_db`, `sdr` (on/off) | | `receivers.sdr.*` — every stick's; a stick's own settings are made once it has been plugged in (web page, or `rpi-alert sdr`) |
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
| `auto_update` | on / off | install new releases nightly, 3–4 am (off by default) |
| `update` | now | install the latest release once, at this boot |

## `config.json` reference

| Key | Default | Meaning |
|---|---|---|
| `name` | `RPi ALERT <hostname>` | Base station name; each receiver reports as "name — receiver" |
| `meganet.enabled` | true | Send to MegaNet at all |
| `meganet.token` | — | The ingest token |
| `meganet.autoRequest` | false | With no token, ask MegaNet for one by itself and keep a request open (a new one each time one runs out). Turns itself off once a token is approved, when an administrator turns a request down, or on *Stop asking* |
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
| `receivers.sdrDevices[]` | — | Each stick's own settings: `{ key, name, enabled, freqHz, format, gainDb, ppm, biasTee, squelchDb }`, `key` being the stick's as the Receivers page and `rpi-alert sdr` show it (`sdr-serial:00000001`, `sdr-port:1-1.4`); a setting left out is the shared one. Entries 0.4 wrote by `{ serial }` alone still apply, to every stick with that serial |
| `audio.enabled`, `audio.mode`, `audio.device`, `audio.volume` | true, auto, default, 80 | The chirps |
| `web.port` | 80 | The dashboard (8080 if 80 is refused) |
| `kiosk.mode` | auto | auto: full-screen dashboard while a monitor is connected and the Pi has ≥ 900 MB |
| `system.timezone` | — | Set from the page; ALERT2 frame times are local |

Environment variables (for development and tests): `RPI_ALERT_CONFIG`, `RPI_ALERT_DATA`,
`RPI_ALERT_DEV`, `RPI_ALERT_SYSFS`, `RPI_ALERT_PRIV`, `RPI_ALERT_ASSUME_CLOCK=1`,
`RPI_ALERT_LOG_LEVEL=debug`, `RPI_ALERT_PORT` (the CLI).
