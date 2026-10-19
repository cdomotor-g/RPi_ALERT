'use strict';
// ALERT2 frames heard off the air (alert2-air.js, in an SDR channel's worker)
// → the readings and receptions an SDR channel sends, as ert.js makes them
// from an ERT-A2's frames: protocol "alert2", format "ALERT2".
//
// Every record is a reception — with the station it came from and the path of
// repeaters it took, which is what finding a bad repeater is made of. A record
// is a reading once: a network relays each PDU along several paths, so one
// reading comes in two, three, four times, a few seconds apart, often within
// one frame. A test PDU's records are receptions only.
//
// Time: a PDU's stamp is seconds since 00:00 or 12:00 UTC, and each record is
// that many seconds before it. The stamp goes on the half day nearest its
// arrival; a network whose clock runs on local time instead (more than ten
// minutes out in UTC, within ten in local) is read in local time; neither,
// and the record is timed by its arrival. A Pi whose own clock is not yet
// trusted leaves the time to the agent (lib/agent.js deviceReading).

const HALF_DAY_MS = 12 * 3600 * 1000;
const SKEW_MS = 10 * 60 * 1000;
const DUP_MS = 15 * 60 * 1000;      // a relayed copy comes within seconds; this is ample
const DUP_SLACK_S = 2;

// stamp (seconds into a half day, starting `offsetMs` from UTC's) → the time
// nearest `refMs` it can be.
function onHalfDay(stamp, refMs, offsetMs) {
  const local = refMs + (offsetMs || 0);
  const base = Math.floor(local / HALF_DAY_MS) * HALF_DAY_MS + stamp * 1000 - (offsetMs || 0);
  return [base - HALF_DAY_MS, base, base + HALF_DAY_MS].reduce((a, b) => (Math.abs(b - refMs) < Math.abs(a - refMs) ? b : a));
}

// → { t, clock: 'utc' | 'local' } or null.
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

class Alert2Reader {
  constructor() {
    this.seen = new Map();          // "id:value:second" → when it was last heard
    this.counts = { frames: 0, bad: 0, pdus: 0, records: 0, readings: 0, duplicates: 0 };
    this.sources = new Set();
    this.note = '';
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
        if (p.error || !app || p.port !== 1) continue;      // ALERT concentration only: the rest carry no readings
        const placed = stampTime(app.stamp, now);
        if (app.stamp != null && !placed) {
          const note = 'ALERT2 time stamps fit neither UTC nor local time within ten minutes of this Pi\'s clock, so readings are timed by arrival (check the clock)';
          if (note !== this.note) { this.note = note; out.notes.push(note); }
        } else if (placed) this.note = '';
        for (const r of app.records) {
          this.counts.records++;
          const ts = (placed ? placed.t : now) - r.before * 1000;
          const dup = this.repeat(r.id, r.value, ts, now);
          if (dup) this.counts.duplicates++;
          const detail = Object.assign({ source: p.source, path: p.path, hop_limit: p.hopLimit, stamp: app.stamp, before_s: r.before,
            clock: placed ? placed.clock : 'arrival', duplicate: dup }, fd);
          // Heard now (the agent times it), as every SDR reception is; when it was read is in the stamp.
          out.receptions.push({ alert_id: r.id, value_raw: r.value, payload_hex: r.hex, ok: !app.test, fault: app.test ? 'test' : null, detail });
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

  status() { return { counts: this.counts, sources: [...this.sources], note: this.note || null }; }
}

module.exports = { Alert2Reader, stampTime, onHalfDay };
