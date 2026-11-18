# Configuration

Four ways in, one set of settings (`/etc/rpi-alert/config.json`, owned by the agent's user,
mode 0600 because it holds the ingest token):

| Where | Who it suits |
|---|---|
| **The web page** — `http://rpi-alert.local/` or the Pi's own screen | everyone; every setting is there |
| **`rpi-alert` over SSH** (PuTTY on Windows) | headless, scripted |
| **`rpi-alert.conf`** on the SD card's boot partition (on a computer with none: `/etc/rpi-alert.conf`) | setting a card up before the Pi ever boots |
| editing `config.json` | not needed; the others validate what they are given |

## The web page

Six tabs, the first what the Pi's own screen shows:

- **Overview** — the plots together at the top: this Pi's temperature, load and memory, and the
  radio picture (spectrum and waterfall); then the counts at a glance; each receiver's state (for a
  stick, each channel's level, bursts and readings, and a *Details* fold with its tuner, window, USB
  port and what its decoders cost) with its charts over 30 minutes, 6 or 24 hours; the **last 10
  bursts**, each with what it came to (its readings, a repeat of one already heard, or nothing);
  Flood-Net (sending, what is waiting, check-ins); and this Pi's settings. **Every setting is
  folded under the card it belongs to**, each fold's one line saying what it is set to: under
  *Receivers*, the RTL-SDR sticks (each stick's channels, window and tuner, with what they will cost
  the Pi as they are typed; the defaults; decoding), serial devices and recordings; under
  *Flood-Net*, the token and sending, and what Flood-Net may do here; under *This Pi*, location,
  audio, screen, network (Wi-Fi scan and join, hostname), the hotspot (the Pi's own Wi-Fi network
  for a phone where there is no other), the web page's password, SSH access (the `alert` account,
  its keys and where each came from, password login, Flood-Net's team keys), and system and updates
  (time zone, restart, reboot, shut down, updates). Looking needs no password; opening a fold asks
  for it where one is set (this Pi's own screen never does). The Pi's own screen hides the folds.
  A link to one setting: `http://rpi-alert.local/#set-sdr` (or `#set-meganet`, `#set-location`,
  `#set-audio`, …; the old `#settings-…` links still work).
- **Readings** — every reading decoded since the agent started, newest first (protocol, format,
  address, station, value in engineering units, signal, receiver), and the stations heard most.
- **Bursts** — every receiver's bursts over the last 30 minutes, 6 or 24 hours; every burst heard
  since the page opened (and the half hour before), each with its length, its signal over the noise
  floor and what it came to; and the bursts kept as recordings, each a download.
- **Requests** — what Flood-Net's administrators asked this Pi to do from its Base Stations tab,
  and whether it was done.
- **Log** — the agent's own log, everything or only warnings and errors.
- **Survey** — a site survey: start one now or at the next power-up, whether this Pi is ready to be
  left at a site with no network (receivers, location, clock, room on the card, power, token), and a
  table of every station it has heard there — good and bad frames, signal and SNR — readable on site
  before it is ever on a network. [survey.md](survey.md)

**Several channels on one stick.** One stick decodes every channel in its *window* — a stretch of
the band up to 2.4 MHz wide — all at the same time. Under **Overview → Receivers → RTL-SDR sticks** each stick's
*Channels* are chips: × takes one away; type a frequency (a format after one sent in another:
`152.4 EIF`) or tap one of the frequencies MegaNet's stations use — from the station register the
Pi fetches each day, those used within 150 km of it first, each saying what it would do to the
window — to add it. The first is the stick's own receiver; each is a receiver of its own: named for
its frequency (*RTL-SDR · 151.525*), with its own MegaNet receiver id (`rpi-<host>-sdr1-151.525`; the
stick's own channel keeps `rpi-<host>-sdr1`), its own decoder, squelch and counts.

**The window.** Every channel's decoder takes in a stick's whole window, so the window is what a
stick costs the Pi — and a wider one can hear weak bursts *better*, not worse: the stick's samples
are 8-bit, and their noise is spread across the whole window, so the wider it is the less of that
noise is left once a channel is filtered down to its own ±12 kHz. Measured at 18 Bateson
(8 November 2026, the same five channels, 15 minutes each way): in 288 kHz each channel's noise
floor was 5–6 dB higher than in 960 kHz (−64 against −70 dBFS) and the bursts 3–5 dB nearer it, and
every channel heard fewer — 151.500 12 readings against 33 and 44, 151.5375 606 against 782 and
722, 151.575 27 against 61 and 67. So narrow a window to spare the Pi, not to hear better. *Automatic* is the narrowest that holds
the stick's channels: 240 kHz for channels within 162 kHz of each other, then 960 kHz, 1.2, 1.44,
1.92 and 2.4 MHz. **288 kHz** (0.22) lies between 240 kHz and 960 kHz: five channels 75 kHz apart
(151.500–151.575) fit in it with the DC spike 20 kHz clear, where 240 kHz holds four — at about
three fifths of 960 kHz's work a channel (0.62, measured on a PC), twice 240 kHz's. Automatic takes it only where *No narrower than* or *No
wider than* names it, or it is chosen as the window. **Why not any width you type?** The stick's
chip, the RTL2832U, samples only from 225 to 300 kHz or from 900 kHz up — nothing between — and the
window is as wide as it samples; the decoder wants 240 kHz, which a whole multiple, or 288 kHz
(resampled by 5/6), gives it exactly. So a range typed as 151.425–151.6 MHz is 175 kHz: no stick can
take exactly that, and the nearest it can that holds five channels there is 288 kHz. The settings
show each window's real edges in MHz. Signals outside a stick's channels but inside its window do
not reach the decoders — each channel is filtered down to its own ±12 kHz — unless they are strong
enough to overload the stick (its *ADC* level on the Overview near 0 dBFS). Since 0.20 *No narrower than* and *No wider than* keep Automatic between two
windows: a widest keeps a stick light whatever channels it is given — a channel it cannot hold is
not decoded, and the stick says which and what a wider window would cost — and a narrowest shows
more of the band on the waterfall (limits that cross: the widest wins). A window chosen by hand is
exactly that one, limits or not; a channel outside it is not decoded, and the stick says so. Each
stick can have its own limits, or follow the defaults'; Flood-Net's Base Stations tab sets them too.
As channels are typed, the card shows the window each stick will take, where,
and what that costs this Pi in cores (each choice in the *Window* and limit lists with its cost), which channel
is the one that widens a stick, whether saving retunes it, and the whole Pi's decoding against its
cores — from what the agent measured a channel costs this Pi at each window, and how busy each
decoder is now. Adding or taking away a channel leaves the others alone: they keep their receiver
ids, and are restarted only if the stick has to be tuned elsewhere (it keeps where it is tuned when
that still holds them all). Channels too far apart for any one window are refused, saying which.
More: [hardware.md](hardware.md#several-channels-on-one-stick).

**Several RTL-SDR sticks.** Each stick is a receiver of its own, with its own MegaNet receiver id
(`rpi-<host>-sdr1`, `-sdr2`, …) and name (*RTL-SDR*, *RTL-SDR 2*, …, numbered in USB port order).
Under **Overview → Receivers → RTL-SDR sticks**, each stick has a block of its own: its channels, window, frame
format, gain, ppm, squelch, bias tee and name, or it can be turned off. Each field shows the value
the stick has, marked *default* (it follows **Defaults**, further down, which a new stick starts
with) or *this stick's* — change a field and it is the stick's own; ↺ gives it back to the default.
So one Pi can
listen to networks further apart than one stick hears. Changing one stick's channels, gain, ppm or
bias tee restarts only that stick's `rtl_sdr` (and only if where it is tuned changes); a format or
squelch change does not restart anything.

**Bias tee.** It puts 4.5 V on the stick's antenna socket, for an LNA powered up the coax — on a
stick that has one (RTL-SDR Blog V3 and V4; a generic stick has none). `rtl_sdr` has no bias-tee
option, so the agent switches it with `rtl_biast` (part of the `rtl-sdr` package) just before
`rtl_sdr` opens the stick, and switches it off again when it is turned off. With two sticks that
share a serial it waits until it has seen which device number is which stick, so the volts never
reach the other one. If it cannot be switched, the stick receives without it and its card says why.

<a id="alert2-off-the-air"></a>**ALERT2 off the air.** Every SDR channel hears ALERT2 as well as its
legacy format: a burst none of the legacy formats reads is tried as an ALERT2 AirLink frame, and
each ALERT concentration record in it is a reading with protocol `alert2`, format ALERT2, timed by
its own stamp (seconds since 00:00 or 12:00 UTC; a network on local time is read in local time).
The network's fresh PDUs say which clock it keeps, and then one delivered late — a repeater's
store and forward, half an hour behind — keeps its stamp too, up to six hours old; a stamp that
fits neither, or comes from the future, is timed by arrival, and the stick's details on the Overview say why. A record relayed by several repeaters is one reading and a reception for each path, so
the Reception Map shows the paths. A station reporting its own sensors (self-reporting, not
concentrated ALERT) is a reception with each sensor's number and value — it has no ALERT id to be a
reading by. A channel's line on the Overview counts its ALERT2 frames
(and those whose sync was heard but would not decode). Nothing to set — the channel's format
stays its legacy one. A Pi short of CPU can turn it off (`receivers.sdr.alert2: false`): each try
costs a few tenths of a second on a Pi 4, and only bursts nothing else decoded are tried.

<a id="lean-decoder"></a>**The decoder.** Under **Overview → Receivers → RTL-SDR sticks**, *Decoder* chooses how a burst is decoded, using
MegaNet's own `alert-dsp.js` either way (MegaNet #259):

- **Lean** (the default since 0.17, as on floodwarning.net): filters a burst once for each of its 9
  carrier guesses rather than once for each of 45 guesses. At the first base station to compare
  the two, 14 of 11,628 live bursts read differently (0.12%; 13 of them on one stick with a
  differently placed aerial), and lean took a third of the full decoder's time.
- **Full**: the 45-guess decoder, as before 0.17.
- **Light** (0.19): as lean, with each burst filtered down to 48 kHz once before its 9 carrier
  guesses — they all lie within ±17 kHz of the channel. About half of lean's time a burst (65 ms
  against 122 on MegaNet's bench); over 600 synthesised bursts both found the same 642 true
  readings, and every real burst in MegaNet's tests reads the same. Not bit for bit lean: prove it
  where you are with *Compare light* before choosing it.
- **Compare**: decodes with the full decoder and sends those readings, then decodes each burst lean
  too. Each stick's card counts how often the two agreed, and the first 20 differences are logged
  with both readings. It costs about half as much again per burst, and is skipped whenever bursts
  are waiting.
- **Compare light** (0.19): the same, lean against light — lean's readings sent, light's counted
  beside them (*Light decoder* on the card; `lean_check` with `pair: lean-light` to Flood-Net).

The same choice is `receivers.sdr.decoder` (`lean`, `full`, `light`, `compare`, `compare-light`), or `sdr_decoder = full` on
the SD card. 0.16 wrote `full` into every settings file it saved, so 0.17 reads a 0.16 `full` as
that default and makes it `lean`; a `compare` someone chose is kept.

<a id="between-bursts"></a>**Between bursts.** Under **Overview → Receivers → RTL-SDR sticks**, *Between bursts* chooses what each channel's
decoder does while nothing is on its channel (MegaNet's `BurstWatch`, #259 part 2):

- **Filter every sample** (the default, as before 0.18): the decoder filters the stick's whole
  window into its channel all the time, burst or not. Between bursts that is nearly all its work,
  and more the wider the window.
- **Filter only around bursts**: the decoder keeps the last 1.4 s of the window as it came and looks
  at its channel 25 times a second. While nothing shows it filters nothing. When the channel comes
  within 3 dB of the squelch it filters the kept 0.8 s before and carries on from there (0.18: a
  second before, and a second after; 0.19 halves the hang-over and a third of the time awake), so the
  squelch and the decoder see the same samples they always did: in MegaNet's tests, the same
  readings and the same bursts, each the same length, every time. A quiet channel then costs this
  Pi from 2½ times less at 240 kHz to about 20 times less at 2.4 MHz (*Settings* measures both on
  this Pi, and says what a stick will take under the one chosen). A channel kept busy — a carrier
  that stays up — costs what it did.
- **Check**: filters every sample and sends those readings, and runs a second decoder filtering only
  around bursts on the same samples. Every 10 s each stick's card adds up the readings both got and
  the readings only one did (matched 20 s later), how much of the time the second was awake, and its
  share of the work; a reading only one got is logged, the first 20. It costs a little more than
  *Filter every sample* alone. (0.18–0.19.0 counted it but showed none of it — a stick's total
  started without the check's counts — so only the log had it; 0.19.1 shows it on the card and in
  Flood-Net.)

**What the first check found** (18 Bateson, a Pi 4, from 4 November 2026 on 0.19.0): on the two
ordinary ALERT channels the two decoders disagreed far more often than lean and full ever did — 20
readings on 151.500 in its first 6½ hours (about one in 13) and 20 on 151.525 in 7½ (about one in
19), when the log stopped listing them. On 151.525 they went both ways. On 151.500 filtering around
bursts was the one that missed it 10 times of the 12 still in the log, and every one of those 10
was a weak burst, 8–9 dB over the noise, just over the 8 dB squelch — and 37% of that channel's
bursts are that weak. The check compares ordinary ALERT readings only, never ALERT2 frames, so it
says nothing yet about 151.5375, whose traffic is nearly all ALERT2. Until the watch wakes for the
weakest bursts it lets through, keep **Filter every sample** on any computer with the power for it
(a Pi 4 or 5 has plenty), and treat *Filter only around bursts* as the way to fit a smaller one,
at the cost of some weak bursts.

The same choice is `receivers.sdr.watch` (`always`, `bursts`, `check`), or `sdr_watch = check` on
the SD card. Flood-Net's Base Stations tab sets it too, and shows each stick's check.

Since 0.19 each channel's decoder keeps 5 s of its channel for decode windows rather than 8 (a 3 s
burst and its margins need 3.8) and nothing for the website's *capture IQ*, which the Pi never
uses: about 10 MB less a channel, the same readings.

Since 0.17 only a stick's first channel works out the stick's spectrum for the waterfall: the other
channels see the same slice, and skipping it saves a sixth of a channel's work between bursts.

<a id="recordings"></a>**Recordings.** Under **Overview → Receivers → Recordings**, list channels (MHz) to keep the IQ of every
burst heard on them — to see what is on a channel nothing here decodes yet (another format,
another protocol), and to build the decoder that will — as ALERT2's was. Each burst is two files in
`/var/lib/rpi-alert/recordings`: an `.iq8`, the channel's own 240 ksps as u8 I then Q, centred on
it — the burst and 0.4 s either side, the decoder's own samples scaled so the loudest fills most of
a byte (a channel heard at −60 dBFS would otherwise be nothing but 127s and 128s), in the format
MegaNet's SDR card captures and its tests decode — and a `.json` saying what it was (frequency,
stick and tuning, the burst's level and length, the scale, what it decoded as). The newest are kept, up to the size set
(256 MB by default; about 1 MB a second of burst), and none is written with under 512 MB of the
card free. The same card lists them, newest first, each a download; `rpi-alert record` does it
from the command line, and MegaNet can fetch one a piece at a time
([remote-management.md](remote-management.md)). A recorded channel says so on the Overview.

**Tuning help.** Each stick's card on the **Receivers** page suggests the ppm and gain to set, from
what it has heard since the agent started, with a button that sets it for that stick only:

- *Frequency correction* — every decoded burst's carrier offset is measured (the FM discriminator
  averaged over the burst, to a few tens of Hz). The offsets are the stick's crystal error plus each
  station's own, so the suggestion is the median of the stations' medians — after 6 bursts from at
  least 2 stations. Under 1 ppm off, it says the setting is right.
- *Gain* — down (at least 8 dB) when bursts reach the ADC's full scale or the ADC clips; up (up to
  12 dB) when even the strongest bursts peak below −30 dBFS; otherwise it says the gain is right.
  Only bursts heard at the gain now set count, so each change is judged afresh.

The stick's line on the Overview says *⚙ suggests …* while there is something to change.

Most sticks share one serial number (`00000001`), so sticks are told apart by the **USB port** they
are in: keep each in its port and it keeps its name, settings and receiver id, across replugs and
reboots, whatever else is plugged in. (A stick plugged into another port takes the place of a stick
like it that is missing — the one seen last — so a stick moved on its own keeps who it is. A stick
with a serial of its own is recognised in any port.)
A stick that is unplugged stays listed, as *unplugged*, with when it was last seen, until it comes
back or you press **Remove** — which forgets its name, its own settings and its receiver id; plugged
in again, it is found as a new receiver.
- **Log** — the agent's log, live.

**Getting the token.** *Request a token* (Overview → Flood-Net → Token and sending, or the banner while there is none)
makes a token on the Pi and asks MegaNet to approve it; the Pi shows a code and a QR code, an
administrator signed in to MegaNet anywhere approves the request on MegaNet's **Admin** tab →
**Ingest tokens**, and the token is saved by itself. The token being asked about waits in
`/var/lib/rpi-alert/token-request.json` (0600) so a restart carries on asking; it becomes
`meganet.token` only once approved. Pasting a token still works.

**Who may change settings.** The Pi's own screen and the `rpi-alert` command (both on the Pi
itself) always may. From other computers: anyone, until a web password is set — the page says so
in a banner — then only someone who has logged in. The ingest token is never sent back out, to
anyone; the page shows `mgn_ab…wxyz`. Where a receiver is (it may be someone's house) is hidden
from visitors who are not logged in. Four settings narrow this for a base station on an
organisation's network: the next section.

"The Pi itself" means any request that comes from the computer's own address (`127.0.0.1`). That
is right for a Pi whose only browser is its own screen. **On a computer where somebody browses the
web, or where a proxy of any kind runs, turn `web.behindProxy` on** (next section), even with no
proxy in front: as it comes, a web page in a browser on that computer whose name has been pointed
at `127.0.0.1` is taken for the base station itself and can change its settings, and so is every
caller of a proxy that does not send `X-Forwarded-For`. Where the agent can tell such a request
from its own — it asks for a name the base station does not go by, or carries another of a proxy's
headers — it says so in the log (`was taken for the base station itself … turn it on`); it cannot
always tell.

## The dashboard on a managed network

Four settings (0.24) for a base station on an organisation's own network — a council's, an
agency's — where somebody whose job it is asks what listens, who is let in and what is on record.
Each is as it was before 0.24 until it is set. Each is set **on the base station itself** — in
`rpi-alert.conf`, with `rpi-alert config set` over SSH, or in `config.json` — never from another
computer's browser, even logged in, and never from Flood-Net: a login from the network must not be
a way to open what the owner closed.

**Two limits, before anything else.**

- **`web.behindProxy` rests on the proxy doing its part.** The agent treats what a reverse proxy
  passes on as a visitor's only when the proxy adds `X-Forwarded-For` to every request. A proxy
  that adds no such header lets anybody who asks it for `localhost` in as the base station itself —
  the settings, the password, a reboot. The agent cannot see this from where it sits. After
  setting it up, run the check under [What the proxy has to do](#what-the-proxy-has-to-do), from
  another computer.
- **These four settings exist only from 0.24.** An earlier version ignores them: if a base
  station is put back to 0.23 or older by hand, the dashboard is again on every address, with
  nothing asked before it is read, and a proxy's callers are taken for the base station itself.
  The updater's own way back after a failed update only ever returns to the version that was
  running, so it cannot take a base station that runs 0.24 back past it.

| Setting | In `rpi-alert.conf` | As it comes | Set |
|---|---|---|---|
| `web.bind` | `web_bind = 127.0.0.1` | empty: every address the computer has | the dashboard answers on that one address, and to the computer itself |
| `web.hosts` | `web_hosts = bs01.council.example` | none | the dashboard also answers to these names |
| `web.behindProxy` | `web_behind_proxy = yes` | `false` | a reverse proxy on the same computer publishes the dashboard: what it passes on is never taken for the base station itself |
| `web.requireLogin` | `web_require_login = all` | `settings` | `all`: nothing is read without a login |

```
rpi-alert config set web.bind 127.0.0.1          then: sudo systemctl restart rpi-alert
rpi-alert config set web.hosts bs01.council.example      several with commas between; none for none
rpi-alert config set web.behindProxy true
rpi-alert config set web.requireLogin all
```

`web.bind` is taken when the agent starts; the other three hold from the next request.

**Where it listens (`web.bind`).** Left empty, the dashboard answers on every address the computer
has, as before. Given an address, it answers on that address and on `127.0.0.1` — where the
`rpi-alert` command, the Pi's own screen and the updater ask — and nowhere else, so
`web.bind = 127.0.0.1` keeps it off the network altogether. It is one address, as numbers (IPv4 or
IPv6; never `0.0.0.0` or `::`, which mean every address). An address the computer does not have — not yet, because the network has not given it, or
ever, because it was mistyped — does not stop the agent receiving and sending. The dashboard is
then on `127.0.0.1` alone, the log
says so (`cannot listen on http://10.0.0.5/ (EADDRNOTAVAIL: this machine does not have that
address) — the dashboard is on this machine only (127.0.0.1) until it can`), and the agent asks for
the address again every 30 seconds and takes it when it is there. It never falls back to every
address. To open a dashboard that is on `127.0.0.1` alone from your own computer, go through SSH:
`ssh -L 8080:127.0.0.1:80 alert@<base station>`, then `http://localhost:8080/` (whoever has a shell
on the base station is let in without the password, as on its own screen) — or publish it with a
reverse proxy, below.

**The names it answers to (`web.hosts`).** The dashboard refuses a request for a name it does not
know (`unrecognised Host header`), so that a web page somewhere else cannot point a name of its own
at the base station and read it through your browser. It knows its addresses, `localhost`, any
`.local` name and the computer's own host name. `web.hosts` adds up to 16 more: the name your DNS
gives it. Whole names, no wildcards.

**Behind a reverse proxy (`web.behindProxy`).** The dashboard is plain HTTP. For HTTPS with your
organisation's certificate, put a reverse proxy on the same computer, set `web.bind = 127.0.0.1` so
that the proxy is the only way in from the network, and turn this on. It matters because the agent
takes a request from the computer's own address (`127.0.0.1`, `::1`) for the base station itself —
its screen, or the `rpi-alert` command — and lets it in with no password; and through a proxy on
the same computer, every caller arrives from that address. With `web.behindProxy` on:

- A request that carries `X-Forwarded-For`, `Forwarded`, `X-Real-IP` or any other header a proxy
  adds (`Via`, `X-Forwarded-Proto`, `X-Forwarded-Host`, …) is never the base station itself —
  whatever the header says, however it is spelt, empty or sent twice — and neither is anything
  that follows it on the same connection.
- The caller's address — in the log, and for the limits on logins and live streams — is the last
  one in `X-Forwarded-For`: the one the proxy itself saw. That header is believed only because the
  request came from the computer's own address; sent straight from the network it is ignored.
- When the proxy says the caller came over HTTPS (`X-Forwarded-Proto: https`), the login's cookie
  is marked `Secure`.
- A request from the computer's own address with none of those headers is still the base station
  itself — that is how `rpi-alert` and the updater ask — as long as it asks for `127.0.0.1`,
  `localhost` or `::1` by name, in HTTP/1.1, and, when a browser sent it, from a page of that name.
  Every program and every user on the computer itself can send that, as before: who has a shell
  there has the base station anyway.
- A request with more than 64 header lines is never the base station itself, with this setting on
  or off: the `rpi-alert` command sends about seven and a browser about twenty. (Node.js 18 and 20
  read only the first thousand or so header lines of a request, so a caller who sent that many
  could push the header a proxy adds after them out of sight; the agent now reads them all, and
  this rule holds whatever Node.js does.)

<a id="what-the-proxy-has-to-do"></a>What the proxy has to do — **the agent cannot do this part
for it**:

1. **Add `X-Forwarded-For` to every request it passes on**, on every route, the live stream
   (`/api/events`) included. A proxy that adds nothing sends, for a caller who asks it for
   `localhost`, exactly what the `rpi-alert` command sends, and that caller is let in as the base
   station itself. The agent catches what it can of this — a request for another name, one a
   browser sent from a page of another name, one in HTTP/1.0 — treats it as a visitor's and says so
   in the log (`carried none of a reverse proxy's headers … Treated as a visitor`), but somebody who
   sets out to can get past all three.
2. **Pass the browser's `Host` on unchanged**, and list that name in `web.hosts`. A change is only
   accepted from the page it came from: the `Origin` the browser sends must match the `Host` the
   agent sees, so a proxy that puts its own target in `Host` gets `cross-site request refused` on
   every login.
3. **Connect to `127.0.0.1` (or `::1`) on the same computer.** From anywhere else — another
   computer, a container with an address of its own — its callers are all visitors, which is safe,
   but `X-Forwarded-For` is not believed, so they share one address: one lock-out, and one
   allowance of live streams, between them.
4. Send `X-Forwarded-Proto`, so that the cookie is `Secure`; and leave `/api/events` unbuffered
   (the agent asks nginx for that itself, with `X-Accel-Buffering: no`).

Tried against the agent on 11 and 18 November 2026 (Ubuntu 24.04's packages), and nginx in the
tests where it is installed:

- **nginx 1.24** adds no such header unless told to, and puts its own target in `Host`. As it
  comes, its callers are visitors only because it also speaks HTTP/1.0 to the agent — do not rely
  on that. Its three lines:

  ```nginx
  location / {
      proxy_pass http://127.0.0.1:8080;
      proxy_set_header Host $http_host;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_set_header X-Forwarded-Proto $scheme;
  }
  ```

  A `location` with a `proxy_set_header` of its own drops the ones set outside it: repeat all three
  in each. One that did not (`/api/events`, passed on in HTTP/1.1) gave the live stream to anybody.
- **Caddy 2.6** does all of it as it comes: `reverse_proxy 127.0.0.1:8080`. It puts its headers
  after the caller's own, which is where the thousand header lines above came in: against a 0.24
  agent on Node.js 18, 1,100 of them from another computer are answered `log in first`, and a wrong
  password sent that way is logged with the caller's own address.
- **HAProxy 2.8** passes `Host` on but adds no header unless told to: `option forwardfor`, and
  `http-request set-header X-Forwarded-Proto https`. Without them, a caller who asked for
  `localhost` was let in as the base station itself.

Then check it, from another computer: `curl -s https://bs01.council.example/api/status` must say
`"local":false` (or, with a login for everything, `log in first`), and none of these three may
show the settings — the agent's answer is `log in first`; to the second and third the proxy may
give one of its own:

```
curl -s https://bs01.council.example/api/config
curl -s -H 'Host: localhost' https://bs01.council.example/api/config
curl -s -H 'Host: localhost' $(printf -- '-H D:x %.0s' $(seq 1100)) https://bs01.council.example/api/config
```

(The third sends 1,100 header lines first.) The agent says the second of these in its own log when
the setting is turned on, and `rpi-alert config set web.behindProxy true` prints it. If the proxy
answers on port 80 itself, move the agent off it: `rpi-alert config set web.port 8080`.

**A login for everything (`web.requireLogin`).** `settings`, as before: looking needs no password —
the status (without where the base station is, or its addresses), the readings, the graphs, the
live stream and the station search answer anyone — and the settings need one. `all`: none of them
answers without a login (`401`, `log in first`), nor does any other route; only the page itself,
which is the same in every copy of RPi ALERT and holds no data, and the login are served, and the
page asks for the password before it shows anything. The `rpi-alert` command and the Pi's own
screen still need none. A live stream lasts as long as the login it was opened with: logged out, a
new password, or seven days, and it ends. With no password set there is no login to give, so nobody
is let in from another computer (the agent makes a password the first time it starts, shown by
`rpi-alert status`).

**Logins on record.** Every login attempt is a line in the agent's log, as a warning — in
`journalctl -u rpi-alert`, on the Log tab and in the log Flood-Net can ask for — with the caller's
address and never anything that was typed. So is a change of the password, and the login that is
handed out with the new one:

```
WARN  [web] login accepted from 10.20.0.15
WARN  [web] login refused from 10.20.0.15: wrong password (1 in a row)
WARN  [web] login refused from 10.20.0.15: wrong password (5 in a row; locked out for 30 s)
WARN  [web] login refused from 10.20.0.15: locked out for another 27 s after 5 wrong passwords — not checked
WARN  [web] login refused from 10.20.0.15: 12 more tries while locked out — not checked
WARN  [web] login accepted from 203.0.113.7 (through the proxy)
WARN  [web] login refused from 10.20.0.15: cross-site request — the password was not looked at
WARN  [web] login refused from 10.20.0.15: unrecognised Host header — the password was not looked at
WARN  [web] login refused from 10.20.0.15: a request that could not be read (bad JSON) — the password was not looked at
WARN  [web] login refused: 40 more tries in the last minute with cross-site request, from 10.20.0.15, 10.20.0.16 — not looked at
WARN  [web] password changed from 10.20.0.15
WARN  [web] login accepted from 10.20.0.15 (new password)
WARN  [web] password removed from 127.0.0.1
```

The three "not looked at" lines are login attempts the agent refuses before it reads a password:
one sent from another site's page, one that asks for a name the base station does not go by, and
one whose content cannot be read. Something sent as a password that is not text is a wrong
password, counted like any other.

Two kinds of line stand for several, so that nobody can fill the log and push the lines that
matter out of it: a locked-out address's tries, and the attempts refused unread — the first is a
line, the rest of that minute a count (with the first few addresses they came from). A request
that cannot be read at all — a broken address or cookie — is answered `400` and is no line; and if
a request makes the agent itself stumble, the first is logged in full and the rest of that minute
as a count. The agent sends its log nowhere by itself: forwarding the journal to your own collector
is the operating system's job (`systemd-journal-upload`, rsyslog).

**How wrong passwords are limited.** By address, and only so: the first four wrong passwords from
an address cost nothing; from the fifth, each locks that address out for 30 seconds longer than the
one before (30 s, 60 s, 90 s, …) up to 15 minutes, during which nothing from it is checked — the
right password is refused too. A right password from that address clears its count; so does an
hour with no wrong password from it and no lock on it, and a restart of the agent. (Before 0.24
the lock grew without end and a count was kept until the agent restarted, so one wrong password a
month later could still lock an address out for half an hour.) There is no limit across addresses:
somebody with many addresses gets four tries from each, held back only by the work of checking a
password (scrypt). The counts are in memory, for the 5,000 addresses counted most recently. The
password itself is 6 characters or more — ten letters and digits, when the agent made it.
The lock-out slows guessing; it does not stop slow guessing for ever. With the lock capped at 15
minutes, one address can still try about a hundred passwords a day — about 3,000 a month. The
password the agent makes is safe against that; one chosen by hand should be long (four or more
unrelated words, or 12 characters or more), never a word or a name.
Callers who share one address share its lock-out: an office behind one address, or a proxy that
does not say whom it forwards for — one of them guessing keeps the others out, the right password
included, for as long as the guessing goes on. The `rpi-alert` command on the base station is never
locked out. On a network where that is not enough, keep the dashboard off it (`web.bind`) or put it
behind a proxy that limits requests itself.

**A setting that cannot be read.** A slip in `config.json` must not open what it was written to
close, so for `web.bind`, `web.behindProxy` and `web.requireLogin` the agent takes the cautious
value (`127.0.0.1`, `true`, `all`) where it cannot read what was meant, and its log says so when it
starts (`settings file has problems …`, `settings file is not valid JSON …`):

- A value that makes no sense — an address mistyped, `"yes"` for `true` — or the setting under
  another spelling with the right one absent (`require_login`, `behindproxy`): that setting is the
  cautious value. Any other key under `web` that the agent does not know is named in the log and
  ignored.
- `"web": "off"`, `"web": null`, or anything else where the group of settings in `{ }` belongs: all three are the
  cautious values. (The same slip in another group — `"meganet": "off"` — costs that group its
  settings and leaves the rest of the file alone.)
- A file that cannot be read as JSON at all — a comma too many, a comment, half a file: every
  setting starts from as it comes, as before 0.24 (the token and the password are lost with it; the
  file is kept as `config.json.bad`), **except** those of the three that the file's text shows it
  set to something other than as it comes. The agent reads that from the text alone, so it errs
  towards closing: a setting's name with any value but as it comes — even one that only appears
  inside another setting's text — counts as set.
- A file that is there and cannot be opened (a link, another user's file): all three are the
  cautious values, since what it set cannot be known.

A setting that is not there at all is as it comes. The cautious values keep the dashboard on the
computer itself: `rpi-alert` over SSH still reaches it. They are **written into `config.json`**
the next time the agent saves it, so putting the slip right is not enough to open the dashboard
again — set each of the three back by hand once the file is right, if that is what you want:

```
rpi-alert config set web.bind ''                  then: sudo systemctl restart rpi-alert
rpi-alert config set web.behindProxy false
rpi-alert config set web.requireLogin settings
```

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
                                 (web.bind, web.hosts, web.behindProxy, web.requireLogin: above)
rpi-alert sdr                    the RTL-SDR sticks: number, name, channels, USB port, state
rpi-alert sdr 1                  one stick: where it is tuned, and each channel with its receiver id
rpi-alert sdr 2 freq 151.525     one stick's own setting: freq (the channels it hears, MHz), format, gain (dB or auto),
                                 ppm, squelch, bias-tee, name — "shared" goes back to the shared
                                 one; rpi-alert sdr 2 off / on. A stick by number, name or USB port
rpi-alert sdr 1 freq 151.5, 151.525, 152.4 eif
                                 several channels on one stick, all heard at once (its own first);
                                 one alone is that channel alone
rpi-alert sdr 1 channels 151.95  just its more channels ("none" for none, "shared" for the shared)
rpi-alert sdr remove 3           forget an unplugged stick (name, settings, receiver id)
rpi-alert password               the web page password
rpi-alert remote [manage|report|off]   what MegaNet's Base Stations tab may do; how check-ins go
rpi-alert access                 who may log in over SSH (docs/access.md)
sudo rpi-alert access add-key "ssh-ed25519 AAAA… you@laptop"   remove-key <fingerprint> · github <name…>|none
rpi-alert access meganet on|off · from private|any · password-login on|off|unchanged · ssh on|off · sync
sudo rpi-alert access alert-password [--none]   the alert account's password (the console)
rpi-alert record 151.5375        keep the IQ of every burst on these channels (off: stop; clear: delete
                                 them all); with nothing after it, what is kept and the newest
rpi-alert readings [n] · log [n] · test-audio [alert|alert2|beep] · send-now · version
sudo journalctl -u rpi-alert -f  the full log
sudo systemctl restart rpi-alert
```

## The boot-partition file (`rpi-alert.conf`)

`key = value` lines, `#` comments; applied at every boot in which the file is present, then
renamed `rpi-alert.conf.applied` with secrets blanked; results in `rpi-alert-boot.log`.
Example with every key: [os/boot/rpi-alert.conf.example](../os/boot/rpi-alert.conf.example).

**A computer with no boot partition** (0.24) — one that is not a Raspberry Pi — reads the same
file from **`/etc/rpi-alert.conf`**, when no boot partition holds one: at boot, or at once with
`sudo rpi-alert import-boot-config`. It is root's file, in `/etc` beside the agent's folder
`/etc/rpi-alert` and not in it, because it is applied as root and can give the `alert` account a
key or a password, and the agent — the part that faces the network — can write in its own folder:
a file there is never applied. Put it there as root (`sudo install -m 600 my-settings
/etc/rpi-alert.conf`): it is applied only when it is a plain file that belongs to root and that
nobody else can write — not a link, not another user's, not writable by its group or by everybody
— and otherwise left where it is, with the reason in the journal. Once applied it becomes
`/etc/rpi-alert.conf.applied` (root's, secrets blanked); what happened is in
`journalctl -u rpi-alert-boot-config`.

| Key | Value | Setting |
|---|---|---|
| `token` | `mgn_…` | `meganet.token` |
| `request_token` | yes / no | `meganet.autoRequest` — with no token, ask MegaNet for one at boot and keep asking until an administrator approves it |
| `name` | text | `name` — what MegaNet calls this base station |
| `latitude`, `longitude` | decimal degrees | `location` (approximate) |
| `location_station` (+ `location_station_name`) | MegaNet station id, with `latitude`/`longitude` | `location.source = station` |
| `use_gps` | yes / no | `location.useGps` |
| `gps_bluetooth` | Bluetooth address, or off | a Bluetooth GPS (an Emlid Reach set to *Position output → Bluetooth, NMEA*): Bluetooth turned on, the receiver paired and kept connected by `rpi-alert-btgps.service`, read as `/dev/rpi-alert-gps` (added to `receivers.extraPorts`); turns `location.useGps` on unless `use_gps` says otherwise. For a mobile unit |
| `gps_bluetooth_pin` | e.g. 123456 | the PIN the receiver asks for when pairing (Emlid's default is 123456): up to 16 letters and digits |
| `gps_bluetooth_channel` | 1–30 | its serial channel, if not 1 (else 1 to 10 are tried) |
| `sdr_frequency_mhz` | e.g. `151.5, 151.525, 151.95, 152.4` (what the set-up page fills in), or one, or with a format: `152.4 eif` | The channels one stick hears: `receivers.sdr.freqHz` (the first) and `receivers.sdr.moreChannels` (the rest, all heard at once). One alone is that channel alone, unless `sdr_more_channels_mhz` gives the more channels. Absent: MegaNet's four |
| `sdr_more_channels_mhz` | e.g. `151.525, 152.4`, or none | `receivers.sdr.moreChannels` alone |
| `sdr_format` | binary / enhanced_iflows / ascii | `receivers.sdr.format` |
| `sdr_gain_db` | dB, or auto | `receivers.sdr.gainDb` |
| `sdr_sample_rate` | auto, or 240000, 288000, 960000, 1200000, 1440000, 1920000, 2400000 | `receivers.sdr.sampleRate`: the window (auto: the narrowest that holds the channels) |
| `sdr_sample_rate_min`, `sdr_sample_rate_max` | none, or one of the windows above | `receivers.sdr.sampleRateMin` / `sampleRateMax` (0.20): the narrowest and the widest window *auto* may take |
| `sdr_ppm`, `sdr_bias_tee`, `sdr_squelch_db`, `sdr_decoder` (`lean`/`full`/`light`/`compare`/`compare-light`), `sdr_watch` (`always`/`bursts`/`check`), `sdr` (on/off) | | `receivers.sdr.*` — every stick's; a stick's own settings are made once it has been plugged in (web page, or `rpi-alert sdr`) |
| `auto_detect` | yes / no | `receivers.autoDetect` |
| `extra_ports` | e.g. /dev/serial0 | `receivers.extraPorts` (a GPIO-UART GPS, say) |
| `audio` | auto / live / synth / beep / off | `audio.mode` |
| `audio_device`, `audio_volume` | ALSA name; 0–100 | `audio.*` |
| `kiosk` | auto / on / off | `kiosk.mode` |
| `web_password` | text | stored hashed (scrypt) |
| `web_bind` | an address, `localhost`, or `all` | `web.bind` (0.24): the address the dashboard listens on — [on a managed network](#the-dashboard-on-a-managed-network) |
| `web_hosts` | names, or none | `web.hosts`: more names the dashboard answers to |
| `web_behind_proxy` | yes / no | `web.behindProxy`: a reverse proxy on the same computer publishes the dashboard |
| `web_require_login` | all / settings | `web.requireLogin`: `all` — nothing is read without a login |
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
| `hotspot` | auto / on / off | `hotspot.mode`: the Pi's own Wi-Fi network for a phone where there is no other (auto: after three minutes with no network) |
| `hotspot_ssid`, `hotspot_password` | text | its name (RPi-ALERT-… if absent) and password (8–63 characters, no spaces; made on the Pi if absent) — the password wiped from the card |
| `self_recovery` | full / network / off | `recover.mode`: what the Pi does by itself when it loses touch with MegaNet (full if absent) |
| `survey` | the site's name | start a site survey at this power-up ([survey.md](survey.md)) |
| `survey_hours` | e.g. 72, or 0 | hours of listening before it ends itself (0: until ended); 72 if absent |
| `survey_readings` | yes / no | send the survey's readings to MegaNet too (no: only its receptions) |

## `config.json` reference

| Key | Default | Meaning |
|---|---|---|
| `name` | `RPi ALERT <hostname>` | Base station name; each receiver reports as "name — receiver" |
| `meganet.enabled` | true | Send to MegaNet at all |
| `meganet.token` | — | The ingest token |
| `meganet.autoRequest` | false | With no token, ask MegaNet for one by itself and keep a request open (a new one each time one runs out). Turns itself off once a token is approved, when an administrator turns a request down, or on *Stop asking* |
| `meganet.endpoints` | floodwarning.net `/api/db` proxy, then the Supabase project | Tried in order; the one that works is remembered |
| `meganet.receptions` | true | Also post every frame heard to `report_receptions` (Reception Map). A site survey's go whatever this says |
| `meganet.queueMb` | 1024 | How much of the SD card what waits for MegaNet may take (16–65536 MB). It is on the card, not in memory; past this, or with under 256 MB of the card free, the oldest is dropped and counted |
| `meganet.stationsUrls` | floodwarning.net, then GitHub Pages `stations.json` | The register used to name stations (daily, cached) |
| `location.source` | none | none · manual · station · gps (GPS only) |
| `location.lat/lon/accuracy_m/station/stationName` | — | The fixed location |
| `location.useGps` | true | A GPS fix, when there is one, is used instead |
| `receivers.autoDetect` | true | Recognise serial devices from what they send |
| `receivers.ports[]` | — | Per-port overrides: `{ match, type: auto/quansheng/ert-a2/gps/ignore, baud, name }`; `match` is a `/dev/serial/by-id/…` path, a `/dev` name or `vvvv:pppp` |
| `receivers.extraPorts[]` | — | Non-USB ports to scan too |
| `receivers.sdr.enabled` | true | Use RTL-SDR sticks |
| `receivers.sdr.freqHz` | 151500000 | The ALERT channel (a stick's own) |
| `receivers.sdr.moreChannels` | 151.525, 151.95 and 152.4 MHz | More channels for the same stick to decode at once, each a receiver of its own: `[{ freqHz, format }]`, `format` left out for the stick's own. At most 7, within 1.89 MHz of each other and of `freqHz` (the widest window); none listed twice. By default the rest of the channels MegaNet's stations use, so a new base station hears all four. While they are those, a change to `freqHz` alone (MegaNet's Base Stations tab, `rpi-alert config set`) keeps them: the channel moved to stops being a more channel, the one left becomes one, and any too far from the new one to share the stick are dropped. More channels anyone chose stay as they are |
| `receivers.sdr.format` | BINARY | BINARY · ENHANCED_IFLOWS · ASCII (one per channel: alert-dsp.js explains why) |
| `receivers.sdr.sampleRate` | 0 (auto) | A stick's window, in samples a second. 0: the narrowest that holds its channels — 20 kHz or more from the DC spike, clear of each other's mirror images. Or exactly one of 240000, 288000 (0.22), 960000, 1200000, 1440000, 1920000, 2400000; a channel that does not fit in it is not decoded, and says so. Every channel's decoder takes in the whole window: 960000 is about three times 240000's work a channel, 1920000 five. Settings from before 0.15 (version 1), where a rate set by hand was raised for channels that needed more, are carried over: 240000 — set to mean as light as the channels allow — becomes 0, which now means that; any other is kept, exactly |
| `receivers.sdr.sampleRateMin`, `sampleRateMax` | 0, 0 (no limits) | 0.20: with `sampleRate` 0, the narrowest and the widest window it may take — each 0 or one of the windows above. Automatic takes the narrowest that holds the channels, then the narrowest allowed if that is narrower, or the widest allowed if it is wider (the channels that do not fit are not decoded, and say so). The narrowest may not be wider than the widest; where a stick's own and the shared ones cross, the widest wins. Each stick may have its own |
| `receivers.sdr.offsetHz` | 0 (auto) | One channel: tune this far below it (default rate/4) to keep the DC spike off it. Several are placed by the agent |
| `receivers.sdr.gainDb` | 29.7 | null = tuner AGC |
| `receivers.sdr.ppm`, `biasTee`, `gate`, `squelchDb`, `minVotes`, `minVotesCrc` | 0, false, true, 8, 4, 4 | Tuner correction, bias tee, burst gate and decoder vote bars |
| `receivers.sdr.alert2` | true | Also try every burst the legacy decoder reads nothing in as ALERT2 (AirLink, 4800 bps) — on every channel of every stick; its readings go as protocol `alert2`: [ALERT2 off the air](#alert2-off-the-air) |
| `receivers.sdr.decoder` | `lean` | `lean` (a third of the full decoder's time), `full` (the 45-guess decoder) or `compare` (full sent, lean checked against it on every burst): [The decoder](#lean-decoder) |
| `receivers.record` | `{ freqHz: [], maxMb: 256 }` | Channels whose every burst is kept as IQ, and how much of the card they may take (16–8192 MB): [Recordings](#recordings) |
| `receivers.sdrDevices[]` | — | Each stick's own settings: `{ key, name, enabled, freqHz, format, moreChannels, sampleRate, sampleRateMin, sampleRateMax, gainDb, ppm, biasTee, squelchDb }`, `key` being the stick's as the Receivers page and `rpi-alert sdr` show it (`sdr-serial:00000001`, `sdr-port:1-1.4`); a setting left out is the shared one (`moreChannels: []` is none). A stick given a `freqHz` of its own while on MegaNet's channels keeps them around it, as above (a stick on 162 MHz: none fit, so that channel alone). Entries 0.4 wrote by `{ serial }` alone still apply, to every stick with that serial |
| `audio.enabled`, `audio.mode`, `audio.device`, `audio.volume` | true, auto, default, 80 | The chirps |
| `web.port` | 80 | The dashboard (8080 if 80 is refused) |
| `web.bind` | empty | 0.24: the one address the dashboard listens on, beside `127.0.0.1`; empty is every address. Taken when the agent starts. [On a managed network](#the-dashboard-on-a-managed-network), as the three below |
| `web.hosts` | `[]` | Up to 16 more names the dashboard answers to, beside its addresses, `localhost`, `.local` names and the host name |
| `web.behindProxy` | false | A reverse proxy on the same computer publishes the dashboard: a request it passed on is never the base station itself, and its caller's address is the one the proxy saw |
| `web.requireLogin` | `settings` | `settings`: looking needs no login, the settings do. `all`: nothing is read without one |
| `kiosk.mode` | auto | auto: full-screen dashboard while a monitor is connected and the Pi has ≥ 900 MB |
| `system.timezone` | — | Set from the page; an ERT-A2's ALERT2 frame times are local (off the air they are UTC) |
| `remote.mode` | manage | manage · report · off — what MegaNet's Base Stations tab may do. Set only on the Pi: MegaNet cannot change it |
| `remote.idleS` | 60 | How often to check in with MegaNet while nobody has the base station open (30–900 s) |
| `hotspot.mode` | auto | The Pi's own Wi-Fi network: auto — up after three minutes with no network (neither Ethernet nor a Wi-Fi network joined), down the moment there is one, and, with nobody on it, stepping aside every ten minutes for a minute and a half so the Pi can join a Wi-Fi network it knows; on — always (it takes the Wi-Fi radio); off. Set on the Pi only: MegaNet sees whether a password is set, never the password, and cannot change any of it |
| `hotspot.ssid` | — | Its name; empty is `RPi-ALERT-` and the first four of the host id |
| `recover.mode` | full | What the Pi does by itself when no MegaNet door has answered for two minutes (0.23, [how-it-works.md](how-it-works.md)): `full` — join its saved Wi-Fi network again, renew the connection, restart NetworkManager at fifteen minutes, and reboot the Pi after 45 (each reboot in one outage after a longer wait: 3 h, 12 h, a day; never in a survey, with a phone on the hotspot, during an update, or a Pi that has not reached MegaNet in a week); `network` — all of that but the reboot; `off` — only keep what is heard, as before 0.23. MegaNet's Base Stations tab can change it; `rpi-alert recover` shows what it is doing and the last times the link was lost |
| `hotspot.password` | made on the Pi | WPA2, 8–63 characters, no spaces; made the first time the agent starts (`xxxx-xxxx-xxxx`) and shown on the Overview, `rpi-alert hotspot` and the Survey page |

Environment variables (for development and tests): `RPI_ALERT_CONFIG`, `RPI_ALERT_DATA`,
`RPI_ALERT_DEV`, `RPI_ALERT_SYSFS`, `RPI_ALERT_PRIV`, `RPI_ALERT_ASSUME_CLOCK=1`,
`RPI_ALERT_LOG_LEVEL=debug`, `RPI_ALERT_PORT` (the CLI), `RPI_ALERT_BOOT_DIRS` and
`RPI_ALERT_ETC_CONF` (where `rpi-alert.conf` is looked for).
