# First test on the bench Pi

A checklist for bringing RPi ALERT up on the Pi on the test bench. Everything below has run in
simulation (pseudo-terminal receivers, a fake `rtl_sdr` streaming synthesised bursts, a MegaNet
stand-in) and the image has been built and installed in an emulated chroot — but **none of it has
run on a real Pi with real receivers yet**. This is that run.

## 0. Before you start

- A phone (or computer) signed in to MegaNet as an administrator — the bench Pi asks for its own
  ingest token and you approve it there. (Or a token made beforehand: Admin → Ingest tokens →
  *Bench Pi*.)
- Decide: **reflash** with the RPi ALERT image (clean, what a new site gets), or **install over**
  the Raspberry Pi OS already on it (keeps what is there). Either is fine; reflashing tests the image.

## 1. Get RPi ALERT on it

- **Reflash**: <https://cdomotor-g.github.io/RPi_ALERT/> → Pi 4 (or whichever it is) → Imager with
  the RPi ALERT repository, customisation on (user, Wi-Fi, SSH) → write the card's settings (name
  *Bench Pi*, the bench's coordinates, token left empty so it asks MegaNet for one) → boot.
- **Install over**: SSH in, then
  `curl -fsSL https://raw.githubusercontent.com/cdomotor-g/RPi_ALERT/main/os/bootstrap.sh | sudo bash`,
  then `rpi-alert setup` (press Enter at the token question).
- **The token**: `rpi-alert request-token` (or *Request a token* on the dashboard) shows a code and
  a QR code. Scan it with the phone, check the code on MegaNet's Admin tab matches, press
  *Approve*. Expect the Pi to say *Approved* within five seconds. Then on the Admin tab the token
  is listed as *Bench Pi*, made by you, and — once a receiver is plugged in — the receivers behind it.

Expect: `http://<hostname>.local/` shows the dashboard; `rpi-alert status` shows MegaNet **ok** with
the token's label, the clock **ok (ntp)**, and the location.

## 2. The V2 stick (known good)

1. Plug it in with its antenna. Within a few seconds: **Receivers → RTL-SDR**, state *receiving*,
   tuner *Fitipower FC0013*, samples arriving at ~960 ksps (Pi 4).
2. Wait for traffic on 151.5 MHz. The dashboard's burst plot shows bursts; decoded ones turn green and
   readings appear with station names. Compare a few with MegaNet's Message Log.
3. If bursts are heard but not decoded: check the frame format (ALERT Binary for the live network),
   the ADC level (no clipping on the Receivers page; lower the gain if there is), and the ppm.
4. Save a good burst for the tests: `sudo systemctl stop rpi-alert;
   rtl_sdr -f 151260000 -s 960000 -g 29.7 -n 2880000 burst.iq8` while a station transmits (3 s), then
   restart the agent and send the file back.

## 3. The V4 stick

1. Swap the V2 for the V4. Expect tuner *Rafael Micro R828D* and model *RTL-SDR Blog V4*.
2. If it does not open, `rpi-alert status` / Receivers shows `rtl_sdr`'s own words. Then:
   - `lsmod | grep dvb` — should be empty (the DVB-T driver is blacklisted; reboot once after install);
   - `rtl_test -t` — what librtlsdr makes of the stick;
   - on Bookworm, `sudo /opt/rpi-alert/os/install.sh --build-rtl` builds the RTL-SDR Blog driver.
3. Same decode check as the V2.

## 3a. Both sticks at once

1. With the V2 running as *RTL-SDR*, plug the V4 in beside it. Expect *RTL-SDR 2* within a few
   seconds — and *RTL-SDR* not renamed, not restarted (its Receivers card: same receiver id, no
   restarts), even though both sticks say serial 00000001.
2. **Settings → RTL-SDR → Each stick**: give *RTL-SDR 2* another channel (or the same channel in
   Enhanced iFLOWS) and save. Only that stick restarts; each now hears its own. `rpi-alert sdr`
   lists both with their USB ports.
3. On the Receivers page, each card's *USB port* line should say *seen to be this stick*. Swap
   the antennas, or unplug one, to be sure which is which.
4. Reboot with both plugged in: the same names, ports and channels come back.
5. Unplug one: it stays listed as *unplugged*. Press **Remove**: it is gone, and plugged in again
   it is found as a new stick (with the first free name).

## 4. Quansheng radio

Plug in by USB-C with the ALERT app running (F then 0). Expect *Quansheng radio*, recognised by USB id
36b7, firmware hash, battery and noise floor within 10 s; the radio's clock set (`EVT … CLOCK`
in the log); each DEC on the dashboard and in MegaNet.

## 5. ERT-A2

RS-232 through a USB-serial cable (9600 8N1), or its USB port. Expect *ERT-A2* after its first frame,
readings tagged ALERT2. If the Receivers page says frame times are hours out, check the Pi's time zone.

## 6. The things that go wrong at a site

| Do this | Expect |
|---|---|
| Unplug a receiver for 10 s, plug it back in | *unplugged*, then *receiving* again; readings resume; same receiver id |
| Unplug the radio while it is sending | the port closes cleanly, reopens on replug |
| Pull the network for 10 minutes | readings keep arriving on the dashboard; *waiting* climbs; all sent when the network returns |
| Pull the power, restore it | everything comes back by itself; anything queued is sent |
| Boot with no network at all, then connect it | readings show ⏳ (held for the clock) until NTP sets it, then are timed and sent |
| A monitor plugged in / unplugged | the full-screen dashboard starts within ~10 s / stops |
| A speaker in the audio jack | a chirp for each burst (Settings → Audio → *Test ALERT chirp*) |

## 7. If something is wrong

`rpi-alert status`, the **Log** tab, or `sudo journalctl -u rpi-alert -e` usually say why.
Collect them with `sudo journalctl -u rpi-alert --since today > rpi-alert.log`.

### Letting Claude Code help over the network

If a Claude Code session runs on a laptop on the same network as the Pi, it can do the checks above
over SSH. Give it a user on the Pi (`ssh <user>@rpi-alert.local` must work from the laptop, ideally
with a key: `ssh-copy-id <user>@rpi-alert.local`), point it at this file, and ask it to work through
sections 2–6 and report — it can read logs, run `rpi-alert status`, capture IQ with `rtl_sdr`, and
push fixes to this repository.
