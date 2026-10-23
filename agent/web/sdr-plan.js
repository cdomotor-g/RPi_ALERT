'use strict';
// Where to tune a stick, and how wide a window to take, so that it hears
// every channel it is given at once — and what that costs the Pi.
//
// An RTL-SDR hands over a slice of the band as wide as its sample rate, and
// the agent decodes each ALERT channel in that slice with a decoder of its own
// (lib/devices/sdr.js): one rtl_sdr, one stream, as many channels as fit.
//
// The window is a stick's biggest cost. Every channel's decoder takes in the
// whole slice and filters its own channel out of it, so a channel in a
// 960 kHz window is about three times the work of one in 240 kHz, and in
// 1.92 MHz about five (COST). And the decoder itself works at 240 ksps
// whatever the window (alert-dsp.js): a wider one hears no channel better,
// it only holds channels further apart. So
//
//   * automatic (sampleRate 0) is the narrowest window that holds every
//     channel clear of the hard limits below, tuned for the most room within
//     it — never a wider one for more room than the limits ask;
//   * a window set by hand is exactly that one: wider for a broader view on
//     the waterfall, or narrow to keep a stick light whatever channels it is
//     given. The stick's own channel is heard, then each other one that fits
//     beside those already in, nearest first; the rest are not decoded, and
//     the plan says why — outside the window, or a clash with the DC spike or
//     a mirror image — and the window that would hold them all (needs).
//
// One channel is tuned as it always was: the stick offsetHz below it (a
// quarter of the rate) so the DC spike every RTL2832U has never lands on it.
// Several get the centre that keeps every channel
//
//   * inside the middle USABLE part of the slice: the RTL2832U's own filter
//     rolls off towards its edges, and what lies beyond them folds back in;
//   * away from the DC spike at the centre, and the low-frequency noise
//     around it (worst on a zero-IF tuner like the V2's FC0013): never nearer
//     than DC_MIN, and DC_CLEAR away when there is room;
//   * away from every other channel's mirror image: a zero-IF tuner's I/Q
//     imbalance puts a faint copy of each signal at the opposite offset, and a
//     strong burst's copy landing on another channel would be decoded there.
//     Never nearer than MIRROR_GOOD (outside that channel's carrier search
//     and filter), and MIRROR_CLEAR when there is room.
//
// Of the centres that keep those limits, the best is the one whose nearest
// hazard is furthest from any channel, each measured against its own
// clearance (beyond which it makes no difference); then the one keeping the
// channels furthest from the edges. But where the stick is tuned now is kept
// when it still holds every channel within those limits in the window it
// now needs (opts.prefer): a channel added or taken away is then only a
// decoder started or stopped, and the others hear on without a break.
//
// Loaded by web/index.html as the global SdrPlan — the settings page plans a
// stick's channels as they are typed — and with require() by the agent.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SdrPlan = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // Each an exact multiple of the decoder's 240 ksps and an exact divisor of
  // the RTL2832U's 28.8 MHz (÷120, 30, 24, 20, 15, 12), inside its two valid
  // bands (225–300 k and 0.9–3.2 M). AlertDsp.DEVICE_RATES, the ones
  // MegaNet's SDR card offers, are among them.
  const RATES = [240000, 960000, 1200000, 1440000, 1920000, 2400000];
  // A channel's decoding at each window against one at 240 ksps — steady
  // state, between bursts (a burst's decode is the same work at any window).
  // lib/devices/sdr-bench.js measures this Pi's own.
  const COST = { 240000: 1, 960000: 3, 1200000: 3.7, 1440000: 4.1, 1920000: 5.1, 2400000: 6.3 };
  const USABLE = 0.8;          // of the sample rate, around the centre
  const CH_HALF = 15000;       // a channel's own width either side: the decoder's ±10 kHz carrier search, and the signal
  const DC_MIN = 20000;        // never a channel nearer than this to the DC spike
  const DC_CLEAR = 100000;
  const MIRROR_GOOD = 20000;   // never another channel's image nearer: outside its carrier search and filter
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
    return { centerHz: c, dc, mirror, clear, edge: half - far };
  }

  // The best centre for these (distinct) frequencies at this rate, of those
  // that keep the hard limits → its score; or { why } when there is none:
  // 'outside' (they do not fit in the window), 'spike' or 'mirror' (they fit,
  // but never clear of it).
  function bestCentre(freqs, rate) {
    const half = reach(rate);
    const lo = Math.max(...freqs) - half, hi = Math.min(...freqs) + half;
    if (lo > hi) return { why: 'outside' };
    let best = null, tried = 0, offSpike = false;
    const consider = (c) => {
      tried++;
      const s = score(freqs, c, half);
      if (s.dc < DC_MIN) return;
      offSpike = true;
      if (s.mirror < MIRROR_GOOD) return;
      if (!best || s.clear > best.clear || (s.clear === best.clear && s.edge > best.edge)) best = s;
    };
    for (let c = Math.ceil(lo / STEP) * STEP; c <= hi; c += STEP) consider(c);
    if (!tried) consider(Math.round((lo + hi) / 2));
    return best || { why: offSpike ? 'mirror' : 'spike' };
  }

  // Asked for every few seconds (each stick's settings, its status, the page
  // as channels are typed), and the answer only changes with the settings:
  // the last few are kept.
  const memo = new Map();

  // chans: [{ freqHz, format }], the stick's own channel first.
  // opts: { sampleRate: as set (0: automatic), offsetHz: as set (0: a quarter
  // of the rate), prefer: { sampleRate, centerHz }, where the stick is tuned
  // now }.
  // → { sampleRate, centerHz, auto, needs (the narrowest window that holds
  //     every channel; null: none does), lowHz and highHz (the window's
  //     edges), dcHz and mirrorHz (the nearest hazard of each kind to a
  //     channel; null for one channel),
  //     channels: [{ freqHz, format, offsetHz, inBand, why (when not) }] }
  function plan(chans, opts) {
    opts = opts || {};
    const rate = RATES.includes(opts.sampleRate) ? opts.sampleRate : 0;
    const pre = opts.prefer && RATES.includes(opts.prefer.sampleRate) && Number.isFinite(opts.prefer.centerHz) ? opts.prefer : null;
    const key = chans.map(c => c.freqHz + '/' + c.format).join(',') + '|' + rate + '|' + (opts.offsetHz || 0) + '|' + (pre ? pre.sampleRate + '@' + pre.centerHz : '');
    let out = memo.get(key);
    if (!out) {
      out = compute(chans, rate, opts.offsetHz, pre);
      if (memo.size >= 64) memo.delete(memo.keys().next().value);
      memo.set(key, out);
    }
    return Object.assign({}, out, { channels: out.channels.map(c => Object.assign({}, c)) });
  }

  function compute(chans, asked, offsetHz, prefer) {
    const main = chans[0].freqHz;
    const freqs = [...new Set(chans.map(c => c.freqHz))].sort((a, b) => a - b);
    const single = (rate) => ({ centerHz: Math.round(main - (offsetHz || rate / 4)), dc: null, mirror: null });
    // The narrowest window that holds them all (a wider one has room for
    // every centre a narrower one has, so every window from there up does).
    let needs = null, needsAt = null;
    if (freqs.length === 1) needs = RATES[0];
    else {
      for (const r of RATES) {
        const b = bestCentre(freqs, r);
        if (!b.why) { needs = r; needsAt = b; break; }
      }
    }
    const rate = asked || needs || RATES[RATES.length - 1];
    let best = freqs.length === 1 ? single(rate) : rate === needs ? needsAt : bestCentre(freqs, rate), heard = new Set(freqs);
    if (freqs.length > 1 && !best.why && prefer && prefer.sampleRate === rate) {
      const now = score(freqs, prefer.centerHz, reach(rate));
      if (now.edge >= 0 && now.dc >= DC_MIN && now.mirror >= MIRROR_GOOD) best = now;
    }
    const why = new Map();
    if (best.why) {
      // Not all of them: the stick's own channel, then each other one that
      // still fits beside those already in, nearest first.
      const fit = [main];
      for (const f of freqs.filter(f => f !== main).sort((a, b) => Math.abs(a - main) - Math.abs(b - main))) {
        const b = bestCentre(fit.concat(f), rate);
        if (b.why) why.set(f, b.why); else fit.push(f);
      }
      best = fit.length > 1 ? bestCentre(fit, rate) : single(rate);
      heard = new Set(fit);
    }
    const centerHz = best.centerHz;
    const fin = (v) => (Number.isFinite(v) ? Math.round(v) : null);
    return {
      sampleRate: rate, centerHz, auto: !asked, needs, lowHz: centerHz - rate / 2, highHz: centerHz + rate / 2,
      dcHz: fin(best.dc), mirrorHz: fin(best.mirror),
      channels: chans.map(c => Object.assign({ freqHz: c.freqHz, format: c.format, offsetHz: c.freqHz - centerHz, inBand: heard.has(c.freqHz) },
        heard.has(c.freqHz) ? {} : { why: why.get(c.freqHz) || 'outside' })),
    };
  }

  // A plan's decoding, in cores of this Pi: each channel it hears at the
  // plan's window. perChannel: { rate: cores a channel takes }, as
  // sdr-bench.js measured it here; without it, in channels at 240 ksps.
  function load(p, perChannel) {
    const n = p.channels.filter(c => c.inBand).length;
    const one = perChannel && perChannel[p.sampleRate];
    return n * (one != null ? one : COST[p.sampleRate] || 1);
  }

  // '240 kHz', '1.44 MHz'.
  function width(rate) { return rate >= 1e6 ? (rate / 1e6) + ' MHz' : (rate / 1e3) + ' kHz'; }

  return { plan, bestCentre, reach, load, width, RATES, COST, USABLE, CH_HALF, DC_MIN, MIRROR_GOOD, MAX_CHANNELS, MAX_SPAN_HZ };
}));
