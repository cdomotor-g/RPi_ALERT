'use strict';
// A Wi-Fi network of the Pi's own, for when it has none: a phone joins it and
// opens the dashboard — at a site survey on a hill, or a base station whose
// network has gone — with nothing else to bring.
//
// NetworkManager runs it (the root helper's hotspot-up / hotspot-down, an
// access point on the Pi's Wi-Fi with NetworkManager's own DHCP, the Pi at
// 10.42.0.1), WPA2 with a password made on the Pi the first time and shown on
// its dashboard, set from the SD card (hotspot_password) or here. Whether it is
// up, who is on it and whether the Pi has another network are read without
// root — NetworkManager answers any user — so the twenty-second look costs no
// sudo, and fills no log.
//
// hotspot.mode:
//   auto  up after three minutes with no network — neither Ethernet nor a
//         Wi-Fi network joined — and down the moment one is there. One Wi-Fi
//         radio cannot be an access point and look for networks at once, so
//         while nobody is on the hotspot it steps aside every ten minutes, for
//         a minute and a half, to let NetworkManager join a network it knows
//         (a base station whose router came back); with a phone on it, it
//         stays. With no Wi-Fi network saved there is nothing to look for, and
//         it stays.
//   on    always (a Pi on Ethernet, or one that should never join Wi-Fi)
//   off   never

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const system = require('./system');

const TICK_MS = 20000;
const WAIT_MS = 3 * 60 * 1000;
const STAND_ASIDE_EVERY_MS = 10 * 60 * 1000;
const STAND_ASIDE_MS = 90 * 1000;
const ADDRESS = '10.42.0.1';
const NAME = 'rpi-alert-hotspot';

// A password to read off a screen and type into a phone: no 0/O, 1/l/I.
function makePassword() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const b = crypto.randomBytes(12);
  return Array.from(b, x => abc[x % abc.length]).join('').replace(/(.{4})(?!$)/g, '$1-');
}

// nmcli -t: fields split on ':', a ':' or '\\' inside one escaped with '\\'.
function nmRows(text) {
  return String(text || '').split('\n').filter(l => l.trim()).map(l => l.split(/(?<!\\):/).map(f => f.replace(/\\([:\\])/g, '$1')));
}

// What NetworkManager says, as the hotspot needs it:
//   devices:     nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device
//   connections: nmcli -t -f NAME,TYPE connection show
//   stations:    iw dev <wifi> station dump (who is on the hotspot)
//   reg:         iw reg get
function parseStatus(devices, connections, stations, reg) {
  const devs = nmRows(devices).map(([device, type, state, conn]) => ({ device, type, state: state || '', conn: conn || '' }));
  const wifi = devs.find(d => d.type === 'wifi');
  const on = (d) => /^connected/.test(d.state);
  return {
    wifi: wifi ? wifi.device : null,
    active: devs.some(d => d.conn === NAME && on(d)),
    clients: (String(stations || '').match(/^Station /gm) || []).length,
    saved: nmRows(connections).filter(([name, type]) => type === '802-11-wireless' && name !== NAME).length,
    // Connected to a network that is not the hotspot: Ethernet, or Wi-Fi joined.
    connected: devs.filter(d => on(d) && d.conn !== NAME && (d.type === 'ethernet' || d.type === 'wifi')).map(d => d.device + ':' + d.type + ':' + d.conn),
    country: (/country (\w\w)/.exec(String(reg || '')) || [])[1] || null,
  };
}

async function readStatus() {
  const nm = (args) => system.run('nmcli', ['-t'].concat(args), { timeout: 8000 });
  const d = await nm(['-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device']);
  if (d.missing) return { error: 'NetworkManager (nmcli) is not installed' };
  if (d.code) return { error: (d.stderr || '').trim().slice(0, 200) || 'NetworkManager did not answer' };
  const c = await nm(['-f', 'NAME,TYPE', 'connection', 'show']);
  let s = parseStatus(d.stdout, c.stdout, '', '');
  let stations = '';
  if (s.wifi && s.active) {
    const iw = await system.run('iw', ['dev', s.wifi, 'station', 'dump'], { timeout: 5000 });
    stations = iw.code === 0 ? iw.stdout : '';
    // No iw, or not allowed: the neighbours the Pi has heard from on it.
    if (iw.code !== 0) {
      const n = await system.run('ip', ['neigh', 'show', 'dev', s.wifi], { timeout: 5000 });
      stations = (n.stdout.match(/\b(REACHABLE|STALE|DELAY|PROBE)\b/g) || []).map(() => 'Station x').join('\n');
    }
  }
  const reg = await system.run('iw', ['reg', 'get'], { timeout: 5000 });
  s = parseStatus(d.stdout, c.stdout, stations, reg.stdout);
  return s;
}

class Hotspot extends EventEmitter {
  // opts: { exec(verb, ...args) → { code, stdout, stderr }, read() → status | { error }, now() } — for tests
  constructor(agent, opts) {
    super();
    this.agent = agent;
    this.log = agent.log.child('hotspot');
    this.exec = (opts && opts.exec) || ((verb, ...a) => system.priv(verb, ...a));
    this.read = (opts && opts.read) || readStatus;
    this.now = (opts && opts.now) || Date.now;
    this.st = { available: null, active: false, clients: 0, saved: 0, connected: [], wifi: null, country: null, error: '', note: '' };
    this.lastNetAt = this.now();
    this.upAt = 0;
    this.asideUntil = 0;
    this.busy = false;
  }

  cfg() { return this.agent.config.get().hotspot; }
  ssid() { return this.cfg().ssid || 'RPi-ALERT-' + String(this.agent.state.data.hostId || '').slice(0, 4).toUpperCase(); }
  password() { return this.cfg().password; }

  start() {
    // Made once, kept in the settings, shown on the dashboard.
    if (!this.cfg().password) {
      const r = this.agent.config.update({ hotspot: { password: makePassword() } });
      if (!r.ok) this.log.warn('could not make a hotspot password: ' + r.errors.join('; '));
    }
    this.agent.config.on('change', (changed) => { if (changed.some(p => p.startsWith('hotspot.'))) { this.asideUntil = 0; this.tick(true); } });
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    this.first = setTimeout(() => this.tick(), 5000);
    this.first.unref?.();
    return this;
  }
  stop() { clearInterval(this.timer); clearTimeout(this.first); }

  async tick(changed) {
    if (this.busy) return;
    this.busy = true;
    try { await this.step(changed); } catch (e) { this.st.error = e.message; } finally { this.busy = false; }
  }

  async step(changed) {
    const s = await this.read();
    if (!s || s.error) {
      this.st.available = false;
      this.st.error = (s && s.error) || 'NetworkManager cannot be asked';
      return;
    }
    Object.assign(this.st, s, { available: !!s.wifi, error: '' });
    const now = this.now();
    const net = s.connected.length > 0;
    if (net) this.lastNetAt = now;
    const mode = this.cfg().mode;
    let want = false;
    if (!s.wifi) this.st.note = 'This Pi has no Wi-Fi.';
    else if (mode === 'off') this.st.note = 'Off.';
    else if (mode === 'on') { want = true; this.st.note = 'Always on.'; }
    else want = this.autoWant(s, net, now);
    if (want && (!s.active || changed)) await this.up();
    else if (!want && s.active) await this.down();
  }

  autoWant(s, net, now) {
    if (net) { this.st.note = 'On a network (' + s.connected.map(c => c.split(':')[0]).join(', ') + ') — no hotspot needed.'; return false; }
    if (now < this.asideUntil) { this.st.note = 'Stepped aside for a minute to let the Pi join a Wi-Fi network it knows.'; return false; }
    if (s.active) {
      if (!s.clients && s.saved && now - this.upAt > STAND_ASIDE_EVERY_MS) {
        this.asideUntil = now + STAND_ASIDE_MS;
        this.st.note = 'Nobody on the hotspot: stepping aside to look for a known Wi-Fi network.';
        return false;
      }
      this.st.note = s.clients ? s.clients + ' connected.' : 'Up — no network here.';
      return true;
    }
    const wait = WAIT_MS - (now - this.lastNetAt);
    if (wait > 0) { this.st.note = 'No network: the hotspot comes up in ' + Math.ceil(wait / 60000) + ' min unless one appears.'; return false; }
    return true;
  }

  async up() {
    const r = await this.exec('hotspot-up', this.ssid(), this.password());
    if (r.code !== 0) {
      const err = ((r.stderr || r.stdout || '').trim() || 'failed').slice(0, 200);
      if (err !== this.st.error) this.log.warn('could not start the hotspot: ' + err);
      this.st.error = err;
      return;
    }
    this.upAt = this.now();
    this.st.active = true;
    this.log.info('hotspot "' + this.ssid() + '" up — a phone joins it and opens http://' + ADDRESS + '/');
    this.emit('change');
  }

  async down() {
    const r = await this.exec('hotspot-down');
    if (r.code !== 0) { this.st.error = ((r.stderr || '').trim() || 'failed').slice(0, 200); return; }
    this.st.active = false;
    this.log.info('hotspot down' + (this.st.connected.length ? ' — on a network' : ''));
    this.emit('change');
  }

  // For the dashboard: without the password unless asked (the page asks once logged in).
  status(withPassword) {
    const c = this.cfg();
    const o = { mode: c.mode, ssid: this.ssid(), address: ADDRESS, available: this.st.available, active: this.st.active, clients: this.st.clients,
      wifi: this.st.wifi, country: this.st.country, note: this.st.note, error: this.st.error };
    if (withPassword) o.password = c.password;
    return o;
  }
}

module.exports = { Hotspot, parseStatus, nmRows, readStatus, makePassword, ADDRESS, NAME };
