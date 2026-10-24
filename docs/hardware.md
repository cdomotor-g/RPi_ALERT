# Hardware

## Raspberry Pi

| Pi | Image | Notes |
|---|---|---|
| **Pi 4 / 400 / CM4** | 64-bit | The recommended base station: CPU for several SDR channels, the screen dashboard, and a 3.5 mm audio jack. Official 15 W (5 V 3 A) supply. No RTC: an RTC board (DS3231, `dtoverlay=i2c-rtc,ds3231`) keeps time across power cuts — for a [site survey](survey.md) with no GPS and no internet. |
| Pi 5 / 500 / CM5 | 64-bit | Fastest. **No audio jack**: chirps over HDMI audio or a USB sound card. Official 27 W supply, or USB devices are current-limited. A Pi 5 can keep time across power cuts with its RTC battery (fitted to the J5 header). |
| Pi 3 / 3+ / CM3 | 64-bit | Fine for every receiver; 1 GB is enough for the screen dashboard. 5 V 2.5 A supply. No RTC: an RTC board (DS3231, `dtoverlay=i2c-rtc,ds3231`) keeps time across power cuts, as on a Pi 4. |
| Zero 2 W | 64-bit | 512 MB: no screen dashboard (web page and console only); a few SDR channels, closest in a 240 kHz window. One micro-USB OTG port — use a powered USB hub for more than one receiver. No audio jack. |
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

Settings that matter: **frequency** (a new base station hears all four of MegaNet's channels —
151.5, 151.525, 151.95 and 152.4 MHz — on one stick: below), **format** (ALERT Binary
for the live networks; Enhanced iFLOWS for an ERT-A2 set to it — one at a time, see
`alert-dsp.js`), **gain** (~30 dB; lower if the ADC clips, which the Overview shows),
**ppm** (the stick's frequency error; the decoder searches ±10 kHz so it matters little).

The DVB-T modules (`dvb_usb_rtl28xxu`, `rtl2832`, `rtl2832_sdr`, `rtl2830`, `r820t`) are
blacklisted. Only one program can hold a stick: stop `rtl_tcp`, SDR++ or GQRX while the agent runs.

### Several channels on one stick

A stick hands over a whole slice of the band at once — as wide as its sample rate — so it does not
have to choose one channel: the agent decodes **every ALERT channel in the slice at the same time**,
each with a decoder thread of its own, and each is a receiver of its own in MegaNet. A new base
station listens on all four of the channels MegaNet's stations use; change them under
**Settings → RTL-SDR** — each stick's *Channels*, typed or picked from the frequencies MegaNet's
stations use, those near the Pi first (or `rpi-alert sdr 1 freq 151.5, 151.525, 152.4`, or
`sdr_frequency_mhz = 151.5, 151.525, 152.4` on the SD card).

- **How far apart**: channels within **1.89 MHz** of each other fit one stick (80% of the top rate,
  2.4 Msps, less a channel's width at each end: the RTL2832U's filter rolls off at the edges). The
  channels MegaNet's stations use — 151.500, 151.525, 151.950 and 152.400 MHz — span 900 kHz: one
  stick hears all four. A channel further away needs a stick of its own (below); the settings say so.
- **The window** — the stretch of the band a stick takes, as wide as its sample rate — is what a
  stick costs the Pi. Every channel's decoder takes in the whole window and filters its own channel
  out of it, so a channel is about three times the work in a 960 kHz window as in 240 kHz, and five
  times in 1.92 MHz — and hears nothing better for it: the decoder works at 240 ksps whatever the
  window (a test holds a 240 kHz and a 960 kHz window to the same readings at 10 dB over the
  noise). So *Automatic* takes the **narrowest window that holds the stick's channels**, and the
  settings offer:

  | Window | Holds channels up to | A channel's decoding, between bursts |
  |---|---|---|
  | 240 kHz | 162 kHz apart | 1× |
  | 960 kHz | 0.74 MHz | 3× |
  | 1.2 MHz | 0.93 MHz | 3.7× |
  | 1.44 MHz | 1.12 MHz — MegaNet's four channels | 4.1× |
  | 1.92 MHz | 1.51 MHz | 5.1× |
  | 2.4 MHz | 1.89 MHz | 6.3× |

  (Each is an exact divisor of the stick's 28.8 MHz crystal and a multiple of the decoder's 240 ksps.
  Nothing between 300 kHz and 900 kHz: the RTL2832U does not sample there.) A burst's decode — a
  second or so on a Pi 4 — comes on top, the same at any window: on the bench Pi 4, two sticks of
  two channels took 0.49 of a core in 960 kHz windows and 0.26 in 240 kHz, bursts and all. A window set by hand (Settings →
  RTL-SDR, the stick's *Window*; `rpi-alert sdr 1 window 240k`) is exactly that one: wider to see
  more of the band on the waterfall, or narrow to keep a stick light whatever it is given — a
  channel that does not fit in it is not decoded, and the stick says so, and which window would
  hold them all.
- **Where it is tuned**: within its window, the centre that keeps every channel at least 20 kHz —
  100 kHz when there is room — from the DC spike at the centre, and at least 20 kHz off every other
  channel's *mirror image* (a zero-IF tuner like the V2's FC0013 shows a faint copy of each signal
  at the opposite offset; a strong burst's copy landing on another channel would be decoded there
  too). For the four channels above: a 1.44 MHz window around 151.85 MHz — the nearest channel
  100 kHz from the spike, no image within 200 kHz. Adding or taking away a channel keeps the stick
  where it is tuned whenever that still holds them all, so its other channels hear on without a
  break. The Overview shows both (a stick's details). One channel alone is tuned as before: a quarter
  of the window away.
- **What it costs this Pi**: a couple of minutes after it starts, the agent measures what a channel
  costs its own Pi at each window; and as it runs, how busy each decoder is (its thread's share of
  the time spent working, bursts and all — the Overview's *Decoder busy*). **Settings → RTL-SDR**
  puts the two together as channels are typed: each stick's window and what it will take of the Pi
  in cores, each choice of window with its cost, which channel is the one that widens a stick
  (*152.4 MHz is what makes this stick 1.44 MHz wide: without it the rest fit 960 kHz*), and the
  whole Pi's decoding against its cores. A decoder that cannot keep up drops samples — bursts in
  them are missed — and says so in the log, on the Overview and in the settings: a decoder may
  fall up to 20 s behind (a burst decode holds it up for seconds) before its samples are dropped,
  and what it reads late is timed as it was heard. At 18 Bateson (a Pi 4 with its kiosk on), eight
  channels in two 1.92 MHz windows were more than it had — load 9, every channel dropping samples,
  most bursts lost; the same eight split low and high over two sticks (151.425–151.5375 on one,
  151.95–152.4625 on the other) in 960 kHz each brought it to about 4.5: keep each stick's channels
  close together, and list only channels worth hearing. The kiosk was the rest of it: with the screen
  off the same Pi went from load 4.7 to 2.8. Before 0.15.1 the dashboard flashed each new reading,
  and with a reading every second or so the flash never ended, so Chromium repainted the whole
  screen every frame; now the kiosk tints the newest row and draws what arrives at most every two
  seconds (a fifth of the browser's CPU, measured against `simulate.sh` at that site's ALERT2 rate).
  And two sticks are seldom equally good: at 18 Bateson one heard the same bursts 9–19 dB weaker
  than the other (compare their SNR on a channel both hear), and on it 152.400 MHz went silent — put
  the weak channels on the better stick, the strong ones on the other. A channel that hears bursts it cannot decode
  costs a decode attempt (a second or so) for each. A Zero 2 W manages a few channels in 240 kHz,
  fewer in 960 kHz. At most 8 channels a stick; each uses ~30 MB.
- **Shared by its channels**: the gain, ppm and bias tee are the stick's. A very strong channel can
  push the ADC towards clipping for the rest — lower the gain until bursts peak below −3 dBFS.
  Each channel gates on its own power, at the stick's squelch, and has a format of its own
  (`152.4 EIF` for a channel sent in Enhanced iFLOWS) — one format a channel: a frequency listed
  twice, even in two formats, is refused, because Enhanced iFLOWS read off a strong ALERT Binary
  burst makes ghosts with a valid CRC (the reason MegaNet's decoder reads one format at a time).

### Several sticks

Plug in as many as the Pi's CPU and USB power allow — each is a receiver of its own with its own
decoder threads, so a Pi 4 runs a few, each in the narrowest window its channels allow (two V4s draw
about 0.6 A; use a powered hub beyond that). Give each its own channels under **Settings → RTL-SDR**
(or
`rpi-alert sdr 2 freq 151.525`), and one Pi listens to networks further apart than one stick can
hear.

Most sticks leave the factory with serial `00000001`, so the agent tells them apart by **USB port**:
keep each stick in its port and it keeps its name, its settings and its MegaNet receiver id, however
many others come and go. librtlsdr numbers the sticks itself (`rtl_sdr -d 0, 1, …` — in reverse USB
device-path order, as libusb lists them), and those numbers change as sticks are plugged in and out,
so the agent works out each stick's number when it starts its `rtl_sdr`, then checks the stick it
really opened (the `/dev/bus/usb` node it holds) and reopens the right one if they differ. The
Overview shows each stick's port (its details) and how it was opened.

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
the flash log, shown on the Overview. Run the radio's **ALERT app** (F then 0) — records flow
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

Both are parsed by MegaNet's `alert2.js`, which reads the line by the NHWC specifications (IND API
v1.1, MANT v1.2, Application Layer v1.3). The line carries no clean-or-bad verdict of its own; a
frame is bad when its structure does not add up. Each ALERT concentration record (a repeater's
bundle of legacy ALERT readings) of a frame that adds up is a reading (protocol ALERT2), timed by
the frame's 16-bit stamp — seconds since the most recent 00:00 or 12:00 — put on the half-day
nearest its arrival in UTC or local time, whichever lands within ten minutes, less the seconds a
repeater held the record. A stamp that fits neither (a drifting network clock) is timed by arrival
and the Overview says so. **Set the Pi's time zone** to the network's (Australia/Brisbane is the
image's default). A gauge's own report of its sensors (a self-report) and a frame flagged as test
data are receptions only; every record, bad ones included, is a reception.

## USB GPS

Any NMEA 0183 receiver (u-blox pucks, most "USB GPS" dongles; GPIO-UART GPS modules via
`extra_ports = /dev/serial0`). Recognised by its `$GPGGA`/`$GNRMC` sentences. While it has a fix, it
is the base station's location (recorded in MegaNet as exact) and, with no internet, its clock.
`gpsd` is deliberately not used: its hotplug rules grab USB-serial adapters, which would fight the
ERT-A2 for its cable.

## Audio

`aplay` on ALSA's default device (on a Pi 3/4 that is the 3.5 mm jack); choose HDMI or a USB sound
card under **Settings → Audio**. The image keeps `dtparam=audio=on` in `config.txt`.
