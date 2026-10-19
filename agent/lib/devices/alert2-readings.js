'use strict';
// ALERT2 frames heard off the air (alert2-air.js, in an SDR channel's worker)
// → the readings and receptions an SDR channel sends, as ert.js makes them
// from an ERT-A2's frames: protocol "alert2", format "ALERT2".
//
// Every record is a reception — with the station it came from and the path of
// repeaters it took, which is what finding a bad repeater is made of. A record
// is a reading once: a network relays each PDU along several paths, so one
// reading comes in two, three, four times, a few seconds apart, often within
// one frame. A test PDU's records are receptions only. A PDU on any other
// port — a station reporting its own sensors (self-reporting), or the
// network's own business — is a reception, with what it says: those carry no
// ALERT id, so they are not readings.
//
// Time: a PDU's stamp is seconds since 00:00 or 12:00 UTC, and each record is
// that many seconds before it. Most PDUs come within a minute or two of their
// stamp, and they say which clock the network keeps: on the half day nearest
// their arrival, within ten minutes, in UTC (or in local time, for a network
// that runs on it). Some come late — a repeater's store and forward, half an
// hour behind — and once the network's clock is known those keep their stamp
// too: the last time it could be, up to six hours before arrival. A stamp that
// fits neither, and any before the clock is known, is timed by arrival. A Pi
// whose own clock is not yet trusted leaves the time to the agent
// (lib/agent.js deviceReading).

const HALF_DAY_MS = 12 * 3600 * 1000;
const SKEW_MS = 10 * 60 * 1000;
const LATE_MS = 6 * 3600 * 1000;
const CLOCK_EVIDENCE = 3;           // fresh PDUs on one clock (and four times those on the other) to know it
const NOTE_MS = 3600 * 1000;
const DUP_MS = 15 * 60 * 1000;      // a relayed copy comes within seconds; this is ample
const DUP_SLACK_S = 2;

// stamp (seconds into a half day, starting `offsetMs` from UTC's) → the time
// nearest `refMs` it can be.
function onHalfDay(stamp, refMs, offsetMs) {
  const local = refMs + (offsetMs || 0);
  const base = Math.floor(local / HALF_DAY_MS) * HALF_DAY_MS + stamp * 1000 - (offsetMs || 0);
  return [base - HALF_DAY_MS, base, base + HALF_DAY_MS].reduce((a, b) => (Math.abs(b - refMs) < Math.abs(a - refMs) ? b : a));
}

// A stamp within ten minutes of refMs, in UTC or else local time → { t, clock: 'utc' | 'local' } or null.
function stampTime(stamp, refMs) {
  if (stamp == null || stamp >= 43200) return null;
  const utc = onHalfDay(stamp, refMs, 0);
  if (Math.abs(utc - refMs) <= SKEW_MS) return { t: utc, clock: 'utc' };
  const off = -new Date(refMs).getTimezoneOffset() * 60000;
  if (off) {
    const loc = onHalfDay(stamp, refMs, off);
    if (Math.abs(loc - refMs) <= SKEW_MS) return { t: loc, clock: 'local' };
  }
  return null;
}

// A PDU that is not ALERT concentration → its reception: heard, and what it says.
function otherPdu(p, fd) {
  const app = p.app, detail = Object.assign({ source: p.source, port: p.port, path: p.path, hop_limit: p.hopLimit, stamp: app.stamp, apdu: app.apdu }, fd);
  const sensors = [].concat(...(app.elements || []).filter(e => e.sensors).map(e => e.sensors));
  if (sensors.length) detail.sensors = sensors.slice(0, 40).map(s => (s.hex ? [s.sensor, s.hex] : [s.sensor, s.value]));
  const others = (app.elements || []).filter(e => !e.sensors).map(e => e.type);
  if (others.length) detail.elements = others.slice(0, 20);
  if (app.test) detail.test = true;
  return { alert_id: null, ok: !app.test, fault: null, payload_hex: app.hex ? app.hex.slice(0, 64) : null,
    detail: Object.assign(detail, { kind: sensors.length ? 'self-report' : 'other' }) };
}

// The latest the stamp can be that is not after refMs (by more than the skew): a PDU held up on its way.
function lastHalfDay(stamp, refMs, offsetMs) {
  const t = onHalfDay(stamp, refMs, offsetMs);
  return t > refMs + SKEW_MS ? t - HALF_DAY_MS : t;
}

class Alert2Reader {
  constructor() {
    this.seen = new Map();          // "id:value:second" → when it was last heard
    this.counts = { frames: 0, bad: 0, pdus: 0, records: 0, readings: 0, duplicates: 0, late: 0, other: 0 };
    this.sources = new Set();
    this.clocks = { utc: 0, local: 0 };   // fresh PDUs that fit each clock and not the other
    this.note = '';
    this.noteAt = 0;
  }

  // The clock the network keeps, once its fresh PDUs have said: 'utc', 'local' or null.
  clock() {
    const { utc, local } = this.clocks;
    if (utc >= CLOCK_EVIDENCE && utc >= 4 * local) return 'utc';
    if (local >= CLOCK_EVIDENCE && local >= 4 * utc) return 'local';
    return null;
  }

  // A PDU's stamp, heard at `now` → { t, clock, late } or null (timed by arrival).
  place(stamp, now) {
    if (stamp == null || stamp >= 43200) return null;
    const off = -new Date(now).getTimezoneOffset() * 60000;
    const utc = onHalfDay(stamp, now, 0), loc = off ? onHalfDay(stamp, now, off) : null;
    const near = (t) => t != null && Math.abs(t - now) <= SKEW_MS;
    if (near(utc) && !near(loc)) this.clocks.utc++;
    else if (near(loc) && !near(utc)) this.clocks.local++;
    if (this.clocks.utc + this.clocks.local > 1000) { this.clocks.utc >>= 1; this.clocks.local >>= 1; }
    const known = this.clock();
    const clock = known || (near(utc) ? 'utc' : near(loc) ? 'local' : null);
    if (!clock) return null;
    if (near(clock === 'utc' ? utc : loc)) return { t: clock === 'utc' ? utc : loc, clock };
    if (!known) return null;
    const t = lastHalfDay(stamp, now, clock === 'utc' ? 0 : off);
    return now - t <= LATE_MS ? { t, clock, late: true } : null;
  }

  say(out, now, note) {
    if (note === this.note && now - this.noteAt < NOTE_MS) return;
    this.note = note; this.noteAt = now;
    out.notes.push(note);
  }

  // A worker's alert2 result for one burst, heard at `now` (ms) → { readings, receptions, notes }.
  take(res, now, trusted) {
    const out = { readings: [], receptions: [], notes: [] };
    for (const [k, t] of this.seen) if (now - t > DUP_MS) this.seen.delete(k);
    for (const f of (res && res.frames) || []) {
      const fd = { cfo_hz: f.cfoHz, baud: f.baud, sync: f.sync, fixed: f.fixed };
      if (!f.ok) {
        this.counts.bad++;
        out.receptions.push({ alert_id: null, ok: false, fault: 'frame', detail: Object.assign({ error: String(f.error || '').slice(0, 120), len: f.len ?? null }, fd) });
        continue;
      }
      this.counts.frames++;
      for (const p of f.pdus) {
        this.counts.pdus++;
        this.sources.add(p.source);
        if (this.sources.size > 32) this.sources.delete(this.sources.values().next().value);
        const app = p.app;
        if (p.error || !app) continue;
        if (p.port !== 1) { this.counts.other++; out.receptions.push(otherPdu(p, fd)); continue; }
        const placed = this.place(app.stamp, now);
        if (placed && placed.late) this.counts.late++;
        if (app.stamp != null && !placed) {
          this.say(out, now, this.clock() ? 'ALERT2 time stamps from the future, or more than six hours old, are timed by arrival (check the network\'s clock and this Pi\'s)'
            : 'ALERT2 time stamps fit neither UTC nor local time within ten minutes of this Pi\'s clock, so readings are timed by arrival (check the clock)');
        }
        for (const r of app.records) {
          this.counts.records++;
          const ts = (placed ? placed.t : now) - r.before * 1000;
          const dup = this.repeat(r.id, r.value, ts, now);
          if (dup) this.counts.duplicates++;
          const detail = Object.assign({ source: p.source, path: p.path, hop_limit: p.hopLimit, stamp: app.stamp, before_s: r.before,
            clock: placed ? placed.clock : 'arrival', late: !!(placed && placed.late), duplicate: dup }, fd);
          if (app.test) detail.test = true;
          // Heard now (the agent times it), as every SDR reception is; when it was read is in the stamp.
          // A test PDU's is not ok, and says why in its detail: MegaNet's
          // receptions take only the faults it knows (0047), and "test" is not one.
          out.receptions.push({ alert_id: r.id, value_raw: r.value, payload_hex: r.hex, ok: !app.test, fault: null, detail });
          if (app.test || dup) continue;
          this.counts.readings++;
          out.readings.push({ alert_id: r.id, value_raw: r.value, ts: trusted ? ts : null, source: p.source, path: p.path, stamp: app.stamp, before: r.before });
        }
      }
    }
    return out;
  }

  // Heard already (within a couple of seconds of the same time)? Remembers it either way.
  repeat(id, value, ts, now) {
    const s = Math.round(ts / 1000);
    let dup = false;
    for (let d = -DUP_SLACK_S; d <= DUP_SLACK_S && !dup; d++) dup = this.seen.has(id + ':' + value + ':' + (s + d));
    this.seen.set(id + ':' + value + ':' + s, now);
    return dup;
  }

  status() { return { counts: this.counts, sources: [...this.sources], clock: this.clock(), note: this.note || null }; }
}

module.exports = { Alert2Reader, stampTime, onHalfDay };
