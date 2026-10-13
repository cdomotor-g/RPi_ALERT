'use strict';
// Tuning help for one RTL-SDR stick: the frequency correction (ppm) and the
// gain to set, from what it has heard since the agent started.
//
// ppm — each decoded burst's carrier offset (lib/devices/carrier.js) is the
// stick's error plus that station's own. Stations are off by their own small
// amounts, either way, so: a median for each station, then the median of the
// stations. Each offset is kept with the ppm in use when it was heard, so a
// correction set part-way does not muddle the ones before it.
//
// gain — bursts that reach the ADC's full scale (or samples clipping) say
// turn it down; the strongest bursts all far below full scale say there is
// room to turn it up. Only bursts heard at the gain now set count.

const DAY = 24 * 3600 * 1000;
const MAX_CARRIERS = 400, MAX_PEAKS = 120;
const MIN_BURSTS = 6, MIN_STATIONS = 2;
const PPM_WORTH = 1;             // less than this off: leave it
const SATURATED_DBFS = -3;       // as the web page calls a saturated burst
const TARGET_DBFS = -12;         // the strongest bursts, with room to spare
const LOW_DBFS = -30;            // strongest bursts below this: room to turn up
// The gains an R820T/R828D tuner (every RTL-SDR Blog stick) takes, in dB.
const GAINS = [0, 0.9, 1.4, 2.7, 3.7, 7.7, 8.7, 12.5, 14.4, 15.7, 16.6, 19.7, 20.7, 22.9, 25.4, 28.0, 29.7,
  32.8, 33.8, 36.4, 37.2, 38.6, 40.2, 42.1, 43.4, 43.9, 44.5, 48.0, 49.6];

const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r1 = (v) => Math.round(v * 10) / 10;
// The tuner's gain nearest to `db`, no higher than it when lowering, no lower when raising.
function snapGain(db, dir) {
  if (dir < 0) return [...GAINS].reverse().find(g => g <= db) ?? GAINS[0];
  if (dir > 0) return GAINS.find(g => g >= db) ?? GAINS[GAINS.length - 1];
  return GAINS.reduce((a, g) => (Math.abs(g - db) < Math.abs(a - db) ? g : a), GAINS[0]);
}

class TuneHelp {
  constructor(now) {
    this.now = now || (() => Date.now());
    this.carriers = [];   // { t, id, ppm: the stick's error as heard, with the correction then set }
    this.peaks = [];      // { t, peakDb, gain }
  }

  // A decoded burst `hz` off its channel at `freqHz`, from station `id`, while
  // the stick was corrected by `ppmSet`.
  carrier(id, hz, freqHz, ppmSet) {
    if (hz == null || !Number.isFinite(hz) || !freqHz) return;
    // Heard high (+hz): the stick tunes low, its crystal slow — rtl_sdr -p
    // takes the crystal's error, so the correction goes down.
    this.carriers.push({ t: this.now(), id, ppm: (ppmSet || 0) - hz / freqHz * 1e6 });
    if (this.carriers.length > MAX_CARRIERS) this.carriers.splice(0, this.carriers.length - MAX_CARRIERS);
  }

  burst(peakDb, gainDb) {
    if (peakDb == null || !Number.isFinite(peakDb)) return;
    this.peaks.push({ t: this.now(), peakDb, gain: gainDb == null ? 'auto' : gainDb });
    if (this.peaks.length > MAX_PEAKS) this.peaks.splice(0, this.peaks.length - MAX_PEAKS);
  }

  ppm(ppmSet) {
    const since = this.now() - DAY;
    const by = new Map();
    for (const c of this.carriers) if (c.t >= since) { if (!by.has(c.id)) by.set(c.id, []); by.get(c.id).push(c.ppm); }
    const n = [...by.values()].reduce((a, v) => a + v.length, 0);
    const per = [...by.values()].map(median);
    const out = { bursts: n, stations: per.length, set: ppmSet || 0 };
    if (n < MIN_BURSTS || per.length < MIN_STATIONS) return Object.assign(out, { state: 'measuring', need: { bursts: MIN_BURSTS, stations: MIN_STATIONS } });
    const est = median(per);
    const spread = median(per.map(p => Math.abs(p - est)));
    Object.assign(out, { estimate: r1(est), spread: r1(spread), suggest: Math.round(est) });
    out.state = Math.abs(est - out.set) < PPM_WORTH || out.suggest === out.set ? 'ok' : 'change';
    return out;
  }

  gain(gainDb, clipPct) {
    const g = gainDb == null ? 'auto' : gainDb;
    const peaks = this.peaks.filter(p => p.gain === g && p.t >= this.now() - DAY).map(p => p.peakDb);
    const out = { bursts: peaks.length, set: gainDb == null ? null : gainDb };
    const clipping = clipPct != null && clipPct >= 0.5;
    if (peaks.length < 5 && !clipping) return Object.assign(out, { state: 'measuring', need: { bursts: 5 } });
    const sorted = peaks.slice().sort((a, b) => a - b);
    const top = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] : null;
    const sat = peaks.filter(p => p >= SATURATED_DBFS).length;
    out.strongest = top != null ? r1(top) : null;
    out.saturated = sat;
    if (clipping || sat >= Math.max(2, peaks.length * 0.1)) {
      // A saturated peak is only a lower bound on the signal: down at least 8 dB.
      const from = gainDb == null ? 30 : gainDb;
      const by = Math.max(8, top != null ? top - TARGET_DBFS : 8);
      return Object.assign(out, { state: 'change', why: clipping ? 'clipping' : 'saturated', suggest: snapGain(from - by, -1) });
    }
    if (gainDb != null && top != null && top < LOW_DBFS && gainDb < GAINS[GAINS.length - 1]) {
      const by = Math.min(12, TARGET_DBFS - 6 - top);
      return Object.assign(out, { state: 'change', why: 'weak', suggest: snapGain(gainDb + by, 1) });
    }
    return Object.assign(out, { state: 'ok' });
  }

  status(cfg, level) {
    return { ppm: this.ppm(cfg.ppm), gain: this.gain(cfg.gainDb, level ? level.clipPct : null) };
  }
}

module.exports = { TuneHelp, snapGain, GAINS };
