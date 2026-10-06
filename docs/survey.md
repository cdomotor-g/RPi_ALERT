# Site surveys

Is a hill worth a repeater? Would a base station at the depot hear the stations the network
misses? Leave a Pi there for a day or three, with or without a network, and find out: which
stations it hears, how often, how strongly. Back on a network, what it heard goes to MegaNet,
where the Reception Map's **Site surveys** panel lays it beside what the network itself received
over the same days.

## What you need

| | |
|---|---|
| **A Pi** | Any that decodes an RTL-SDR: 3, 3+, 4, 5, or a Zero 2 W for one stick. Memory is not what limits a survey's length — see [Memory and storage](#memory-and-storage). |
| **Receivers and an antenna** | An RTL-SDR stick on the channels the network uses (`151.5, 151.525, 151.95, 152.4` fit one stick), or a Quansheng radio. Use the antenna, and the height, the real installation would have: the survey measures the site *and* the antenna. **Fix the stick's gain** (Settings → RTL-SDR, not *auto*) and keep it the same from survey to survey, or levels cannot be compared between sites. |
| **A clock that survives a power cut** | **A USB GPS** (recommended — it is also the survey's exact position), or a **battery RTC**: a Pi 5 with its RTC battery, or an RTC board (DS3231) on a Pi 3 or 4, checked against NTP once before it goes out (have it online in the office). With none of these the time comes from NTP while it has a network and is lost at the next power cut: what is heard after that is kept, and timed if the time is learnt again in that same power-up — otherwise it cannot be placed and is dropped. |
| **Where it is** | A GPS fix, or the site's coordinates typed in (Settings → Location) — **the site's, not the office's**. Every frame is stored with where it was heard. |
| **Power for the days** | Estimates (measure yours: [bench-test.md](bench-test.md)): a Pi 3B+ with one stick ≈ 3.5–4 W, a Pi 4 ≈ 4.5–5.5 W, a Pi 5 ≈ 5.5–7 W — about 270, 360 and 450 Wh for 72 hours. A 12 V 100 Ah LiFePO4 battery and a good 5 V buck converter runs any of them for a week; a USB power bank lasts hours, not days, and many brown out a Pi. The Survey page warns of under-voltage, which can ruin an SD card. Unplug the monitor (the kiosk costs memory and power). |
| **A token** | Not needed to start. Everything is kept on the card and goes once the Pi has a working token — *Request a token* when it is back on a network. |
| **An SD card** | 16 GB or more, A1/A2 or high-endurance. A survey writes only what it hears (tens of MB a day). |
| **A way to look at it on site** (optional) | Put your phone's hotspot in the card's `rpi-alert.conf` (`wifi_ssid`, `wifi_password`): on site the Pi joins it, `http://rpi-alert.local/` opens on the phone, and while the hotspot is up the Pi has NTP and sends as it hears. When you drive off it carries on offline. |

## Starting one

Three ways, all ending in the same survey:

1. **On site, from the dashboard** — the **Survey** page: name the site, choose how long, *Start now*.
2. **In the office, started at the site** — the same, *Start at the next power-up*: shut the Pi
   down, take it out, switch it on there. (Restarting it in the office does not start it; only a new
   power-up does.)
3. **No screen at all** — on the SD card's `rpi-alert.conf`:
   ```
   survey = Mt Mee candidate repeater
   survey_hours = 72
   ```
   It starts at the power-up that reads the card.

Or over SSH: `rpi-alert survey start "Mt Mee candidate repeater" --hours 72` (`--next-boot` to arm
it), `rpi-alert survey` for how it is going, `rpi-alert survey end`.

The **Survey** page says, before you walk away, whether the Pi is ready to be left: receivers
listening, its location, its clock, room on the card for the days at the rate it is hearing, power,
memory, token. Red is something that will lose the survey; amber is worth knowing.

## While it runs

- **Every frame heard is kept**, good or bad, with its signal (dBFS off an RTL-SDR, dBm off a radio),
  its SNR, the channel and where the Pi was — and goes to MegaNet as a *reception*
  (`report_receptions`), tagged with the survey, whatever *Also send every frame heard* says.
- **Readings stay on the Pi** unless the survey was started with *Also send its readings*. A reading
  posted days late marks its station "last seen" now on MegaNet, and is stored as a second copy beside
  the one the network already has (MegaNet deduplicates on the exact time, and no two receivers time
  a burst the same); the receptions carry everything the survey needs.
- **The tally on the Pi** — the Survey page's *Heard at this site*: each address, its station, good
  and bad frames, when last heard, its median signal and spread, its SNR, the channel. Readable on site
  with no network; kept across restarts.
- **It ends itself** when its hours of listening are up (counted while switched on — a night with the
  power off does not count), or when a GPS fix puts it more than 500 m from where it began (it has
  been taken away, and what it hears now is not the site's). Or *End the survey* / `rpi-alert survey end`.
  What it heard is kept, and goes to MegaNet whenever it can.

## Afterwards

Bring it back and put it on a network. It sends what is waiting — about a thousand receptions a call,
so a busy three days (100,000 frames) takes a few minutes — and the header says how much is left.
Then in MegaNet: **Reception Map → Site surveys** (editors), pick the survey: every station heard
there, how many of its transmissions the site caught of those the network stored over the same days,
those the site heard that the network never got, and the signal and SNR of each.

## Memory and storage

What used to limit a long offline spell was memory: before 0.9 the queue for MegaNet lived in RAM and
was rewritten to the card whole, every couple of seconds. Three days of four busy channels — some
150,000 readings and as many receptions — is about 100 MB of JavaScript heap and as much again while
writing it out, against a heap limit of about a quarter of the Pi's RAM (~250 MB on a 1 GB Pi 3), and
seconds of the agent standing still at every save; the count limits (20,000 receptions) dropped the
oldest after a day or two anyway. Now the queue is on the card, only appended to
([how-it-works.md](how-it-works.md)), and memory holds a few thousand items however long it grows.

| Pi | RAM | What a survey uses | Verdict |
|---|---|---|---|
| Pi 3 / 3B+ | 1 GB | ~120 MB Raspberry Pi OS Lite, ~60 MB the agent, ~30 MB a decoding channel — about 300 MB with four channels; the queue a few MB | Fine, headless (the kiosk would add 300–400 MB) |
| Pi 3A+, Zero 2 W | 512 MB | the same, at 240 ksps and fewer channels | Fine for one stick, a channel or two |
| Pi 4 | 1–8 GB | as the Pi 3 | Plenty |
| Pi 5 | 2–16 GB | as the Pi 3 | Plenty; its RTC battery makes it the easiest survey Pi |

On the card each reception waits as about 450 bytes (and a reading, if they are being sent, 220).
The busiest channel MegaNet has seen hears 5,000–6,000 frames a day in dry weather, so four channels
are ~10 MB a day, a storm several times that: the default limit (`meganet.queueMb`, 1 GB, with 256 MB
of the card always left free) holds months of a quiet site and weeks of a wet one. Past it, the oldest
is dropped and counted, never silently.

## Limits

- **The time.** No GPS, no battery RTC and no network: a power cut costs whatever is heard until the
  time is known again in the same power-up, and anything heard in a power-up that never learns it.
  The readiness check says so in red. (A way to time such a power-up afterwards, by matching what it
  heard against the network's own readings, is on the [roadmap](roadmap.md).)
- **dBFS is not dBm.** An RTL-SDR's level is relative to its own full scale at its gain: compare
  stations at one site, and sites surveyed with the same stick, gain and antenna — not against a radio's
  dBm.
- **A frame heard on two channels** (a repeater and its station) counts on each.
