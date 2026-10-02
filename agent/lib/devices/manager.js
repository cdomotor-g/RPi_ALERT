'use strict';
// Every receiver plugged into the Pi, found, identified, kept open, and
// reopened when it comes back.
//
// Every two seconds the USB serial ports and RTL-SDR sticks are listed from
// sysfs. A new port gets a session: opened, listened to until what it sends
// says what it is (sniff.js), then handed to that receiver's driver. A port
// that errors or hangs up — the device unplugged, its power gone, the radio
// rebooted — is closed and tried again (1 s, 2 s, 5 s … 30 s) for as long as
// its device node exists, and picked up again by the scan when it reappears,
// under whatever /dev name the kernel gives it this time. Its identity is the
// /dev/serial/by-id link (vendor, model, serial number), so it keeps its
// MegaNet receiver id across all of that, and across reboots.

const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { SerialPort } = require('../serial/port');
const { listPorts, listSdrs } = require('../serial/scan');
const { Sniffer } = require('./sniff');
const { QuanshengDriver } = require('./quansheng');
const { ErtDriver } = require('./ert');
const { GpsDriver } = require('./gps');
const { SdrSession } = require('./sdr');
const { Quansheng } = require('../meganet-codecs');

const SCAN_MS = 2000;
const RETRY = [1000, 2000, 5000, 10000, 30000];
const FORGET_MS = 60 * 60 * 1000;

function usbId(p) { return p.usb ? p.usb.vid + ':' + p.usb.pid : ''; }

class PortSession extends EventEmitter {
  constructor(mgr, port) {
    super();
    this.mgr = mgr;
    this.agent = mgr.agent;
    this.port = port;
    this.key = port.key;
    this.log = this.agent.log.child(port.name);
    this.sp = null;
    this.driver = null;
    this.sniffer = null;
    this.state = 'new';
    this.type = null;
    this.how = '';
    this.retry = 0;
    this.timer = null;
    this.goneAt = 0;
    this.openedAt = 0;
    this.error = '';
    this.reconnects = 0;
    this.closing = false;
    this.toggling = false;
  }

  get kind() { return this.type; }

  override() {
    const list = this.agent.config.get().receivers.ports || [];
    const p = this.port;
    return list.find(o => o.match === p.byId || o.match === p.dev || o.match === p.key || o.match === p.byPath || (o.match && o.match.toLowerCase() === usbId(p))) || null;
  }

  name() {
    const o = this.override();
    if (o && o.name) return o.name;
    if (!this.type) return p2(this.port);
    const label = { quansheng: 'Quansheng radio', 'ert-a2': 'ERT-A2', gps: 'GPS' }[this.type] || 'Serial device';
    const pt = this.point();
    return label + (pt && pt.n > 1 ? ' ' + pt.n : '');
  }

  point() { return this.type && this.type !== 'gps' ? this.agent.state.pointFor(this.key, this.type) : null; }

  baudFor() {
    const o = this.override();
    if (o && o.baud) return o.baud;
    if (this.port.acm) return 115200;            // USB CDC: the speed is ignored
    const mem = this.agent.state.portMemory(this.key);
    if (mem && mem.baud) return mem.baud;
    return 9600;
  }

  async open() {
    clearTimeout(this.timer);
    if (this.closing || this.opening || this.sp) return;
    this.opening = true;
    try { await this.doOpen(); } finally { this.opening = false; }
  }

  async doOpen() {
    const o = this.override();
    if (o && o.type === 'ignore') { this.state = 'ignored'; this.emit('change'); return; }
    if (!this.agent.config.get().receivers.autoDetect && !(o && o.type && o.type !== 'auto')) {
      this.state = 'ignored'; this.error = 'automatic detection is off and no type is set for this port'; this.emit('change'); return;
    }
    const baud = this.sniffer ? this.sniffer.baud : this.baudFor();
    this.sp = new SerialPort(this.port.dev, { baud });
    this.sp.on('data', (b) => this.onData(b));
    this.sp.on('close', (err) => this.onLost(err));
    this.state = 'opening';
    try {
      await this.sp.open();
    } catch (e) {
      this.sp = null;
      this.error = e.code === 'EACCES' ? 'permission denied (is the agent in the dialout group?)' : e.code === 'EBUSY' ? 'in use by another program' : e.message;
      this.state = 'error';
      this.log.warn('could not open ' + this.port.dev + ': ' + this.error);
      this.scheduleRetry();
      this.emit('change');
      return;
    }
    this.openedAt = Date.now();
    this.error = '';
    if (this.retry) { this.reconnects++; this.log.info('reconnected'); }
    this.retry = 0;
    // What is it? Settings first, then the USB id, then what it says.
    if (!this.driver) {
      if (o && o.type && o.type !== 'auto') this.attach(o.type, { how: 'set in settings' });
      else if (this.port.usb && parseInt(this.port.usb.vid, 16) === Quansheng.USB_VID) this.attach('quansheng', { how: 'USB id 36b7 (ALERT firmware)' });
      else {
        this.sniffer = this.sniffer || new Sniffer({ baud, hunt: !this.port.acm && !(o && o.baud) });
        this.state = 'identifying';
        this.log.info('opened at ' + baud + ' baud — listening to work out what it is');
      }
    } else {
      this.state = 'running';
      this.driver.onOpen();
    }
    this.emit('change');
  }

  attach(type, info) {
    this.type = type;
    this.how = info.how || '';
    const ctx = this.ctxFor();
    if (type === 'quansheng') this.driver = new QuanshengDriver(ctx);
    else if (type === 'ert-a2') this.driver = new ErtDriver(ctx, { binary: !!info.binary });
    else if (type === 'gps') this.driver = new GpsDriver(ctx);
    else { this.state = 'error'; this.error = 'unknown type ' + type; return; }
    this.sniffer = null;
    this.state = 'running';
    this.log.info('identified: ' + this.name() + ' (' + this.how + ') at ' + (this.sp ? this.sp.baud : '?') + ' baud');
    this.agent.state.rememberPort(this.key, { type, baud: this.sp ? this.sp.baud : null });
    this.driver.onOpen();
    if (info.bytes && info.bytes.length) this.driver.feed(Buffer.from(info.bytes));
    this.agent.deviceAttached(this);
    this.emit('change');
  }

  ctxFor() {
    const self = this;
    return {
      log: this.log,
      port: this.port,
      clock: this.agent.clock,
      write: (s) => (self.sp && self.sp.isOpen ? self.sp.write(s) : Promise.reject(new Error('port is closed'))),
      reading: (r) => this.agent.deviceReading(self, r),
      reception: (rx) => this.agent.deviceReception(self, rx),
      event: (type, data) => this.agent.deviceEvent(self, type, data),
      toggleDtr: () => self.toggleDtr(),
    };
  }

  onData(buf) {
    if (this.driver) { try { this.driver.feed(buf); } catch (e) { this.log.error('driver: ' + (e.stack || e)); } return; }
    if (!this.sniffer) return;
    const r = this.sniffer.feed(buf);
    if (!r) return;
    if (r.baud) {
      this.log.info('not text at ' + this.sp.baud + ' baud — trying ' + r.baud);
      this.sp.setBaud(r.baud).catch(e => this.log.warn(e.message));
      this.emit('change');
      return;
    }
    this.attach(r.type, r);
  }

  async toggleDtr() {
    if (!this.sp || this.toggling) return;
    this.toggling = true;
    try { await this.sp.toggleDtr(100); if (this.driver) this.driver.onOpen(); }
    catch (e) { this.log.warn('DTR toggle failed: ' + e.message); this.onLost(e); }
    this.toggling = false;
  }

  onLost(err) {
    if (this.closing) return;
    const was = this.state;
    this.sp = null;
    if (this.driver) this.driver.onClose();
    this.state = 'disconnected';
    this.error = err ? (err.code === 'EOF' ? 'the device hung up' : err.message || String(err)) : '';
    if (was === 'running' || was === 'identifying') this.log.warn('lost the connection (' + this.error + ') — will reconnect');
    this.agent.deviceDetached(this);
    this.scheduleRetry();
    this.emit('change');
  }

  scheduleRetry() {
    clearTimeout(this.timer);
    if (this.closing) return;
    const ms = RETRY[Math.min(this.retry, RETRY.length - 1)];
    this.retry++;
    this.timer = setTimeout(() => {
      if (!fs.existsSync(this.port.dev)) { this.state = 'unplugged'; this.goneAt = this.goneAt || Date.now(); this.emit('change'); return; }
      this.open();
    }, ms);
  }

  // The scan saw it again, maybe under a new /dev name. A port that came back
  // is opened at once; one that is merely failing to open is left to its
  // retry timer, so a busy port is not hammered every scan.
  seen(port) {
    const moved = port.dev !== this.port.dev;
    const back = this.state === 'unplugged';
    this.goneAt = 0;
    this.port = port;
    if (moved && this.sp) {
      const s = this.sp; this.sp = null; s.close();
      if (this.driver) this.driver.onClose();
      this.agent.deviceDetached(this);
    }
    if ((moved || back) && !this.closing && this.state !== 'ignored') { clearTimeout(this.timer); this.open(); }
  }

  missing() {
    if (!this.goneAt) {
      this.goneAt = Date.now();
      if (this.state === 'running' || this.state === 'identifying') this.log.warn('unplugged');
      this.state = 'unplugged';
      if (this.sp) { const s = this.sp; this.sp = null; s.close(); if (this.driver) this.driver.onClose(); this.agent.deviceDetached(this); }
      clearTimeout(this.timer);
      this.emit('change');
    }
  }

  async close() {
    this.closing = true;
    clearTimeout(this.timer);
    if (this.sp) { const s = this.sp; this.sp = null; await s.close(); }
    if (this.driver) this.driver.onClose();
    this.agent.deviceDetached(this);
  }

  // Settings changed for this port: start over.
  async restart() {
    await this.close();
    this.closing = false;
    this.driver = null; this.sniffer = null; this.type = null;
    this.retry = 0;
    this.open();
  }

  tick(now) { if (this.driver && this.state === 'running') { try { this.driver.tick(now); } catch (e) { this.log.error(e.stack || e); } } }

  status() {
    const pt = this.point();
    return {
      key: this.key, kind: this.type || 'unknown', name: this.name(), pointId: pt ? pt.pointId : null, state: this.state, how: this.how,
      protocol: this.driver ? this.driver.protocol : null, error: this.error || null,
      port: { dev: this.port.dev, byId: this.port.byId, usb: this.port.usb, driver: this.port.driver, baud: this.sp ? this.sp.baud : (this.sniffer ? this.sniffer.baud : null), acm: this.port.acm },
      rx: this.sp ? this.sp.rx : 0, lastRxAgoMs: this.sp && this.sp.lastRx ? Date.now() - this.sp.lastRx : null,
      reconnects: this.reconnects, openedAt: this.openedAt, detail: this.driver ? this.driver.status() : null,
    };
  }

  detail() { return this.driver ? this.driver.detail() : {}; }
}

function p2(port) {
  const u = port.usb;
  return (u && (u.product || u.manufacturer)) ? (u.product || u.manufacturer) + ' (' + port.name + ')' : port.name;
}

class DeviceManager extends EventEmitter {
  constructor(agent) {
    super();
    this.agent = agent;
    this.log = agent.log.child('devices');
    this.ports = new Map();   // key → PortSession
    this.sdrs = new Map();    // key → SdrSession
    this.timer = null;
    this.tickTimer = null;
    this.sticks = [];
  }

  start() {
    this.scan();
    this.timer = setInterval(() => this.scan(), SCAN_MS);
    this.tickTimer = setInterval(() => { const now = Date.now(); for (const s of this.ports.values()) s.tick(now); }, 1000);
    this.agent.config.on('change', (changed) => this.onConfig(changed));
    return this;
  }

  scan() {
    const cfg = this.agent.config.get().receivers;
    let ports;
    try { ports = listPorts(cfg.extraPorts); } catch (e) { this.log.error('port scan: ' + e.message); ports = []; }
    const present = new Set();
    for (const p of ports) {
      present.add(p.key);
      let s = this.ports.get(p.key);
      if (!s) {
        s = new PortSession(this, p);
        s.on('change', () => this.emit('change'));
        this.ports.set(p.key, s);
        this.log.info('found ' + p.dev + (p.byId ? ' (' + p.byId.split('/').pop() + ')' : '') + (p.usb ? ' USB ' + usbId(p) : ''));
        s.open();
      } else s.seen(p);
    }
    for (const [key, s] of this.ports) {
      if (present.has(key)) continue;
      s.missing();
      if (s.goneAt && Date.now() - s.goneAt > FORGET_MS) { s.close(); this.ports.delete(key); this.emit('change'); }
    }

    let sticks;
    try { sticks = listSdrs(); } catch (e) { sticks = []; }
    this.sticks = sticks;
    const live = new Set();
    for (const st of sticks) {
      live.add(st.key);
      let s = this.sdrs.get(st.key);
      if (!s) {
        s = new SdrSession(this.agent, st);
        s.on('change', () => this.emit('change'));
        this.sdrs.set(st.key, s);
        this.log.info('found RTL-SDR ' + st.vid + ':' + st.pid + ' ' + [st.manufacturer, st.product, st.serial && 'SN ' + st.serial].filter(Boolean).join(' '));
        s.start();
        this.agent.deviceAttached(s);
        this.emit('change');
      } else {
        s.stick = st;
        if (s.state === 'unplugged') { s.log.info('plugged back in'); s.start(); this.agent.deviceAttached(s); this.emit('change'); }
      }
    }
    for (const [key, s] of this.sdrs) {
      if (live.has(key) || s.state === 'unplugged') continue;
      s.log.warn('unplugged');
      s.stop();
      s.state = 'unplugged';
      this.agent.deviceDetached(s);
      this.emit('change');
    }
  }

  sdrCount() { return this.sticks.length; }

  onConfig(changed) {
    if (changed.some(p => p.startsWith('receivers.sdr') || p === 'receivers.sdrDevices' || p.startsWith('audio.'))) {
      for (const s of this.sdrs.values()) if (s.state !== 'unplugged') s.reconfigure();
    }
    if (changed.some(p => p === 'receivers.ports' || p === 'receivers.autoDetect' || p === 'receivers.extraPorts')) {
      for (const s of this.ports.values()) s.restart();
    }
  }

  all() { return [...this.ports.values(), ...this.sdrs.values()]; }

  gpsFix() {
    for (const s of this.ports.values()) if (s.type === 'gps' && s.driver && s.driver.current()) return s.driver.current();
    return null;
  }

  status() {
    return {
      ports: [...this.ports.values()].map(s => s.status()),
      sdrs: [...this.sdrs.values()].map(s => s.status()),
    };
  }

  async stop() {
    clearInterval(this.timer); clearInterval(this.tickTimer);
    for (const s of this.sdrs.values()) s.stop();
    await Promise.all([...this.ports.values()].map(s => s.close()));
  }
}

module.exports = { DeviceManager, PortSession };
