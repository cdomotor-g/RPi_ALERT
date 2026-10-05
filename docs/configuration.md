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
  own), serial devices, audio, screen, network (Wi-Fi scan and join, hostname), web password,
  remote management (what MegaNet's Base Stations tab may do, and what it last asked), SSH access
  (the `alert` account, its keys and where each came from, password login, MegaNet's team keys),
  time zone, restart/reboot/shut down, update check.

**Several channels on one stick.** One stick decodes every channel in a stretch of the band about
1.9 MHz wide, all at the same time. Under **Settings → RTL-SDR**, *Frequency* is the stick's own
channel and *More channels on the same stick* the others — `151.525, 151.95, 152.4`, with a format
after any channel sent in another one (`152.4 EIF`). Each channel is a receiver of its own: named for
its frequency (*RTL-SDR · 151.525*), with its own MegaNet receiver id (`rpi-<host>-sdr1-151.525`; the
stick's own channel keeps `rpi-<host>-sdr1`), its own decoder, squelch and counts. The stick's
sample rate goes up by itself to hold them (the setting is the least it uses), and it is tuned so the
DC spike and any mirror image stay off every channel — the Receivers page shows where it is tuned and
a row for each channel. Adding or removing a channel leaves the others alone: they keep their
receiver ids, and are restarted only if the stick had to be tuned elsewhere. Channels too far apart
for one stick are refused, saying which. More: [hardware.md](hardware.md#several-channels-on-one-stick).

**Several RTL-SDR sticks.** Each stick is a receiver of its own, with its own MegaNet receiver id
(`rpi-<host>-sdr1`, `-sdr2`, …) and name (*RTL-SDR*, *RTL-SDR 2*, …, numbered in USB port order).
Under **Settings → RTL-SDR → Each stick**, any stick can have its own name, frequency, more channels,
frame format, gain, ppm, squelch and bias tee, or be turned off; a blank field is the shared setting
above it, and `none` in *More channels* leaves a stick with only its own frequency. So one Pi can
listen to networks further apart than one stick hears. Changing one stick's channels, gain, ppm or
bias tee restarts only that stick's `rtl_sdr` (and only if where it is tuned changes); a format or
squelch change does not restart anything.

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
rpi-alert sdr                    the RTL-SDR sticks: number, name, channels, USB port, state
rpi-alert sdr 1                  one stick: where it is tuned, and each channel with its receiver id
rpi-alert sdr 2 freq 151.525     one stick's own setting: freq (MHz), format, gain (dB or auto),
                                 ppm, squelch, bias-tee, name — "shared" goes back to the shared
                                 one; rpi-alert sdr 2 off / on. A stick by number, name or USB port
rpi-alert sdr 1 freq 151.5, 151.525, 152.4 eif
                                 several channels on one stick, all heard at once (its own first)
rpi-alert sdr 1 channels 151.95  just its more channels ("none" for none, "shared" for the shared)
rpi-alert sdr remove 3           forget an unplugged stick (name, settings, receiver id)
rpi-alert password               the web page password
rpi-alert remote [manage|report|off]   what MegaNet's Base Stations tab may do; how check-ins go
rpi-alert access                 who may log in over SSH (docs/access.md)
sudo rpi-alert access add-key "ssh-ed25519 AAAA… you@laptop"   remove-key <fingerprint> · github <name…>|none
rpi-alert access meganet on|off · from private|any · password-login on|off|unchanged · ssh on|off · sync
sudo rpi-alert access alert-password [--none]   the alert account's password (the console)
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
| `sdr_frequency_mhz` | e.g. 151.5 — or several, `151.5, 151.525, 152.4 eif` | `receivers.sdr.freqHz` (the first); several: also `receivers.sdr.moreChannels` (the rest), all heard by one stick at once |
| `sdr_more_channels_mhz` | e.g. `151.525, 152.4`, or none | `receivers.sdr.moreChannels` alone |
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
| `ssh_key` | `ssh-ed25519 AAAA… you@laptop` | a key that may log in as `alert` — a line each; the card's lines replace the ones before; `none` clears them ([access.md](access.md)) |
| `ssh_github` | names | GitHub accounts whose public keys may log in as `alert`, fetched hourly |
| `ssh_meganet_keys` | yes / no | MegaNet's team keys may log in as `alert` (off by default) |
| `ssh_from` | private / any | where keys fetched from GitHub and MegaNet work from (private networks by default) |
| `ssh_password_login` | on / off | SSH password login (absent: as Raspberry Pi Imager set it) |
| `alert_password` | text, or none | a password for `alert` — the console, and SSH if password login is on; wiped from the card |
| `remote_management` | manage / report / off | `remote.mode`: what MegaNet's Base Stations tab may do ([remote-management.md](remote-management.md)) |
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
| `receivers.sdr.freqHz` | 151500000 | The ALERT channel (a stick's own) |
| `receivers.sdr.moreChannels` | [] | More channels for the same stick to decode at once, each a receiver of its own: `[{ freqHz, format }]`, `format` left out for the stick's own. At most 7, within 1.89 MHz of each other and of `freqHz`; none listed twice |
| `receivers.sdr.format` | BINARY | BINARY · ENHANCED_IFLOWS · ASCII (one per channel: alert-dsp.js explains why) |
| `receivers.sdr.sampleRate` | 0 (auto) | 960000 on a 4-core Pi with ≥ 1 GB, else 240000 — or higher, as much as a stick's channels need (the setting is the least used) |
| `receivers.sdr.offsetHz` | 0 (auto) | One channel: tune this far below it (default rate/4) to keep the DC spike off it. Several are placed by the agent |
| `receivers.sdr.gainDb` | 29.7 | null = tuner AGC |
| `receivers.sdr.ppm`, `biasTee`, `gate`, `squelchDb`, `minVotes`, `minVotesCrc` | 0, false, true, 8, 4, 4 | Tuner correction, bias tee, burst gate and decoder vote bars |
| `receivers.sdrDevices[]` | — | Each stick's own settings: `{ key, name, enabled, freqHz, format, moreChannels, gainDb, ppm, biasTee, squelchDb }`, `key` being the stick's as the Receivers page and `rpi-alert sdr` show it (`sdr-serial:00000001`, `sdr-port:1-1.4`); a setting left out is the shared one (`moreChannels: []` is none). Entries 0.4 wrote by `{ serial }` alone still apply, to every stick with that serial |
| `audio.enabled`, `audio.mode`, `audio.device`, `audio.volume` | true, auto, default, 80 | The chirps |
| `web.port` | 80 | The dashboard (8080 if 80 is refused) |
| `kiosk.mode` | auto | auto: full-screen dashboard while a monitor is connected and the Pi has ≥ 900 MB |
| `system.timezone` | — | Set from the page; ALERT2 frame times are local |
| `remote.mode` | manage | manage · report · off — what MegaNet's Base Stations tab may do. Set only on the Pi: MegaNet cannot change it |
| `remote.idleS` | 60 | How often to check in with MegaNet while nobody has the base station open (30–900 s) |

Environment variables (for development and tests): `RPI_ALERT_CONFIG`, `RPI_ALERT_DATA`,
`RPI_ALERT_DEV`, `RPI_ALERT_SYSFS`, `RPI_ALERT_PRIV`, `RPI_ALERT_ASSUME_CLOCK=1`,
`RPI_ALERT_LOG_LEVEL=debug`, `RPI_ALERT_PORT` (the CLI).
