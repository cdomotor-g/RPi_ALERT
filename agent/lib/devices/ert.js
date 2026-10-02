'use strict';
// An ELPRO ERT-A2 ALERT2 receiver: its RS-232 port's "ALERT2 ASCII" lines
// (9600 8N1, with the receiver's clock and no RSSI) or its USB port's binary
// frames (RSSI, no clock). MegaNet's alert2.js parses both; this mirrors the
// Serial Monitor's ERT-A2 card (serial-ert.js) so a frame becomes the same
// readings, at the same time, as it does on floodwarning.net.
//
// Readings are protocol "alert2". Only a frame the receiver called clean, and
// only its clean records, are sent as readings; every record (and every frame
// that would not parse) is still a reception, because the bad ones are what
// finding a corrupting repeater is made of.
//
// Time: an ALERT2 frame carries its own seconds-since-midnight, the network's
// clock. It is put on the day nearest to its arrival — which lets two
// receivers that heard one frame agree on it — unless that is more than ten
// minutes from the Pi's clock (a time zone, a drifting network clock), when
// the arrival time is used instead. Midnight is local time, as the ERT-A2 and
// the Serial Monitor both take it: set the Pi's time zone (Australia/Brisbane
// by default in the image).

const { Alert2 } = require('../meganet-codecs');

const TAG = 'ALERT2A,';
const SKEW_MS = 10 * 60 * 1000;

function onDayNearest(sod, refMs) {
  const d = new Date(refMs);
  d.setHours(0, 0, 0, 0);
  const t = d.getTime() + sod * 1000;
  return [t - 86400000, t, t + 86400000].reduce((a, b) => (Math.abs(b - refMs) < Math.abs(a - refMs) ? b : a));
}

class ErtDriver {
  constructor(ctx, opts) {
    this.ctx = ctx;
    this.kind = 'ert-a2';
    this.protocol = 'alert2';
    this.fmt = opts && opts.binary ? 'bin' : null;
    this.text = '';
    this.bin = [];
    this.counts = { frames: 0, bad: 0, readings: 0, warned: 0 };
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
    if (f.warn && f.warn.length) { this.counts.warned++; this.ctx.log.info('ALERT2 frame: ' + f.warn.join('; ')); }
    if (f.hdr.decoder != null) this.decoder = String(f.hdr.decoder);
    if (f.hdr.source != null) { this.sources.add(f.hdr.source); if (this.sources.size > 16) this.sources.delete(this.sources.values().next().value); }
    if (f.hdr.clockSod != null && f.payload) {
      let d = f.hdr.clockSod - f.payload.sod;
      if (d > 46800) d -= 86400; else if (d < -46800) d += 86400;
      this.clockSkewS = d;
    }
    if (!f.payload) return;
    const ts = this.frameTime(f, now);
    const clean = f.hdr.frameOk !== 0;
    f.records.forEach(r => {
      this.ctx.reception({
        protocol: 'alert2', alert_id: r.alertId, value_raw: r.value,
        payload_hex: r.bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase(),
        ok: r.ok && clean, fault: !r.ok ? 'status' : !clean ? 'frame' : null,
        rssi_dbm: f.hdr.rssi == null ? null : f.hdr.rssi, detail: { source: f.hdr.source, quality: f.hdr.quality }, ts,
      });
    });
    if (!clean) return;
    const recs = f.records.filter(r => r.ok);
    recs.forEach((r, i) => {
      this.counts.readings++;
      this.ctx.reading({ alert_id: r.alertId, value_raw: r.value, protocol: 'alert2', fmt: 'ALERT2', ts,
        line: i ? null : text, rssi_dbm: f.hdr.rssi == null ? null : f.hdr.rssi, burstKey: 'e' + this.counts.frames });
    });
  }

  frameTime(f, now) {
    const sod = f.payload.sod;
    if (!this.ctx.clock.trusted()) return null;          // the agent times it once the clock is known
    const ts = onDayNearest(sod, now);
    if (Math.abs(ts - now) > SKEW_MS) {
      const note = 'ALERT2 frame times are ' + Math.round((ts - now) / 60000) + ' min from this Pi\'s clock, so readings are timed by arrival (check the time zone)';
      if (note !== this.skewNote) { this.skewNote = note; this.ctx.log.warn(note); }
      return now;
    }
    this.skewNote = '';
    return ts;
  }

  tick() {}

  status() {
    return { format: this.fmt, counts: this.counts, lastFrame: this.lastFrame, decoder: this.decoder,
      sources: [...this.sources], receiverClockSkewS: this.clockSkewS, note: this.skewNote || null };
  }

  detail() {
    const d = { via: this.fmt === 'ascii' ? 'RS-232' : this.fmt === 'bin' ? 'USB' : 'serial' };
    if (this.fmt) d.format = this.fmt === 'ascii' ? 'rs232-ascii' : 'usb-binary';
    if (this.decoder) d.decoder_address = this.decoder;
    if (this.sources.size) d.source_addresses = [...this.sources].slice(0, 8);
    return d;
  }
}

module.exports = { ErtDriver, onDayNearest };
