# Roadmap

What is done is in the [README](../README.md). Next, roughly in order of value:

## Needs hardware (the bench Pi)

- **First run on the bench Pi** — [bench-test.md](bench-test.md): V2 stick off air, then the V4,
  a Quansheng radio, an ERT-A2; unplug/replug and power-cut recovery; the kiosk on a monitor; the
  audio jack.
- **RTL-SDR Blog V4 confirmed** on Trixie's librtlsdr (and on Bookworm with the rtl-sdr-blog build).
  If it needs more than that, the fallback is MegaNet's own `rtlsdr.js` driven through node-usb,
  which already opens the V4 in Chrome.
- **A second off-air regression vector**: capture a good 151.5 MHz ALERT Binary burst on the bench
  (`rtl_sdr -f 151.26e6 -s 960000 …`) and add it to the tests beside the 4078 rig's.

## First run, the dashboard and the command line

From a review of the set-up page, the dashboard and the CLI (2026-10-07), roughly in order of how
badly each one strands somebody:

- **The headless dead end.** A Pi with no screen, no SSH and no `web_password` on the card makes a
  password of its own and shows it only on the Pi itself (`web-password.js`), so a laptop on the
  network meets a login with no way in. Any one of three fixes unsticks it: write a status file to
  the boot partition once the Pi is up (address, hostname, pairing code, where the password is
  shown); say in the login dialog that `web_password=` on the card sets it; and a captive portal on
  the hotspot, so a phone that joins **RPi-ALERT-…** is taken to the dashboard instead of having to
  know `http://10.42.0.1/`.
- **A dashboard that goes stale and stays stale.** The page updates only over its event stream, and
  the server refuses a stream past 24 in all or 6 from one address with a 503 — after which
  `EventSource` never retries and the page sits on "reconnecting…". Fall back to polling
  `/api/status` when the stream fails. Separately, the page reloads itself after an update only when
  its own Settings started it, so a kiosk keeps running the old page after a nightly or remote
  update: reload when the agent's version changes.
- **Health it collects and does not show.** Disk, load, memory and throttling go to MegaNet in the
  heartbeat but only temperature and under-voltage are on the page. Show them; add a network chip
  that says in words whether there is a link, an address, a route and the internet, instead of the
  Network card's raw `nmcli` output; and split "Could not reach MegaNet" into DNS, route, TLS (often
  a wrong clock) and refused.
- **A support bundle.** One button (and a CLI verb) that downloads the recent journal, the status,
  and the settings with the token, passwords and keys taken out — instead of
  [bench-test.md](bench-test.md)'s `journalctl > file` — plus search and a level filter on the Log
  page. MegaNet's Base Stations tab could fetch the same bundle (see *MegaNet side*).
- **Confirm the actions that can cut you off.** Joining a Wi-Fi network (it can drop the session you
  are using), hotspot *Always on* (it takes the Wi-Fi radio), *Request a new token* while the current
  one works, turning sending or remote management off, and a receiver's *Restart* are one click
  today. A hostname change needs a reboot and does not offer one. Rescan, Test audio and Restart say
  nothing when they finish.
- **Passwords typed where they show.** The Wi-Fi password is typed into the browser's `prompt()`, in
  clear (`agent/web/app.js`): make it a password field in a dialog. `rpi-alert password` echoes what
  is typed while `rpi-alert access alert-password` hides it: hide both.
- **The set-up page's missing keys.** The card file takes the hotspot's name and password, ppm and
  bias tee, `auto_update`, `ssh_from`, `alert_password` and the survey keys (`bootconf.js`), and
  the page writes none of them. Add them under an *Advanced* fold, let the page open an existing
  `rpi-alert.conf` to edit it, and make the web password a step rather than a "recommended" aside.
- **Accessibility.** The status chips are a polite live region rebuilt every 2 s with "· 5 s ago" in
  it, so a screen reader announces them continuously: announce changes of state only. The tabs
  want `tabpanel` and arrow keys; the spectrum and burst plots want axes and a text alternative.
- **The command line.** Per-command `--help` (`rpi-alert sdr --help` reads `--help` as a stick's
  name today); a non-zero exit on an unknown command; `status --json` documented; and the page's
  verbs it lacks — reboot, restart or rescan a receiver, network and Wi-Fi, and updates without
  `sudo rpi-alert-update`.

## Receiving

- **ALERT2 off the air with an RTL-SDR** — today ALERT2 needs an ERT-A2. A 4800 bps ALERT2 demodulator
  in the SDR worker would let one stick hear both protocols.
- **Both ALERT formats from one stick** — alert-dsp.js decodes one frame format at a time because a
  strong Binary burst makes CRC-valid Enhanced iFLOWS ghosts. A per-burst decision (try Binary, and
  Enhanced iFLOWS only when Binary finds nothing) could make the format setting unnecessary.
- **A channeliser shared by a stick's channels** — each channel's decoder thread converts and
  filters the stick's whole stream on its own (one stick, several channels, is done: see
  [hardware.md](hardware.md#several-channels-on-one-stick)). If the bench Pi shows CPU is what limits
  the channels a Pi can take, one thread per stick could convert the samples and cut out every
  channel once (a polyphase filter bank), handing each decoder its own 240 ksps stream — a change to
  MegaNet's `alert-dsp.js` first, so the website gains it too.
- **Quansheng "rejected" receptions** — re-decode each `BST` line's bits (`Quansheng.scanBurst`) and log
  frames the radio heard but did not report, as MegaNet's Serial Monitor does.
- **Upload MegaNet's station table to a Quansheng radio** from the Receivers page
  (`Quansheng.buildStationTable` + `uploadCommands`, already in the vendored codec).

## Seeing what the radio hears

- **Decode history per channel.** The Receivers page's bursts, decodes and floor are counted since
  the agent started and lost on a restart; keep hourly counts on disk and draw a day of them, so
  "this channel went quiet at 3 a.m." is on the page.
- **A spectrum you can read.** The 1 s max-hold line has no axes: give it frequency and level axes,
  mark the channels, and add a waterfall of the last few minutes.
- **Tuning help.** `alert-dsp.js`'s `carrierSearch` already measures each burst's carrier offset.
  Averaged over the stations a stick hears, it is the stick's own ppm error, so the page can suggest
  the ppm to set; clipping is warned about today, so suggest the gain that stops it too. The same
  offsets per station are MegaNet's transmitter-drift finding (*MegaNet side*).
- **Record the next N seconds.** A button (and a CLI verb) that saves a stick's IQ or demodulated
  audio for a bad station, without stopping the agent and running `rtl_sdr` by hand as
  [bench-test.md](bench-test.md) does.
- **A readings table you can search.** Filter by station, channel or receiver; keep the last day
  across a restart (today it is the last 500, in memory); a sparkline per station.
- **Listen from a phone.** Play each burst's audio in the browser, for a Pi with no speaker — the
  clips the speaker plays already exist (`audio.js`).
- **Survey export on the Pi.** The Survey page's tally as CSV and KML, for a site with no network to
  send it from.

## Operating

- **Updates you can see coming, and undo.** Installing from the page exists (Settings → *Check for
  updates* → *Install*). Missing: an *update available* badge that appears on its own (the Install
  button shows today only when the check's message matches `/is available/`), the release notes
  before installing, a *go back to the previous version* button beside the automatic two-minute
  rollback, and a channel or pinned version settable from MegaNet, so a fleet takes a release a few
  Pis at a time (`update.install` takes no version today).
- **Sign the releases** — *needs a person.* `os/release-signing-key.pem` is still the placeholder, so
  `rpi-alert-update` installs releases as root without verifying them. Make the key pair, set the
  `RELEASE_SIGNING_KEY` repository secret and commit the public key, in the order
  [release-signing.md](release-signing.md) gives.
- **Settings backup, and an identity that survives a new card.** Export the settings as an
  `rpi-alert.conf` (secrets left out, or asked for) and import one. The host id is derived from
  `/etc/machine-id` (`state.js`), so a replacement card gives every receiver a new MegaNet ingest
  point and splits its history: let the card file carry the id.
- **Read-only root file system** (overlayfs) for sites with unreliable power — SD cards fail when
  written to as power drops. Raspberry Pi OS has it in `raspi-config`; the queue would move to a
  small writable partition.
- **GPS-disciplined time with chrony** (PPS where the GPS has it) instead of the agent's own setting
  of the clock.
- **systemd watchdog for the agent** (the code is there; the unit leaves it off until it has run on
  hardware).
- **Remote management, further** (the Base Stations tab and SSH access are done, in 0.7 —
  [remote-management.md](remote-management.md), [access.md](access.md)): per-station team keys
  rather than one list for the fleet; an alert when a base station goes quiet (now MegaNet's
  [EPIC #214](https://github.com/cdomotor-g/MegaNet/issues/214)); SSH certificates
  signed by MegaNet for short-lived access, if the key lists ever grow unwieldy.
- **Cellular backhaul**: a USB LTE modem through NetworkManager/ModemManager (the udev rules already
  keep ModemManager off the receivers).
- **UPS HAT** status on the dashboard. (A battery RTC — a Pi 5's, or an RTC board — is used and shown
  since 0.9: the clock trusts it once NTP or a GPS has vouched for it, [survey.md](survey.md).)
- **Timing a power-up that never learnt the time**, after the fact: what a survey heard in it carries
  its monotonic times, and the network's own readings of the same stations, at the same values, say
  when that was — a match of a dozen frames at one consistent offset would place the lot, where today
  they are dropped.
- **HTTPS** for the web page (self-signed, or via MegaNet).

## MegaNet side

- A `path` prefix of its own (`rpi-alert/`) for Pi receivers, if MegaNet wants to tell them apart
  from browsers at a glance (today they share `serial-monitor/`, which MegaNet's joins and checks
  expect; `detail.app = "RPi ALERT"` already tells them apart).
- ~~An "ingest point" page in MegaNet listing base stations, their receivers and last report.~~
  Done: MegaNet's Base Stations tab (0049).
- **The carrier offset with each reading** heard by an SDR, the way `freq_mhz` and `snr_db` travel
  since MegaNet's `0050`, for MegaNet's transmitter-drift finding
  ([MegaNet #217](https://github.com/cdomotor-g/MegaNet/issues/217)).
- **A burst heard by two receivers.** MegaNet drops a duplicate on address + `reading_ts` + raw
  value, and a legacy ALERT reading's `reading_ts` is this agent's arrival time to the millisecond,
  so two sticks or channels hearing one burst are probably stored twice
  ([MegaNet #232](https://github.com/cdomotor-g/MegaNet/issues/232), which measures it first).
  [how-it-works.md](how-it-works.md) says such a reading is stored once and [survey.md](survey.md)
  says no two receivers time a burst the same; once #232 settles it, make both say what is true.
- **A support bundle from the Base Stations tab**: a remote verb returning the bundle above, under
  the same rules as the other verbs — never the token, a password or a key.
- **A receiver that runs but hears nothing** is MegaNet's to notice
  ([MegaNet #215](https://github.com/cdomotor-g/MegaNet/issues/215)), from what the heartbeat already
  sends — each receiver's decodes and the seconds since it last sent anything. Nothing changes here
  unless that turns out not to be enough.
