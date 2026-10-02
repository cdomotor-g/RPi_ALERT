'use strict';
// A USB GPS (a u-blox puck, any NMEA 0183 receiver). Its fix is where this
// base station is — the one location MegaNet records as exact — and its UTC
// time stands in for network time when the Pi has had no NTP since boot, so a
// base station with no internet still times its readings correctly.
//
// Sentences are parsed by MegaNet's serial-gps.js (GGA, RMC, GST; any talker;
// a sentence failing its checksum is dropped).

const { Nmea } = require('../meganet-codecs');

const STALE_MS = 10000;

function utcOf(time, date) {
  if (!time || !date || date.length < 6) return null;
  const hh = +time.slice(0, 2), mm = +time.slice(2, 4), ss = parseFloat(time.slice(4));
  const d = +date.slice(0, 2), mo = +date.slice(2, 4), y = 2000 + +date.slice(4, 6);
  const ms = Date.UTC(y, mo - 1, d, hh, mm, Math.floor(ss), Math.round((ss % 1) * 1000));
  return Number.isFinite(ms) ? ms : null;
}

class GpsDriver {
  constructor(ctx) {
    this.ctx = ctx;
    this.kind = 'gps';
    this.protocol = null;
    this.text = '';
    this.fix = null;
    this.sats = null; this.hdop = null; this.alt = null; this.quality = 0;
    this.speed = null; this.course = null; this.valid = false; this.gstM = null;
    this.utc = null;
    this.counts = { sentences: 0, bad: 0 };
  }

  onOpen() { this.text = ''; }
  onClose() { this.fix = null; this.ctx.event('gps', null); }

  feed(chunk) {
    this.text += chunk.toString('latin1');
    let m;
    while ((m = this.text.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.text.slice(0, m);
      this.text = this.text.slice(m + (this.text.substr(m, 2) === '\r\n' ? 2 : 1));
      this.line(line.trim());
    }
    if (this.text.length > 4096) this.text = '';
  }

  line(t) {
    if (!t) return;
    const p = Nmea.parse(t);
    if (!p) return;
    if (p.type === 'bad') { this.counts.bad++; return; }
    this.counts.sentences++;
    const now = Date.now();
    if (p.type === 'GGA') {
      this.quality = p.quality; this.sats = p.sats; this.hdop = p.hdop; this.alt = p.alt;
      if (p.quality > 0 && p.lat != null && p.lon != null) this.setFix(p.lat, p.lon, now);
    } else if (p.type === 'RMC') {
      this.valid = p.valid;
      this.speed = p.knots != null ? p.knots * 0.514444 : null;
      this.course = p.course;
      const utc = utcOf(p.time, p.date);
      // A receiver's time is worth having only once it has a fix: before that
      // many report their firmware's build date.
      if (p.valid && utc) { this.utc = { ms: utc, at: process.hrtime.bigint() }; this.ctx.event('gps-time', this.utc); }
      if (p.valid && p.lat != null && p.lon != null && !(this.fix && now - this.fix.t < 500)) this.setFix(p.lat, p.lon, now);
    } else if (p.type === 'GST') this.gstM = p.m;
  }

  setFix(lat, lon, now) {
    const acc = this.gstM != null ? Math.max(1, Math.round(this.gstM)) : this.hdop != null ? Math.max(1, Math.round(this.hdop * 5)) : null;
    this.fix = { lat: +lat.toFixed(7), lon: +lon.toFixed(7), accuracy_m: acc, t: now, sats: this.sats, alt: this.alt,
      speed_mps: this.speed, heading_deg: this.course };
    this.ctx.event('gps', this.fix);
  }

  current() { return this.fix && Date.now() - this.fix.t < STALE_MS ? this.fix : null; }

  tick() {}

  status() {
    const f = this.current();
    return { fix: f, quality: this.quality, sats: this.sats, hdop: this.hdop, valid: this.valid, counts: this.counts };
  }

  detail() { return { via: 'NMEA' }; }
}

module.exports = { GpsDriver, utcOf, STALE_MS };
