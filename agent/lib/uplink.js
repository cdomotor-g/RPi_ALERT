'use strict';
// Everything bound for MegaNet waits here until it is stored: readings, the
// frames each receiver heard (receptions), and readings still waiting for the
// clock to be trusted.
//
// Rules taken from the Serial Monitor (serial-ingest.js, reception-log.js),
// which MegaNet already runs against this same database:
//   * One protocol and one receiver per batch, at most 1,000 readings, every
//     few seconds (sooner when 500 are waiting). path serial-monitor/<point id>
//     and source "serial" say which receiver heard them.
//   * Retrying is always safe: ingest() stores the same reading once.
//   * 401/403: the token is mistyped or revoked. Stop, keep everything, say
//     so — and start again the moment a new token is saved.
//   * 400: this agent misread the contract. The batch would fail the same way
//     for ever, so it is dropped and logged.
//   * Anything else: keep it, back off (10 s doubling to 5 min), try again.
//
// The queue is kept on disk (the newest 50,000 readings and 20,000
// receptions), written two seconds after it changes, so a power cut loses at
// most the last couple of seconds.

const fs = require('node:fs');
const path = require('node:path');
const { MegaNet } = require('./meganet');

const READINGS_MAX = 50000, RECEPTIONS_MAX = 20000, PENDING_MAX = 20000;
const BATCH = 1000, FLUSH_MS = 5000, RX_FLUSH_MS = 10000, BACKOFF_MAX = 5 * 60 * 1000;
const REPORT_MS = 15 * 60 * 1000;

class Uplink {
  constructor(opts) {
    this.cfg = opts.config;        // Config
    this.clock = opts.clock;
    this.log = opts.log;
    this.file = path.join(opts.dataDir, 'queue.json');
    this.api = new MegaNet(() => this.cfg.get().meganet, this.log);
    this.readings = [];            // { point, protocol, alert_id, value_raw, reading_ts, line? }
    this.receptions = [];          // { point, receiver, rx: {…} }
    this.pending = [];             // { kind: 'reading'|'reception', item, mono, boot }
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
    try {
      const q = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.readings = Array.isArray(q.readings) ? q.readings : [];
      this.receptions = Array.isArray(q.receptions) ? q.receptions : [];
      this.pending = Array.isArray(q.pending) ? q.pending : [];
      if (this.readings.length || this.receptions.length || this.pending.length) {
        this.log.info('kept from before: ' + this.readings.length + ' readings, ' + this.receptions.length + ' receptions, ' + this.pending.length + ' waiting for the clock');
      }
    } catch (_) {}
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

  // r: { point, protocol, alert_id, value_raw, ts|null, line }
  addReading(r) {
    const item = { point: r.point, protocol: r.protocol, alert_id: r.alert_id, value_raw: r.value_raw, reading_ts: r.ts, line: r.line || undefined };
    if (r.ts == null) { this.hold('reading', item); return; }
    this.readings.push(item);
    if (this.readings.length > READINGS_MAX) { this.st.dropped += this.readings.length - READINGS_MAX; this.readings.splice(0, this.readings.length - READINGS_MAX); }
    this.persistSoon();
    this.schedule(this.readings.length >= 500 ? 0 : FLUSH_MS);
  }

  addReception(point, receiver, rx) {
    if (!this.cfg.get().meganet.receptions) return;
    const item = { point, receiver, rx };
    if (rx.heard_at == null) { this.hold('reception', item); return; }
    this.receptions.push(item);
    if (this.receptions.length > RECEPTIONS_MAX) this.receptions.splice(0, this.receptions.length - RECEPTIONS_MAX);
    this.persistSoon();
    this.scheduleRx(RX_FLUSH_MS);
  }

  hold(kind, item) {
    this.pending.push({ kind, item, mono: this.clock.mono(), boot: this.clock.bootId() });
    if (this.pending.length > PENDING_MAX) this.pending.splice(0, this.pending.length - PENDING_MAX);
    this.persistSoon();
  }

  // The clock is trusted now: give every held item its real time.
  timeHeld() {
    if (!this.pending.length) return;
    const boot = this.clock.bootId();
    let timed = 0, lost = 0;
    for (const p of this.pending) {
      if (p.boot !== boot) { lost++; continue; }
      const ts = Math.round(this.clock.wallOf(p.mono));
      if (p.kind === 'reading') { p.item.reading_ts = ts; this.readings.push(p.item); }
      else { p.item.rx.heard_at = ts; this.receptions.push(p.item); }
      timed++;
    }
    this.pending = [];
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
    const first = this.readings[0];
    const batch = [];
    for (const r of this.readings) {
      if (r.point === first.point && r.protocol === first.protocol) batch.push(r);
      if (batch.length >= BATCH) break;
    }
    const lines = batch.map(r => r.line).filter(Boolean);
    const payload = {
      source: 'serial', protocol: first.protocol, path: 'serial-monitor/' + first.point,
      readings: batch.map(r => ({ alert_id: r.alert_id, reading_ts: r.reading_ts, value_raw: r.value_raw })),
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
      const sent = new Set(batch);
      this.readings = this.readings.filter(r => !sent.has(r));
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
      const sent = new Set(batch);
      this.readings = this.readings.filter(r => !sent.has(r));
      this.st.lastError = 'MegaNet refused a batch of ' + batch.length + ' as malformed (' + ((out && (out.message || out.hint)) || res.status) + ') — dropped.';
      this.log.error(this.st.lastError);
      this.persistSoon();
      if (this.readings.length) this.schedule(FLUSH_MS);
    } else {
      this.st.lastError = 'MegaNet answered ' + res.status + ((out && out.message) ? ' (' + out.message + ')' : '') + ' — keeping ' + this.readings.length + ', trying again.';
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
    const first = this.receptions[0];
    const batch = [];
    for (const r of this.receptions) {
      if (r.point === first.point && r.receiver === first.receiver) batch.push(r);
      if (batch.length >= BATCH) break;
    }
    this.rxInflight = true;
    try {
      const res = await this.api.rpc('report_receptions', { point_id: first.point, receiver: first.receiver, receptions: batch.map(b => b.rx) });
      if (res.status === 200 && res.body) {
        const sent = new Set(batch);
        this.receptions = this.receptions.filter(r => !sent.has(r));
        this.st.rxSent += res.body.accepted || 0;
        this.st.rxRefused += (res.body.rejected || []).length;
        this.st.rxError = ''; this.st.rxMissing = false;
        this.persistSoon();
      } else if (res.status === 404 && res.missingFn) {
        this.st.rxMissing = Date.now();
        this.st.rxError = 'MegaNet cannot keep receptions yet (migration 0047 is not applied there); they are kept here.';
      } else if (res.status === 400) {
        const sent = new Set(batch);
        this.receptions = this.receptions.filter(r => !sent.has(r));
        this.st.rxError = 'MegaNet refused a batch of receptions as malformed (' + ((res.body && res.body.message) || 400) + ') — dropped.';
        this.log.warn(this.st.rxError);
      } else if (res.status === 401 || res.status === 403) {
        this.st.rxError = 'The ingest token was refused.';
      } else {
        this.st.rxError = 'Receptions not sent (' + res.status + ') — kept, and tried again.';
      }
    } catch (e) {
      this.st.rxError = 'Receptions not sent (' + e.message + ') — kept, and tried again.';
    }
    this.rxInflight = false;
    if (this.receptions.length) this.scheduleRx(this.st.rxError ? 60000 : (this.receptions.length >= BATCH ? 0 : RX_FLUSH_MS));
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
    try {
      if (!this.readings.length && !this.receptions.length && !this.pending.length) {
        if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
        return;
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ readings: this.readings, receptions: this.receptions, pending: this.pending }));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) { this.log.warn('could not save the queue: ' + e.message); }
  }

  status() {
    const m = this.cfg.get().meganet;
    return Object.assign({}, this.st, {
      enabled: m.enabled, tokenSet: !!m.token, queued: this.readings.length, receptionsQueued: this.receptions.length,
      waitingForClock: this.pending.length, backoffMs: this.backoff, endpoint: this.api.lastEndpoint,
    });
  }
}

module.exports = { Uplink };
