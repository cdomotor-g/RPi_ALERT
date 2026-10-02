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
- **Several channels on one stick** — at 960 ksps a stick sees ±480 kHz; several AlertDsp channels
  could run off one stream.
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
- **Remote fleet view**: MegaNet already records each receiver's reports; an admin page there could
  show every RPi ALERT base station's health.
- **Cellular backhaul**: a USB LTE modem through NetworkManager/ModemManager (the udev rules already
  keep ModemManager off the receivers).
- **UPS HAT / Pi 5 RTC** status on the dashboard.
- **HTTPS** for the web page (self-signed, or via MegaNet).

## MegaNet side

- A `path` prefix of its own (`rpi-alert/`) for Pi receivers, if MegaNet wants to tell them apart
  from browsers at a glance (today they share `serial-monitor/`, which MegaNet's joins and checks
  expect; `detail.app = "RPi ALERT"` already tells them apart).
- An "ingest point" page in MegaNet listing base stations, their receivers and last report.
