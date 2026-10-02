'use strict';
// A Quansheng UV-K5 V3 / UV-K1 on the ALERT receiver firmware
// (cdomotor-g/quansheng_alert_v3, schema 2), or a UV-K5 on the older DP32G030
// ALERT firmware (cdomotor-g/quansheng_alert) through its programming cable.
//
// Everything about the wire format is MegaNet's quansheng.js — the same codec
// the website's Serial Monitor runs. What this file adds is what a base
// station that nobody is watching needs:
//
//   * DTR. The radio sends only while the host holds DTR, and goes silent for
//     good when a send is not collected. On every (re)open the port's DTR goes
//     down and up (close with HUPCL, reopen), and after 25 s with not one byte
//     — STA alone arrives every 10 s — it is toggled again (ALERT_SERIAL.md §2).
//   * The clock. It lives in the radio's RAM and is lost at every reboot, so it
//     is set (TIME <epoch>) whenever the radio (re)connects and the Pi's own
//     clock is trustworthy, and again each hour.
//   * One console command at a time, each ending in OK or ERR (§7.1).
//
// Every DEC line is a reading, protocol "alert" (the radio hears legacy ALERT:
// ALERT Binary or Enhanced iFLOWS, shown in `fmt`). Readings are timed by
// arrival, as the Serial Monitor times a live port's.

const { Quansheng: Q } = require('../meganet-codecs');

const SILENCE_MS = 25000;
const CLOCK_EVERY_MS = 60 * 60 * 1000;
const LEGACY = /^ALERT,(\d+),(\d+),([A-Z0-9]*),(-?\d*),(.*)$/;

class QuanshengDriver {
  constructor(ctx) {
    this.ctx = ctx;
    this.kind = 'quansheng';
    this.protocol = 'alert';
    this.schema = Q.createSchema();
    this.reader = new Q.LineReader();
    this.console = !!(ctx.port && ctx.port.acm);   // the console is USB only; the UART carries records only
    this.queue = [];
    this.cur = null;
    this.legacy = false;
    this.sta = null;
    this.info = {};
    this.settings = {};
    this.fw = null;
    this.lastByte = Date.now();
    this.lastClockSet = 0;
    this.dtrToggles = 0;
    this.counts = { dec: 0, bst: 0, undecoded: 0, sta: 0, evt: 0, lines: 0 };
    this.lastDec = null;
    this.bootloader = false;
  }

  onOpen() {
    this.lastByte = Date.now();
    this.reader = new Q.LineReader();
    this.cur = null;
    this.queue = [];
    if (!this.console) return;
    // Give the firmware a moment after DTR rises, then ask for the schema at
    // once (the HDR block sent at app start is lost if no host had DTR up),
    // set the clock, and read the radio's details.
    setTimeout(() => {
      this.command('CSV HDR');
      this.syncClock(true);
      this.command('INFO');
    }, 800);
  }

  onClose() {
    if (this.cur) { clearTimeout(this.cur.timer); this.cur.reject(new Error('port closed')); }
    this.cur = null;
    this.queue.splice(0).forEach(q => q.reject(new Error('port closed')));
  }

  feed(chunk) {
    this.lastByte = Date.now();
    this.dtrToggles = 0;
    const { lines, frames } = this.reader.feed(chunk);
    if (this.reader.bootloader && !this.bootloader) {
      this.bootloader = true;
      this.ctx.log.warn('the radio is in its bootloader (DFU) — it is waiting to be flashed, not receiving');
    }
    for (const f of frames) this.ctx.log.debug('binary frame 0x' + f.id.toString(16));
    for (const line of lines) this.line(line);
  }

  line(line) {
    this.counts.lines++;
    const cls = Q.classify(line);
    if (cls === 'final') return this.finish(line);
    if (cls === 'record') {
      if (this.cur) this.touch();
      return this.record(line);
    }
    if (cls === 'debug') { this.ctx.log.debug('radio: ' + line); if (this.cur) this.touch(); return; }
    // data: a console reply line
    if (this.cur) { this.cur.lines.push(line); this.touch(); this.data(line); }
  }

  record(line) {
    if (line.startsWith('ALERT,')) return this.legacyLine(line);
    const p = Q.parseRecord(this.schema, line);
    if (p.type === 'HDR') {
      if (p.header && p.header.kind === 'fw') {
        this.fw = p.header.fw;
        if (p.header.schema !== Q.SCHEMA) this.ctx.log.warn('the radio speaks schema ' + p.header.schema + '; this agent was written for ' + Q.SCHEMA);
      }
      return;
    }
    if (!p.rec) return;
    const r = p.rec;
    if (p.type === 'DEC') {
      this.counts.dec++;
      if (r.id == null || r.value == null) return;
      this.lastDec = { t: Date.now(), id: r.id, value: r.value, name: r.name, kind: r.kind, fmt: r.fmt, rssi: r.rssi };
      this.ctx.reading({
        alert_id: r.id, value_raw: r.value, protocol: 'alert', fmt: r.fmt || null, line,
        rssi_dbm: r.rssi, nf_dbm: r.nf, fade_db: r.fade, name: r.name || '', kindLabel: r.kind || '',
        eng: r.eng, unit: r.unit, burstKey: 'q' + r.uptime_ms,
      });
      this.ctx.reception({
        protocol: 'alert', alert_id: r.id, value_raw: r.value, payload_hex: r.payload_hex || null, ok: true,
        rssi_dbm: r.rssi, nf_dbm: r.nf, detail: { fmt: r.fmt, fade: r.fade, uptime_ms: r.uptime_ms },
      });
    } else if (p.type === 'BST') {
      this.counts.bst++;
      this.ctx.event('burst', { peak: r.peak, nf: r.nf, ms: r.burst_ms, frames: r.nframes });
      if (r.nframes === 0) {
        this.counts.undecoded++;
        this.ctx.reception({ protocol: 'alert', alert_id: null, ok: false, fault: 'undecoded', rssi_dbm: r.peak, nf_dbm: r.nf,
          detail: { burst_ms: r.burst_ms, nbits: r.nbits, uptime_ms: r.uptime_ms } });
      }
    } else if (p.type === 'STA') {
      this.counts.sta++;
      this.sta = Object.assign({ t: Date.now() }, r);
      this.ctx.event('status', {});
    } else if (p.type === 'EVT') {
      this.counts.evt++;
      this.ctx.log.info('radio event ' + r.code + (r.detail ? ': ' + r.detail : ''));
    }
  }

  // The pre-schema-2 line: ALERT,<id>,<value>,<ABF|EIF>,<rssi dBm>,<name>
  legacyLine(line) {
    const m = LEGACY.exec(line);
    if (!m) return;
    if (!this.legacy) { this.legacy = true; this.ctx.log.info('legacy ALERT firmware line format (DP32G030 build)'); }
    this.counts.dec++;
    const id = Number(m[1]), value = Number(m[2]), rssi = m[4] === '' ? null : Number(m[4]);
    this.lastDec = { t: Date.now(), id, value, name: m[5], fmt: m[3] || null, rssi };
    this.ctx.reading({ alert_id: id, value_raw: value, protocol: 'alert', fmt: m[3] || null, line, rssi_dbm: rssi, name: m[5].trim() });
    this.ctx.reception({ protocol: 'alert', alert_id: id, value_raw: value, ok: true, rssi_dbm: rssi, detail: { fmt: m[3] || null, legacy: true } });
  }

  data(line) {
    const d = Q.parseData(this.schema, line);
    if (d.type === 'INFO') this.info[d.key] = d.values.join(',');
    else if (d.type === 'GET') this.settings[d.name] = d.value;
  }

  // ── the console: one command at a time ─────────────────────────────────────

  command(cmd) {
    if (!this.console) return Promise.reject(new Error('this radio is on its UART, which has no console'));
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd, resolve, reject });
      this.next();
    });
  }

  next() {
    if (this.cur || !this.queue.length) return;
    const q = this.queue.shift();
    this.cur = Object.assign(q, { lines: [], timer: null });
    this.touch();
    this.ctx.write(q.cmd + '\r').catch(e => { this.fail(e); });
  }

  touch() {
    if (!this.cur) return;
    clearTimeout(this.cur.timer);
    this.cur.timer = setTimeout(() => this.fail(new Error('no answer to ' + this.cur.cmd)), Q.timeoutFor(this.cur.cmd));
  }

  finish(line) {
    if (!this.cur) return;
    const c = this.cur;
    this.cur = null;
    clearTimeout(c.timer);
    const f = Q.parseFinal(line);
    if (f.ok) c.resolve({ lines: c.lines, detail: f.detail });
    else c.reject(new Error(c.cmd + ': ERR ' + f.reason + (Q.ERRORS[f.reason] ? ' (' + Q.ERRORS[f.reason] + ')' : '')));
    this.next();
  }

  fail(err) {
    if (!this.cur) return;
    const c = this.cur;
    this.cur = null;
    clearTimeout(c.timer);
    c.reject(err);
    this.next();
  }

  syncClock(force) {
    if (!this.console || !this.ctx.clock.trusted()) return;
    const now = this.ctx.clock.now();
    if (!force && now - this.lastClockSet < CLOCK_EVERY_MS) return;
    this.lastClockSet = now;
    this.command('TIME ' + Math.floor(now / 1000))
      .then(() => this.ctx.log.info('set the radio\'s clock'))
      .catch(e => this.ctx.log.warn('could not set the radio\'s clock: ' + e.message));
  }

  tick(now) {
    // Silence on the USB port means the radio dropped the host: toggle DTR
    // (before anything else is queued to a radio that is not listening). Not
    // on the UART, where silence means the ALERT app is not running.
    if (this.console && !this.cur && now - this.lastByte > SILENCE_MS) {
      this.lastByte = now;
      this.dtrToggles++;
      this.ctx.log.info('no data for ' + Math.round(SILENCE_MS / 1000) + ' s — toggling DTR' + (this.dtrToggles > 1 ? ' (' + this.dtrToggles + ' times now; is the ALERT app running on the radio?)' : ''));
      this.ctx.toggleDtr();
      return;
    }
    this.syncClock(false);
  }

  status() {
    const s = this.sta;
    return {
      firmware: this.fw, legacy: this.legacy, console: this.console, bootloader: this.bootloader,
      battery: s ? { mv: s.batt_mv, pct: s.batt_pct } : null,
      nf_dbm: s ? s.nf : null, rssi_dbm: s ? s.rssi : null, squelch: s ? !!s.sq : null,
      bursts: s ? s.bursts : null, decodes: s ? s.decodes : null, log: s ? { state: s.log_state, count: s.log_count, cap: s.log_cap } : null,
      stationTable: s ? s.stn_src : (this.info.stn || null), freq: this.settings.FREQ_MHZ || null,
      counts: this.counts, lastDec: this.lastDec, staAgeMs: s ? Date.now() - s.t : null,
    };
  }

  detail() {
    const d = { via: this.console ? 'USB' : 'UART' };
    if (this.fw) d.firmware = this.fw;
    if (this.legacy) d.firmware_line = 'legacy';
    d.schema = this.legacy ? 1 : Q.SCHEMA;
    const st = this.sta && this.sta.stn_src;
    if (st) d.station_table = st;
    if (this.settings.FREQ_MHZ) d.freq_mhz = Number(this.settings.FREQ_MHZ);
    return d;
  }
}

module.exports = { QuanshengDriver };
