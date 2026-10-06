'use strict';
// A site survey: this Pi left at a candidate site — a repeater or base
// station that might be built — for a day or three, often with no network,
// to find out which stations can be heard there and how strongly. What it
// hears is kept on the card (the queue is on disk, lib/spool.js) and goes to
// MegaNet when the Pi is next on a network, where the Reception Map's Site
// surveys panel lays it beside what the network itself stored (docs/survey.md).
//
// While a survey runs:
//   * every frame heard goes to MegaNet as a reception (report_receptions,
//     0047) tagged { survey: id, survey_name } in its detail — whatever
//     meganet.receptions says, because they are the survey. Each carries
//     where the Pi was and its signal, and MegaNet keeps them, of any age.
//   * readings do not go to ingest_http unless the survey says so. A reading
//     posted days late marks its station "last seen" now, and is stored as a
//     second copy beside the one the network kept (MegaNet deduplicates on
//     the exact time, and two receivers never time a burst the same), so the
//     survey's evidence is its receptions.
//   * a tally of what was heard — each address's frames, good and bad, its
//     signal and its SNR — is kept here, so the result can be read on the Pi
//     itself (the dashboard's Survey page) before it is ever on a network.
//
// It starts now (the dashboard, `rpi-alert survey start`), at the next power
// up (armed, for a Pi set up in the office and switched on at the site), or
// from `survey = <name>` on the SD card. It ends when asked, when its planned
// hours of listening are up (counted on the monotonic clock, so it needs no
// clock and the hours a Pi is switched off do not count), or when a GPS fix
// puts the Pi more than half a kilometre from where the survey began — it has
// been taken away, and what it hears now is not the site's.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { mono } = require('./clock');

const TICK_MS = 30000, SAVE_MS = 5 * 60 * 1000, HISTORY = 10;
const MOVE_M = 500, ANCHOR_ACC_M = 100;
// Bytes a frame heard costs on the card while it waits (a reception ~450, its reading ~220).
const BYTES_PER_FRAME = 700;
// A guess at what one channel hears in a day, before the survey has heard enough to say.
const FRAMES_PER_CHANNEL_DAY = 12000;

function metres(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// The p-th fraction of a histogram { bin: count }.
function quantile(hist, p) {
  const bins = Object.keys(hist || {}).map(Number).sort((a, b) => a - b);
  let n = 0;
  for (const b of bins) n += hist[b];
  if (!n) return null;
  let acc = 0;
  for (const b of bins) { acc += hist[b]; if (acc >= p * n) return b; }
  return bins[bins.length - 1];
}

function cleanName(v) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60); }
function cleanHours(v) { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 24 * 30 ? Math.round(n * 10) / 10 : 72; }

class Survey extends EventEmitter {
  constructor(agent) {
    super();
    this.agent = agent;
    this.log = agent.log.child('survey');
    this.file = path.join(agent.dataDir, 'survey.json');
    this.requestFile = path.join(agent.dataDir, 'survey-request.json');   // written by `survey = …` on the SD card
    this.s = null;            // the survey running, armed, or the one that last ended
    this.history = [];        // summaries of the ones before
    this.lastMono = null;
    this.dirty = false;
    this.savedAt = 0;
    this.far = 0;
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.s = j.current || null;
      this.history = Array.isArray(j.history) ? j.history.slice(0, HISTORY) : [];
    } catch (_) {}
    return this;
  }

  start() {
    const boot = this.agent.clock.bootId();
    if (this.s && this.s.state === 'running') this.log.info('carrying on with survey "' + this.s.name + '" (' + this.s.id + ') after a restart');
    if (this.s && this.s.state === 'armed' && this.s.armedBoot !== boot) this.begin(this.s, 'armed at the last power-up');
    // `survey = …` on the SD card: start one now, at this power-up.
    try {
      const req = JSON.parse(fs.readFileSync(this.requestFile, 'utf8'));
      fs.unlinkSync(this.requestFile);
      if (req && req.name) {
        if (this.running()) this.end('replaced by the SD card\'s survey');
        this.begin({ name: req.name, hours: req.hours, readings: !!req.readings }, 'the SD card asked for it');
      }
    } catch (_) {}
    this.agent.clock.on('trusted', () => this.clockKnown());
    this.agent.on('gps', (fix) => this.gps(fix));
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    this.lastMono = mono();
    return this;
  }

  stop() { clearInterval(this.timer); this.tick(); this.saveNow(); }

  running() { return !!this.s && this.s.state === 'running'; }

  // ── starting and ending ─────────────────────────────────────────────────

  newId() { return 's-' + (this.agent.state.data.hostId || 'x') + '-' + crypto.randomBytes(3).toString('hex'); }

  // o: { name, hours, readings }; when: 'now' | 'boot'
  open(o, when) {
    const name = cleanName(o && o.name);
    if (!name) throw Object.assign(new Error('A survey needs a name — what the site is called.'), { status: 400 });
    if (this.running()) this.end('a new survey was started');
    const s = { id: this.newId(), name, hours: cleanHours(o.hours), readings: !!o.readings };
    if (when === 'boot') {
      this.s = Object.assign(s, { state: 'armed', armedAt: this.agent.clock.trusted() ? this.agent.clock.now() : null, armedBoot: this.agent.clock.bootId() });
      this.log.info('survey "' + name + '" armed: it starts at the next power-up');
      this.saveNow();
      this.emit('change');
      return this.s;
    }
    return this.begin(s, 'started from the dashboard');
  }

  begin(o, why) {
    const c = this.agent.clock;
    this.s = {
      id: o.id || this.newId(), name: cleanName(o.name) || 'Site survey', hours: cleanHours(o.hours), readings: !!o.readings,
      state: 'running', startedAt: c.trusted() ? c.now() : null, startBoot: c.bootId(), startMono: mono(), elapsedMs: 0,
      anchor: null, endedAt: null, endedWhy: null,
      totals: { ok: 0, bad: 0, undecoded: 0, untimed: 0 }, ids: {}, points: {},
    };
    this.lastMono = mono();
    const loc = this.agent.location();
    if (loc.source !== 'none') this.s.where = { lat: loc.lat, lon: loc.lon, source: loc.source };
    if (loc.source === 'gps' && Number.isFinite(loc.lat) && !(loc.accuracy_m > ANCHOR_ACC_M)) this.s.anchor = { lat: loc.lat, lon: loc.lon };
    this.log.info('survey "' + this.s.name + '" (' + this.s.id + ') started — ' + why + (this.s.hours ? ', for ' + this.s.hours + ' h of listening' : ''));
    this.saveNow();
    this.emit('change');
    return this.s;
  }

  end(why) {
    if (!this.s || this.s.state === 'ended') return null;
    const c = this.agent.clock;
    if (this.s.state === 'armed') { this.log.info('survey "' + this.s.name + '" disarmed'); this.s = null; this.saveNow(); this.emit('change'); return null; }
    this.tick(true);
    this.s.state = 'ended';
    this.s.endedAt = c.trusted() ? c.now() : null;
    this.s.endedWhy = why || 'ended';
    this.history.unshift(this.summary(this.s));
    this.history = this.history.slice(0, HISTORY);
    this.log.info('survey "' + this.s.name + '" ended (' + this.s.endedWhy + '): ' + this.s.totals.ok + ' good frames from ' + Object.keys(this.s.ids).length + ' addresses');
    this.saveNow();
    this.emit('change');
    return this.s;
  }

  summary(s) {
    return { id: s.id, name: s.name, startedAt: s.startedAt, endedAt: s.endedAt, endedWhy: s.endedWhy, elapsedMs: s.elapsedMs,
      totals: s.totals, addresses: Object.keys(s.ids).length, where: s.where || null };
  }

  clockKnown() {
    const s = this.s;
    if (s && s.state === 'running' && s.startedAt == null && s.startBoot === this.agent.clock.bootId()) {
      s.startedAt = Math.round(this.agent.clock.wallOf(s.startMono));
      this.dirty = true;
    }
  }

  // Listening time, and whether it is over.
  tick(quiet) {
    const now = mono();
    const s = this.s;
    if (s && s.state === 'running' && this.lastMono != null) {
      s.elapsedMs += Math.max(0, now - this.lastMono);
      this.dirty = true;
      if (!quiet && s.hours && s.elapsedMs >= s.hours * 3600e3) { this.lastMono = now; this.end('its ' + s.hours + ' h of listening are up'); return; }
    }
    this.lastMono = now;
    if (this.dirty && Date.now() - this.savedAt > SAVE_MS) this.saveNow();
  }

  // A GPS fix: where the survey is, and whether the Pi has been taken away.
  gps(fix) {
    const s = this.s;
    if (!s || s.state !== 'running' || !fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return;
    if (fix.accuracy_m > ANCHOR_ACC_M) return;
    if (!s.anchor) { s.anchor = { lat: fix.lat, lon: fix.lon }; s.where = { lat: fix.lat, lon: fix.lon, source: 'gps' }; this.dirty = true; return; }
    // Two fixes in a row far away, not one stray one.
    if (metres(s.anchor, fix) > MOVE_M) { if (++this.far >= 2) this.end('the GPS says it was moved more than ' + MOVE_M + ' m from where the survey began'); }
    else this.far = 0;
  }

  // ── what is heard ───────────────────────────────────────────────────────

  // What goes in a reception's detail while a survey runs; null when none does.
  tag() { return this.running() ? { survey: this.s.id, survey_name: this.s.name } : null; }
  // Whether readings go to ingest_http now.
  sendReadings() { return !this.running() || this.s.readings; }

  // Every frame a receiver heard (agent.deviceReception), as it is sent.
  heard(pointId, freqMhz, rx) {
    if (!this.running()) return;
    const s = this.s;
    const p = s.points[pointId] || (s.points[pointId] = { ok: 0, bad: 0, undecoded: 0, freq_mhz: freqMhz || null });
    if (rx.heard_at == null) s.totals.untimed++;
    if (rx.alert_id == null) { s.totals.undecoded++; p.undecoded++; this.dirty = true; return; }
    const t = s.ids[rx.alert_id] || (s.ids[rx.alert_id] = { ok: 0, bad: 0, first: Date.now(), last: 0, lv: {}, sn: {}, u: null, pts: {} });
    if (rx.ok) { t.ok++; s.totals.ok++; p.ok++; } else { t.bad++; s.totals.bad++; p.bad++; }
    t.last = Date.now();
    t.pts[pointId] = (t.pts[pointId] || 0) + 1;
    if (rx.ok) {
      const dbm = Number.isFinite(rx.rssi_dbm) ? rx.rssi_dbm : null, dbfs = Number.isFinite(rx.level_dbfs) ? rx.level_dbfs : null;
      const lv = dbm != null ? dbm : dbfs;
      if (lv != null) { t.lv[Math.round(lv)] = (t.lv[Math.round(lv)] || 0) + 1; t.u = dbm != null ? 'dBm' : 'dBFS'; }
      const d = rx.detail || {};
      const snr = Number.isFinite(d.snr_db) ? d.snr_db : (dbm != null && Number.isFinite(rx.nf_dbm) ? dbm - rx.nf_dbm : null);
      if (snr != null) t.sn[Math.round(snr)] = (t.sn[Math.round(snr)] || 0) + 1;
    }
    this.dirty = true;
  }

  // ── for the dashboard ───────────────────────────────────────────────────

  stations() {
    const s = this.s;
    if (!s) return [];
    const loc = this.agent.location();
    return Object.entries(s.ids).map(([id, t]) => {
      const cands = this.agent.stations.lookup(Number(id), loc.lat != null ? loc : null);
      const st = cands[0] || null;
      return {
        alert_id: Number(id), station: st ? { id: st.id, name: st.name, km: st.km ?? null, kind: st.kind || '' } : null, shared: cands.length > 1 ? cands.length : 0,
        ok: t.ok, bad: t.bad, first: t.first, last: t.last, unit: t.u,
        level: { p10: quantile(t.lv, 0.1), p50: quantile(t.lv, 0.5), p90: quantile(t.lv, 0.9) }, snr: quantile(t.sn, 0.5),
        points: Object.keys(t.pts),
      };
    }).sort((a, b) => b.ok - a.ok || a.alert_id - b.alert_id);
  }

  async status() {
    const s = this.s;
    const out = {
      state: s ? s.state : 'none', now: Date.now(), history: this.history,
      readiness: await this.readiness(),
    };
    if (s) {
      Object.assign(out, {
        id: s.id, name: s.name, hours: s.hours, readings: s.readings, startedAt: s.startedAt || null, endedAt: s.endedAt || null, endedWhy: s.endedWhy || null,
        elapsedMs: s.elapsedMs || 0, endsInMs: s.state === 'running' && s.hours ? Math.max(0, s.hours * 3600e3 - s.elapsedMs) : null,
        where: s.where || null, anchor: s.anchor || null, totals: s.totals || null, points: s.points || {},
        stations: s.state === 'armed' ? [] : this.stations(),
      });
    }
    return out;
  }

  // Whether this Pi is ready to be left at a site with no network: each check
  // { key, level: good | warn | bad, label, detail }.
  async readiness() {
    const a = this.agent;
    const out = [];
    const add = (key, level, label, detail) => out.push({ key, level, label, detail });

    const dev = a.devices.status();
    const sdrCh = dev.sdrs.filter(d => d.state === 'running').reduce((n, d) => n + ((d.channels && d.channels.length) || 1), 0);
    const radios = dev.ports.filter(p => p.state === 'running' && ['quansheng', 'ert-a2'].includes(p.kind)).length;
    const channels = sdrCh + radios;
    if (channels) add('receivers', 'good', channels + ' receiver channel' + (channels === 1 ? '' : 's') + ' listening', dev.sdrs.filter(d => d.state === 'running').map(d => d.name).concat(dev.ports.filter(p => p.state === 'running' && p.kind !== 'gps').map(p => p.name)).join(', '));
    else add('receivers', 'bad', 'Nothing is listening', 'Plug in an RTL-SDR stick, a Quansheng radio or an ERT-A2 — the Receivers page says what it sees.');

    const loc = a.location();
    if (loc.source === 'gps') add('location', 'good', 'GPS fix' + (Number.isFinite(loc.accuracy_m) ? ' ±' + Math.round(loc.accuracy_m) + ' m' : ''), 'Each frame is stored with where it was heard, exactly; and the survey ends itself if the Pi is moved.');
    else if (loc.source === 'manual' || loc.source === 'station') add('location', 'warn', 'Location typed in (approximate)', 'Each frame is stored at ' + loc.lat.toFixed(5) + ', ' + loc.lon.toFixed(5) + ' — make sure that is the site, not the office. A USB GPS makes it exact.');
    else add('location', 'bad', 'No location', 'Set the site\'s coordinates (Settings → Location) or plug in a USB GPS: a survey with no position cannot be mapped.');

    const c = a.clock.status();
    const rtc = c.rtc;
    if (c.source === 'gps') add('clock', 'good', 'Time from the GPS', 'Survives a power cut for as long as the GPS gets a fix.');
    else if (c.source === 'rtc') add('clock', 'good', 'Time from the battery RTC', 'Checked against NTP or a GPS on ' + new Date(rtc.verifiedAt).toLocaleDateString() + '; it keeps time through a power cut.');
    else if (c.source === 'ntp' && rtc && rtc.usable) add('clock', 'good', 'Time from NTP, kept by the battery RTC', 'The RTC carries the time through a power cut with no internet.');
    else if (c.trusted) add('clock', 'warn', 'Time from NTP only — until the next power cut', 'With no internet, GPS or battery RTC, a power cut loses the time: what is heard afterwards waits on the card until the time is known again in that same power-up, and is lost if it never is. A USB GPS (or a Pi 5 RTC battery, or an RTC board) closes the gap.' + (rtc && rtc.note ? ' ' + rtc.note : ''));
    else add('clock', 'bad', 'The time is not known', 'Nothing heard can be timed until NTP or a GPS gives the time in this power-up. Join a network once (a phone hotspot will do), or plug in a USB GPS.' + (rtc && rtc.note ? ' ' + rtc.note : ''));

    const up = a.uplink.status();
    const info = await require('./system').info().catch(() => ({}));
    const free = info.disk ? info.disk.freeMb : null;
    const room = Math.min(up.queueLimitMb - up.queueMb, free != null ? free - 256 : Infinity);
    const s = this.s && this.s.state === 'running' ? this.s : null;
    const perDay = s && s.elapsedMs > 3600e3
      ? (s.totals.ok + s.totals.bad + s.totals.undecoded) / (s.elapsedMs / 86400e3)
      : Math.max(1, channels) * FRAMES_PER_CHANNEL_DAY;
    const days = room / (perDay * BYTES_PER_FRAME / 1048576);
    const rate = Math.round(perDay).toLocaleString() + ' frames a day' + (s && s.elapsedMs > 3600e3 ? ' so far' : ' (a guess for ' + Math.max(1, channels) + ' channel' + (channels === 1 ? '' : 's') + ')');
    if (days >= 7) add('storage', 'good', 'Room for ' + (days > 60 ? 'months' : Math.floor(days) + ' days') + ' on the card', Math.round(room) + ' MB free for the queue at ' + rate + '. It is kept on the card, not in memory.');
    else add('storage', days >= 3 ? 'warn' : 'bad', 'Room for ' + days.toFixed(1) + ' days on the card', Math.round(room) + ' MB free for the queue at ' + rate + ' — raise meganet.queueMb or use a bigger card.');

    const memMb = a.board && a.board.memMb;
    if (memMb) add('memory', memMb >= 900 ? 'good' : 'warn', memMb + ' MB of RAM', memMb >= 900
      ? 'Plenty: what waits for MegaNet is on the card, so the survey\'s length does not depend on memory.'
      : 'Enough headless, for one stick; no screen dashboard on this Pi.');

    const pw = info.power;
    if (pw && (pw.underVoltageNow || pw.underVoltageSinceBoot)) add('power', pw.underVoltageNow ? 'bad' : 'warn', 'Under-voltage ' + (pw.underVoltageNow ? 'now' : 'since this power-up'), 'The supply sags: the Pi may slow down or reset, and an SD card written to as the power drops can be ruined. Use a proper supply or a better battery and cable.');
    else if (pw) add('power', 'good', 'Power steady', 'No under-voltage since this power-up.');

    if (up.tokenSet && !up.tokenRefused) add('token', 'good', 'MegaNet token set', up.lastOkAt ? 'Last sent ' + new Date(up.lastOkAt).toLocaleString() + '.' : 'Nothing sent yet.');
    else add('token', 'warn', up.tokenRefused ? 'MegaNet refused the token' : 'No MegaNet token yet', 'Fine for a survey: everything is kept on the card and goes once it has a working token — Request a token when it is back on a network.');

    return out;
  }

  // ── on disk ─────────────────────────────────────────────────────────────

  saveNow() {
    this.dirty = false;
    this.savedAt = Date.now();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ current: this.s, history: this.history }));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) { this.log.warn('could not save the survey: ' + e.message); }
  }
}

// `survey = <name>` on the SD card (bootconf, as root, before the agent): a
// request the agent takes up when it starts.
function requestFromCard(dataDir, o) {
  const name = cleanName(o.name);
  if (!name) return false;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'survey-request.json'), JSON.stringify({ name, hours: cleanHours(o.hours), readings: !!o.readings, at: os.hostname() }));
  return true;
}

module.exports = { Survey, quantile, metres, requestFromCard };
