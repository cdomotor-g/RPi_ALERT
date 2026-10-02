# Research: what exists, what was chosen, and why

## Building the operating system

| Option | What it is | Verdict |
|---|---|---|
| **Customise official Raspberry Pi OS Lite** (chosen) | Download Raspberry Pi's own Lite image, run an install script in a chroot (qemu-user), shrink, compress. | Smallest thing that works: Raspberry Pi keeps doing kernels, firmware, Wi-Fi drivers and security updates; Imager's customisation (cloud-init on Trixie) keeps working; every Pi model Raspberry Pi supports is supported. The *same* script installs onto a running Pi, so there is one install path to test, and the bench Pi can be upgraded without a reflash. Builds in ~10 minutes on a GitHub runner. |
| [pi-gen](https://github.com/RPi-Distro/pi-gen) | The tool Raspberry Pi uses to build Raspberry Pi OS, from debootstrap, in stages. | Proven, but rebuilding the OS from scratch is slow (an hour+) and then *we* own what Raspberry Pi already ships. Worth moving to only if the image has to differ deeply from Lite. |
| [rpi-image-gen](https://github.com/raspberrypi/rpi-image-gen) | Raspberry Pi's newer declarative (YAML) image builder. | The likely long-term successor to pi-gen; a good fit if RPi ALERT ever needs read-only root or A/B updates. Same trade-off as pi-gen today. |
| [CustomPiOS](https://github.com/guysoft/CustomPiOS) | The framework behind OctoPi and FullPageOS: modules run over an official image. | Same idea as the chosen route, with a framework around it. A plain script was simpler to read and to reuse for on-Pi installs. |
| DietPi | A trimmed Debian for SBCs with its own automation. | Not Raspberry Pi OS, so not what Imager customises; another distribution to track. |
| Buildroot / Yocto | Build a minimal Linux from source. | Smallest image, but drivers, Wi-Fi, a browser kiosk and updates all become our job. Far more effort than the gain. |
| balenaOS / Ubuntu Core | Container/snap-based appliance OSes. | Need their cloud or store tooling; heavier than needed for one service. |

## Appliances to learn from

- **[adsb.im](https://adsb.im/)** (ADS-B feeder image) — the closest analogue: a Raspberry Pi image
  for SDR receivers feeding networks, configured from a web page on `*.local`. Same pattern here:
  web page first, no screen required.
- **PiAware** (FlightAware) and **Pi24** (Flightradar24) — RTL-SDR feeder images; settings in a
  text file on the boot partition, which RPi ALERT's `rpi-alert.conf` copies.
- **OctoPi / FullPageOS** — CustomPiOS images; FullPageOS is a browser kiosk. RPi ALERT's kiosk
  is lighter (cage, a single-app Wayland compositor, instead of X and a window manager) and only
  runs while a monitor is connected.
- **MegaNet's own Serial Monitor** — the browser version of this: the same receivers, decoders and
  MegaNet contract. RPi ALERT is that, headless and unattended.

## Can a web page flash the SD card?

**No — not in any browser today, by design.**

- **WebUSB** blocks the USB mass-storage class outright (the browser will not hand a storage device
  to a page).
- The **File System Access API** reads and writes *files and folders* the user picks; it cannot open
  a raw block device (`\\.\PhysicalDrive1`, `/dev/sdb`).
- **Web Serial** is for serial ports, which is how ESP Web Tools flashes microcontrollers — but an
  SD card is not a serial device.

So "go to a website, click some buttons" is done as far as browsers allow:

1. The set-up page picks the image for the Pi model and starts **Raspberry Pi Imager** with the
   RPi ALERT repository (`--repo …/os_list.json`), so RPi ALERT is a choice in Imager's own list and
   Imager's customisation (user, Wi-Fi, SSH) applies.
2. After Imager writes the card, the page **writes the card's settings file straight onto its boot
   partition** — that *is* a folder, so the File System Access API can (Chrome and Edge); other
   browsers download it.

**Flashing from the Pi itself**: a Pi cannot rewrite the card it is running from. But a **Pi 4 or 5
with no card in** can boot Raspberry Pi's *network install* (hold Shift), which runs Imager on the Pi
and writes a card inserted afterwards. Its list is Raspberry Pi's own, so the route there is: network
install → Raspberry Pi OS Lite → boot → the one-line installer (`os/bootstrap.sh`), which produces the
same system as the image.

**Fallbacks**: download the `.img.xz` and use Imager's *Use custom* or balenaEtcher.

## Why the V4 did not "just work"

Two independent causes, both common on Linux, both handled now:

1. **The library.** Raspberry Pi OS Bookworm's `librtlsdr0` is 0.6.0, which predates the RTL-SDR
   Blog V4 (R828D tuner with the V4's input switching and upconverter). Trixie's 2.0.2 contains the
   V4 support (checked: the library carries "RTL-SDR Blog V4 Detected"). The installer checks the
   library for it and builds `rtlsdrblog/rtl-sdr-blog` when it is missing.
2. **The kernel.** Linux's DVB-T TV driver (`dvb_usb_rtl28xxu`) claims any RTL2832U the moment it is
   plugged in, and then nothing else can open it. RPi ALERT blacklists it (and its tuner modules).

(MegaNet's browser driver, `rtlsdr.js`, recognises the V4 by its USB strings and drives it over
WebUSB — which is why it worked on Windows once WinUSB was on the stick.)

## Why not gpsd

gpsd's udev hotplug rules claim USB-serial adapters with the chips GPS pucks use — the same FTDI,
CP210x and PL2303 chips an ERT-A2's RS-232 cable uses. The agent reads NMEA itself, recognising the GPS
by its sentences, so the two never fight over a port.
