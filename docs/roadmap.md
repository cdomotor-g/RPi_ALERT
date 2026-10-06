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

## Operating

- **One-click updates** from the web page (today: *Check for updates* on the page, `sudo rpi-alert-update` over SSH).
- **Read-only root file system** (overlayfs) for sites with unreliable power — SD cards fail when
  written to as power drops. Raspberry Pi OS has it in `raspi-config`; the queue would move to a
  small writable partition.
- **GPS-disciplined time with chrony** (PPS where the GPS has it) instead of the agent's own setting
  of the clock.
- **systemd watchdog for the agent** (the code is there; the unit leaves it off until it has run on
  hardware).
- **Remote management, further** (the Base Stations tab and SSH access are done, in 0.7 —
  [remote-management.md](remote-management.md), [access.md](access.md)): per-station team keys
  rather than one list for the fleet; an alert when a base station goes quiet; SSH certificates
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
