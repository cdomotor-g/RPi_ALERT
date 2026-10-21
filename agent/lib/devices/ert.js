'use strict';
// An ELPRO ERT-A2 ALERT2 receiver: its RS-232 port's "ALERT2 ASCII" lines
// (9600 8N1, with the receiver's clock and no RSSI) or its USB port's binary
// frames (RSSI, no clock). MegaNet's alert2.js parses both; this mirrors the
// Serial Monitor's ERT-A2 card (serial-ert.js) so a frame becomes the same
// readings, at the same time, as it does on floodwarning.net.
//
// Readings are protocol "alert2": each ALERT concentration record (a
// repeater's bundle of legacy ALERT readings, MANT port 1) of a frame whose
// structure adds up. The line carries no verdict of its own (IND API v1.1
// §5.2, MegaNet's #209): a frame is bad only when it does not add up
// (`damaged`). Every record — and every frame that would not parse, and a
// gauge's self-report (port 0) — is still a reception, because the bad ones
// are what finding a corrupting repeater is made of. A frame flagged as test
// data is receptions only, as on the SDR (alert2-readings.js).
//
// Time: an ALERT2 frame carries a 16-bit stamp, seconds since the most recent
// 00:00 or 12:00 — a half-day count, not a day's — and each record the seconds
// a repeater held it. The stamp is put on the half-day nearest its arrival, in
// UTC or local time, whichever lands within ten minutes (Alert2.placeStamp),
// less each record's hold — which lets two receivers that heard one frame
// agree on it. Neither fitting (a drifting network clock), the arrival time is
// used and the log says why.

const { Alert2 } = require('../meganet-codecs');

const TAG = 'ALERT2A,';

class ErtDriver {
  constructor(ctx, opts) {
    this.ctx = ctx;
    this.kind = 'ert-a2';
    this.protocol = 'alert2';
    this.fmt = opts && opts.binary ? 'bin' : null;
    this.text = '';
    this.bin = [];
    this.counts = { frames: 0, bad: 0, readings: 0, warned: 0, tests: 0, selfReports: 0 };
    this.bases = { utc: 0, local: 0, either: 0, none: 0 };
    this.lastFrame = null;
    this.decoder = null;
    this.sources = new Set();
    this.skewNote = '';
    this.clockSkewS = null;
  }

  onOpen() { this.text = ''; this.bin = []; }
  onClose() {}

  feed(chunk) {
    if (this.fmt !== 'ascii') {
      for (const b of chunk) this.bin.push(b);
      this.scanBin();
      if (this.fmt === 'bin') return;
    }
    this.text += chunk.toString('latin1');
    let m;
    while ((m = this.text.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.text.slice(0, m);
      this.text = this.text.slice(m + (this.text.substr(m, 2) === '\r\n' ? 2 : 1));
      this.line(line);
      if (this.fmt === 'bin') { this.text = ''; return; }
    }
    if (this.text.length > 16384) this.text = '';
  }

  line(raw) {
    const t = raw.trim();
    if (!t) return;
    const at = t.indexOf(TAG);
    if (at < 0) { if (/^[\x20-\x7e\t]+$/.test(t)) this.ctx.log.debug('ert-a2: ' + t); return; }
    if (!this.fmt) this.setFmt('ascii');
    if (this.fmt !== 'ascii') return;
    const s = t.slice(at);
    Alert2.parseAscii(s).frames.forEach(f => this.frame(f, s));
  }

  setFmt(fmt) {
    this.fmt = fmt;
    if (fmt === 'ascii') this.bin = [];
    this.ctx.log.info(fmt === 'ascii' ? 'reading ALERT2 ASCII lines (RS-232: receiver clock, no RSSI)' : 'reading ERT-A2 binary frames (USB: RSSI, no receiver clock)');
  }

  scanBin() {
    if (this.bin.length < 7) return;
    const out = Alert2.parseBinBytes(this.bin);
    this.bin.splice(0, out.used);
    if (this.bin.length > 65536) this.bin.splice(0, this.bin.length - 4096);
    if (!this.fmt) {
      if (!out.frames.some(f => !f.error)) return;
      this.setFmt('bin');
    }
    out.frames.forEach(f => this.frame(f, f.raw));
  }

  frame(f, text) {
    const now = this.ctx.clock.now();
    this.counts.frames++;
    this.lastFrame = { t: now, rssi: f.hdr ? f.hdr.rssi : null, error: f.error || null, n: f.records ? f.records.length : 0 };
    if (f.error) {
      this.counts.bad++;
      this.ctx.log.warn('ALERT2 frame not decoded: ' + f.error);
      this.ctx.reception({ protocol: 'alert2', alert_id: null, ok: false, fault: 'frame', rssi_dbm: f.hdr ? f.hdr.rssi : null,
        detail: { error: String(f.error).slice(0, 120) } });
      return;
    }
    const h = f.hdr;
    if (f.warn && f.warn.length) { this.counts.warned++; this.ctx.log.info('ALERT2 frame: ' + f.warn.join('; ')); }
    if (h.decoder != null) this.decoder = String(h.decoder);
    if (h.source != null) { this.sources.add(h.source); if (this.sources.size > 16) this.sources.delete(this.sources.values().next().value); }
    if (!f.payload) return;
    const stamp = f.payload.stamp;
    // The receiver's own clock against where the frame's stamp lands on it.
    if (h.clockMs && !f.damaged && stamp != null) {
      const p = Alert2.placeStamp(stamp, h.clockMs);
      if (p) this.clockSkewS = Math.round((h.clockMs - (p.ms != null ? p.ms : p.local)) / 1000);
    }
    const ts = this.frameTime(f, now);
    const at = off => (ts == null ? null : ts - (off || 0) * 1000);
    const clean = !f.damaged;
    const test = !!(f.payload.ctl && f.payload.ctl.test);
    if (test) this.counts.tests++;
    const rssi = h.rssi == null ? null : h.rssi;
    const base = { source: h.source, port: h.port, hop_limit: h.hopLimit, time_lock: h.timeLock };
    f.records.forEach(r => {
      this.ctx.reception({
        protocol: 'alert2', alert_id: r.alertId, value_raw: r.value,
        payload_hex: r.bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase(),
        ok: r.ok && clean && !test, fault: r.ok && clean ? null : 'frame', rssi_dbm: rssi,
        detail: Object.assign({}, base, { offset_s: r.offset }, test ? { test: true } : {}), ts: at(r.offset),
      });
    });
    // A gauge's own report of its sensors: one reception for the frame.
    if ((f.reports || []).length) {
      this.counts.selfReports++;
      this.ctx.reception({ protocol: 'alert2', alert_id: null, ok: clean && !test, fault: clean ? null : 'frame', rssi_dbm: rssi, ts,
        detail: Object.assign({}, base, { kind: 'self-report', self_report: (f.sensors || []).length }, test ? { test: true } : {}) });
    }
    if (!clean || test) return;
    const recs = f.records.filter(r => r.ok);
    recs.forEach((r, i) => {
      this.counts.readings++;
      this.ctx.reading({ alert_id: r.alertId, value_raw: r.value, protocol: 'alert2', fmt: 'ALERT2', ts: at(r.offset),
        line: i ? null : text, rssi_dbm: rssi, burstKey: 'e' + this.counts.frames });
    });
  }

  // When the frame was stamped: its half-day stamp put on the half-day nearest
  // its arrival, UTC or local, whichever lands within ten minutes. null while
  // the Pi's clock is not trusted (the agent times it then, lib/agent.js).
  frameTime(f, now) {
    if (!this.ctx.clock.trusted()) return null;
    const stamp = f.payload.stamp;
    if (stamp == null) return now;
    const p = Alert2.placeStamp(stamp, now);
    this.bases[(p && p.base) || 'none']++;
    if (!p || p.base == null) {
      const off = p ? Math.min(Math.abs(p.utc - now), Math.abs(p.local - now)) : 0;
      const note = 'ALERT2 frame times are ' + Math.round(off / 60000) + ' min from this Pi\'s clock on both UTC and local time, so readings are timed by arrival (check the network\'s clock)';
      if (note !== this.skewNote) { this.skewNote = note; this.ctx.log.warn(note); }
      return now;
    }
    this.skewNote = '';
    return p.ms;
  }

  tick() {}

  status() {
    return { format: this.fmt, counts: this.counts, lastFrame: this.lastFrame, decoder: this.decoder,
      sources: [...this.sources], receiverClockSkewS: this.clockSkewS, stampBases: this.bases, note: this.skewNote || null };
  }

  detail() {
    const d = { via: this.fmt === 'ascii' ? 'RS-232' : this.fmt === 'bin' ? 'USB' : 'serial' };
    if (this.fmt) d.format = this.fmt === 'ascii' ? 'rs232-ascii' : 'usb-binary';
    if (this.decoder) d.decoder_address = this.decoder;
    if (this.sources.size) d.source_addresses = [...this.sources].slice(0, 8);
    return d;
  }
}

module.exports = { ErtDriver };
