# Hardware

## Raspberry Pi

| Pi | Image | Notes |
|---|---|---|
| **Pi 4 / 400 / CM4** | 64-bit | The recommended base station: CPU for the SDR decoder at 960 ksps, the screen dashboard, and a 3.5 mm audio jack. Official 15 W (5 V 3 A) supply. |
| Pi 5 / 500 / CM5 | 64-bit | Fastest. **No audio jack**: chirps over HDMI audio or a USB sound card. Official 27 W supply, or USB devices are current-limited. A Pi 5 can keep time across power cuts with its RTC battery (fitted to the J5 header). |
| Pi 3 / 3+ / CM3 | 64-bit | Fine for every receiver; 1 GB is enough for the screen dashboard. 5 V 2.5 A supply. |
| Zero 2 W | 64-bit | 512 MB: no screen dashboard (web page and console only); the SDR runs at 240 ksps. One micro-USB OTG port — use a powered USB hub for more than one receiver. No audio jack. |
| Pi 1 / 2 / Zero / Zero W | 32-bit | Too slow for the RTL-SDR decoder. Fine for a Quansheng radio or an ERT-A2. |

**Power matters more than anything else here.** An under-powered Pi drops USB devices when a
radio transmits or a stick warms up, and that looks exactly like a flaky receiver. The dashboard
shows a red banner and the *Under-voltage* chip when the Pi's firmware reports it
(`vcgencmd get_throttled`). Use the official supply, short cables, and a powered hub for several
receivers. For sites with dirty power, a UPS HAT keeps the Pi up through brownouts.

**SD cards**: an A1/A2-rated card from a known brand, 16 GB+. The agent writes little (the queue
only when it is non-empty, the journal capped at 64 MB). An industrial or high-endurance card is
worth it for a remote site.

## RTL-SDR sticks

Any RTL2832U stick works through `librtlsdr`'s `rtl_sdr`; the agent decodes the IQ with MegaNet's
`alert-dsp.js` (AFSK 1300.8 / 2109.4 Hz, 300 baud, 45 carrier/timing combinations, a vote bar of 4).

| Stick | Tuner | Status |
|---|---|---|
| **RTL-SDR Blog V4** | R828D | Supported by Raspberry Pi OS Trixie's own `librtlsdr0` 2.0.2 (it carries the V4 code: "RTL-SDR Blog V4 Detected"). On Bookworm, whose 0.6 library does not know the V4, the installer builds `rtlsdrblog/rtl-sdr-blog`. This, and the DVB-T kernel driver claiming the stick, are the usual reasons a V4 "does not work out of the box" on Linux — both are handled. **Not yet seen on hardware here.** |
| RTL-SDR Blog V3 | R820T2 | Supported by every librtlsdr. |
| RTL-SDR Blog V2 / generic FC0013 | FC0013 | Known to work on the bench Pi. Zero-IF tuner with a DC spike at the centre: the agent tunes a quarter of the sample rate below the channel, so the spike never lands on a burst. |
| Generic R820T/R820T2 | | Supported. |

Settings that matter: **frequency** (151.5 MHz for the MegaNet networks), **format** (ALERT Binary
for the live networks; Enhanced iFLOWS for an ERT-A2 set to it — one at a time, see
`alert-dsp.js`), **gain** (~30 dB; lower if the ADC clips, which the Receivers page shows),
**ppm** (the stick's frequency error; the decoder searches ±10 kHz so it matters little).

The DVB-T modules (`dvb_usb_rtl28xxu`, `rtl2832`, `rtl2832_sdr`, `rtl2830`, `r820t`) are
blacklisted. Only one program can hold a stick: stop `rtl_tcp`, SDR++ or GQRX while the agent runs.

### Several sticks

Plug in as many as the Pi's CPU and USB power allow — each is a receiver of its own with its own
decoder thread, so a Pi 4 runs a few at 960 ksps (two V4s draw about 0.6 A; use a powered hub
beyond that). Give each its own channel under **Settings → RTL-SDR → Each stick** (or
`rpi-alert sdr 2 freq 151.525`), and one Pi listens to several networks at once.

Most sticks leave the factory with serial `00000001`, so the agent tells them apart by **USB port**:
keep each stick in its port and it keeps its name, its settings and its MegaNet receiver id, however
many others come and go. librtlsdr numbers the sticks itself (`rtl_sdr -d 0, 1, …` — in reverse USB
device-path order, as libusb lists them), and those numbers change as sticks are plugged in and out,
so the agent works out each stick's number when it starts its `rtl_sdr`, then checks the stick it
really opened (the `/dev/bus/usb` node it holds) and reopens the right one if they differ. The
Receivers page shows each stick's port and how it was opened.

To make a stick recognisable in any port, give it a serial of its own — with the agent stopped and
that stick alone plugged in: `sudo systemctl stop rpi-alert; rtl_eeprom -s ALERT1`, then unplug it
and plug it back in. A serial that is a number (like `2`) is read by `rtl_sdr` as a device number,
so use letters (`ALERT1`, `NORTH`). After that it is a new stick to the agent: remove the old one.

## Quansheng UV-K5 V3 / UV-K1 (ALERT receiver firmware)

USB-C straight to the Pi. The port (VID `36B7`, CDC-ACM, `/dev/ttyACM*`) is recognised by its USB id
and spoken to as `docs/ALERT_SERIAL.md` in
[quansheng_alert_v3](https://github.com/cdomotor-g/quansheng_alert_v3) says: DTR asserted (and
toggled after 25 s of silence — the radio stops sending if a send is not collected), `CSV HDR` on
connect, the radio's clock set from the Pi's (`TIME <epoch>`, again hourly), one console command at
a time. Every `DEC` line is a reading (protocol ALERT, format ABF/EIF as the radio reports); `BST`
lines with no frames are logged as undecoded receptions; `STA` gives battery, noise floor, RSSI and
the flash log, shown on the Receivers page. Run the radio's **ALERT app** (F then 0) — records flow
only while it runs.

The K1's speaker/mic jack UART (38400 8N1, through a USB-serial cable) carries the same records but no
console: recognised by its records, no DTR toggling or clock setting.

## Quansheng UV-K5 on the older DP32G030 ALERT firmware

Through a K5 programming cable (USB-serial, 38400 8N1). Its `ALERT,<id>,<value>,<fmt>,<rssi>,<name>`
lines are recognised (the agent hunts for the speed when it sees line noise) and each is a reading.

## ELPRO ERT-A2 (ALERT2)

- **RS-232 port** → a USB-serial adapter (FTDI, CP210x, CH340, PL2303). The unit writes its
  *ALERT2 ASCII* lines at **9600 8N1**: receiver clock in every line, no RSSI. Recognised by the
  `ALERT2A,` tag.
- **USB port** → its binary framing (`ALERT2` sync + TLVs): RSSI in every frame, no receiver clock.

Both are parsed by MegaNet's `alert2.js`. Only frames the receiver calls clean, and their clean
records, are readings (protocol ALERT2), timed by the frame's own time of day put on the nearest
day — unless that is more than ten minutes from the Pi's clock (time zone, drifting network clock),
when arrival time is used and the Receivers page says so. **Set the Pi's time zone** to the network's
(Australia/Brisbane is the image's default). Every record, bad ones included, is a reception.

## USB GPS

Any NMEA 0183 receiver (u-blox pucks, most "USB GPS" dongles; GPIO-UART GPS modules via
`extra_ports = /dev/serial0`). Recognised by its `$GPGGA`/`$GNRMC` sentences. While it has a fix, it
is the base station's location (recorded in MegaNet as exact) and, with no internet, its clock.
`gpsd` is deliberately not used: its hotplug rules grab USB-serial adapters, which would fight the
ERT-A2 for its cable.

## Audio

`aplay` on ALSA's default device (on a Pi 3/4 that is the 3.5 mm jack); choose HDMI or a USB sound
card under **Settings → Audio**. The image keeps `dtparam=audio=on` in `config.txt`.
