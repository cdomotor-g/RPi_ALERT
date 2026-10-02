# Installing RPi ALERT

Three routes, one result. The set-up page — <https://cdomotor-g.github.io/RPi_ALERT/> —
walks through the first two and writes the card's settings for you.

## What you need

- A Raspberry Pi (a **Pi 4** is the recommended base station; see [hardware.md](hardware.md)),
  its proper power supply, and a microSD card of 8 GB or more.
- A receiver: an RTL-SDR stick with a VHF antenna, a Quansheng UV-K5 V3/UV-K1 on the ALERT
  receiver firmware (USB-C cable), or an ELPRO ERT-A2 (USB-serial cable to its RS-232 port,
  or its USB port).
- A network (Ethernet or Wi-Fi) for MegaNet — it can come and go; nothing is lost while it is away.
- A MegaNet **ingest token** for this base station: an administrator mints one on
  MegaNet's **Admin** tab → **Ingest tokens** → *Create token* (label it for the place, e.g.
  *Bench Pi*). It is shown once. One token per Pi covers every receiver on it.

## Route 1 — Raspberry Pi Imager with the RPi ALERT repository

Raspberry Pi Imager can show third-party operating systems from a repository file. Start
it with RPi ALERT's:

| | |
|---|---|
| Windows (Win+R) | `"C:\Program Files (x86)\Raspberry Pi Imager\rpi-imager.exe" --repo https://cdomotor-g.github.io/RPi_ALERT/os_list.json` |
| macOS (Terminal) | `"/Applications/Raspberry Pi Imager.app/Contents/MacOS/rpi-imager" --repo https://cdomotor-g.github.io/RPi_ALERT/os_list.json` |
| Linux | `rpi-imager --repo https://cdomotor-g.github.io/RPi_ALERT/os_list.json` |

(If Imager is installed somewhere else, use that path — the `--repo` argument is what matters.)

1. **Device** → your Pi. **Operating System** → **RPi ALERT (arm64)** (or armhf for a Pi 1/2/Zero).
   **Storage** → the SD card.
2. Accept **customisation**: user name and password (needed to log in over SSH), Wi-Fi, time
   zone, and **Enable SSH**. RPi ALERT images keep Raspberry Pi OS's cloud-init, so this works
   exactly as for Raspberry Pi OS.
3. Write. When it finishes, **leave the card in** if you want to add its settings
   (below), otherwise eject it.

## Route 2 — download the image

From [Releases](https://github.com/cdomotor-g/RPi_ALERT/releases):
`rpi-alert-<version>-arm64.img.xz` (Pi 3/4/5/Zero 2 W) or `-armhf` (also Pi 1/2/Zero). Check
it against the `.sha256` beside it, then write it with Raspberry Pi Imager
(**Operating System → Use custom**) or balenaEtcher. Imager's customisation is offered for a
custom image too.

## Route 3 — a Pi that already runs Raspberry Pi OS

No reflash needed; this is how the bench Pi can be brought up to date. Log in (screen or SSH) and:

```sh
curl -fsSL https://raw.githubusercontent.com/cdomotor-g/RPi_ALERT/main/os/bootstrap.sh | sudo bash
```

It works on Raspberry Pi OS **Trixie** or **Bookworm**, Lite or Desktop, 64- or 32-bit, and:

- installs Node.js, `rtl-sdr`, ALSA utilities, Avahi, and (with 1 GB of RAM or more) cage + Chromium for the screen;
- on Bookworm, whose `librtlsdr` predates the RTL-SDR Blog V4, builds and installs
  [rtlsdrblog/rtl-sdr-blog](https://github.com/rtlsdrblog/rtl-sdr-blog) (Trixie's own already knows the V4);
- blacklists the DVB-T TV driver that otherwise grabs RTL-SDR sticks;
- creates the `rpi-alert` service user, installs the agent in `/opt/rpi-alert`, its services,
  udev rules, the root helper and the hardware watchdog;
- starts it, and prints the dashboard address.

Options after `bash -s --`: `--no-kiosk`, `--no-watchdog`, `--build-rtl`. From a checkout:
`sudo ./os/install.sh`. To remove: `sudo /opt/rpi-alert/os/install.sh --uninstall` (`--purge` also
deletes settings and queue).

A Pi 4 or 5 with no other computer at all: hold **Shift** while it boots with no card in for
Raspberry Pi's [network install](https://www.raspberrypi.com/documentation/computers/getting-started.html#install-over-the-network),
which runs Raspberry Pi Imager on the Pi itself and writes a card you insert; choose
Raspberry Pi OS Lite, boot it, and run the line above.

## The card's settings (optional)

With the freshly written card still in the computer, its **bootfs** drive (the one holding
`config.txt`) can carry an `rpi-alert.conf`. The set-up page writes it there directly in Chrome or
Edge (*Write to the SD card…* → choose the bootfs drive), or downloads it for you to copy. By hand:
copy `rpi-alert.conf.example` on that drive to `rpi-alert.conf` and fill it in. Every key is in
[configuration.md](configuration.md#the-boot-partition-file-rpi-alertconf).

At boot the Pi applies it, renames it `rpi-alert.conf.applied` with the token and passwords blanked,
and writes what it did to `rpi-alert-boot.log` on the same drive.

## First boot

1. Put the card in the Pi. Plug in the receivers, the network, then power.
2. The first boot expands the file system and runs Imager's customisation — allow two minutes.
3. Open **http://rpi-alert.local/** (or the hostname you chose) from a computer on the same
   network. If `.local` names do not resolve there (some corporate networks), use the address
   your router lists for the Pi, or plug in a monitor: the console shows it.
4. **Settings → MegaNet**: paste the ingest token, press *Check token* (it says which ingest
   point MegaNet knows it as), name the base station, *Save*. **Settings → Location**: set where it is.
5. **Dashboard**: each receiver appears within seconds of being plugged in; readings appear as they
   are heard, with the station each address belongs to.
6. **Settings → Web page password**: set one, so others on the network cannot change things.

Over SSH instead: `ssh <user>@rpi-alert.local`, then `rpi-alert setup` (questions for the
essentials) and `rpi-alert status`.

## Updating

`sudo rpi-alert-update` installs the latest release (`--ref main` for the development branch);
**Settings → System → Check for updates** says whether there is one. Settings, the queue and
the receiver ids are kept. Raspberry Pi OS itself updates the usual way
(`sudo apt update && sudo apt full-upgrade`).
