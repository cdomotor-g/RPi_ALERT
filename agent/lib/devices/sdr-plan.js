'use strict';
// Where to tune a stick, and how fast to sample, so that it hears every
// channel it is given at once.
//
// An RTL-SDR hands over a slice of the band as wide as its sample rate, and
// the agent decodes each ALERT channel in that slice with a decoder of its own
// (sdr.js): one rtl_sdr, one stream, as many channels as fit.
//
// One channel is tuned as it always was: the configured rate (or the board's),
// the stick offsetHz below the channel (a quarter of the rate) so the DC spike
// every RTL2832U has never lands on it.
//
// Several channels get the lowest of AlertDsp's rates — each an exact multiple
// of the decoder's 240 ksps — at or above the configured one that holds them
// all, and the centre that keeps every channel
//
//   * inside the middle USABLE part of the slice: the RTL2832U's own filter
//     rolls off towards its edges, and what lies beyond them folds back in;
//   * away from the DC spike at the centre, and the low-frequency noise
//     around it (worst on a zero-IF tuner like the V2's FC0013): never nearer
//     than DC_MIN, and DC_CLEAR away when there is room;
//   * away from every other channel's mirror image: a zero-IF tuner's I/Q
//     imbalance puts a faint copy of each signal at the opposite offset, and a
//     strong burst's copy landing on another channel would be decoded there.
//     MIRROR_CLEAR keeps it outside that channel's carrier search and filter.
//
// The best centre is the one whose nearest hazard is furthest from any
// channel, each hazard measured against its own clearance (beyond which it
// makes no difference); then the one keeping the channels furthest from the
// edges. A rate that cannot keep DC_GOOD from the spike and MIRROR_GOOD from
// every image gives way to the next rate up that does better. Channels that
// cannot all fit even at the top rate (the settings refuse channels further
// apart than MAX_SPAN_HZ, so only one stuck on the DC spike in the middle of
// the widest span gets here) are heard as many as fit, the stick's own channel
// first; the rest are not decoded, and say so.

const RATES = [240000, 960000, 1200000, 1920000, 2400000];   // AlertDsp.DEVICE_RATES (sdr.test.js holds them equal)
const USABLE = 0.8;          // of the sample rate, around the centre
const CH_HALF = 15000;       // a channel's own width either side: the decoder's ±10 kHz carrier search, and the signal
const DC_MIN = 20000;        // never a channel nearer than this to the DC spike
const DC_GOOD = 50000;
const DC_CLEAR = 100000;
const MIRROR_GOOD = 20000;   // another channel's image this far off is outside its carrier search and filter
const MIRROR_CLEAR = 30000;
const STEP = 500;            // centres tried, Hz apart
const MAX_CHANNELS = 8;      // on one stick: each is a decoder thread
// Channels further apart than this never fit one stick: the widest slice less
// a channel's width at each end.
const MAX_SPAN_HZ = USABLE * RATES[RATES.length - 1] - 2 * CH_HALF;

// How far a channel may sit from the centre at a rate.
function reach(rate) { return USABLE * rate / 2 - CH_HALF; }

function score(freqs, c, half) {
  let dc = Infinity, mirror = Infinity, far = 0;
  for (let i = 0; i < freqs.length; i++) {
    const o = freqs[i] - c;
    dc = Math.min(dc, Math.abs(o));
    far = Math.max(far, Math.abs(o));
    for (let j = i + 1; j < freqs.length; j++) mirror = Math.min(mirror, Math.abs(o + freqs[j] - c));
  }
  const clear = Math.min(Math.min(dc, DC_CLEAR) / DC_CLEAR, Math.min(mirror, MIRROR_CLEAR) / MIRROR_CLEAR);
  return { centerHz: c, dc, mirror, clear, edge: half - far, good: dc >= DC_GOOD && mirror >= MIRROR_GOOD };
}

// The best centre for these (distinct) frequencies at this rate, or null when
// they do not fit in it.
function bestCentre(freqs, rate) {
  const half = reach(rate);
  const lo = Math.max(...freqs) - half, hi = Math.min(...freqs) + half;
  if (lo > hi) return null;
  let best = null;
  const consider = (c) => {
    const s = score(freqs, c, half);
    if (!best || s.clear > best.clear || (s.clear === best.clear && s.edge > best.edge)) best = s;
  };
  for (let c = Math.ceil(lo / STEP) * STEP; c <= hi; c += STEP) consider(c);
  if (!best) consider(Math.round((lo + hi) / 2));
  return best;
}

// Asked for every few seconds (each stick's settings, its status), and the
// answer only changes with the settings: the last few are kept.
const memo = new Map();

// chans: [{ freqHz, format }], the stick's own channel first.
// opts: { sampleRate: as set (0: automatic), baseRate: the board's automatic
// rate, offsetHz: as set (0: a quarter of the rate) }.
// → { sampleRate, centerHz, raised (the rate went up to hold them), dcHz and
//     mirrorHz (the nearest hazard of each kind to a channel; null for one
//     channel), channels: [{ freqHz, format, offsetHz, inBand }] }
function plan(chans, opts) {
  opts = opts || {};
  const from = opts.sampleRate || opts.baseRate || RATES[1];
  const key = chans.map(c => c.freqHz + '/' + c.format).join(',') + '|' + from + '|' + (opts.offsetHz || 0);
  let out = memo.get(key);
  if (!out) {
    out = compute(chans, from, opts.offsetHz);
    if (memo.size >= 32) memo.delete(memo.keys().next().value);
    memo.set(key, out);
  }
  return { sampleRate: out.sampleRate, centerHz: out.centerHz, raised: out.raised, dcHz: out.dcHz, mirrorHz: out.mirrorHz,
    channels: out.channels.map(c => Object.assign({}, c)) };
}

function compute(chans, from, offsetHz) {
  const main = chans[0].freqHz;
  const freqs = [...new Set(chans.map(c => c.freqHz))].sort((a, b) => a - b);
  let rate, best, heard;
  if (freqs.length === 1) {
    rate = from;
    best = { centerHz: Math.round(main - (offsetHz || rate / 4)), dc: null, mirror: null };
    heard = new Set(freqs);
  } else {
    let pick = null;
    for (const r of RATES) {
      if (r < from) continue;
      const b = bestCentre(freqs, r);
      if (!b || b.dc < DC_MIN) continue;
      if (!pick || b.clear > pick.best.clear) pick = { rate: r, best: b };
      if (pick.best.good) break;
    }
    if (pick) {
      rate = pick.rate; best = pick.best; heard = new Set(freqs);
    } else {
      // Not all of them: the stick's own channel, then each other one that
      // still fits beside those already in, nearest first.
      rate = RATES[RATES.length - 1];
      const fit = [main];
      for (const f of freqs.filter(f => f !== main).sort((a, b) => Math.abs(a - main) - Math.abs(b - main))) {
        const b = bestCentre(fit.concat(f), rate);
        if (b && b.dc >= DC_MIN) fit.push(f);
      }
      best = fit.length > 1 ? bestCentre(fit, rate) : { centerHz: Math.round(main - rate / 4), dc: null, mirror: null };
      heard = new Set(fit);
    }
  }
  const centerHz = best.centerHz;
  const fin = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  return {
    sampleRate: rate, centerHz, raised: rate > from, dcHz: fin(best.dc), mirrorHz: fin(best.mirror),
    channels: chans.map(c => ({ freqHz: c.freqHz, format: c.format, offsetHz: c.freqHz - centerHz, inBand: heard.has(c.freqHz) })),
  };
}

module.exports = { plan, bestCentre, reach, RATES, USABLE, CH_HALF, DC_MIN, DC_GOOD, MIRROR_GOOD, MAX_CHANNELS, MAX_SPAN_HZ };
