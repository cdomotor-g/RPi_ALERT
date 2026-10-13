'use strict';
// The last day, a minute at a time, for the dashboard's graphs: the Pi's
// temperature, load and memory, and for each receiver the bursts and readings
// it heard and its noise floor. Kept in memory and written to the data
// directory every ten minutes (and on the way down), so a restart or an update
// does not blank the graphs; a power cut loses at most those ten minutes.
//
// Receivers are keyed as the page keys them: a serial device, a stick with one
// channel, or each channel of a stick with several (session.key).

const fs = require('node:fs');
const path = require('node:path');
const system = require('./system');

const MINUTE = 60 * 1000;
const KEEP_MS = 24 * 60 * MINUTE;
const LEVEL_EVERY_MS = 10 * 1000;   // the noise floor, averaged over the minute
const SAVE_EVERY_MS = 10 * MINUTE;

const minuteOf = (t) => Math.floor(t / MINUTE) * MINUTE;
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);

class History {
  constructor(agent, opts) {
    opts = opts || {};
    this.agent = agent;
    this.log = agent.log.child ? agent.log.child('history') : agent.log;
    this.file = path.join(agent.dataDir, 'history.json');
    this.now = opts.now || (() => Date.now());
    this.sys = [];            // [t, tempC, load1, memUsedPct]
    this.rx = new Map();      // key → { name, unit, rows: [[t, bursts, readings, nf]] }
    this.acc = new Map();     // key → { t, sum, n }: this minute's noise floor so far
    this.timers = [];
    this.onBurst = (b) => this.count(b.key, b.receiver, 1, 0);
    this.onReading = (r) => this.count(r.receiverKey, r.receiver, 0, 1);
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const since = this.now() - KEEP_MS;
      if (Array.isArray(j.sys)) this.sys = j.sys.filter(p => Array.isArray(p) && p[0] >= since);
      for (const [k, v] of Object.entries(j.rx || {})) {
        const rows = (v.rows || []).filter(p => Array.isArray(p) && p[0] >= since);
        if (rows.length) this.rx.set(k, { name: String(v.name || k), unit: v.unit || null, rows });
      }
    } catch (_) {}
    return this;
  }

  start() {
    this.agent.on('burst', this.onBurst);
    this.agent.on('reading', this.onReading);
    this.timers.push(setInterval(() => this.levels(), LEVEL_EVERY_MS));
    this.timers.push(setInterval(() => { this.sample().catch(() => {}); }, MINUTE));
    this.timers.push(setInterval(() => this.save(), SAVE_EVERY_MS));
    setTimeout(() => { this.levels(); this.sample().catch(() => {}); }, 3000).unref?.();
    return this;
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.agent.off('burst', this.onBurst);
    this.agent.off('reading', this.onReading);
    this.save();
  }

  // This minute's row for a receiver, made if need be.
  row(key, name, unit) {
    let r = this.rx.get(key);
    if (!r) { r = { name: name || key, unit: unit || null, rows: [] }; this.rx.set(key, r); }
    if (name) r.name = name;
    if (unit) r.unit = unit;
    const t = minuteOf(this.now());
    let last = r.rows[r.rows.length - 1];
    if (!last || last[0] !== t) { last = [t, 0, 0, null]; r.rows.push(last); this.trim(r.rows); }
    return last;
  }

  count(key, name, bursts, readings) {
    if (!key) return;
    const row = this.row(key, name);
    row[1] += bursts;
    row[2] += readings;
  }

  // Each receiver's noise floor now: an SDR channel's in dBFS, a Quansheng
  // radio's in dBm. An ERT-A2 does not say.
  levels() {
    let st;
    try { st = this.agent.devices.status(); } catch (_) { return; }
    const seen = [];
    for (const d of st.sdrs || []) {
      const multi = d.channels && d.channels.length > 1;
      for (const ch of multi ? d.channels : [Object.assign({}, d, { key: (d.channels && d.channels[0] && d.channels[0].key) || d.key })]) {
        if (ch.level && ch.level.nfDb != null) seen.push([ch.key, ch.name, 'dBFS', ch.level.nfDb]);
      }
    }
    for (const p of st.ports || []) {
      if (p.kind === 'quansheng' && p.detail && p.detail.nf_dbm != null && p.state === 'running') seen.push([p.key, p.name, 'dBm', p.detail.nf_dbm]);
    }
    const t = minuteOf(this.now());
    for (const [key, name, unit, nf] of seen) {
      let a = this.acc.get(key);
      if (!a || a.t !== t) { a = { t, sum: 0, n: 0 }; this.acc.set(key, a); }
      a.sum += nf; a.n++;
      this.row(key, name, unit)[3] = r1(a.sum / a.n);
    }
  }

  async sample() {
    const s = await system.info();
    const mem = s.memMb && s.memMb.total ? (1 - s.memMb.free / s.memMb.total) * 100 : null;
    const t = minuteOf(this.now());
    const p = [t, s.tempC, s.load ? s.load[0] : null, r1(mem)];
    if (this.sys.length && this.sys[this.sys.length - 1][0] === t) this.sys[this.sys.length - 1] = p;
    else this.sys.push(p);
    this.trim(this.sys);
  }

  trim(rows) {
    const since = this.now() - KEEP_MS;
    let i = 0;
    while (i < rows.length && rows[i][0] < since) i++;
    if (i) rows.splice(0, i);
  }

  // For the page: everything from `since` on (0: the whole day). The minute
  // still being filled is always included, so a page asking again from the
  // last minute it has gets that minute's final counts.
  get(since) {
    since = Math.max(Number(since) || 0, this.now() - KEEP_MS);
    const rx = [];
    for (const [key, r] of this.rx) {
      const rows = r.rows.filter(p => p[0] >= since);
      if (rows.length || !since) rx.push({ key, name: r.name, unit: r.unit, rows });
    }
    return { now: this.now(), minuteMs: MINUTE, keepMs: KEEP_MS, cores: (this.agent.board && this.agent.board.cores) || null,
      sys: this.sys.filter(p => p[0] >= since), rx };
  }

  save() {
    try {
      const rx = {};
      for (const [k, v] of this.rx) if (v.rows.length) rx[k] = v;
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ sys: this.sys, rx }));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) { this.log.debug && this.log.debug('history not saved: ' + e.message); }
  }
}

module.exports = { History, MINUTE, KEEP_MS };
