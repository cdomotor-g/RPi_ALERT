'use strict';
// The agent: every receiver on the Pi, decoding, and posting to MegaNet.
//
//   devices/manager   finds and keeps open the serial receivers and SDR sticks
//   clock             says when the Pi's time can be trusted (NTP, else GPS)
//   uplink            the queue to MegaNet: readings, receptions, receiver reports
//   stations          MegaNet's register, for naming what is heard
//   audio             the chirps
//   web/server        the dashboard and settings, on port 80
//
// A reading's life: a driver decodes it → deviceReading() times it (arrival,
// or the frame's own time; held on the monotonic clock if the wall clock is
// not yet trusted), names it, shows it, plays it, and queues it for MegaNet.

const os = require('node:os');
const { EventEmitter } = require('node:events');
const logm = require('./log');
const { Config } = require('./config');
const { State, KINDS, DATA_DIR } = require('./state');
const { Clock } = require('./clock');
const { Uplink } = require('./uplink');
const { TokenRequest } = require('./token-request');
const { Stations } = require('./stations');
const { Audio } = require('./audio');
const { DeviceManager } = require('./devices/manager');
const { board } = require('./serial/scan');
const system = require('./system');
const pkg = require('../package.json');

const RECENT = 500;
const KIOSK_MIN_MB = 900;

class Agent extends EventEmitter {
  constructor(opts) {
    super();
    this.setMaxListeners(200);
    opts = opts || {};
    this.log = logm.logger('agent');
    this.dataDir = opts.dataDir || DATA_DIR;
    this.config = (opts.config || new Config(opts.configFile)).load();
    if (this.config.loadError) this.log.warn(this.config.loadError);
    this.state = new State(this.dataDir).load();
    this.board = board();
    this.clock = new Clock({ log: this.log.child('clock'), assumeSynced: opts.assumeClock,
      setSystemTime: (ms) => system.priv('set-time', String(Math.floor(ms / 1000))).then(r => { if (r.code) throw new Error(r.stderr.trim() || 'failed'); }) });
    this.uplink = new Uplink({ config: this.config, clock: this.clock, log: this.log.child('meganet'), dataDir: this.dataDir }).load();
    // Asking MegaNet for a token instead of having one typed in (0048).
    this.tokenRequest = new TokenRequest({ config: this.config, api: this.uplink.api, dataDir: this.dataDir, log: this.log.child('token'),
      describe: () => this.tokenRequestPayload() }).load();
    this.stations = new Stations({ dataDir: this.dataDir, log: this.log.child('stations'), getUrls: () => this.config.get().meganet.stationsUrls }).load();
    this.audio = new Audio({ log: this.log.child('audio'), getCfg: () => this.config.get().audio });
    this.devices = new DeviceManager(this);
    this.recent = [];
    this.bursts = [];
    this.counts = { readings: 0, alert: 0, alert2: 0, receptions: 0 };
    this.startedAt = Date.now();
    this.kiosk = { running: null, display: false, lastAction: 0, error: '' };
    this.timers = [];
  }

  start() {
    this.log.info('RPi ALERT ' + pkg.version + ' on ' + (this.board.model || os.hostname()) + ' (' + this.board.cores + ' cores, ' + this.board.memMb + ' MB), node ' + process.version);
    this.clock.start();
    this.uplink.start();
    this.tokenRequest.start();
    this.tokenRequest.on('change', () => this.emit('token-request', this.tokenRequest.status()));
    this.stations.start();
    this.devices.start();
    this.devices.on('change', () => this.emit('devices'));
    this.config.on('change', (changed) => {
      this.log.info('settings changed: ' + changed.join(', '));
      this.emit('config', changed);
      if (changed.some(p => p.startsWith('kiosk.'))) this.kioskCheck(true);
      if (changed.includes('system.timezone')) this.applyTimezone();
    });
    this.timers.push(setInterval(() => this.kioskCheck(false), 5000));
    this.timers.push(setInterval(() => this.emit('tick'), 2000));
    this.watchdog();
    setTimeout(() => this.kioskCheck(false), 3000);
    return this;
  }

  async stop() {
    this.timers.forEach(clearInterval);
    await this.devices.stop();
    this.tokenRequest.stop();
    this.uplink.stop();
    this.stations.stop();
    this.clock.stop();
    this.state.saveNow();
  }

  baseName() { return this.config.get().name || 'RPi ALERT ' + os.hostname(); }

  // ── from the devices ──────────────────────────────────────────────────────

  deviceReading(session, r) {
    const now = this.clock.now();
    const trusted = this.clock.trusted();
    const ts = r.ts != null ? r.ts : (trusted ? now : null);
    const point = session.point ? (typeof session.point === 'function' ? session.point() : session.point) : null;
    const loc = this.location();
    const cands = this.stations.lookup(r.alert_id, loc.lat != null ? loc : null);
    const st = cands[0] || null;
    const kind = r.kindLabel || (st && st.kind) || '';
    const item = {
      t: trusted ? (ts || now) : Date.now(), ts, timed: ts != null, receiver: session.name(), receiverKind: session.kind,
      receiverKey: session.key, pointId: point ? point.pointId : null, protocol: r.protocol, fmt: r.fmt || null,
      alert_id: r.alert_id, value_raw: r.value_raw, kind, eng: engValue(kind, r.value_raw, r),
      station: st ? { id: st.id, name: st.name, km: st.km ?? null } : (r.name ? { id: null, name: r.name } : null),
      shared: cands.length > 1 ? cands.length : 0,
      rssi_dbm: r.rssi_dbm ?? null, level_dbfs: r.level_dbfs ?? null, votes: r.votes ?? null,
      nf_dbm: r.nf_dbm ?? null, nf_dbfs: r.nf_dbfs ?? null, snr_db: snrOf(r),
    };
    this.counts.readings++;
    this.counts[r.protocol] = (this.counts[r.protocol] || 0) + 1;
    this.recent.unshift(item);
    if (this.recent.length > RECENT) this.recent.length = RECENT;
    this.emit('reading', item);
    this.audio.reading({ protocol: r.protocol, alert_id: r.alert_id, value_raw: r.value_raw, burstKey: r.burstKey, receiverKey: session.key }, session.kind === 'sdr');
    if (point && this.config.get().meganet.enabled) {
      this.uplink.addReading({ point: point.pointId, protocol: r.protocol, alert_id: r.alert_id, value_raw: r.value_raw, ts, line: r.line });
    }
  }

  deviceReception(session, rx) {
    const point = session.point ? (typeof session.point === 'function' ? session.point() : session.point) : null;
    if (!point) return;
    this.counts.receptions++;
    const trusted = this.clock.trusted();
    const loc = this.location();
    const out = {
      heard_at: rx.ts != null ? rx.ts : (trusted ? this.clock.now() : null),
      protocol: rx.protocol || null, alert_id: rx.alert_id ?? null, value_raw: rx.value_raw ?? null, payload_hex: rx.payload_hex || null,
      ok: !!rx.ok, fault: rx.fault || null, rssi_dbm: num(rx.rssi_dbm), level_dbfs: num(rx.level_dbfs), nf_dbm: num(rx.nf_dbm),
      votes: rx.votes ?? null, location_source: loc.source,
      detail: Object.assign({ app: 'RPi ALERT' }, rx.detail || {}),
    };
    if (loc.source !== 'none') {
      out.lat = loc.lat; out.lon = loc.lon; out.accuracy_m = num(loc.accuracy_m);
      if (loc.source === 'gps') { out.speed_mps = num(loc.speed_mps); out.heading_deg = num(loc.heading_deg); }
    }
    this.uplink.addReception(point.pointId, KINDS[session.kind === 'sdr' ? 'sdr' : session.type].receiver, out);
  }

  deviceEvent(session, type, data) {
    if (type === 'gps-time') { this.clock.gpsTime(data); return; }
    if (type === 'gps') { this.emit('gps', data); return; }
    if (type === 'burst') {
      const b = Object.assign({ t: Date.now(), receiver: session.name(), kind: session.kind }, data);
      this.bursts.unshift(b);
      if (this.bursts.length > 100) this.bursts.length = 100;
      this.emit('burst', b);
      return;
    }
    this.emit('device-event', { key: session.key, type, data });
  }

  deviceAttached(session) {
    const kind = session.kind === 'sdr' ? 'sdr' : session.type;
    if (!KINDS[kind] || !KINDS[kind].receiver) return;
    const point = typeof session.point === 'function' ? session.point() : session.point;
    if (!point) return;
    this.uplink.registerPoint(point.pointId, () => this.describe(session, kind, point));
    this.emit('devices');
  }

  deviceDetached(session) {
    const point = typeof session.point === 'function' ? session.point() : session.point;
    if (point) this.uplink.deactivatePoint(point.pointId);
    this.emit('devices');
  }

  // What report_ingest_point (0045) is told about one receiver.
  describe(session, kind, point) {
    const loc = this.location();
    const p = {
      point_id: point.pointId,
      name: (this.baseName() + ' — ' + session.name()).slice(0, 120),
      receiver: KINDS[kind].receiver,
      detail: Object.assign({ app: 'RPi ALERT', version: pkg.version, host: os.hostname(), board: this.board.model || undefined }, session.detail()),
      location_source: loc.source,
      location_note: locNote(loc),
    };
    if (loc.source !== 'none') {
      p.lat = loc.lat; p.lon = loc.lon;
      if (Number.isFinite(loc.accuracy_m)) p.accuracy_m = loc.accuracy_m;
      if (loc.station) p.host_station_id = loc.station;
    }
    if (JSON.stringify(p.detail).length > 3500) p.detail = { app: 'RPi ALERT', version: pkg.version };
    return p;
  }

  // What a token request tells MegaNet about this Pi (0048): the name it will
  // post under, and enough for an administrator to recognise it — the board,
  // the host name, what is plugged in. The station it sits at, when the
  // operator said one, as a suggestion for the token's host station.
  tokenRequestPayload() {
    const loc = this.location();
    const rx = this.devices.all().filter(s => s.state !== 'unplugged' && (s.kind === 'sdr' || (s.type && s.type !== 'gps')))
      .map(s => ({ kind: s.kind === 'sdr' ? 'rtl-sdr' : s.type, name: s.name() })).slice(0, 8);
    const p = {
      label: this.baseName(),
      detail: { app: 'RPi ALERT', version: pkg.version, host: os.hostname(), board: this.board.model || undefined, receivers: rx },
    };
    if (loc.station) p.host_station_id = loc.station;
    return p;
  }

  // Where this base station is: a GPS fix when there is one (and GPS is
  // allowed), else the fixed location from the settings, else nowhere.
  location() {
    const c = this.config.get().location;
    if (c.useGps !== false || c.source === 'gps') {
      const f = this.devices.gpsFix();
      if (f) return { source: 'gps', lat: f.lat, lon: f.lon, accuracy_m: f.accuracy_m, speed_mps: f.speed_mps, heading_deg: f.heading_deg };
    }
    if ((c.source === 'manual' || c.source === 'station') && Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
      return { source: c.source, lat: c.lat, lon: c.lon, accuracy_m: Number.isFinite(c.accuracy_m) ? c.accuracy_m : null,
        station: c.source === 'station' ? c.station || null : null, stationName: c.stationName || '' };
    }
    return { source: 'none', gpsLost: c.source === 'gps' };
  }

  // ── the display ───────────────────────────────────────────────────────────

  // The kiosk (a full-screen browser on the dashboard) runs only while a
  // monitor is plugged in, so a headless base station spends no memory on it.
  async kioskCheck(force) {
    if (this.kioskBusy) return;
    this.kioskBusy = true;
    try { await this.kioskCheckNow(force); } finally { this.kioskBusy = false; }
  }

  async kioskCheckNow(force) {
    const mode = this.config.get().kiosk.mode;
    const display = system.displayConnected();
    const lowMem = this.board.memMb && this.board.memMb < KIOSK_MIN_MB;
    const want = mode === 'on' ? display : mode === 'auto' ? display && !lowMem : false;
    this.kiosk.display = display;
    this.kiosk.lowMem = !!lowMem;
    if (!system.privAvailable()) return;
    // First look: is it already running (the agent restarted under it)? No root needed to ask.
    if (this.kiosk.running === null) {
      const r = await system.run('systemctl', ['is-active', '--quiet', 'rpi-alert-kiosk.service'], { timeout: 5000 });
      this.kiosk.running = r.code === 0;
    }
    if (!force && want === this.kiosk.running) return;
    if (!force && Date.now() - this.kiosk.lastAction < 15000) return;
    this.kiosk.lastAction = Date.now();
    const r = await system.priv('kiosk', want ? 'start' : 'stop');
    if (r.code === 0) {
      if (this.kiosk.running !== want) this.log.info(want ? 'a display is connected — starting the kiosk' : 'stopping the kiosk' + (display ? '' : ' (no display)'));
      this.kiosk.running = want; this.kiosk.error = ''; this.kiosk.failures = 0;
    } else {
      const err = (r.stderr || r.stdout).trim().slice(0, 200) || 'exit ' + r.code;
      if (err !== this.kiosk.error) this.log.warn('could not ' + (want ? 'start' : 'stop') + ' the kiosk: ' + err);
      this.kiosk.error = err;
      // Back off: a Pi installed without the kiosk packages should not retry every 15 s.
      this.kiosk.failures = (this.kiosk.failures || 0) + 1;
      this.kiosk.lastAction = Date.now() + Math.min(300000, 30000 * this.kiosk.failures);
      this.kiosk.running = want ? false : this.kiosk.running;
    }
  }

  async applyTimezone() {
    const tz = this.config.get().system.timezone;
    if (!tz) return;
    const r = await system.priv('timezone', tz);
    if (r.code) this.log.warn('could not set the time zone: ' + (r.stderr || r.stdout).trim());
    else { process.env.TZ = tz; this.log.info('time zone ' + tz); }
  }

  // systemd's watchdog (WatchdogSec= in the unit): a stalled event loop stops
  // the pings and systemd restarts the agent.
  watchdog() {
    const usec = Number(process.env.WATCHDOG_USEC);
    if (!process.env.NOTIFY_SOCKET || !usec) return;
    const { execFile } = require('node:child_process');
    const ping = () => execFile('systemd-notify', ['WATCHDOG=1'], () => {});
    ping();
    this.timers.push(setInterval(ping, Math.max(1000, usec / 3000)));
  }

  // ── for the web page and the CLI ──────────────────────────────────────────

  async status() {
    return {
      version: pkg.version, name: this.baseName(), startedAt: this.startedAt, hostId: this.state.data.hostId,
      clock: this.clock.status(), meganet: this.uplink.status(), tokenRequest: this.tokenRequest.status(), stations: this.stations.status(),
      location: Object.assign(this.location(), { configured: this.config.get().location.source }),
      devices: this.devices.status(), audio: this.audio.status(), counts: this.counts,
      kiosk: Object.assign({ mode: this.config.get().kiosk.mode }, this.kiosk), system: await system.info(),
      board: this.board, passwordSet: !!this.config.get().web.passwordHash,
    };
  }
}

// Signal over noise floor: the SDR's channel peak over its floor (dBFS), or a
// radio's RSSI over its own noise reading (dBm). Null when either side is missing.
function snrOf(r) {
  if (r.snr_db != null) return num(r.snr_db);
  const sig = num(r.rssi_dbm), nf = num(r.nf_dbm);
  return sig != null && nf != null ? Math.round((sig - nf) * 10) / 10 : null;
}

function num(v) { return v == null || !Number.isFinite(Number(v)) ? null : Number(v); }

// The value as MegaNet shows it: battery addresses in volts (raw ÷ 10), rain
// as tips, 2047 as full scale (over-range, or a dead sensor), the rest raw.
function engValue(kind, raw, r) {
  if (raw === 2047) return 'FULL';
  if (r && r.eng && r.unit) return r.eng + ' ' + r.unit;
  if (kind === 'BATT') return (raw / 10).toFixed(1) + ' V';
  if (kind === 'RAIN') return raw + ' tips';
  return String(raw);
}

function fmtDist(m) { return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km'; }

function locNote(loc) {
  if (loc.gpsLost) return 'GPS chosen, but the GPS has no fix right now.';
  if (loc.source === 'gps') return 'GPS fix from the USB GPS on the RPi ALERT base station' + (Number.isFinite(loc.accuracy_m) ? ', ±' + fmtDist(loc.accuracy_m) : '') + '.';
  if (loc.source === 'manual') return 'Approximate: coordinates set in the RPi ALERT settings. No GPS.';
  if (loc.source === 'station') return 'Approximate: the operator says the receiver is at ' + (loc.stationName || loc.station) + '. No GPS.';
  return 'No location given. No GPS.';
}

module.exports = { Agent, engValue, locNote };
