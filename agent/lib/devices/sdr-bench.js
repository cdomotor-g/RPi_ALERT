'use strict';
// What one channel's decoder costs this Pi at each window, measured here —
// so that the settings page can say what a stick's channels will take before
// they are saved, in this Pi's own cores rather than a table from another.
//
// A channel's decoder (sdr-worker.js) takes in the stick's whole window and
// filters its own channel out of it: its steady work, between bursts, goes
// with the window (web/sdr-plan.js COST), and that is what is measured — the
// pipeline the decoders run, fed a quiet band's noise for a fraction of a
// second at each window, the best of a few tries, in a worker thread of its
// own. A burst's decode is the same work at any window, and comes on top.
//
// The same again with a BurstWatch in front of the pipeline, asleep, as it is
// between bursts with receivers.sdr.watch 'bursts' (MegaNet #259 part 2):
// `watched`, so the page can say what that will take too.
//
// Once, a couple of minutes after the agent starts with a stick plugged in
// (the board does not change while it runs; lib/agent.js). A few seconds of
// one core on a Pi 4.
//
//   measure() → Promise<{ perChannel: { rate: cores }, watched: { rate: cores }, at, ms }>

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const SECONDS = 0.4;       // of samples, each try
const TRIES = 3;

function bench(rates) {
  const { AlertDsp } = require('../meganet-codecs');
  const out = {}, watched = {};
  // Every window once over first, so the first measured is not the one the
  // JavaScript engine is still compiling.
  for (const pass of [0, 1]) for (const rate of rates) {
    // rtl_sdr's own reads (sdr.js args()): 64 KiB from 900 ksps up, else 16.
    const chunk = rate >= 900000 ? 65536 : 16384;
    const u8 = new Uint8Array(chunk);
    let seed = 1;
    for (let i = 0; i < chunk; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; u8[i] = 117 + (seed % 21); }
    const n = Math.max(8, Math.round((pass ? SECONDS : SECONDS / 5) * rate * 2 / chunk));
    let best = Infinity;
    const pipe = new AlertDsp.Pipeline(() => {});
    pipe.configure({ deviceRate: rate, channelOffsetHz: 37000, specHz: 1, scopeHz: 1, fftSize: 2048 });
    for (let i = 0; i < 4; i++) pipe.feed(u8);
    for (let t = 0; t < (pass ? TRIES : 1); t++) {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < n; i++) pipe.feed(u8);
      const s = Number(process.hrtime.bigint() - t0) / 1e9;
      best = Math.min(best, s / (n * chunk / 2 / rate));
    }
    if (pass) out[rate] = Math.round(best * 1000) / 1000;
    // Watched: fed its first 2.5 s, after which a quiet channel's pipeline
    // sleeps; on the first pass over too, so it is not timed while compiling.
    const wp = new AlertDsp.Pipeline(() => {});
    wp.configure({ deviceRate: rate, channelOffsetHz: 37000, specHz: 1, scopeHz: 1, fftSize: 2048 });
    const w = new AlertDsp.BurstWatch(wp);
    for (let i = 0; i < Math.ceil(2.5 * rate * 2 / chunk); i++) w.feed(u8);
    const nw = Math.round(n / SECONDS);           // a second of samples a try: it costs little
    let bestW = Infinity;
    for (let t = 0; t < (pass ? TRIES : 1); t++) {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < nw; i++) w.feed(u8);
      const s = Number(process.hrtime.bigint() - t0) / 1e9;
      bestW = Math.min(bestW, s / (nw * chunk / 2 / rate));
    }
    if (pass) watched[rate] = w.awake ? out[rate] : Math.round(bestW * 1000) / 1000;
  }
  return { perChannel: out, watched };
}

if (!isMainThread && workerData && workerData.sdrBench) {
  try { parentPort.postMessage(bench(workerData.rates)); } catch (e) { parentPort.postMessage({ error: String(e && e.message || e) }); }
}

function measure(rates) {
  const { RATES } = require('../../web/sdr-plan');
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const w = new Worker(__filename, { workerData: { sdrBench: true, rates: rates || RATES } });
    let done = false;
    w.on('message', (m) => {
      done = true;
      if (m.error) reject(new Error(m.error)); else resolve({ perChannel: m.perChannel, watched: m.watched, at: Date.now(), ms: Date.now() - t0 });
      w.terminate();
    });
    w.on('error', (e) => { if (!done) { done = true; reject(e); } });
    w.on('exit', (code) => { if (!done) { done = true; reject(new Error('the measurement stopped (' + code + ')')); } });
  });
}

module.exports = { measure, bench };
