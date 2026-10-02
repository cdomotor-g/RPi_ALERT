'use strict';
// What the agent remembers between runs that is not a setting: this Pi's short
// id, the receiver id it gave each device it has seen (so the same radio is the
// same MegaNet ingest point next month), and what each port turned out to be.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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

class State {
  constructor(dir) {
    this.dir = dir || DATA_DIR;
    this.file = path.join(this.dir, 'state.json');
    this.data = { hostId: null, points: {}, ports: {} };
    this.timer = null;
  }

  load() {
    try { this.data = Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (_) {}
    if (!this.data.hostId) this.data.hostId = hostId() || crypto.randomBytes(4).toString('hex');
    this.data.points = this.data.points || {};
    this.data.ports = this.data.ports || {};
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
}

module.exports = { State, KINDS, DATA_DIR };
