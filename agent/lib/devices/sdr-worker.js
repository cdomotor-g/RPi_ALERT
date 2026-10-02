'use strict';
// One RTL-SDR's receive chain, in a worker thread: u8 IQ chunks from rtl_sdr
// in, MegaNet's AlertDsp.Pipeline (the website's own decoder) in the middle,
// decodes, burst stats, a coarse spectrum and gated audio out.
//
// A burst decode tries 45 carrier/timing combinations and takes a second or
// two on a Pi; here it cannot hold up the serial ports or the web page.

const { parentPort, workerData } = require('node:worker_threads');
const { AlertDsp } = require('../meganet-codecs');

const PREROLL_S = 0.15, HANG_S = 0.25, MAX_CLIP_S = 4;
const SPEC_BINS = 256;

let audioOn = !!(workerData && workerData.audio);
let levels = 0;
let clip = null;            // gated audio being collected: { parts: [], n }
let preroll = [];           // the last PREROLL_S of audio, for the start of a burst
let prerollN = 0;
let closedAt = 0;
let processed = 0;

const pipe = new AlertDsp.Pipeline((m) => {
  switch (m.type) {
    case 'decode':
      parentPort.postMessage({ type: 'decode', readings: m.readings, shadows: m.shadows, burst: m.burst, all: m.all,
        ms: m.ms, combos: m.combos, seconds: m.seconds, format: m.format, carrier: m.trace ? m.trace.carrierHz : null });
      break;
    case 'burst':
      parentPort.postMessage({ type: 'burst', ms: m.ms, peakDb: m.peakDb, nfDb: m.nfDb });
      break;
    case 'level':
      // ~10 a second from the pipeline; two a second is plenty for a dashboard.
      if (++levels % 5 === 0) parentPort.postMessage({ type: 'level', level: m });
      break;
    case 'spectrum': {
      // 2048 bins → 256, max-hold within each, for the dashboard's little plot.
      const k = m.db.length / SPEC_BINS, out = new Array(SPEC_BINS);
      for (let i = 0; i < SPEC_BINS; i++) {
        let mx = -200;
        for (let j = 0; j < k; j++) mx = Math.max(mx, m.db[i * k + j]);
        out[i] = Math.round(mx * 10) / 10;
      }
      parentPort.postMessage({ type: 'spectrum', db: out, floorDb: m.floorDb, peakDb: m.peakDb, rate: m.rate });
      break;
    }
    case 'audio':
      gateAudio(m.pcm, m.rate);
      break;
    default:
      break;
  }
});

function gateAudio(pcm, rate) {
  if (!audioOn) return;
  const now = processed / pipe.cfg.deviceRate;      // seconds of signal, not wall time
  if (pipe.open) {
    if (!clip) { clip = { parts: preroll.slice(), n: prerollN, rate }; }
    closedAt = now;
  }
  if (clip) {
    clip.parts.push(pcm); clip.n += pcm.length;
    if ((!pipe.open && now - closedAt > HANG_S) || clip.n > MAX_CLIP_S * rate) {
      const out = new Float32Array(clip.n);
      let o = 0;
      for (const p of clip.parts) { out.set(p, o); o += p.length; }
      parentPort.postMessage({ type: 'audio', pcm: out, rate }, [out.buffer]);
      clip = null; preroll = []; prerollN = 0;
    }
    return;
  }
  preroll.push(pcm); prerollN += pcm.length;
  while (preroll.length > 1 && prerollN - preroll[0].length > PREROLL_S * rate) prerollN -= preroll.shift().length;
}

parentPort.on('message', (m) => {
  try {
    if (m.type === 'iq') {
      const u8 = new Uint8Array(m.buf);
      pipe.feed(u8);
      processed += u8.length >> 1;
      parentPort.postMessage({ type: 'fed', bytes: u8.length });
    } else if (m.type === 'config') {
      if ('audio' in m.cfg) audioOn = !!m.cfg.audio;
      pipe.configure(Object.assign({}, m.cfg, { audio: audioOn }));
    } else if (m.type === 'reset') {
      pipe.reset(); clip = null; preroll = []; prerollN = 0; processed = 0;
    }
  } catch (e) {
    parentPort.postMessage({ type: 'error', message: String((e && e.stack) || e) });
  }
});

pipe.configure(Object.assign({ specHz: 1, scopeHz: 1, fftSize: 2048 }, (workerData && workerData.cfg) || {}, { audio: audioOn }));
parentPort.postMessage({ type: 'ready' });
