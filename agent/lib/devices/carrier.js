'use strict';
// How far off its channel each burst's carrier is, in Hz — to within a few
// tens of Hz, where the decoder's own carrier search is only good to a few
// hundred. An FM burst's discriminator output swings either side of its
// carrier's offset, so its average over the burst is that offset. The
// pipeline (vendor/meganet/alert-dsp.js, kept verbatim) leaves the
// discriminator's last third of a second in `audio`, a ring, and says while
// the squelch is `open`: read after each feed, that is the whole burst.
//
// Averaged over the stations a stick hears, the offsets are the stick's own
// frequency error (lib/devices/tune-help.js); sent with each reception, they
// are each transmitter's drift in MegaNet's Station Health (#217).
//
// One carrier or two. A repeater that keys up as the station it relays lets
// go holds the squelch open across both: one burst, two carriers, and their
// average is neither. So the middle of the burst is measured in halves, and
// halves more than STEP_HZ apart are not one transmitter — the burst is
// reported as split (head and tail), with no offset.

const TRIM_START_S = 0.03;   // the squelch opens 20 ms in, at a feed's grain
const TRIM_END_S = 0.1;      // and closes 100 ms after the carrier drops
const MIN_S = 0.08;          // too little left to average: no estimate
const MAX_S = 4;
const STEP_HZ = 60;          // halves this far apart: two transmitters (noise is ±20 Hz)

class CarrierMeter {
  constructor(pipe, fsBb) {
    this.pipe = pipe;
    this.fs = fsBb;
    this.ring = pipe.audio || null;
    this.lastPos = pipe.audio ? pipe.audioPos : 0;
    this.cur = null;
    this.byT = new Map();     // burst start (its t) → { hz, steady, head, tail }
  }

  // After each pipe.feed(): `n` baseband samples were expected (to see the
  // ring did not wrap more than once — then the estimate is dropped).
  after(expected) {
    const p = this.pipe, A = p.audio;
    if (!A) return;
    // Set up again (a reset, new settings): a new ring, read from its start.
    if (A !== this.ring) { this.ring = A; this.lastPos = 0; this.cur = null; }
    const AN = A.length;
    const n = (p.audioPos - this.lastPos + AN) % AN;
    if (p.open && !this.cur) this.cur = { vals: [], t: p.burst ? p.burst.t : null, ok: true, lastN: 0 };
    if (this.cur) {
      const c = this.cur;
      if (expected != null && expected >= AN) c.ok = false;
      if (c.vals.length < MAX_S * this.fs) for (let k = 0; k < n; k++) c.vals.push(A[(this.lastPos + k) % AN]);
      c.lastN = n;
      if (p.burst && c.t == null) c.t = p.burst.t;
      if (!p.open) {
        const est = c.ok ? measure(c.vals, this.fs, c.lastN) : null;
        if (est && c.t != null) {
          this.byT.set(c.t, est);
          if (this.byT.size > 50) this.byT.delete(this.byT.keys().next().value);
        }
        this.cur = null;
      }
    }
    this.lastPos = p.audioPos;
  }

  // The burst that started at t, once: { hz, steady, head, tail } — hz null
  // when it was not one steady carrier — or null if it was not measured.
  take(t) {
    if (t == null || !this.byT.has(t)) return null;
    const est = this.byT.get(t);
    this.byT.delete(t);
    return est;
  }
}

// A trimmed mean, its outliers (clicks) cut.
function trimmed(v) {
  const s = Float64Array.from(v).sort();
  const lo = Math.floor(s.length * 0.1), hi = Math.ceil(s.length * 0.9);
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += s[i];
  return sum / (hi - lo);
}

// The middle of the burst: its offset, and whether it was one carrier.
function measure(vals, fs, lastN) {
  const a = Math.round(TRIM_START_S * fs), z = vals.length - Math.round(TRIM_END_S * fs) - lastN;
  if (z - a < MIN_S * fs) return null;
  const mid = vals.slice(a, z), h = mid.length >> 1;
  const head = Math.round(trimmed(mid.slice(0, h))), tail = Math.round(trimmed(mid.slice(h)));
  const steady = Math.abs(head - tail) <= STEP_HZ;
  return { hz: steady ? Math.round(trimmed(mid)) : null, steady, head, tail };
}

// The offset alone, as before: null when not one steady carrier.
function estimate(vals, fs, lastN) {
  const m = measure(vals, fs, lastN);
  return m ? m.hz : null;
}

module.exports = { CarrierMeter, estimate, measure, STEP_HZ };
