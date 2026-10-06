'use strict';
// Everything bound for MegaNet waits here until it is stored: readings, the
// frames each receiver heard (receptions), and readings still waiting for the
// clock to be trusted.
//
// Rules taken from the Serial Monitor (serial-ingest.js, reception-log.js),
// which MegaNet already runs against this same database:
//   * One protocol and one receiver per batch, at most 1,000 readings, every
//     few seconds (sooner when 500 are waiting). path serial-monitor/<point id>
//     and source "serial" say which receiver heard them; each reading says on
//     what frequency and how strongly (MegaNet 0050).
//   * Retrying is always safe: ingest() stores the same reading once.
//   * 401/403: the token is mistyped or revoked. Stop, keep everything, say
//     so — and start again the moment a new token is saved.
//   * 400: this agent misread the contract. The batch would fail the same way
//     for ever, so it is dropped and logged.
//   * Anything else: keep it, back off (10 s doubling to 5 min), try again —
//     with half the batch, down to 100, in case it was the size (a backfill
//     of days at 1,000 a call can meet the database's statement timeout).
//
// The queue is on disk, appended to two seconds after it changes, so a power
// cut loses at most the last couple of seconds (lib/spool.js). It is bounded
// by disk, not memory: meganet.queueMb (1 GB) for the lot, and never below
// 256 MB of the card left free; past either, the oldest goes first. Memory
// holds a few thousand items whatever the backlog — days of a site survey
// with no network are fine on a Pi 3 (docs/survey.md).

const fs = require('node:fs');
const path = require('node:path');
const { MegaNet } = require('./meganet');
const { Spool } = require('./spool');

const BATCH = 1000, BATCH_MIN = 100, WINDOW = 3000, FLUSH_MS = 5000, RX_FLUSH_MS = 10000, BACKOFF_MAX = 5 * 60 * 1000;
const REPORT_MS = 15 * 60 * 1000;
const MIN_FREE_MB = 256, ROOM_CHECK_MS = 60000;

class Uplink {
  constructor(opts) {
    this.cfg = opts.config;        // Config
    this.clock = opts.clock;
    this.log = opts.log;
    this.dataDir = opts.dataDir;
    this.file = path.join(opts.dataDir, 'queue.json');   // the queue before 0.9, read once and moved into the spool
    this.api = new MegaNet(() => this.cfg.get().meganet, this.log);
    const spool = (name) => new Spool({ dir: path.join(opts.dataDir, 'queue', name), log: this.log });
    this.readings = spool('readings');       // { point, protocol, alert_id, value_raw, reading_ts, line?, freq_mhz?, rssi_dbm?, level_dbfs?, snr_db? }
    this.receptions = spool('receptions');   // { point, receiver, rx: {…} }
    this.pending = spool('pending');         // { kind: 'reading'|'reception', item, mono, boot }
    this.batch = BATCH; this.rxBatch = BATCH;
    this.roomAt = 0;
    this.points = new Map();       // point id → { report payload builder, lastReport, lastSig }
    this.st = {
      accepted: 0, duplicates: 0, rejected: 0, dropped: 0, posted: 0, reasons: [], lastOkAt: null, lastError: '',
      tokenRefused: false, label: '', rxSent: 0, rxRefused: 0, rxMissing: false, rxError: '', reportError: '', endpoint: null,
      untimedDropped: 0,
    };
    this.backoff = 0;
    this.inflight = false;
    this.rxInflight = false;
    this.timer = null;
    this.rxTimer = null;
    this.persistTimer = null;
    this.reportTimer = null;
  }

  load() {
    this.readings.load(); this.receptions.load(); this.pending.load();
    // The whole-file queue of 0.8 and before, moved over once.
    try {
      const q = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const r of Array.isArray(q.readings) ? q.readings : []) this.readings.push(r);
      for (const r of Array.isArray(q.receptions) ? q.receptions : []) this.receptions.push(r);
      for (const r of Array.isArray(q.pending) ? q.pending : []) this.pending.push(r);
      this.persistNow();
      fs.unlinkSync(this.file);
    } catch (_) {}
    if (this.readings.length || this.receptions.length || this.pending.length) {
      this.log.info('kept from before: ' + this.readings.length + ' readings, ' + this.receptions.length + ' receptions, ' + this.pending.length + ' waiting for the clock');
    }
    return this;
  }

  start() {
    this.clock.on('trusted', () => this.timeHeld());
    this.cfg.on('change', (changed) => {
      if (changed.some(p => p.startsWith('meganet.'))) {
        this.st.tokenRefused = false; this.st.lastError = ''; this.backoff = 0; this.st.label = '';
        this.reportAll(true);
        this.schedule(0);
        this.scheduleRx(1000);
      } else if (changed.some(p => p.startsWith('location.') || p === 'name')) this.reportAll(true);
    });
    if (this.clock.trusted()) this.timeHeld();
    this.reportTimer = setInterval(() => this.reportAll(false), 60000);
    this.schedule(2000);
    this.scheduleRx(5000);
    return this;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer); clearTimeout(this.rxTimer); clearInterval(this.reportTimer);
    this.persistNow();
  }

  enabled() { const m = this.cfg.get().meganet; return m.enabled && !!m.token; }

  // ── in ──────────────────────────────────────────────────────────────────

  // r: { point, protocol, alert_id, value_raw, ts|null, line, freq_mhz?, rssi_dbm?, level_dbfs?, snr_db? }
  addReading(r) {
    const item = Object.assign({ point: r.point, protocol: r.protocol, alert_id: r.alert_id, value_raw: r.value_raw, reading_ts: r.ts, line: r.line || undefined }, heard(r));
    if (r.ts == null) { this.hold('reading', item); return; }
    this.readings.push(item);
    this.persistSoon();
    this.schedule(this.readings.length >= 500 ? 0 : FLUSH_MS);
  }

  // always: send it even with meganet.receptions off (a site survey's are its point).
  addReception(point, receiver, rx, always) {
    if (!always && !this.cfg.get().meganet.receptions) return;
    const item = { point, receiver, rx };
    if (rx.heard_at == null) { this.hold('reception', item); return; }
    this.receptions.push(item);
    this.persistSoon();
    this.scheduleRx(RX_FLUSH_MS);
  }

  hold(kind, item) {
    this.pending.push({ kind, item, mono: this.clock.mono(), boot: this.clock.bootId() });
    this.persistSoon();
  }

  // The clock is trusted now: give every held item its real time.
  timeHeld() {
    if (!this.pending.length) return;
    const boot = this.clock.bootId();
    let timed = 0, lost = 0;
    this.pending.drain((p) => {
      if (p.boot !== boot) { lost++; return; }
      const ts = Math.round(this.clock.wallOf(p.mono));
      if (p.kind === 'reading') { p.item.reading_ts = ts; this.readings.push(p.item); }
      else { p.item.rx.heard_at = ts; this.receptions.push(p.item); }
      timed++;
    });
    if (lost) { this.st.untimedDropped += lost; this.log.warn(lost + ' readings from an earlier boot never had a trustworthy clock and cannot be timed — dropped'); }
    if (timed) this.log.info('the clock is good: ' + timed + ' held readings/receptions timed and queued');
    this.persistSoon();
    this.schedule(0);
    this.scheduleRx(1000);
  }

  // ── readings out ────────────────────────────────────────────────────────

  schedule(ms) {
    if (this.inflight || this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), Math.max(ms, this.backoff));
  }

  async flush() {
    if (this.inflight || !this.readings.length || !this.enabled() || this.st.tokenRefused) return;
    const win = this.readings.peek(WINDOW);
    if (!win.length) return;
    const first = win[0].item;
    const picked = [];
    for (const e of win) {
      if (e.item.point === first.point && e.item.protocol === first.protocol) picked.push(e);
      if (picked.length >= this.batch) break;
    }
    const batch = picked.map(e => e.item);
    const lines = batch.map(r => r.line).filter(Boolean);
    const payload = {
      source: 'serial', protocol: first.protocol, path: 'serial-monitor/' + first.point,
      readings: batch.map(r => Object.assign({ alert_id: r.alert_id, reading_ts: r.reading_ts, value_raw: r.value_raw }, heard(r))),
    };
    if (lines.length) payload.frame = lines.join('\n').slice(-32768);
    this.inflight = true;
    let res;
    try {
      res = await this.api.rpc('ingest_http', payload);
    } catch (e) {
      this.inflight = false;
      this.st.lastError = 'Could not reach MegaNet (' + e.message + ') — keeping ' + this.readings.length + ', trying again.';
      this.bump();
      return;
    }
    this.inflight = false;
    this.st.endpoint = res.endpoint;
    const out = res.body;
    if (res.status === 200 && out && typeof out.accepted === 'number') {
      this.readings.ack(picked);
      this.batch = Math.min(BATCH, this.batch * 2);
      this.st.posted += batch.length; this.st.accepted += out.accepted; this.st.duplicates += out.duplicates || 0;
      for (const x of out.rejected || []) {
        this.st.rejected++;
        const r = batch[x.i];
        this.st.reasons.unshift((r ? 'ID ' + r.alert_id + ': ' : '') + x.why);
      }
      this.st.reasons = this.st.reasons.slice(0, 6);
      if ((out.rejected || []).length) this.log.warn('MegaNet refused ' + out.rejected.length + ' of ' + batch.length + ': ' + this.st.reasons[0]);
      this.st.lastOkAt = Date.now(); this.st.lastError = ''; this.backoff = 0;
      this.persistSoon();
      if (this.readings.length) this.schedule(0);
    } else if (res.status === 401 || res.status === 403) {
      this.st.tokenRefused = true;
      this.st.lastError = 'MegaNet refused the ingest token (' + res.status + ') — it is mistyped or has been revoked. Nothing is lost: '
        + this.readings.length + ' readings are kept to send once a working token is saved.';
      this.log.error(this.st.lastError);
    } else if (res.status === 400) {
      this.readings.ack(picked);
      this.st.lastError = 'MegaNet refused a batch of ' + batch.length + ' as malformed (' + ((out && (out.message || out.hint)) || res.status) + ') — dropped.';
      this.log.error(this.st.lastError);
      this.persistSoon();
      if (this.readings.length) this.schedule(FLUSH_MS);
    } else {
      this.st.lastError = 'MegaNet answered ' + res.status + ((out && out.message) ? ' (' + out.message + ')' : '') + ' — keeping ' + this.readings.length + ', trying again.';
      if (batch.length > BATCH_MIN) this.batch = Math.max(BATCH_MIN, batch.length >> 1);
      this.bump();
    }
  }

  bump() {
    this.backoff = Math.min(BACKOFF_MAX, this.backoff ? this.backoff * 2 : 10000);
    this.log.warn(this.st.lastError + ' Next try in ' + Math.round(this.backoff / 1000) + ' s.');
    this.schedule(this.backoff);
  }

  sendNow() { this.backoff = 0; this.st.tokenRefused = false; this.schedule(0); this.scheduleRx(0); this.reportAll(true); }

  // ── receptions out ──────────────────────────────────────────────────────

  scheduleRx(ms) {
    if (this.rxInflight || this.stopped) return;
    clearTimeout(this.rxTimer);
    this.rxTimer = setTimeout(() => this.flushRx(), ms);
  }

  async flushRx() {
    if (this.rxInflight || !this.receptions.length || !this.enabled() || this.st.tokenRefused) return;
    if (this.st.rxMissing && Date.now() - this.st.rxMissing < 3600000) return;
    const win = this.receptions.peek(WINDOW);
    if (!win.length) return;
    const first = win[0].item;
    const picked = [];
    for (const e of win) {
      if (e.item.point === first.point && e.item.receiver === first.receiver) picked.push(e);
      if (picked.length >= this.rxBatch) break;
    }
    const batch = picked.map(e => e.item);
    this.rxInflight = true;
    try {
      const res = await this.api.rpc('report_receptions', { point_id: first.point, receiver: first.receiver, receptions: batch.map(b => b.rx) });
      if (res.status === 200 && res.body) {
        this.receptions.ack(picked);
        this.rxBatch = Math.min(BATCH, this.rxBatch * 2);
        this.st.rxSent += res.body.accepted || 0;
        this.st.rxRefused += (res.body.rejected || []).length;
        this.st.rxError = ''; this.st.rxMissing = false;
        this.persistSoon();
      } else if (res.status === 404 && res.missingFn) {
        this.st.rxMissing = Date.now();
        this.st.rxError = 'MegaNet cannot keep receptions yet (migration 0047 is not applied there); they are kept here.';
      } else if (res.status === 400) {
        this.receptions.ack(picked);
        this.persistSoon();
        this.st.rxError = 'MegaNet refused a batch of receptions as malformed (' + ((res.body && res.body.message) || 400) + ') — dropped.';
        this.log.warn(this.st.rxError);
      } else if (res.status === 401 || res.status === 403) {
        this.st.rxError = 'The ingest token was refused.';
      } else {
        this.st.rxError = 'Receptions not sent (' + res.status + ') — kept, and tried again.';
        if (batch.length > BATCH_MIN) this.rxBatch = Math.max(BATCH_MIN, batch.length >> 1);
      }
    } catch (e) {
      this.st.rxError = 'Receptions not sent (' + e.message + ') — kept, and tried again.';
    }
    this.rxInflight = false;
    if (this.receptions.length) this.scheduleRx(this.st.rxError ? 60000 : (this.receptions.length >= this.rxBatch ? 0 : RX_FLUSH_MS));
  }

  // ── each receiver describes itself (0045) ───────────────────────────────

  // describe: () => payload for report_ingest_point, or null while it has nothing to say
  registerPoint(pointId, describe) {
    const p = this.points.get(pointId) || { lastReport: 0, lastSig: '' };
    p.describe = describe;
    p.active = true;
    this.points.set(pointId, p);
    this.reportOne(pointId, true);
  }
  deactivatePoint(pointId) { const p = this.points.get(pointId); if (p) p.active = false; }
  forgetPoint(pointId) { this.points.delete(pointId); }

  reportAll(force) { for (const id of this.points.keys()) this.reportOne(id, force); }

  async reportOne(pointId, force) {
    const p = this.points.get(pointId);
    if (!p || !p.active || !this.enabled() || this.st.tokenRefused) return;
    const payload = p.describe();
    if (!payload) return;
    const sig = JSON.stringify(payload);
    const due = Date.now() - p.lastReport > REPORT_MS;
    if (!force && !due && sig === p.lastSig) return;
    if (p.busy) return;
    p.busy = true;
    try {
      const res = await this.api.rpc('report_ingest_point', payload);
      if (res.status === 200 && res.body) {
        p.lastReport = Date.now(); p.lastSig = sig;
        this.st.label = res.body.label || this.st.label;
        this.st.reportError = '';
      } else if (res.status === 404 && res.missingFn) {
        p.lastReport = Date.now(); p.lastSig = sig;
        this.st.reportError = 'MegaNet cannot record receiver descriptions yet (migration 0045 is not applied there). Readings still go.';
      } else if (res.status === 401 || res.status === 403) {
        this.st.reportError = 'The ingest token was refused.';
        if (!this.st.tokenRefused) { this.st.tokenRefused = true; this.st.lastError = 'MegaNet refused the ingest token (' + res.status + ').'; this.log.error(this.st.lastError); }
      } else {
        this.st.reportError = 'Receiver description not recorded (' + res.status + ((res.body && res.body.message) ? ': ' + res.body.message : '') + ').';
      }
    } catch (e) {
      this.st.reportError = 'Receiver description not recorded: ' + e.message;
    }
    p.busy = false;
  }

  // Check a token without saving it: report one receiver with it.
  async testToken(token, payload) {
    const res = await this.api.rpc('report_ingest_point', payload, token);
    if (res.status === 200 && res.body) return { ok: true, label: res.body.label || '', endpoint: res.endpoint };
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'MegaNet refused this token (' + res.status + ').' };
    if (res.status === 404 && res.missingFn) return { ok: true, label: '', note: 'MegaNet has no report_ingest_point yet; the token could not be checked this way.' };
    return { ok: false, error: 'MegaNet answered ' + res.status + ((res.body && res.body.message) ? ': ' + res.body.message : '') };
  }

  // ── on disk ─────────────────────────────────────────────────────────────

  persistSoon() {
    if (this.persistTimer) return;
    if (this.stopped) { this.persistNow(); return; }
    this.persistTimer = setTimeout(() => { this.persistTimer = null; this.persistNow(); }, 2000);
  }
  persistNow() {
    clearTimeout(this.persistTimer); this.persistTimer = null;
    this.readings.flush(); this.receptions.flush(); this.pending.flush();
    this.makeRoom();
  }

  // Past meganet.queueMb, or with the card nearly full, the oldest goes —
  // from whichever queue is biggest — and is counted, never silently.
  makeRoom() {
    const cap = (this.cfg.get().meganet.queueMb || 1024) * 1048576;
    const spools = [this.readings, this.receptions, this.pending];
    let free = Infinity;
    if (Date.now() - this.roomAt > ROOM_CHECK_MS) {
      this.roomAt = Date.now();
      try { const s = fs.statfsSync(this.dataDir); free = s.bavail * s.bsize; this.st.diskFreeMb = Math.round(free / 1048576); } catch (_) {}
    }
    for (let guard = 0; guard < 1000; guard++) {
      const total = spools.reduce((a, s) => a + s.bytes(), 0);
      const short = free < MIN_FREE_MB * 1048576;
      if (total <= cap && !short) break;
      const big = spools.slice().sort((a, b) => b.bytes() - a.bytes())[0];
      const before = big.bytes();
      const lost = big.dropOldest();
      if (!lost && big.bytes() === before) break;
      this.st.dropped += lost;
      if (short) free += before - big.bytes();
      this.log.warn('the queue is ' + (short ? 'filling the SD card' : 'at its ' + (cap / 1048576) + ' MB limit (meganet.queueMb)') + ' — dropped the oldest ' + lost + ' waiting items');
    }
  }

  queueBytes() { return this.readings.bytes() + this.receptions.bytes() + this.pending.bytes(); }

  status() {
    const m = this.cfg.get().meganet;
    return Object.assign({}, this.st, {
      enabled: m.enabled, tokenSet: !!m.token, queued: this.readings.length, receptionsQueued: this.receptions.length,
      waitingForClock: this.pending.length, backoffMs: this.backoff, endpoint: this.api.lastEndpoint,
      queueMb: Math.round(this.queueBytes() / 104857.6) / 10, queueLimitMb: m.queueMb || 1024, inMemory: this.readings.loadedItems() + this.receptions.loadedItems() + this.pending.loadedItems(),
    });
  }
}

// How a reading was heard (MegaNet 0050): the frequency its receiver channel
// is on, and the signal in whatever terms the receiver measures it — dBm off a
// radio or an ERT-A2, dBFS off an RTL-SDR, and the SNR over its noise floor.
// Each goes only as a number; MegaNet stores a bad one as null and never
// refuses the reading over it, but a queue kept on disk is no place for NaN.
const HEARD = ['freq_mhz', 'rssi_dbm', 'level_dbfs', 'snr_db'];
function heard(r) {
  const o = {};
  for (const k of HEARD) {
    const v = r[k] == null || r[k] === '' ? NaN : Number(r[k]);
    if (Number.isFinite(v)) o[k] = +v.toFixed(k === 'freq_mhz' ? 6 : 2);
  }
  return o;
}

module.exports = { Uplink };
