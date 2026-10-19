'use strict';
// One RTL-SDR's receive chain, in a worker thread: u8 IQ chunks from rtl_sdr
// in, MegaNet's AlertDsp.Pipeline (the website's own decoder) in the middle,
// decodes, burst stats, a coarse spectrum and gated audio out.
//
// A burst decode tries 45 carrier/timing combinations and takes a second or
// two on a Pi; here it cannot hold up the serial ports or the web page.
//
// Recording (lib/recorder.js): with `record` on, every burst the squelch
// opens on goes out as well, as the pipeline holds it once its decode is done
// — the channel's own 240 ksps IQ, centred on it, over the window the decoder
// read (the burst and 0.4 s either side), from the pipeline's float ring and
// scaled to fill a byte (its own u8 capture is too quiet for a weak channel).
//
// ALERT2 (alert2-air.js): a burst the legacy decoder read nothing in — no
// reading, not even a repeat or a shadow — and long enough to hold a frame is
// tried as ALERT2 off the same window, before its decode goes out, so that
// the decode says what it was. Off with receivers.sdr.alert2 false.

const { parentPort, workerData } = require('node:worker_threads');
const { AlertDsp } = require('../meganet-codecs');
const { CarrierMeter } = require('./carrier');
const { toU8 } = require('../recorder');
const Air = require('./alert2-air');

const PREROLL_S = 0.15, HANG_S = 0.25, MAX_CLIP_S = 4;
const ALERT2_MIN_MS = 100;  // a sync and a first block are 153 ms
const SPEC_BINS = 256;

let audioOn = !!(workerData && workerData.audio);
let recordOn = !!(workerData && workerData.cfg && workerData.cfg.record);
let alert2On = !(workerData && workerData.cfg && workerData.cfg.alert2 === false);
let levels = 0;
let clip = null;            // gated audio being collected: { parts: [], n }
let preroll = [];           // the last PREROLL_S of audio, for the start of a burst
let prerollN = 0;
let closedAt = 0;
let processed = 0;

const pipe = new AlertDsp.Pipeline((m) => {
  switch (m.type) {
    case 'decode': {
      // The window just decoded ends where the samples do (within a chunk):
      // the ring's last `seconds` are that burst, as the decoder read it.
      const n = Math.min(pipe.ringR.length, pipe.total, Math.round((m.seconds + 0.05) * AlertDsp.FS_IN));
      const alert2 = alert2On && m.burst && !m.all && !(m.shadows || []).length && m.burst.ms >= ALERT2_MIN_MS ? tryAlert2(n, m) : null;
      parentPort.postMessage({ type: 'decode', readings: m.readings, shadows: m.shadows, burst: m.burst, all: m.all,
        ms: m.ms, combos: m.combos, seconds: m.seconds, format: m.format, carrier: m.trace ? m.trace.carrierHz : null,
        cfoHz: meter.take(m.burst && m.burst.t), alert2 });
      if (recordOn && m.burst) {
        const rec = toU8(pipe.ringR, pipe.ringI, pipe.total, n);
        parentPort.postMessage({ type: 'recording', buf: rec.buf, scale: rec.scale, rate: AlertDsp.FS_IN, seconds: n / AlertDsp.FS_IN, burst: m.burst,
          format: m.format, readings: m.readings.map(r => ({ id: r.sensorId, value: r.value })), all: m.all, shadows: (m.shadows || []).length,
          alert2: alert2 ? alert2.frames.map(f => ({ ok: f.ok, len: f.len, pdus: f.pdus.length })) : null }, [rec.buf]);
      }
      break;
    }
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

// The ring's last n samples, tried as ALERT2: a frame starting in the burst
// the gate saw — the middle of the window decoded (m.seconds, the burst's
// margin either side of it the same), from just before the gate opened.
// → alert2-air.js plain(), or an error.
function tryAlert2(n, m) {
  const CAP = pipe.ringR.length, start = pipe.total - n;
  const re = new Float32Array(n), im = new Float32Array(n);
  for (let k = 0; k < n; k++) { const p = (start + k) % CAP; re[k] = pipe.ringR[p]; im[k] = pipe.ringI[p]; }
  const ms = m.burst.ms / 1000, from = n / AlertDsp.FS_IN - m.seconds + Math.max(0, (m.seconds - ms) / 2);
  try { return Air.plain(Air.receive(re, im, { syncFrom: from - 0.15, syncTo: from + ms - 0.1 })); } catch (e) { return { frames: [], ms: 0, error: String((e && e.stack) || e) }; }
}

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
      meter.after((u8.length >> 1) * AlertDsp.FS_BB / pipe.cfg.deviceRate);
      processed += u8.length >> 1;
      parentPort.postMessage({ type: 'fed', bytes: u8.length });
    } else if (m.type === 'config') {
      if ('audio' in m.cfg) audioOn = !!m.cfg.audio;
      if ('record' in m.cfg) recordOn = !!m.cfg.record;
      if ('alert2' in m.cfg) alert2On = m.cfg.alert2 !== false;
      pipe.configure(Object.assign({}, m.cfg, { audio: audioOn }));
    } else if (m.type === 'reset') {
      pipe.reset(); clip = null; preroll = []; prerollN = 0; processed = 0;
      meter.cur = null; meter.ring = pipe.audio; meter.lastPos = pipe.audio ? pipe.audioPos : 0;
    }
  } catch (e) {
    parentPort.postMessage({ type: 'error', message: String((e && e.stack) || e) });
  }
});

// Each burst's carrier offset, from the pipeline's discriminator (lib/devices/carrier.js).
const meter = new CarrierMeter(pipe, AlertDsp.FS_BB);

pipe.configure(Object.assign({ specHz: 1, scopeHz: 1, fftSize: 2048 }, (workerData && workerData.cfg) || {}, { audio: audioOn }));
parentPort.postMessage({ type: 'ready' });
