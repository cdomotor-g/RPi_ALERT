'use strict';
// What the agent remembers between runs that is not a setting: this Pi's short
// id, the receiver id it gave each device it has seen (so the same radio is the
// same MegaNet ingest point next month), what each port turned out to be, and
// each RTL-SDR stick it has seen and where.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { portCompare } = require('./serial/scan');

const DATA_DIR = process.env.RPI_ALERT_DATA || '/var/lib/rpi-alert';

// receiver kind → MegaNet's `receiver` vocabulary (0045) and a short tag for ids
const KINDS = {
  quansheng: { receiver: 'quansheng', tag: 'qs', label: 'Quansheng radio' },
  'ert-a2': { receiver: 'ert-a2', tag: 'ert', label: 'ERT-A2' },
  sdr: { receiver: 'rtl-sdr', tag: 'sdr', label: 'RTL-SDR' },
  gps: { receiver: null, tag: 'gps', label: 'GPS' },
};

function hostId() {
  for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const id = fs.readFileSync(f, 'utf8').trim();
      if (/^[0-9a-f]{32}$/.test(id)) return crypto.createHash('sha256').update('rpi-alert:' + id).digest('hex').slice(0, 8);
    } catch (_) {}
  }
  return null;
}

const SEEN_EVERY_MS = 10 * 60 * 1000;

// What a stick says it is: USB ids, maker, model, serial.
function model(s) { return [s.vid, s.pid, s.manufacturer, s.product, s.serial].join('|'); }

class State {
  constructor(dir) {
    this.dir = dir || DATA_DIR;
    this.file = path.join(this.dir, 'state.json');
    this.data = { hostId: null, points: {}, ports: {}, sdrs: {} };
    this.timer = null;
  }

  load() {
    try { this.data = Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (_) {}
    if (!this.data.hostId) this.data.hostId = hostId() || crypto.randomBytes(4).toString('hex');
    this.data.points = this.data.points || {};
    this.data.ports = this.data.ports || {};
    this.data.sdrs = this.data.sdrs || {};
    this.saveSoon();
    return this;
  }

  saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.saveNow(); }, 1000);
    this.timer.unref?.();
  }
  saveNow() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (_) {}
  }

  // A stable MegaNet point id for one physical device: rpi-<host>-<tag><n>,
  // numbered per kind in the order devices are first seen. Matches 0045's
  // ^[a-z0-9][a-z0-9._-]{2,63}$.
  pointFor(deviceKey, kind) {
    const k = kind + '|' + deviceKey;
    if (this.data.points[k]) return this.data.points[k];
    const tag = KINDS[kind] ? KINDS[kind].tag : 'rx';
    const taken = new Set(Object.values(this.data.points).map(p => p.pointId));
    let n = 1;
    while (taken.has('rpi-' + this.data.hostId + '-' + tag + n)) n++;
    const p = { pointId: 'rpi-' + this.data.hostId + '-' + tag + n, kind, n, firstSeen: new Date().toISOString() };
    this.data.points[k] = p;
    this.saveSoon();
    return p;
  }

  portMemory(portKey) { return this.data.ports[portKey] || null; }
  rememberPort(portKey, info) {
    this.data.ports[portKey] = Object.assign({}, this.data.ports[portKey], info, { at: new Date().toISOString() });
    this.saveSoon();
  }

  // A serial port forgotten: what it was, and its receiver id.
  forgetPort(portKey) {
    delete this.data.ports[portKey];
    for (const k of Object.keys(this.data.points)) if (!k.startsWith('sdr|') && k.slice(k.indexOf('|') + 1) === portKey) delete this.data.points[k];
    this.saveSoon();
  }

  // ── RTL-SDR sticks ─────────────────────────────────────────────────────
  // Each stick seen, under the key its receiver id and its own settings hang
  // off: { serial, busPath, vid, pid, manufacturer, product, firstSeen,
  // lastSeen }. What is plugged in is matched to them by what each stick says
  // it is and which USB port it is in — never by what else is plugged in, so a
  // second stick does not rename the first, even when both say they are
  // 00000001, as most sticks do. Two sticks that say the same are told apart
  // by their USB ports.

  // sticks (scan.js) → Map(stick → key), new sticks remembered as they come.
  assignSdrs(sticks) {
    const reg = this.data.sdrs;
    const out = new Map();
    const taken = new Set();
    let free = sticks.slice().sort((a, b) => portCompare(a.busPath, b.busPath));
    const give = (st, key) => { out.set(st, key); taken.add(key); free = free.filter(x => x !== st); };
    const keys = Object.keys(reg);
    // 1. The same stick in the same port.
    for (const st of free.slice()) {
      const k = keys.find(k => !taken.has(k) && reg[k].busPath === st.busPath && model(reg[k]) === model(st));
      if (k) give(st, k);
    }
    // 2. Sticks known from before this list was kept (0.4 and earlier) only by
    // their receiver ids: "sdr-port:<USB port>" (a stick whose serial was
    // shared) by port here, "sdr-serial:<serial>" by serial below.
    const legacy = Object.keys(this.data.points).filter(p => p.startsWith('sdr|')).map(p => p.slice(4)).filter(k => !reg[k]);
    for (const st of free.slice()) {
      const k = legacy.find(k => !taken.has(k) && k === 'sdr-port:' + st.busPath);
      if (k) give(st, k);
    }
    // 3. Moved to another port: a stick that says the same, not plugged in
    // anywhere else (the one seen last, if several).
    for (const st of free.slice()) {
      const k = keys.filter(k => !taken.has(k) && model(reg[k]) === model(st)).sort((a, b) => String(reg[b].lastSeen || '').localeCompare(String(reg[a].lastSeen || '')))[0]
        || legacy.find(k => !taken.has(k) && !!st.serial && k === 'sdr-serial:' + st.serial);
      if (k) give(st, k);
    }
    // 4. New to this Pi.
    for (const st of free.slice()) give(st, this.newSdrKey(st, taken));
    const now = new Date().toISOString();
    for (const [st, key] of out) {
      const r = reg[key];
      const info = { serial: st.serial, busPath: st.busPath, vid: st.vid, pid: st.pid, manufacturer: st.manufacturer, product: st.product };
      if (!r || Object.keys(info).some(f => r[f] !== info[f])) {
        reg[key] = Object.assign({ firstSeen: now }, r, info, { lastSeen: now });
        this.saveSoon();
      }
    }
    return out;
  }

  // The first stick with a serial is "sdr-serial:<serial>"; one that shares
  // it, "sdr-port:<the USB port it was first seen in>".
  newSdrKey(st, taken) {
    const used = (k) => (taken && taken.has(k)) || !!this.data.sdrs[k] || !!this.data.points['sdr|' + k];
    if (st.serial && !used('sdr-serial:' + st.serial)) return 'sdr-serial:' + st.serial;
    let k = 'sdr-port:' + st.busPath;
    for (let n = 2; used(k); n++) k = 'sdr-port:' + st.busPath + '#' + n;
    return k;
  }

  sdrEntries() { return Object.entries(this.data.sdrs); }
  sdrInfo(key) { return this.data.sdrs[key] || null; }

  // Still plugged in: noted now and then, so an unplugged stick says when it was last seen.
  touchSdrs(keys) {
    const now = Date.now();
    for (const k of keys) {
      const r = this.data.sdrs[k];
      if (r && !(now - Date.parse(r.lastSeen) < SEEN_EVERY_MS)) { r.lastSeen = new Date(now).toISOString(); this.saveSoon(); }
    }
  }
  sdrGone(key) {
    const r = this.data.sdrs[key];
    if (r) { r.lastSeen = new Date().toISOString(); this.saveSoon(); }
  }

  // A stick forgotten: where it was, and its receiver id (which the next new
  // stick may get).
  forgetSdr(key) {
    delete this.data.sdrs[key];
    delete this.data.points['sdr|' + key];
    this.saveSoon();
  }
}

module.exports = { State, KINDS, DATA_DIR };
