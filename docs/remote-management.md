# Remote management: MegaNet's Base Stations tab

A base station with a MegaNet ingest token checks in with MegaNet's **Base Stations** tab
(MegaNet's migration 0049). There, MegaNet's administrators see every base station's health in one
list and — if the base station allows it — change its settings, restart it, install updates and read
its log, without anybody going to site.

## Which way the connection goes

```
 RPi ALERT ──HTTPS, X-Ingest-Token──▶ floodwarning.net /api/db (or Supabase)  ◀── MegaNet's Base Stations tab
           ◀── "next in 60 s" + anything asked                               (an administrator, signed in)
```

**The base station calls MegaNet; MegaNet never calls the base station.** There is no port to open,
no tunnel, nothing listening for MegaNet, and nothing a stranger could connect to. The Pi asks over
the same HTTPS door, with the same ingest token, as its readings — so it works wherever the readings
get out, behind any NAT, firewall or cellular modem — once a minute:

```
POST <endpoint>/rpc/base_station_checkin    apikey · X-Ingest-Token · Content-Profile: meganet
{"payload": {"v": 1, "agent": {"app": "RPi ALERT", "version": "0.7.1"}, "mode": "manage", "idle_s": 60,
             "beat": {…}, "status": {…}, "results": [{"id": 17, "ok": true, "result": …}], "keys_hash": "…"}}
→ {"next_s": 60, "watch": false, "want_status": false, "commands": [{"id": 18, "verb": "log", "args": {"lines": 200}}],
   "keys_hash": "…", "label": "Mt Stuart base"}
```

- The **heartbeat** goes every time — a few hundred bytes: uptime, temperature, load, free memory
  and disk, under-voltage, the clock, what is queued for MegaNet, and each receiver's state, what it
  has decoded and when it last sent anything.
- The **whole status** goes when something in it changed, every quarter of an hour, and when an
  administrator opens the base station: the receivers and their settings, the uplink, the clock,
  where it is, the software and its update state, who may log in over SSH (fingerprints and
  comments, never a key), and the settings — less the ingest token (not even masked) and the web
  password.
- MegaNet's answer says when to check in next: a minute normally (± 10 %, so a fleet started by one
  power cut does not check in in step), **every five seconds while an administrator has this base
  station open** (MegaNet stops asking for that three minutes after they close it), and at once
  after doing something, to deliver the answer.

## What MegaNet may ask

Only these, each done once — MegaNet hands a request over once, and the Pi remembers which it has
done — and each written in the Pi's log and on its web page:

| Request | |
|---|---|
| `status` | send the whole status now |
| `log` | the last 1–400 lines of the agent's log |
| `config.set` | change settings, through the same checks as the web page. **Never** the ingest token, the endpoints, the API key or the station register's address (only `meganet.enabled` and `meganet.receptions` of the MegaNet settings), the web page's password or port, or `remote.*` — MegaNet cannot widen its own reach |
| `device.restart`, `device.rescan`, `device.forget` | restart a receiver; look for receivers; forget an unplugged one |
| `send-now`, `stations.refresh` | send what is queued now; download the station register again |
| `agent.restart`, `reboot` | done once the answer has reached MegaNet (or after a minute, if it cannot) |
| `update.check`, `update.install`, `update.auto` | check for, install, and schedule updates — the same installer as the web page, which puts the old version back if the new one does not start |
| `access.sync` | fetch the SSH key lists again |

Nothing else: no shell, no files, no SSH keys, and nothing secret in either direction. A request
for anything else is answered *"this base station cannot …"*. Not a power-off: a Pi on a hill that
was told to shut down needs someone to drive there.

MegaNet keeps its own checks too: only an administrator can ask, only these verbs, at most 20
waiting per base station, and a request not collected within ten minutes expires rather than
running hours later.

## How much MegaNet may do — the Pi decides

`remote.mode`, set on the Pi only:

| | |
|---|---|
| `manage` (default) | health, and the requests above |
| `report` | health only; anything asked is refused (by MegaNet, and by the Pi too) |
| `off` | no check-ins at all. Switched off while running, it says so once, so MegaNet shows "turned off" rather than a station that went quiet |

Set it on the web page (**Settings → Remote management**), with `rpi-alert remote manage|report|off`,
or with `remote_management = …` in `rpi-alert.conf`. `remote.idleS` (30–900 s, default 60) is how
often to check in when nobody is watching.

The web page shows the state ("checking in, last 20 s ago as *Mt Stuart base*"), a chip in its header
while an administrator has the base station open, and the last things asked with what became of each.

## What it costs the base station

One small HTTPS request a minute from the agent's main thread; the decoding runs in worker threads
of its own and never waits for it. The heartbeat and status are built from what the agent already
holds; the update and SSH state are asked of the root helper once a quarter of an hour. A MegaNet
that does not have the Base Stations tab yet (no migration 0049) is asked again an hour later, and
a refused token every fifteen minutes. Readings never wait on any of it.

## Security, in one place

- Nothing listens. The Pi's web page is still the only thing on the network, as before.
- The ingest token authenticates the Pi to MegaNet, as for readings; TLS authenticates MegaNet to the
  Pi. A request can only come from a MegaNet administrator (the database refuses anybody else).
- Someone who got into MegaNet could do what its administrators can: the requests above, on base
  stations set to `manage`. They could not get the token, redirect the readings, set the web page's
  password, add an SSH key, turn management back on, or run a command. `report` or `off` on the Pi
  takes even that away.
- SSH keys are a separate list a Pi has to choose to take ([access.md](access.md)), fetched by root,
  never pushed.
